import { base64url, decode64, enrollmentTicketHash, exact, validLocator } from '../../release/profile.mjs';
import { LIMITS, selfServiceAppsConfig, selfServiceConfig, selfServiceTextConfig, validateSelfServiceProfile } from './profile.mjs';
import { createSelfServiceStore } from './store.mjs';

const MAX_BODY_BYTES = 87400;
const security = Object.freeze({
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});
const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { ...security, 'content-type': 'application/json' } });
const error = (status, code) => reply(status, { error: code });

async function bodyText(request, maximum, timeoutMs) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw Error('BODY_INVALID');
  if (!request.body) throw Error('BODY_INVALID');
  const reader = request.body.getReader(); let timer;
  try {
    return await Promise.race([
      (async () => {
        let size = 0; const chunks = [];
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > maximum) throw Error('BODY_INVALID'); chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('BODY_TIMEOUT')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
function sameSite(request, expected, requireOrigin = false) {
  const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  return (origin === expected || (!requireOrigin && origin === null)) && (site === null || site === 'same-origin' || site === 'none');
}
function jsonMutation(request, expected) {
  return sameSite(request, expected, true) && request.headers.get('content-type') === 'application/json' && !request.headers.has('content-encoding');
}
async function retentionAuthorized(request, env) {
  const expected = env?.SELF_SERVICE_RETENTION_AUTH_HASH, token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || !token) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token[1]));
  const actual = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
  let mismatch = 0; for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return mismatch === 0;
}

/** Best-effort isolate-local friction, NOT identity, a global security bound, or a billing limit.
 * Only the platform-provided CF-Connecting-IP is inspected; forwarded headers are ignored.
 * Bucket keys are held in memory at most ten minutes and are never written to D1/logged. */
function admissionThrottle(now) {
  const buckets = new Map(); let windowStart = 0, total = 0;
  return request => {
    const time = now();
    if (time < windowStart || time - windowStart >= 60000) { windowStart = time; total = 0; }
    if (total >= 20) return false;
    for (const [key, value] of buckets) if (time < value.start || time - value.start >= 600000) buckets.delete(key);
    const raw = request.headers.get('cf-connecting-ip');
    const key = raw && raw.length <= 64 && /^[0-9a-fA-F:.]+$/.test(raw) ? raw : 'unattributed';
    let bucket = buckets.get(key);
    if (!bucket) { if (buckets.size >= 1024) return false; bucket = { start: time, count: 0 }; buckets.set(key, bucket); }
    if (bucket.count >= 3) return false;
    bucket.count++; total++; return true;
  };
}

/** Isolated fictional demo. Only recovery uses DB. There is no public admin/outage control. */
export function createSelfServiceHostedClient({ profile: supplied, role, assets = {} } = {}, { now = Date.now, bodyTimeoutMs = 5000, operationTimeoutMs = 10000 } = {}) {
  if (!['primary', 'recovery'].includes(role) || typeof now !== 'function' || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 5000 || !Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 10000) throw Error('HOST_CONFIGURATION_INVALID');
  const profile = supplied && typeof supplied === 'object' ? Object.freeze({ ...supplied }) : supplied;
  const admit = admissionThrottle(now), stores = new WeakMap();
  function store(env, trusted) {
    const db = env?.DB;
    if (!db || typeof db !== 'object') throw Error('STORE_CONFIGURATION_INVALID');
    let value = stores.get(db); if (!value) { value = createSelfServiceStore({ db, profile: trusted }); stores.set(db, value); }
    return value;
  }
  async function bounded(operation) {
    let timer;
    // Timing out does not cancel a possibly committed D1 operation; clients must reconcile by GET.
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('OPERATION_UNKNOWN')), operationTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  return Object.freeze({
    async fetch(request, env = {}) {
      let trusted;
      try { trusted = validateSelfServiceProfile(profile, now()); } catch { return error(503, 'DEMO_NOT_RELEASED'); }
      if (!trusted) return error(503, 'DEMO_NOT_RELEASED');
      const url = new URL(request.url), expectedOrigin = role === 'primary' ? trusted.primaryOrigin : trusted.recoveryOrigin;
      if (url.origin !== expectedOrigin) return error(421, 'HOST_REJECTED');
      const ended = () => now() >= trusted.expires;
      if (role === 'recovery' && url.pathname === '/api/retention/cleanup') {
        if (request.method !== 'POST') return error(405, 'METHOD_BLOCKED');
        if (!(await retentionAuthorized(request, env))) return error(403, 'RETENTION_REQUEST_REJECTED');
        if (url.search || url.hash || !sameSite(request, trusted.recoveryOrigin) || request.headers.get('content-type') !== 'application/json' || request.headers.has('content-encoding')) return error(403, 'RETENTION_REQUEST_REJECTED');
        try { if (await bodyText(request, 2, bodyTimeoutMs) !== '{}') return error(403, 'RETENTION_REQUEST_REJECTED'); } catch { return error(403, 'RETENTION_REQUEST_REJECTED'); }
        try {
          const result = await bounded(() => store(env, trusted).cleanupExpired());
          return result.state === 'not_due' ? error(409, 'RETENTION_NOT_DUE') : reply(200, { activeRecordsDeleted: true, remaining: result.remaining, remainingCapabilities: result.remainingCapabilities, purgedMs: result.purgedMs });
        } catch { return error(503, 'CLEANUP_UNCONFIRMED'); }
      }
      if (ended()) return error(410, 'DEMONSTRATION_ENDED');
      if (role === 'recovery' && url.pathname === '/api/enrollment/start') {
        if (request.method !== 'POST') return error(405, 'METHOD_BLOCKED');
        if (url.search || url.hash || !jsonMutation(request, trusted.recoveryOrigin) || request.headers.has('authorization')) return error(403, 'ENROLLMENT_DENIED');
        if (!admit(request)) return error(429, 'ADMISSION_THROTTLED');
        try { if (await bodyText(request, 2, bodyTimeoutMs) !== '{}') return error(400, 'ENROLLMENT_INVALID'); } catch { return error(400, 'ENROLLMENT_INVALID'); }
        if (ended()) return error(410, 'DEMONSTRATION_ENDED');
        try {
          const token = base64url(crypto.getRandomValues(new Uint8Array(32))), hash = await enrollmentTicketHash(token);
          const issued = await bounded(() => store(env, trusted).issue(hash));
          if (issued.state === 'expired' || ended()) return error(410, 'DEMONSTRATION_ENDED');
          if (issued.state === 'limit') return error(429, 'ENROLLMENT_LIMIT');
          return reply(201, { enrollmentToken: token, expiresAt: issued.expiresAt, serverNow: issued.serverNow });
        } catch { return error(503, 'ENROLLMENT_ISSUE_UNKNOWN'); }
      }
      if (role === 'recovery' && url.pathname.startsWith('/api/reserve/')) {
        if (!['GET', 'PUT'].includes(request.method)) return error(405, 'METHOD_BLOCKED');
        if (!sameSite(request, trusted.recoveryOrigin)) return error(403, 'ORIGIN_REJECTED');
        const match = /^\/api\/reserve\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
        if (!match || !validLocator(match[1]) || url.search || url.hash) return error(404, 'NOT_FOUND');
        const locator = match[1];
        if (request.method === 'GET') {
          try {
            const bytes = await bounded(() => store(env, trusted).get(locator));
            if (ended()) return error(410, 'DEMONSTRATION_ENDED');
            return bytes ? reply(200, { bytes: base64url(bytes) }) : error(404, 'RESERVE_MISSING');
          } catch (caught) { return error(caught.code === 'RELEASE_EXPIRED' ? 410 : 503, caught.code === 'RELEASE_EXPIRED' ? 'DEMONSTRATION_ENDED' : 'STORE_UNAVAILABLE'); }
        }
        if (!jsonMutation(request, trusted.recoveryOrigin)) return error(403, 'REQUEST_REJECTED');
        const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
        if (!bearer || !validLocator(bearer[1])) return error(403, 'ENROLLMENT_DENIED');
        let bytes;
        try {
          const text = await bodyText(request, MAX_BODY_BYTES, bodyTimeoutMs), value = JSON.parse(text);
          if (!exact(value, ['bytes']) || JSON.stringify(value) !== text) throw Error('BODY_INVALID');
          bytes = decode64(value.bytes, LIMITS.maxRecordBytes);
        } catch { return error(400, 'RECORD_INVALID'); }
        if (ended()) return error(410, 'DEMONSTRATION_ENDED');
        try {
          const hash = await enrollmentTicketHash(bearer[1]);
          const result = await bounded(() => store(env, trusted).putIfAbsent(locator, bytes, hash));
          if (result === 'created') return reply(201, { created: true });
          if (result === 'conflict') return error(409, 'RESERVE_EXISTS');
          if (result === 'denied' || result === 'consumed') return error(403, 'ENROLLMENT_DENIED');
          return result === 'expired' ? error(410, 'DEMONSTRATION_ENDED') : error(429, 'ENROLLMENT_LIMIT');
        } catch { return error(503, 'STORE_WRITE_UNKNOWN'); }
      }
      if (request.method !== 'GET') return error(405, 'METHOD_BLOCKED');
      if (['/api/config', '/api/text-config', '/api/apps-config'].includes(url.pathname) && !url.search && !url.hash) {
        if (role === 'recovery') { try { store(env, trusted); } catch { return error(503, 'STORE_CONFIGURATION_UNAVAILABLE'); } }
        if (url.pathname === '/api/apps-config') return reply(200, { hosted: true, synthetic: false, physicalEnabled: true, selfService: true, fictionalOnly: true, operatorHosted: false, enrollmentRequiresInvitation: false, role, originalOrigin: trusted.primaryOrigin, recoveryOrigin: trusted.recoveryOrigin, apps: selfServiceAppsConfig(trusted), expiresAt: trusted.expiresAt, limits: LIMITS });
        const config = url.pathname === '/api/text-config' ? selfServiceTextConfig(trusted) : selfServiceConfig(trusted);
        return reply(200, { hosted: true, synthetic: false, physicalEnabled: true, selfService: true, fictionalOnly: true, role, originalOrigin: trusted.primaryOrigin, recoveryOrigin: trusted.recoveryOrigin, config, expiresAt: trusted.expiresAt, limits: LIMITS });
      }
      if (/^\/(api|rpc|control)(\/|$)/.test(url.pathname)) return error(404, 'ROUTE_UNAVAILABLE');
      const path = url.pathname === '/' ? '/index.html' : ['/text', '/text/'].includes(url.pathname) ? '/text/index.html' : /^\/apps(?:\/(?:textarea|markdown))?\/?$/.test(url.pathname) ? '/apps/index.html' : url.pathname;
      if (!Object.hasOwn(assets, path)) return error(404, 'NOT_FOUND');
      const asset = assets[path];
      try {
        if (!asset || typeof asset.base64 !== 'string' || typeof asset.contentType !== 'string') throw Error('ASSET_INVALID');
        return new Response(Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0)), { headers: { ...security, 'content-type': asset.contentType } });
      } catch { return error(503, 'ASSET_UNAVAILABLE'); }
    },
  });
}
