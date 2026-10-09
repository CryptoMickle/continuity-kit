import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration } from './config.mjs';

// One-user, loopback-only synthetic teaching server. Never deploy this server.
export async function startIntegration({ primaryPort = 5373, recoveryPort = 5374, dist = fileURLToPath(new URL('./dist/', import.meta.url)) } = {}) {
  for (const port of [primaryPort, recoveryPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT_INVALID');
  if (primaryPort === recoveryPort) throw new Error('PORT_COLLISION');
  const settings = configuration(primaryPort, recoveryPort), servers = [];
  const credentials = new Map(), records = new Map();
  const enrollmentToken = randomBytes(32).toString('base64url');
  let primaryOnline = true, spent = false;
  const counts = { primary: 0, recovery: 0, creates: 0, assertions: 0, writes: 0 };
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 95000) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  async function listen(role, port, origin) {
    const host = new URL(origin).host;
    const server = createServer(async (req, res) => {
      res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      if (req.headers.host !== host) return json(res, 421, { error: 'HOST_REJECTED' });
      counts[role]++;
      if (role === 'primary' && !primaryOnline) return json(res, 503, { error: 'PRIMARY_OFFLINE' });
      if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'])) return json(res, 403, { error: 'ORIGIN_REJECTED' });
      try {
        const url = new URL(req.url, origin);
        if (url.search || url.hash) return json(res, 400, { error: 'URL_REJECTED' });
        if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { ...settings, role, synthetic: true, ...(role === 'recovery' && !spent ? { enrollmentToken } : {}) });
        if (url.pathname === '/api/status' && role === 'recovery' && req.method === 'GET') return json(res, 200, { primaryOnline, records: records.size, counts: { ...counts }, synthetic: true });
        if (url.pathname === '/api/primary' && role === 'recovery' && req.method === 'POST') {
          const input = await readJson(req);
          if (Object.keys(input).join() !== 'online' || typeof input.online !== 'boolean') throw new Error('CONTROL_INVALID');
          primaryOnline = input.online; return json(res, 200, { primaryOnline });
        }
        if (url.pathname === '/api/synthetic' && role === 'recovery' && req.method === 'POST') {
          const input = await readJson(req);
          if (input.rpId !== settings.config.recoveryRpId || !/^[a-f0-9]{64}$/.test(input.salt)) throw new Error('SYNTHETIC_INVALID');
          let id = input.credentialId;
          if (input.action === 'create') {
            if (credentials.size) return json(res, 409, { error: 'ONE_LOCAL_CREDENTIAL_PER_RUN' });
            id = randomBytes(24).toString('base64url'); credentials.set(id, new Map()); counts.creates++;
          } else if (input.action === 'get') {
            id ??= [...credentials.keys()][0]; counts.assertions++;
          } else throw new Error('ACTION_INVALID');
          const outputs = credentials.get(id);
          if (!outputs) return json(res, 404, { error: 'CREDENTIAL_MISSING' });
          if (!outputs.has(input.salt)) outputs.set(input.salt, randomBytes(32));
          return json(res, 200, { credentialId: id, prfOutput: outputs.get(input.salt).toString('base64url') });
        }
        const match = /^\/api\/reserve\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
        if (match && role === 'recovery') {
          const locator = match[1];
          if (Buffer.from(locator, 'base64url').toString('base64url') !== locator) throw new Error('LOCATOR_INVALID');
          if (req.method === 'GET') return records.has(locator) ? json(res, 200, { bytes: records.get(locator).toString('base64url') }) : json(res, 404, { error: 'MISSING' });
          if (req.method === 'PUT') {
            if (spent || req.headers.authorization !== `Bearer ${enrollmentToken}`) return json(res, 403, { error: 'ENROLLMENT_DENIED' });
            const input = await readJson(req);
            if (Object.keys(input).join() !== 'bytes' || typeof input.bytes !== 'string' || input.bytes.length > 87384) throw new Error('RECORD_INVALID');
            const bytes = Buffer.from(input.bytes, 'base64url');
            if (!bytes.length || bytes.length > 65536 || bytes.toString('base64url') !== input.bytes) throw new Error('RECORD_INVALID');
            if (spent) return json(res, 403, { error: 'ENROLLMENT_DENIED' });
            // Atomic only inside this local process; no await between check and insert.
            spent = true; records.set(locator, bytes); counts.writes++;
            return json(res, 201, { created: true });
          }
        }
        if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'ROUTE_UNAVAILABLE' });
        if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_REJECTED' });
        const root = resolve(dist), name = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
        if (!name.startsWith(root + '/') || !types[extname(name)]) return json(res, 404, { error: 'NOT_FOUND' });
        const data = await readFile(name); res.writeHead(200, { 'content-type': types[extname(name)] }); res.end(data);
      } catch { if (!res.headersSent) json(res, 400, { error: 'LOCAL_REQUEST_FAILED' }); else res.end(); }
    });
    servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  }
  async function close() {
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    for (const outputs of credentials.values()) for (const bytes of outputs.values()) bytes.fill(0);
    credentials.clear(); records.clear();
  }
  try { await listen('primary', primaryPort, settings.originalOrigin); await listen('recovery', recoveryPort, settings.recoveryOrigin); }
  catch (error) { await close(); throw error; }
  return { ...settings, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startIntegration();
  console.log(JSON.stringify({ original: app.originalOrigin, reserve: app.recoveryOrigin, scope: 'loopback synthetic integration only' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(); });
}
