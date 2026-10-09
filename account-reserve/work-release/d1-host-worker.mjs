import { createWorkD1Handler, parseWorkEnrollmentTickets } from './d1-handler.mjs';
import { createWorkD1Store } from './d1-store.mjs';
import { enrollmentTicketHash } from '../release/profile.mjs';
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
async function retentionAuthorized(request, env) {
  const expected=env?.WORK_RETENTION_AUTH_HASH;
  const bearer=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization')??'');
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||!bearer)return false;
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bearer[1])));
  const actual=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  let mismatch=0;for(let i=0;i<64;i++)mismatch|=actual.charCodeAt(i)^expected.charCodeAt(i);
  return mismatch===0;
}
function secured(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(security)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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
  const result = await entry.store.checkEnrollment(hash);
  if (Date.now() >= Date.parse(trusted.expiresAt)) return json({ error: 'DEMONSTRATION_ENDED' }, 410);
  if (result === 'ready') return json({ ready: true, expiresAt: trusted.expiresAt });
  if (result === 'expired') return json({ error: 'DEMONSTRATION_ENDED' }, 410);
  if (result === 'denied') return denied();
  throw new Error('STORE_UNAVAILABLE');
}

/** An isolated hosted-work candidate. Assets/profile are build-time public data;
 * D1 is a platform binding; enrollment hashes remain runtime server configuration. */
export function createHostedD1WorkClient({ profile: supplied, role, assets = {} } = {}) {
  if (!['primary', 'recovery'].includes(role)) throw new Error('HOST_ROLE_INVALID');
  // Snapshot public data without consulting the deployment-startup clock.
  const profile = supplied && typeof supplied === 'object' ? Object.freeze({ ...supplied }) : supplied;
  if (profile?.enabled !== true) return Object.freeze({ fetch: async () => unavailable() });
  const handlers = new WeakMap();
  function reserveHandler(env, trusted) {
    const db=env?.DB, ticketText=env?.RESERVE_ENROLLMENT_TICKET_HASHES ?? '[]';
    if(!env || typeof env!=='object' || typeof ticketText!=='string')throw new Error('STORE_CONFIGURATION_INVALID');
    const cached=handlers.get(env);
    if(cached && cached.db===db && cached.ticketText===ticketText)return cached;
    const enrollmentTickets=parseWorkEnrollmentTickets(JSON.parse(ticketText));
    const storeProfile={version:1,enabled:true,releaseId:trusted.releaseId,recoveryOrigin:trusted.recoveryOrigin,expiresAt:trusted.expiresAt};
    const store=createWorkD1Store({db,profile:{releaseId:trusted.releaseId,expires:Date.parse(trusted.expiresAt)}});
    const handler=createWorkD1Handler({profile:storeProfile,allowedOrigins:[trusted.recoveryOrigin],db,enrollmentTickets});
    const entry={db,ticketText,store,handler,enrollmentTickets};handlers.set(env,entry);return entry;
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
      // A separate maintenance capability authenticates the caller. Even an authorized
      // caller cannot select the namespace, deadline or delete any unexpired record.
      if(role==='recovery' && url.pathname==='/api/retention/cleanup') {
        if(request.method!=='POST')return json({error:'METHOD_BLOCKED'},405);
        if(!(await retentionAuthorized(request,env)))return json({error:'RETENTION_REQUEST_REJECTED'},403);
        const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
        if(url.search || url.hash || (origin!==null && origin!==trusted.recoveryOrigin) || (site!==null && !['same-origin','none'].includes(site)) || request.headers.get('content-type')!=='application/json' || request.headers.has('content-encoding') || !(await emptyJsonBody(request)))return json({error:'RETENTION_REQUEST_REJECTED'},403);
        try {
          const result=await reserveHandler(env,trusted).store.cleanupExpired();
          return result.state==='not_due'?json({error:'RETENTION_NOT_DUE'},409):json({activeRecordsDeleted:true,remaining:result.remaining,purgedMs:result.purgedMs});
        }catch{return json({error:'CLEANUP_UNCONFIRMED'},503);}
      }
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
