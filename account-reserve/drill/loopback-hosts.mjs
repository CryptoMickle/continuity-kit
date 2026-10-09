import { createServer } from 'node:http';
import { createReserveHttpStore } from '../sdk/http-store.mjs';

const fail = code => Object.assign(new Error(code), { code });
const send = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
export function tamperCiphertext(bytes) {
  const record = JSON.parse(new TextDecoder().decode(bytes));
  const ciphertext = Buffer.from(record.ciphertext, 'base64url');
  ciphertext[Math.floor(ciphertext.length / 2)] ^= 1;
  return new TextEncoder().encode(JSON.stringify({ ...record, ciphertext: ciphertext.toString('base64url') }));
}

// Disposable loopback transport. Fault controls are local closures, never HTTP APIs.
export async function startDrillHosts({ enrollmentToken }) {
  const servers = [], records = new Map();
  const counts = { primary: 0, storeReads: 0, storeWrites: 0 };
  let primaryOnline = true, mode = 'healthy', consumed = false;
  async function listen(handler) {
    const server = createServer(handler); servers.push(server);
    await new Promise((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ok); });
    return 'http://127.0.0.1:' + server.address().port;
  }
  async function close() {
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    for (const bytes of records.values()) bytes.fill(0);
    records.clear();
  }
  try {
    const primaryOrigin = await listen((request, response) => { counts.primary++; send(response, primaryOnline ? 200 : 503, { role: 'synthetic-primary', ...(!primaryOnline ? { error: 'PRIMARY_OFFLINE' } : {}) }); });
    const reserveOrigin = await listen(async (request, response) => {
      try {
        const match = /^\/api\/reserve\/([A-Za-z0-9_-]{43})$/.exec(request.url);
        if (!match) return send(response, 404, { error: 'NOT_FOUND' });
        const locator = match[1];
        if (request.method === 'GET') {
          counts.storeReads++;
          if (mode === 'unavailable') return send(response, 503, { error: 'STORE_OFFLINE' });
          const bytes = records.get(locator);
          if (mode === 'missing' || !bytes) return send(response, 404, { error: 'MISSING' });
          const value = mode === 'tampered' ? tamperCiphertext(bytes) : bytes;
          return send(response, 200, { bytes: Buffer.from(value).toString('base64url') });
        }
        if (request.method !== 'PUT') return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        if (consumed || request.headers.authorization !== `Bearer ${enrollmentToken}`) return send(response, 403, { error: 'ENROLLMENT_DENIED' });
        let body = ''; for await (const part of request) { body += part; if (body.length > 88000) throw fail('BODY_TOO_LARGE'); }
        const value = JSON.parse(body), bytes = Buffer.from(value.bytes ?? '', 'base64url');
        if (!bytes.length || bytes.length > 65536 || bytes.toString('base64url') !== value.bytes) throw fail('INVALID_BYTES');
        if (records.has(locator)) return send(response, 409, { error: 'EXISTS' });
        consumed = true; counts.storeWrites++; records.set(locator, new Uint8Array(bytes));
        send(response, 201, { created: true });
      } catch { send(response, 400, { error: 'DRILL_REQUEST_FAILED' }); }
    });
    const fetcher = (path, init) => {
      const target = new URL(path, reserveOrigin);
      if (target.origin !== reserveOrigin || !target.pathname.startsWith('/api/reserve/')) throw fail('NON_LOOPBACK_TARGET_REJECTED');
      return fetch(target, init);
    };
    return {
      primaryStatus: async () => { const response = await fetch(primaryOrigin + '/api/config', { redirect: 'error' }); await response.body?.cancel(); return response.status; },
      setPrimaryOnline(value) { primaryOnline = Boolean(value); },
      setStoreMode(value) { if (!['healthy', 'missing', 'tampered', 'unavailable'].includes(value)) throw fail('FAULT_MODE_INVALID'); mode = value; },
      newStore({ writable = false } = {}) { return createReserveHttpStore({ fetcher, ...(writable ? { enrollmentToken } : {}) }); },
      counts: () => ({ ...counts }),
      storedBytes: () => [...records.values()].map(bytes => new Uint8Array(bytes)),
      close,
    };
  } catch (error) { await close(); throw error; }
}
