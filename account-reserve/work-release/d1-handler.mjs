import { releaseProfile, exact, decode64, base64url, validLocator, enrollmentTicketHash, fail } from '../release/profile.mjs';
import { createWorkD1Store } from './d1-store.mjs';

const MAX_REQUEST_BYTES = 90000;
function reply(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
}
export function parseWorkEnrollmentTickets(input = []) {
  if (!Array.isArray(input) || input.length > 16) throw fail('RELEASE_CONFIG_INVALID');
  const result = input.map(grant => {
    if (!exact(grant, ['hash', 'locator']) || typeof grant.hash !== 'string' || !/^[a-f0-9]{64}$/.test(grant.hash) || (grant.locator !== '*' && !validLocator(grant.locator))) throw fail('RELEASE_CONFIG_INVALID');
    return Object.freeze({ ...grant });
  });
  if (new Set(result.map(grant => grant.hash)).size !== result.length) throw fail('RELEASE_CONFIG_INVALID');
  return Object.freeze(result);
}
async function readBody(request, timeoutMs) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) throw fail('REQUEST_INVALID');
  if (!request.body) throw fail('REQUEST_INVALID');
  const reader = request.body.getReader(); let timer;
  try {
    const work = async () => {
      const chunks = []; let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_REQUEST_BYTES) throw fail('REQUEST_INVALID');
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const json = JSON.parse(text);
      // No alternative fields, duplicate-key serialization, or metadata accepted.
      if (!exact(json, ['bytes']) || JSON.stringify(json) !== text) throw fail('REQUEST_INVALID');
      return decode64(json.bytes);
    };
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('REQUEST_INVALID')), timeoutMs); })]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

/** Fetch-compatible B-only ciphertext handler. No public admin or ticket issuer. */
export function createWorkD1Handler({ profile: supplied, allowedOrigins = [], db, enrollmentTickets } = {}, { now = Date.now, bodyTimeoutMs = 5000 } = {}) {
  const profile = releaseProfile(supplied, allowedOrigins);
  if (!profile) return async () => reply(503, { error: 'RELEASE_DISABLED' });
  if (!Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 5000) throw fail('RELEASE_CONFIG_INVALID');
  const grants = parseWorkEnrollmentTickets(enrollmentTickets);
  const store = createWorkD1Store({ profile, db });
  return async request => {
    const url = new URL(request.url);
    if (url.origin !== profile.recoveryOrigin) return reply(421, { error: 'ORIGIN_REJECTED' });
    if (now() >= profile.expires) return reply(410, { error: 'RELEASE_EXPIRED' });
    if (!['GET', 'PUT'].includes(request.method)) return reply(405, { error: 'METHOD_REJECTED' });
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if ((origin !== null && origin !== profile.recoveryOrigin) || (site !== null && !['same-origin', 'none'].includes(site))) return reply(403, { error: 'ORIGIN_REJECTED' });
    const match = /^\/api\/reserve\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    if (!match || !validLocator(match[1]) || url.search || url.hash) return reply(404, { error: 'NOT_FOUND' });
    const locator = match[1];
    if (request.method === 'GET') {
      try {
        const bytes = await store.get(locator);
        return bytes ? reply(200, { bytes: base64url(bytes) }) : reply(404, { error: 'RESERVE_MISSING' });
      } catch (error) { return reply(error.code === 'RELEASE_EXPIRED' ? 410 : 503, { error: error.code === 'RELEASE_EXPIRED' ? 'RELEASE_EXPIRED' : 'STORE_UNAVAILABLE' }); }
    }
    if (origin !== profile.recoveryOrigin || request.headers.get('content-type') !== 'application/json' || request.headers.has('content-encoding')) return reply(403, { error: 'REQUEST_REJECTED' });
    const authorization = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
    let hash;
    try { hash = authorization && await enrollmentTicketHash(authorization[1]); } catch { /* Invalid capability never reaches storage. */ }
    const grant = grants.find(candidate => {
      if (typeof hash !== 'string') return false;
      let mismatch = 0; for (let i = 0; i < 64; i++) mismatch |= hash.charCodeAt(i) ^ candidate.hash.charCodeAt(i);
      return mismatch === 0;
    });
    if (!grant || (grant.locator !== '*' && grant.locator !== locator)) return reply(403, { error: 'ENROLLMENT_DENIED' });
    let bytes;
    try { bytes = await readBody(request, bodyTimeoutMs); } catch { return reply(400, { error: 'RECORD_INVALID' }); }
    if (now() >= profile.expires) return reply(410, { error: 'RELEASE_EXPIRED' });
    try {
      const result = await store.putIfAbsent(locator, bytes, hash);
      if (result === 'created') return reply(201, { created: true });
      if (result === 'conflict') return reply(409, { error: 'RESERVE_EXISTS' });
      if (result === 'consumed') return reply(403, { error: 'ENROLLMENT_CONSUMED' });
      if (result === 'expired') return reply(410, { error: 'RELEASE_EXPIRED' });
      return reply(429, { error: 'RELEASE_WRITE_LIMIT' });
    } catch { return reply(503, { error: 'STORE_WRITE_UNKNOWN' }); }
  };
}
