// Public configuration checks only. This module never calls WebAuthn or storage.
const HOSTED_APP_ID = 'continuity-private-work-v1';
const HOSTED_DERIVATION = 'demo-existing-eoa:v1';
const LOCAL_APP_ID = 'private-work-example-v1';
const LOCAL_DERIVATION = 'example:synthetic-work:v1';
const MAX_LIFETIME_MS = 45 * 24 * 60 * 60 * 1000;
const CONFIG_FIELDS = ['appId', 'originalRpId', 'recoveryRpId', 'derivation'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function fail(code = 'UI_CONFIG_INVALID') { const error = new Error(code); error.code = code; throw error; }
function check(value) { if (!value) fail(); }
function exactKeys(value, keys) { check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')); }
function origin(value) {
  let result;
  try { result = new URL(value); } catch { fail(); }
  check(result.origin === value && !result.username && !result.password && result.pathname === '/' && !result.search && !result.hash);
  return result;
}
function local(url) { return url.protocol === 'http:' && ['work-primary.localhost', 'work-reserve.localhost'].includes(url.hostname) && /^\d+$/.test(url.port) && Number(url.port) >= 1024 && Number(url.port) <= 65535; }
function publicHttps(url) { return url.protocol === 'https:' && !url.port && !url.hostname.endsWith('.localhost') && url.hostname !== 'localhost' && !/^[\d.]+$/.test(url.hostname) && /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]+$/.test(url.hostname); }

export function validateWorkClientEnvironment(env, locationHref, now = Date.now(), hostedOnly = false) {
  check(Number.isFinite(now) && env && typeof env === 'object' && ['primary', 'recovery'].includes(env.role));
  const primary = env.role === 'primary';
  const hosted = env.hosted === true && env.synthetic === false && env.physicalEnabled === true;
  const synthetic = env.synthetic === true && !own(env, 'hosted') && !own(env, 'physicalEnabled') && !own(env, 'expiresAt');
  check(hosted !== synthetic);
  check(typeof hostedOnly === 'boolean' && (!hostedOnly || hosted));
  exactKeys(env, hosted ? ['hosted', 'synthetic', 'physicalEnabled', 'role', 'originalOrigin', 'recoveryOrigin', 'config', 'expiresAt'] : ['synthetic', 'role', 'originalOrigin', 'recoveryOrigin', 'config', ...(!primary && own(env, 'enrollmentToken') ? ['enrollmentToken'] : [])]);
  exactKeys(env.config, CONFIG_FIELDS);
  const original = origin(env.originalOrigin), recovery = origin(env.recoveryOrigin);
  let current;
  try { current = new URL(locationHref); } catch { fail(); }
  check(!current.username && !current.password && current.origin === (primary ? original.origin : recovery.origin));
  check(original.origin !== recovery.origin && original.hostname !== recovery.hostname);
  check(env.config.originalRpId === original.hostname && env.config.recoveryRpId === recovery.hostname);
  let expiresAtMs;
  if (hosted) {
    check(publicHttps(original) && publicHttps(recovery));
    check(env.config.appId === HOSTED_APP_ID && env.config.derivation === HOSTED_DERIVATION);
    check(typeof env.expiresAt === 'string');
    expiresAtMs = Date.parse(env.expiresAt);
    check(Number.isFinite(expiresAtMs) && new Date(expiresAtMs).toISOString() === env.expiresAt);
    if (expiresAtMs <= now) fail('DEMO_EXPIRED');
    check(expiresAtMs - now <= MAX_LIFETIME_MS);
  } else {
    check(local(original) && local(recovery) && original.hostname === 'work-primary.localhost' && recovery.hostname === 'work-reserve.localhost');
    check(env.config.appId === LOCAL_APP_ID && env.config.derivation === LOCAL_DERIVATION);
    if (own(env, 'enrollmentToken')) validateWorkEnrollmentToken(env.enrollmentToken);
  }
  return Object.freeze({ hosted, primary, expiresAtMs });
}

// A valid local token grants one store attempt. It is not a passkey or a recovery input.
export function validateWorkEnrollmentToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail('ENROLLMENT_CODE_INVALID');
  let decoded;
  try { decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='); } catch { fail('ENROLLMENT_CODE_INVALID'); }
  if (decoded.length !== 32 || btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== value) fail('ENROLLMENT_CODE_INVALID');
  return value;
}
