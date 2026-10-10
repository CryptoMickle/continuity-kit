import { createServer } from 'node:http';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ciphertext, decode, exact, fail, hash, LIMITS, locator, profile, textConfig } from './profile.mjs';
import { openStore } from './store.mjs';

const headers = Object.freeze({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
const mime = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const MAX_BODY = 87440;
export function readInvitation(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 65) throw fail('INVITATION_FILE_INVALID');
  const token = readFileSync(path, 'utf8').trim(); if (!/^[a-f0-9]{64}$/.test(token)) throw fail('INVITATION_FILE_INVALID'); return token;
}
async function body(request, limit = MAX_BODY) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) throw fail('BODY_INVALID');
  const chunks = []; let size = 0, timer;
  try {
    return await Promise.race([
      (async () => { for await (const chunk of request) { size += chunk.length; if (size > limit) throw fail('BODY_INVALID'); chunks.push(chunk); } return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); })(),
      new Promise((_, reject) => { timer = setTimeout(() => { reject(fail('BODY_TIMEOUT')); request.destroy(); }, 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}
function sameOrigin(request, expected, mutation = false) {
  return (request.headers.origin === expected || (!mutation && request.headers.origin === undefined))
    && (!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(request.headers['sec-fetch-site']))
    && (!mutation || (request.headers['content-type'] === 'application/json' && !request.headers['content-encoding']));
}
/** Bind only to loopback. An operator TLS proxy forwards the original Host and
 * Origin. X-Forwarded-* is deliberately ignored; no request bodies/URLs logged. */
export async function startOperatorHost({ configuration, database, invitationFile, assets, role = 'recovery', port = 0 }) {
  const trusted = profile(configuration);
  if (!['primary', 'recovery'].includes(role) || !Number.isInteger(port) || port < 0 || port > 65535) throw fail('HOST_CONFIGURATION_INVALID');
  const expected = role === 'primary' ? trusted.primaryOrigin : trusted.recoveryOrigin;
  const expectedHost = new URL(expected).host, root = assets ? realpathSync(assets) : undefined;
  const invitationHash = role === 'recovery' && invitationFile ? hash(readInvitation(invitationFile)) : undefined;
  // Validate private inputs before opening SQLite; failed starts leave no DB open.
  const store = role === 'recovery' ? openStore(database, trusted) : undefined;
  let minute = 0, admissionCount = 0;
  const server = createServer(async (request, response) => {
    const send = (status, value) => { if (!response.destroyed) { response.writeHead(status, { ...headers, 'content-type': 'application/json' }); response.end(JSON.stringify(value)); } };
    try {
      if (request.headers.host !== expectedHost || typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 4096) return send(421, { error: 'HOST_REJECTED' });
      const url = new URL(request.url, expected);
      if (url.origin !== expected || Date.now() >= Date.parse(trusted.expiresAt)) return send(410, { error: 'DEMONSTRATION_ENDED' });
      if (role === 'recovery' && url.pathname === '/api/enrollment/start') {
        if (request.method !== 'POST' || url.search || !sameOrigin(request, expected, true)) return send(403, { error: 'ENROLLMENT_DENIED' });
        const credential = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '');
        if (!invitationHash || !credential || !timingSafeEqual(Buffer.from(invitationHash), Buffer.from(hash(credential[1])))) return send(403, { error: 'INVITATION_REQUIRED' });
        const current = Math.floor(Date.now() / 60000); if (current !== minute) { minute = current; admissionCount = 0; }
        if (++admissionCount > 20) return send(429, { error: 'ADMISSION_THROTTLED' });
        if (await body(request, 2) !== '{}') return send(400, { error: 'ENROLLMENT_INVALID' });
        const token = randomBytes(32).toString('base64url'), issued = store.issue(hash(token));
        return send(201, { enrollmentToken: token, ...issued });
      }
      if (role === 'recovery' && url.pathname.startsWith('/api/reserve/')) {
        const match = /^\/api\/reserve\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
        if (!match || !locator(match[1]) || url.search) return send(404, { error: 'NOT_FOUND' });
        if (!sameOrigin(request, expected, request.method === 'PUT')) return send(403, { error: 'ORIGIN_REJECTED' });
        if (request.method === 'GET') { const found = store.get(match[1]); return found ? send(200, { bytes: found.toString('base64url') }) : send(404, { error: 'RESERVE_MISSING' }); }
        if (request.method !== 'PUT') return send(405, { error: 'METHOD_BLOCKED' });
        const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
        if (!bearer || !locator(bearer[1])) return send(403, { error: 'ENROLLMENT_DENIED' });
        const text = await body(request); let record;
        try { record = JSON.parse(text); } catch { throw fail('RECORD_INVALID'); }
        if (!exact(record, ['bytes']) || JSON.stringify(record) !== text) throw fail('RECORD_INVALID');
        const created = store.putIfAbsent(match[1], ciphertext(decode(record.bytes)), hash(bearer[1]));
        return created ? send(201, { created: true }) : send(409, { error: 'RESERVE_EXISTS' });
      }
      if (request.method !== 'GET') return send(405, { error: 'METHOD_BLOCKED' });
      if (['/api/config', '/api/apps-config'].includes(url.pathname) && !url.search) {
        return send(200, { hosted: true, synthetic: false, physicalEnabled: true, selfService: true,
          operatorHosted: true, enrollmentRequiresInvitation: true, fictionalOnly: true, role,
          originalOrigin: trusted.primaryOrigin, recoveryOrigin: trusted.recoveryOrigin, expiresAt: trusted.expiresAt,
          limits: LIMITS, apps: trusted.apps.map(app => ({ id: app.id, label: app.label, config: textConfig(trusted, app) })) });
      }
      if (/^\/(api|rpc|control)(\/|$)/.test(url.pathname)) return send(404, { error: 'NOT_FOUND' });
      if (!root || /%|\\/.test(url.pathname)) return send(404, { error: 'NOT_FOUND' });
      const entry = ['/', '/apps', '/apps/'].includes(url.pathname);
      const appEntry = trusted.apps.some(app => url.pathname === '/apps/' + app.id + '/' || url.pathname === '/apps/' + app.id);
      const pathname = entry || appEntry ? '/apps/index.html' : url.pathname;
      const file = resolve(root, '.' + pathname);
      if (!file.startsWith(root + sep) || !Object.hasOwn(mime, extname(file))) return send(404, { error: 'NOT_FOUND' });
      let bytes;
      try { if (realpathSync(file) !== file || !lstatSync(file).isFile() || lstatSync(file).size > 8 * 1024 * 1024) throw fail('ASSET_INVALID'); bytes = readFileSync(file); }
      catch { return send(404, { error: 'NOT_FOUND' }); }
      response.writeHead(200, { ...headers, 'content-type': mime[extname(file)] }); response.end(bytes);
    } catch (error) {
      const code = error?.code ?? 'STORE_UNAVAILABLE';
      const status = code === 'STORE_EXPIRED' ? 410 : code === 'ENROLLMENT_LIMIT' ? 429 : code === 'ENROLLMENT_DENIED' ? 403 : ['BODY_INVALID', 'BODY_TIMEOUT', 'RECORD_INVALID'].includes(code) ? 400 : 503;
      send(status, { error: status === 503 ? 'STORE_OPERATION_UNCONFIRMED' : code });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 64;
  try { await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); }); }
  catch (error) { store?.close(); throw error; }
  return Object.freeze({ port: server.address().port,
    async close() { await new Promise(done => { server.close(done); server.closeAllConnections(); }); store?.close(); } });
}
export function argumentsFrom(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[a-z-]+$/.test(argv[i] ?? '') || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(result, argv[i].slice(2))) throw fail('ARGUMENTS_INVALID');
    result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsFrom(process.argv.slice(2));
    if (Object.keys(args).some(key => !['profile', 'database', 'invitation-file', 'assets', 'role', 'port'].includes(key)) || !args.profile) throw fail('ARGUMENTS_INVALID');
    const running = await startOperatorHost({ configuration: JSON.parse(readFileSync(args.profile, 'utf8')), database: args.database,
      invitationFile: args['invitation-file'], assets: args.assets, role: args.role, port: Number(args.port ?? 8787) });
    process.stdout.write(JSON.stringify({ ready: true, role: args.role ?? 'recovery', bind: '127.0.0.1', port: running.port }) + '\n');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void running.close().then(() => process.exit(0)); });
  } catch (error) { process.stderr.write((/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'OPERATOR_START_FAILED') + '\n'); process.exitCode = 1; }
}
