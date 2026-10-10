import { createServer } from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { readFile, realpath, lstat, access } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration, portsFromArgs } from './config.mjs';

const PRF_SALT = '20b9d60bc82e9d394a6e32b02bfb225927685add7cc924188fb8b7117e034d12';
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...names].sort().join();
const canonical = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])));
const b64 = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(max * 4 / 3)
  && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').length <= max && Buffer.from(value, 'base64url').toString('base64url') === value;

/** One-user disposable loopback teaching server. No production or physical mode.
 * B alone owns the simulated authenticator and ciphertext. Never deploy it. */
export async function startTextStarter({ primaryPort = 5973, recoveryPort = 5974, dist = fileURLToPath(new URL('./dist/', import.meta.url)) } = {}) {
  const settings = configuration(primaryPort, recoveryPort), servers = [];
  const staticRoot = await realpath(dist); await access(resolve(staticRoot, 'index.html'));
  const token = randomBytes(32).toString('base64url'), secret = randomBytes(32);
  let credentialId, stored, spent = false, primaryOnline = true;
  const counts = { primary: 0, recovery: 0, creates: 0, assertions: 0, writes: 0 };
  const json = (response, status, value) => { if (!response.destroyed && !response.headersSent) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); } };
  async function body(request, limit) {
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('BODY_INVALID');
    let timer, length = 0; const chunks = [];
    try { return await Promise.race([
      (async () => { for await (const chunk of request) { length += chunk.length; if (length > limit) throw new Error('BODY_INVALID'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); })(),
      new Promise((_, reject) => { timer = setTimeout(() => { request.destroy(); reject(new Error('BODY_TIMEOUT')); }, 5000); }),
    ]); } finally { clearTimeout(timer); }
  }
  async function listen(role, port, origin) {
    const server = createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      if (request.headers.host !== new URL(origin).host) return json(response, 421, { error: 'HOST_REJECTED' });
      counts[role]++;
      if (role === 'primary' && !primaryOnline) return json(response, 503, { error: 'PRIMARY_OFFLINE' });
      try {
        if (typeof request.url !== 'string' || request.url.length > 4096 || !request.url.startsWith('/') || request.url.startsWith('//') || /[%\\]/.test(request.url)) throw new Error('URL_INVALID');
        const url = new URL(request.url, origin);
        if (url.search || url.hash) return json(response, 400, { error: 'URL_REJECTED' });
        const api = url.pathname.startsWith('/api/'), mutation = request.method !== 'GET';
        if (api && ((request.headers.origin && request.headers.origin !== origin)
          || (request.headers['sec-fetch-site'] && !['same-origin','none'].includes(request.headers['sec-fetch-site'])))) return json(response, 403, { error: 'ORIGIN_REJECTED' });
        if (mutation && (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json' || request.headers['content-encoding'])) return json(response, 403, { error: 'ORIGIN_REJECTED' });
        if (url.pathname === '/api/config' && !mutation) return json(response, 200, { ...settings, role, synthetic: true, ...(role === 'recovery' && !spent ? { enrollmentToken: token } : {}) });
        if (url.pathname === '/api/status' && role === 'recovery' && !mutation) return json(response, 200, { synthetic: true, primaryOnline, records: stored ? 1 : 0, counts: { ...counts } });
        if (url.pathname === '/api/primary' && role === 'recovery' && request.method === 'POST') {
          const value = await body(request, 32); if (!exact(value, ['online']) || typeof value.online !== 'boolean') throw new Error('CONTROL_INVALID');
          primaryOnline = value.online; return json(response, 200, { primaryOnline });
        }
        if (url.pathname === '/api/synthetic' && role === 'recovery' && request.method === 'POST') {
          const value = await body(request, 512);
          if (!exact(value, value.credentialId === undefined ? ['action','rpId','salt'] : ['action','rpId','salt','credentialId'])
            || value.rpId !== settings.config.recoveryRpId || value.salt !== PRF_SALT) throw new Error('SYNTHETIC_INVALID');
          if (value.action === 'create') {
            if (credentialId || value.credentialId !== undefined) return json(response, 409, { error: 'ONE_LOCAL_CREDENTIAL_PER_RUN' });
            credentialId = randomBytes(24).toString('base64url'); counts.creates++;
          } else if (value.action === 'get') {
            if (!credentialId || value.credentialId !== undefined && value.credentialId !== credentialId) return json(response, 404, { error: 'CREDENTIAL_MISSING' });
            counts.assertions++;
          } else throw new Error('SYNTHETIC_INVALID');
          return json(response, 200, { credentialId, prfOutput: createHmac('sha256', secret).update(Buffer.from(value.salt, 'hex')).digest('base64url') });
        }
        const match = /^\/api\/reserve\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
        if (role === 'recovery' && match) {
          const locator = match[1]; if (!b64(locator, 32)) throw new Error('LOCATOR_INVALID');
          if (request.method === 'GET') return stored?.locator === locator ? json(response, 200, { bytes: stored.bytes.toString('base64url') }) : json(response, 404, { error: 'RESERVE_MISSING' });
          if (request.method === 'PUT') {
            if (spent || request.headers.authorization !== 'Bearer ' + token) return json(response, 403, { error: 'ENROLLMENT_DENIED' });
            spent = true; // A dispatched write consumes this single-use grant.
            const value = await body(request, 87440);
            if (!exact(value, ['bytes']) || !b64(value.bytes, 65536)) throw new Error('RECORD_INVALID');
            const bytes = Buffer.from(value.bytes, 'base64url'), envelope = JSON.parse(bytes.toString('utf8'));
            if (!exact(envelope, ['format','nonce','ciphertext']) || envelope.format !== 'account-continuity/text-reserve-v1/index'
              || !b64(envelope.nonce, 12) || Buffer.from(envelope.nonce, 'base64url').length !== 12 || !b64(envelope.ciphertext, 65536)
              || Buffer.from(envelope.ciphertext, 'base64url').length < 16 || canonical(envelope) !== bytes.toString('utf8')) throw new Error('RECORD_INVALID');
            if (stored) return json(response, 409, { error: 'RESERVE_EXISTS' });
            stored = { locator, bytes }; counts.writes++; return json(response, 201, { created: true });
          }
        }
        if (api) return json(response, 404, { error: 'ROUTE_UNAVAILABLE' });
        if (mutation) return json(response, 405, { error: 'METHOD_REJECTED' });
        const name = resolve(staticRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
        if (!name.startsWith(staticRoot + sep) || !types[extname(name)] || await realpath(name) !== name) return json(response, 404, { error: 'NOT_FOUND' });
        const stat = await lstat(name); if (!stat.isFile() || stat.size > 1024 * 1024) return json(response, 404, { error: 'NOT_FOUND' });
        response.writeHead(200, { 'content-type': types[extname(name)] }); response.end(await readFile(name));
      } catch { json(response, 400, { error: 'LOCAL_REQUEST_FAILED' }); }
    });
    server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 32;
    servers.push(server); await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  }
  async function close() {
    await Promise.all(servers.map(server => new Promise(done => { server.close(done); server.closeAllConnections(); })));
    secret.fill(0); stored?.bytes.fill(0); stored = undefined; credentialId = undefined;
  }
  try { await listen('primary', primaryPort, settings.originalOrigin); await listen('recovery', recoveryPort, settings.recoveryOrigin); }
  catch (error) { await close(); throw error; }
  return Object.freeze({ ...settings, close });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await startTextStarter(portsFromArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ primary: app.originalOrigin, reserve: app.recoveryOrigin, mode: 'SYNTHETIC LOCAL ONLY', storage: 'Disposable RAM; never deploy this server' }));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) { console.error(error?.code === 'EADDRINUSE' ? 'Ports are occupied. Stop the other server or use --primary-port=5975 --recovery-port=5976.' : 'Starter could not start. Run npm run build first and check that the two local ports are free.'); process.exitCode = 1; }
}
