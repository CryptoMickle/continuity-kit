import { createServer, request as httpRequest } from 'node:http';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNativeProfile, validateNativeEnvironment } from './profile.mjs';

const MAX_BODY = 87440, TIMEOUT = 8000;
const fail = code => Object.assign(new Error(code), { code });
const locator = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
function readBounded(stream, maximum, signal) {
  return new Promise((done, reject) => {
    const length = stream.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) return reject(fail('BODY_INVALID'));
    let total = 0, settled = false; const chunks = [];
    const clean = () => { for (const [name, fn] of [['data', data], ['end', end], ['error', error], ['aborted', error], ['close', close]]) stream.removeListener(name, fn); signal.removeEventListener('abort', abort); };
    const finish = (problem, bytes) => { if (settled) return; settled = true; clean(); if (problem) { stream.pause(); reject(problem); } else done(bytes); };
    const data = chunk => { total += chunk.length; if (total > maximum) finish(fail('BODY_INVALID')); else chunks.push(chunk); };
    const end = () => finish(undefined, Buffer.concat(chunks, total)), error = () => finish(fail('BODY_INVALID'));
    const close = () => { if (!stream.complete) error(); }, abort = () => finish(fail('UPSTREAM_UNAVAILABLE'));
    for (const [name, fn] of [['data', data], ['end', end], ['error', error], ['aborted', error], ['close', close]]) stream.on(name, fn);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}

/** Trusted local operator transport, never a user-selected URL or forwarding
 * proxy. Its caller fixes the loopback port, public origin and API path. */
export async function requestLocalJson({ port, origin, path, method = 'GET', body, authorization, signal, maximum = MAX_BODY }) {
  const url = new URL(origin);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.localhost');
  const route = /^\/api\/replicas\/[a-z][a-z0-9-]{0,31}\/reserve\/([A-Za-z0-9_-]{43})$/.exec(path);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || url.origin !== origin || !(url.protocol === 'https:' || url.protocol === 'http:' && local)
    || !(path === '/api/config' && method === 'GET' || path === '/api/enrollment/start' && method === 'POST'
      || route && locator(route[1]) && ['GET', 'PUT'].includes(method)) || body && body.length > MAX_BODY) throw fail('UPSTREAM_CONFIGURATION_INVALID');
  let request, response;
  try {
    response = await new Promise((done, reject) => {
      request = httpRequest({ hostname: '127.0.0.1', port, path, method, agent: false, signal,
        headers: { host: url.host, origin, connection: 'close', ...(method === 'GET' ? {} : {
          'content-type': 'application/json', 'content-length': body?.length ?? 0, ...(authorization ? { authorization } : {}),
        }) } }, done);
      request.once('error', () => reject(fail('UPSTREAM_UNAVAILABLE'))); request.end(body);
    });
    if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 600 || response.statusCode >= 300 && response.statusCode < 400
      || response.headers['content-encoding'] || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '')) throw fail('UPSTREAM_RESPONSE_INVALID');
    return { status: response.statusCode, bytes: await readBounded(response, maximum, signal) };
  } finally { response?.destroy(); request?.destroy(); }
}

const assetTypes = Object.freeze({ js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', woff2: 'font/woff2' });
async function file(root, name, maximum) {
  const path = join(root, name), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || await realpath(path) !== path) throw fail('ASSETS_INVALID');
  const bytes = await readFile(path); if (bytes.length > maximum) throw fail('ASSETS_INVALID'); return bytes;
}
async function loadAssets(assets, profile, role) {
  const root = await realpath(assets), entries = new Map();
  const config = await file(root, 'continuity-config.json', 16384);
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(config)); } catch { throw fail('BUILD_PROFILE_MISMATCH'); }
  const validated = validateNativeEnvironment(value, role === 'primary' ? profile.primaryOrigin : profile.recoveryOrigin);
  if (validated.role !== role || canonical(validated.profile) !== canonical(profile)) throw fail('BUILD_PROFILE_MISMATCH');
  entries.set('/continuity-config.json', { bytes: Buffer.from(JSON.stringify(validated)), type: 'application/json' });
  entries.set('/', { bytes: await file(root, 'index.html', 1024 * 1024), type: 'text/html;charset=utf-8' });
  entries.set('/index.html', entries.get('/'));
  let names; try { names = await readdir(join(root, 'assets')); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  if (names.length > 64) throw fail('ASSETS_INVALID');
  let total = 0;
  for (const name of names) {
    const match = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css|svg|png|webp|woff2)$/.exec(name);
    if (!match) continue;
    const bytes = await file(root, 'assets/' + name, 8 * 1024 * 1024); total += bytes.length;
    if (total > 32 * 1024 * 1024) throw fail('ASSETS_INVALID');
    entries.set('/assets/' + name, { bytes, type: assetTypes[match[1]] });
  }
  return entries;
}

/** Static native frontend behind an operator's HTTPS proxy. No authenticator,
 * enrollment issuer, application faults or arbitrary proxy routes live here. */
