import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration } from './config.mjs';

// Loopback-only, disposable teaching server. Not a production backend.
export async function startStarter({ primaryPort = 4673, recoveryPort = 4674, physical = false, dist = fileURLToPath(new URL('./dist/', import.meta.url)) } = {}) {
  for (const port of [primaryPort, recoveryPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT_INVALID');
  if (primaryPort === recoveryPort) throw new Error('PORT_COLLISION');
  const settings = configuration(primaryPort, recoveryPort);
  const records = new Map(), credentials = new Map(), servers = [];
  const token = randomBytes(32).toString('base64url');
  let primaryOnline = true, spent = false;
  const counts = { primary: 0, recovery: 0, creates: 0, writes: 0 };
  const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  async function json(req) { let body = ''; for await (const part of req) { body += part; if (body.length > 95000) throw new Error('TOO_LARGE'); } return JSON.parse(body || '{}'); }
  async function listen(role, port, origin) {
    const server = createServer(async (req, res) => {
      res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      if (req.headers.host !== new URL(origin).host) return send(res, 421, { error: 'HOST_REJECTED' });
      counts[role]++;
      if (role === 'primary' && !primaryOnline) return send(res, 503, { error: 'PRIMARY_OFFLINE' });
      if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json')) return send(res, 403, { error: 'ORIGIN_REJECTED' });
      try {
        const url = new URL(req.url, origin);
        if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { ...settings, role, synthetic: !physical, ...(role === 'recovery' && !spent ? { enrollmentToken: token } : {}) });
        if (url.pathname === '/api/status' && req.method === 'GET') return send(res, 200, { primaryOnline, synthetic: !physical, storage: 'RAM; lost on server restart', records: records.size, counts });
        if (url.pathname === '/api/primary' && role === 'recovery' && req.method === 'POST') {
          const value = await json(req); if (typeof value.online !== 'boolean') throw new Error('CONTROL_INVALID');
          primaryOnline = value.online; return send(res, 200, { primaryOnline });
        }
        if (url.pathname === '/api/synthetic' && req.method === 'POST') {
          if (physical) return send(res, 403, { error: 'SYNTHETIC_DISABLED' });
          const input = await json(req), rp = new URL(origin).hostname;
          if (input.rpId !== rp || !/^[a-f0-9]{64}$/.test(input.salt)) throw new Error('SYNTHETIC_INVALID');
          let id = input.credentialId;
          if (input.action === 'create') {
            if (credentials.size >= 8) throw new Error('FIXTURE_LIMIT');
            id = randomBytes(24).toString('base64url'); credentials.set(id, { rp, salts: new Map() }); counts.creates++;
          } else if (input.action === 'get') {
            if (!id) id = [...credentials].reverse().find(([, r]) => r.rp === rp)?.[0];
          } else throw new Error('ACTION_INVALID');
          const record = credentials.get(id); if (!record || record.rp !== rp) throw new Error('CREDENTIAL_MISSING');
          if (!record.salts.has(input.salt)) record.salts.set(input.salt, randomBytes(32));
          return send(res, 200, { credentialId: id, prfOutput: record.salts.get(input.salt).toString('base64url') });
        }
        if (role === 'recovery' && url.pathname.startsWith('/api/reserve/')) {
          const locator = url.pathname.slice('/api/reserve/'.length);
          if (!/^[A-Za-z0-9_-]{43}$/.test(locator)) throw new Error('LOCATOR_INVALID');
          if (req.method === 'GET') return send(res, records.has(locator) ? 200 : 404, records.has(locator) ? { bytes: records.get(locator).toString('base64url') } : { error: 'MISSING' });
          if (req.method === 'PUT') {
            if (spent || req.headers.authorization !== `Bearer ${token}`) return send(res, 403, { error: 'ENROLLMENT_DENIED' });
            const input = await json(req); if (typeof input.bytes !== 'string' || input.bytes.length > 87384) throw new Error('RECORD_INVALID');
            const bytes = Buffer.from(input.bytes, 'base64url');
            if (!bytes.length || bytes.length > 65536 || bytes.toString('base64url') !== input.bytes) throw new Error('RECORD_INVALID');
            if (spent) return send(res, 403, { error: 'ENROLLMENT_DENIED' });
            if (records.has(locator)) return send(res, 409, { error: 'EXISTS' });
            // No await between test and insert: atomic within this one process only.
            records.set(locator, bytes); spent = true; counts.writes++; return send(res, 201, { created: true });
          }
        }
        if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_BLOCKED' });
        const root = resolve(dist), filename = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!filename.startsWith(root + '/') || !['.html', '.js', '.css', '.svg'].includes(extname(filename))) return send(res, 404, { error: 'NOT_FOUND' });
        const data = await readFile(filename); res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(filename)] }); res.end(data);
      } catch { send(res, 400, { error: 'LOCAL_REQUEST_FAILED' }); }
    });
    servers.push(server); await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', ok); });
  }
  async function close() {
    await Promise.all(servers.map(s => new Promise(ok => { s.closeAllConnections(); s.close(ok); })));
    for (const record of credentials.values()) for (const value of record.salts.values()) value.fill(0);
    credentials.clear(); records.clear();
  }
  try { await listen('primary', primaryPort, settings.originalOrigin); await listen('recovery', recoveryPort, settings.recoveryOrigin); } catch (e) { await close(); throw e; }
  return { ...settings, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startStarter({ physical: process.argv.includes('--physical-approved') });
  console.log(JSON.stringify({ primary: app.originalOrigin, reserve: app.recoveryOrigin, mode: process.argv.includes('--physical-approved') ? 'EXPLICIT LOCAL PHYSICAL TEST' : 'SYNTHETIC LOCAL ONLY' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(); });
}
