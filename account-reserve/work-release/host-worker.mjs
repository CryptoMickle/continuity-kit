import { createReserveHandler } from '../release/handler.mjs';
import { createRedisRestCommand } from '../release/redis-rest.mjs';
import { enrollmentTicketHash, SCHEMA, MAX_RECORDS, MAX_RECORD_BYTES } from '../release/profile.mjs';
import { validateWorkReleaseProfile, workReserveConfig } from './profile.mjs';

const security = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...security, 'content-type': 'application/json' } });
const unavailable = () => json({ error: 'WORK_RESERVE_NOT_RELEASED' }, 503);
function secured(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(security)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Read-only preflight. The final existing create-only handler remains the atomic
// authority; this check neither reserves a slot nor consumes a capability.
export const CHECK_ENROLLMENT_SCRIPT = `
local key = KEYS[1]
local expiry, ticket = tonumber(ARGV[1]), ARGV[2]
local now = redis.call('TIME')
if not expiry or tonumber(now[1]) * 1000 + tonumber(now[2]) / 1000 >= expiry then return {'expired'} end
if #ticket ~= 64 or string.find(ticket, '[^0-9a-f]') then return redis.error_reply('RESERVE_STORE_INVALID') end
local kind = redis.call('TYPE', key).ok
if kind == 'none' then return {'ready'} end
if kind ~= 'hash' then return redis.error_reply('RESERVE_STORE_INVALID') end
local fields = redis.call('HLEN', key)
if fields < 4 or fields > ${2 + 2 * MAX_RECORDS} or redis.call('HGET', key, '__schema') ~= '${SCHEMA}' or redis.call('HGET', key, '__expires') ~= ARGV[1] then return redis.error_reply('RESERVE_STORE_INVALID') end
local count, used = 0, 0
for _, field in ipairs(redis.call('HKEYS', key)) do
  if field ~= '__schema' and field ~= '__expires' then
    if string.sub(field, 1, 5) == 'data:' and #field == 48 and not string.find(string.sub(field, 6), '[^A-Za-z0-9_-]') then
      count = count + 1
      local size = redis.call('HSTRLEN', key, field)
      if size < 2 or size > ${Math.ceil(MAX_RECORD_BYTES * 4 / 3)} then return redis.error_reply('RESERVE_STORE_INVALID') end
    elseif string.sub(field, 1, 7) == 'ticket:' and #field == 71 and not string.find(string.sub(field, 8), '[^0-9a-f]') then
      used = used + 1
      local bound = redis.call('HGET', key, field)
      if #bound ~= 43 or string.find(bound, '[^A-Za-z0-9_-]') or redis.call('HEXISTS', key, 'data:' .. bound) ~= 1 then return redis.error_reply('RESERVE_STORE_INVALID') end
    else return redis.error_reply('RESERVE_STORE_INVALID') end
  end
end
if count ~= used or count > ${MAX_RECORDS} then return redis.error_reply('RESERVE_STORE_INVALID') end
if count >= ${MAX_RECORDS} or redis.call('HEXISTS', key, 'ticket:' .. ticket) == 1 then return {'denied'} end
return {'ready'}
`;
async function emptyJsonBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && !['0', '2'].includes(declared)) return false;
  if (!request.body) return true;
  const reader = request.body.getReader(); let timer;
  try {
    return await Promise.race([
      (async () => {
        let length = 0, text = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength; if (length > 2) return false;
          text += String.fromCharCode(...value);
        }
        return text === '' || text === '{}';
      })(),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
async function checkEnrollment(request, trusted, entry) {
  const denied = () => json({ error: 'ENROLLMENT_DENIED' }, 403);
  const site = request.headers.get('sec-fetch-site');
  if (request.headers.get('origin') !== trusted.recoveryOrigin || (site !== null && !['same-origin', 'none'].includes(site)) || request.headers.get('content-type') !== 'application/json' || request.headers.has('content-encoding')) return denied();
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
  if (!bearer || !(await emptyJsonBody(request))) return denied();
  let hash;
  try { hash = await enrollmentTicketHash(bearer[1]); } catch { return denied(); }
  let matched = false;
  for (const grant of entry.enrollmentTickets) {
    let mismatch = 0; for (let i = 0; i < 64; i++) mismatch |= grant.hash.charCodeAt(i) ^ hash.charCodeAt(i);
    if (mismatch === 0 && grant.locator === '*') matched = true;
  }
  if (!matched) return denied();
  if (Date.now() >= Date.parse(trusted.expiresAt)) return json({ error: 'DEMONSTRATION_ENDED' }, 410);
  const result = await entry.command(['EVAL', CHECK_ENROLLMENT_SCRIPT, '1', `accountreserve:v1:${trusted.releaseId}`, String(Date.parse(trusted.expiresAt)), hash]);
  if (!Array.isArray(result) || result.length !== 1) throw new Error('STORE_UNAVAILABLE');
  if (Date.now() >= Date.parse(trusted.expiresAt)) return json({ error: 'DEMONSTRATION_ENDED' }, 410);
  if (result[0] === 'ready') return json({ ready: true, expiresAt: trusted.expiresAt });
  if (result[0] === 'expired') return json({ error: 'DEMONSTRATION_ENDED' }, 410);
  if (result[0] === 'denied') return denied();
  throw new Error('STORE_UNAVAILABLE');
}

/** An isolated hosted-work candidate. Assets/profile are build-time public data;
 * Redis token and enrollment hashes remain exclusively runtime server bindings. */
export function createHostedWorkClient({ profile: supplied, role, assets = {}, redisOrigin } = {}) {
  if (!['primary', 'recovery'].includes(role)) throw new Error('HOST_ROLE_INVALID');
  // Snapshot public data without consulting the deployment-startup clock.
  const profile = supplied && typeof supplied === 'object' ? Object.freeze({ ...supplied }) : supplied;
  if (profile?.enabled !== true) return Object.freeze({ fetch: async () => unavailable() });
  const handlers = new WeakMap();
  function reserveHandler(env, trusted) {
    if (!env || typeof env !== 'object' || env.RESERVE_REDIS_REST_URL !== redisOrigin) throw new Error('REDIS_ORIGIN_MISMATCH');
    const token = env.RESERVE_REDIS_REST_TOKEN;
    const ticketText = env.RESERVE_ENROLLMENT_TICKET_HASHES ?? '[]';
    const cached = handlers.get(env);
    // Revalidate changed runtime bindings; a cached handler cannot preserve a
    // revoked capability or a stale endpoint/token after the environment changes.
    if (cached && cached.token === token && cached.ticketText === ticketText) return cached;
    const command = createRedisRestCommand({ url: redisOrigin, token, allowedOrigins: [redisOrigin] });
    if (typeof ticketText !== 'string') throw new Error('ENROLLMENT_CONFIG_INVALID');
    const enrollmentTickets = JSON.parse(ticketText);
    const storeProfile = {
      version: 1, enabled: true, releaseId: trusted.releaseId,
      recoveryOrigin: trusted.recoveryOrigin, expiresAt: trusted.expiresAt,
    };
    const handler = createReserveHandler({ profile: storeProfile, allowedOrigins: [trusted.recoveryOrigin], command, enrollmentTickets });
    const entry = { token, ticketText, handler, command, enrollmentTickets };
    handlers.set(env, entry);
    return entry;
  }
  return Object.freeze({
    async fetch(request, env = {}) {
      const now = Date.now();
      let trusted;
      try { trusted = validateWorkReleaseProfile(profile, { now, allowExpired: true }); } catch { return unavailable(); }
      if (!trusted) return unavailable();
      let url;
      try { url = new URL(request.url); } catch { return json({ error: 'HOST_REJECTED' }, 421); }
      const expectedOrigin = role === 'primary' ? trusted.primaryOrigin : trusted.recoveryOrigin;
      if (url.origin !== expectedOrigin) return json({ error: 'HOST_REJECTED' }, 421);
      if (now >= Date.parse(trusted.expiresAt)) return json({ error: 'DEMONSTRATION_ENDED' }, 410);
      if (role === 'primary' && env?.WORK_RESERVE_PRIMARY_OFFLINE === 'true') return json({ error: 'PRIMARY_OFFLINE' }, 503);
      if (role === 'recovery' && url.pathname === '/api/enrollment/check') {
        if (request.method !== 'POST') return json({ error: 'METHOD_BLOCKED' }, 405);
        if (url.search || url.hash) return json({ error: 'ENROLLMENT_DENIED' }, 403);
        try { return await checkEnrollment(request, trusted, reserveHandler(env, trusted)); }
        catch { return json({ error: 'STORE_UNAVAILABLE' }, 503); }
      }
      if (role === 'recovery' && url.pathname.startsWith('/api/reserve/')) {
        try { return secured(await reserveHandler(env, trusted).handler(request)); }
        catch { return json({ error: 'STORE_UNAVAILABLE' }, 503); }
      }
      if (request.method !== 'GET') return json({ error: 'METHOD_BLOCKED' }, 405);
      if (url.pathname === '/api/config') {
        if (role === 'recovery') {
          try { reserveHandler(env, trusted); } catch { return json({ error: 'STORE_CONFIGURATION_UNAVAILABLE' }, 503); }
        }
        return json({
          hosted: true, synthetic: false, physicalEnabled: true, role,
          originalOrigin: trusted.primaryOrigin, recoveryOrigin: trusted.recoveryOrigin,
          config: workReserveConfig(trusted), expiresAt: trusted.expiresAt,
        });
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/rpc' || url.pathname.startsWith('/rpc/') || url.pathname === '/control' || url.pathname.startsWith('/control/')) return json({ error: 'ROUTE_UNAVAILABLE' }, 404);
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (!Object.hasOwn(assets, path)) return json({ error: 'NOT_FOUND' }, 404);
      const asset = assets[path];
      try {
        if (!asset || typeof asset.base64 !== 'string' || typeof asset.contentType !== 'string') throw new Error('ASSET_INVALID');
        const bytes = Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0));
        return new Response(bytes, { headers: { ...security, 'content-type': asset.contentType } });
      } catch { return json({ error: 'ASSET_UNAVAILABLE' }, 503); }
    },
  });
}