export async function startNativeHost({ profile: supplied, role, assets, gatewayPort, port = 0 }) {
  const profile = validateNativeProfile(supplied);
  if (!['primary', 'recovery'].includes(role) || !Number.isInteger(port) || port < 0 || port > 65535
    || role === 'primary' && gatewayPort !== undefined || role === 'recovery' && (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535 || gatewayPort === port)) throw fail('HOST_CONFIGURATION_INVALID');
  const origin = role === 'primary' ? profile.primaryOrigin : profile.recoveryOrigin, expectedHost = new URL(origin).host;
  const entries = await loadAssets(assets, profile, role), paths = new Set(profile.replicas.map(item => item.basePath));
  const controllers = new Set(); let closing = false, closePromise;
  const server = createServer(async (request, response) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT); controllers.add(controller);
    const disconnect = () => controller.abort(); request.once('aborted', disconnect); response.once('close', disconnect);
    const send = (status, value) => { if (!response.destroyed && !response.headersSent) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(Buffer.isBuffer(value) ? value : JSON.stringify(value)); } };
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer'); response.setHeader('connection', 'close');
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), publickey-credentials-create=(self), publickey-credentials-get=(self)');
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (closing || request.headers.host !== expectedHost) return send(421, { error: 'HOST_REJECTED' });
      if (Date.now() >= Date.parse(profile.expiresAt)) return send(410, { error: 'PROFILE_EXPIRED' });
      if (typeof request.url !== 'string' || request.url.length > 4096 || !request.url.startsWith('/') || request.url.startsWith('//') || /[%\\?#]/.test(request.url)
        || new URL(request.url, origin).pathname !== request.url) return send(400, { error: 'PATH_REJECTED' });
      const route = /^(\/api\/replicas\/[a-z][a-z0-9-]{0,31}\/reserve)\/([A-Za-z0-9_-]{43})$/.exec(request.url);
      if (role === 'recovery' && route && paths.has(route[1]) && locator(route[2])) {
        if (!['GET', 'PUT'].includes(request.method)) return send(405, { error: 'METHOD_REJECTED' });
        const writing = request.method === 'PUT';
        if (request.headers.origin !== origin && (writing || request.headers.origin !== undefined)
          || request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) return send(403, { error: 'ORIGIN_REJECTED' });
        if (request.headers['content-encoding'] || writing && request.headers['content-type'] !== 'application/json'
          || !writing && (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0')) return send(400, { error: 'BODY_INVALID' });
        const auth = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
        if (writing && (!auth || !locator(auth[1]))) return send(403, { error: 'ENROLLMENT_DENIED' });
        const body = writing ? await readBounded(request, MAX_BODY, controller.signal) : undefined;
        const result = await requestLocalJson({ port: gatewayPort, origin, path: request.url, method: request.method, body,
          authorization: writing ? request.headers.authorization : undefined, signal: controller.signal });
        return send(result.status, result.bytes);
      }
      if (request.url.startsWith('/api/')) return send(404, { error: 'NOT_FOUND' });
      if (request.method !== 'GET') return send(405, { error: 'METHOD_REJECTED' });
      if (request.headers['content-encoding'] || request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0') return send(400, { error: 'BODY_INVALID' });
      const asset = entries.get(request.url); if (!asset) return send(404, { error: 'NOT_FOUND' });
      response.writeHead(200, { 'content-type': asset.type }); response.end(asset.bytes);
    } catch (error) { const status = error?.code === 'BODY_INVALID' ? 400 : 503; send(status, { error: status === 400 ? 'BODY_INVALID' : 'RESERVE_OPERATION_UNCONFIRMED' }); }
    finally { clearTimeout(timer); controller.abort(); controllers.delete(controller); request.removeListener('aborted', disconnect); response.removeListener('close', disconnect); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 64;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return Object.freeze({ port: server.address().port, close() {
    if (!closePromise) { closing = true; for (const controller of controllers) controller.abort(); closePromise = new Promise(done => { server.close(done); server.closeAllConnections(); }).then(() => entries.clear()); }
    return closePromise;
  } });
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index]?.slice(2), value = process.argv[index + 1];
      if (!process.argv[index]?.startsWith('--') || !['profile', 'role', 'assets', 'port', 'gateway-port'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(args, key)) throw fail('ARGUMENTS_INVALID'); args[key] = value;
    }
    if (!args.profile || !args.role || !args.assets) throw fail('ARGUMENTS_INVALID');
    const profile = JSON.parse(await readFile(args.profile, 'utf8'));
    const app = await startNativeHost({ profile, role: args.role, assets: args.assets, port: args.port === undefined ? 8788 : Number(args.port), gatewayPort: args['gateway-port'] === undefined ? undefined : Number(args['gateway-port']) });
    console.log(JSON.stringify({ ready: true, role: args.role, bind: '127.0.0.1', port: app.port }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch { console.error('NATIVE_HOST_START_FAILED'); process.exitCode = 1; }
}
