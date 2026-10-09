// This isolated client accepts native self-service environments only.
const fail = (code = 'UI_CONFIG_INVALID') => { throw Object.assign(new Error(code), { code }); };
const check = value => { if (!value) fail(); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail(); }
  check(url.origin === value && !url.username && !url.password && !url.port && url.protocol === 'https:'
    && /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]+$/.test(url.hostname)
    && !url.hostname.endsWith('.localhost') && url.hostname !== 'localhost');
  return url;
}
export function validateEnvironment(env, href, now = Date.now()) {
  check(Number.isFinite(now));
  check(exact(env, ['hosted', 'physicalEnabled', 'synthetic', 'selfService', 'fictionalOnly', 'role', 'config', 'originalOrigin', 'recoveryOrigin', 'expiresAt', 'limits']));
  check(env.hosted === true && env.physicalEnabled === true && env.synthetic === false && env.selfService === true && env.fictionalOnly === true);
  check(['primary', 'recovery'].includes(env.role));
  check(exact(env.config, ['appId', 'derivation', 'originalRpId', 'recoveryRpId']));
  check(env.config.appId === 'continuity-judge-work-v1' && env.config.derivation === 'demo-existing-eoa:v1');
  const a = origin(env.originalOrigin), b = origin(env.recoveryOrigin);
  let current; try { current = new URL(href); } catch { fail(); }
  check(a.hostname !== b.hostname && current.origin === (env.role === 'primary' ? a.origin : b.origin));
  check(!current.username && !current.password && env.config.originalRpId === a.hostname && env.config.recoveryRpId === b.hostname);
  check(typeof env.expiresAt === 'string');
  const expiresAtMs = Date.parse(env.expiresAt);
  check(Number.isFinite(expiresAtMs) && new Date(expiresAtMs).toISOString() === env.expiresAt);
  if (expiresAtMs <= now) fail('DEMO_EXPIRED');
  check(expiresAtMs - now <= 45 * 86400000);
  check(exact(env.limits, ['maxRecords', 'maxRecordBytes', 'maxIssuedCapabilities', 'capabilityTtlMs']));
  check(env.limits.maxRecords === 64 && env.limits.maxRecordBytes === 65536
    && env.limits.maxIssuedCapabilities === 256 && env.limits.capabilityTtlMs === 300000);
  return Object.freeze({ primary: env.role === 'primary', expiresAtMs });
}
export function validateCapability(value, demoExpiresAtMs, { requestStartedMs, responseReceivedMs } = {}) {
  if (!exact(value, ['enrollmentToken', 'expiresAt', 'serverNow']) || typeof value.enrollmentToken !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value.enrollmentToken) || typeof value.expiresAt !== 'string') fail('CAPABILITY_INVALID');
  let bytes;
  try { bytes = atob(value.enrollmentToken.replaceAll('-', '+').replaceAll('_', '/') + '='); } catch { fail('CAPABILITY_INVALID'); }
  if (bytes.length !== 32 || btoa(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== value.enrollmentToken) fail('CAPABILITY_INVALID');
  const expiry = Date.parse(value.expiresAt), serverNow = Date.parse(value.serverNow);
  if (!Number.isFinite(expiry) || !Number.isFinite(serverNow) || !Number.isFinite(demoExpiresAtMs)
    || new Date(expiry).toISOString() !== value.expiresAt || new Date(serverNow).toISOString() !== value.serverNow
    || expiry > demoExpiresAtMs || expiry <= serverNow || expiry - serverNow > 5 * 60000) fail('CAPABILITY_LIFETIME_INVALID');
  // D1 enforces the actual expiry. Subtract the entire request/body round trip
  // conservatively; a device's wall clock must not invalidate a fresh grant.
  if (!Number.isFinite(requestStartedMs) || !Number.isFinite(responseReceivedMs)
    || requestStartedMs < 0 || responseReceivedMs < requestStartedMs) fail('CAPABILITY_LIFETIME_INVALID');
  const until = requestStartedMs + (expiry - serverNow);
  if (!Number.isFinite(until)) fail('CAPABILITY_LIFETIME_INVALID');
  if (until <= responseReceivedMs) fail('CAPABILITY_EXPIRED');
  return Object.freeze({ token: value.enrollmentToken, until });
}
