// Public configuration and short-lived operator capabilities only. These
// validators do not request credentials, access storage or perform network I/O.
const PROFILE_FIELDS = ['version', 'appId', 'primaryOrigin', 'recoveryOrigin', 'recoveryRpId', 'expiresAt', 'replicas'];
const GRANT_FIELDS = ['format', 'appId', 'recoveryOrigin', 'replicas'];
const GRANT_FORMAT = 'continuitykit/native-replica-grants/v1';
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REPLICA_ID = /^[a-z][a-z0-9-]{0,31}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MAX_GRANTS_BYTES = 8192;
const MAX_GRANT_LIFETIME_MS = 300000;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(value, code) { if (!value) fail(code); }
function record(input, fields, code) {
  try {
    check(input !== null && typeof input === 'object' && !Array.isArray(input), code);
    const prototype = Object.getPrototypeOf(input);
    check(prototype === Object.prototype || prototype === null, code);
    check(Object.getOwnPropertySymbols(input).length === 0, code);
    const names = Object.getOwnPropertyNames(input);
    check(names.length === fields.length && fields.every(field => names.includes(field)), code);
    const result = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, code);
      result[field] = descriptor.value;
    }
    return result;
  } catch { fail(code); }
}
function array(input, code) {
  try {
    check(Array.isArray(input), code);
    const length = Object.getOwnPropertyDescriptor(input, 'length');
    check(length && Object.hasOwn(length, 'value') && length.value >= 2 && length.value <= 3, code);
    check(Object.getOwnPropertySymbols(input).length === 0 && Object.getOwnPropertyNames(input).length === length.value + 1, code);
    const result = [];
    for (let index = 0; index < length.value; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, code);
      result.push(descriptor.value);
    }
    return result;
  } catch { fail(code); }
}
function nowValue(options) {
  try {
    const fields = options && Object.getOwnPropertyNames(options);
    const values = record(options, fields?.length ? ['now'] : [], 'NATIVE_TIME_INVALID');
    const now = Object.hasOwn(values, 'now') ? values.now : Date.now();
    check(Number.isSafeInteger(now) && now >= 0 && now <= 8640000000000000, 'NATIVE_TIME_INVALID');
    return now;
  } catch { fail('NATIVE_TIME_INVALID'); }
}
function origin(value) {
  check(typeof value === 'string' && value.length <= 2048, 'NATIVE_PROFILE_INVALID');
  let parsed;
  try { parsed = new URL(value); } catch { fail('NATIVE_PROFILE_INVALID'); }
  const local = parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname === '127.0.0.1';
  check((parsed.protocol === 'https:' || parsed.protocol === 'http:' && local)
    && parsed.origin === value && !parsed.username && !parsed.password && !parsed.hostname.endsWith('.'), 'NATIVE_PROFILE_INVALID');
  return parsed;
}
function expiry(value, now, invalidCode, expiredCode) {
  check(typeof value === 'string' && ISO_TIME.test(value), invalidCode);
  const millis = Date.parse(value);
  check(Number.isFinite(millis) && new Date(millis).toISOString() === value, invalidCode);
  check(millis > now, expiredCode);
  return millis;
}

/** Exact public profile. Copies data descriptors before reading any field;
 * origin aliases and same-host A/B ports are rejected rather than normalized.
 */
export function validateNativeProfile(input, options = {}) {
  const now = nowValue(options), value = record(input, PROFILE_FIELDS, 'NATIVE_PROFILE_INVALID');
  check(value.version === 1 && typeof value.appId === 'string' && APP_ID.test(value.appId), 'NATIVE_PROFILE_INVALID');
  const primary = origin(value.primaryOrigin), recovery = origin(value.recoveryOrigin);
  check(primary.origin !== recovery.origin && primary.hostname !== recovery.hostname, 'NATIVE_PROFILE_INVALID');
  check(typeof value.recoveryRpId === 'string' && value.recoveryRpId.length <= 253
    && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value.recoveryRpId) && value.recoveryRpId === recovery.hostname, 'NATIVE_PROFILE_INVALID');
  expiry(value.expiresAt, now, 'NATIVE_PROFILE_INVALID', 'NATIVE_PROFILE_EXPIRED');
  const ids = new Set();
  const replicas = array(value.replicas, 'NATIVE_PROFILE_INVALID').map(inputReplica => {
    const replica = record(inputReplica, ['id', 'basePath'], 'NATIVE_PROFILE_INVALID');
    check(typeof replica.id === 'string' && REPLICA_ID.test(replica.id) && !ids.has(replica.id), 'NATIVE_PROFILE_INVALID');
    ids.add(replica.id);
    check(replica.basePath === '/api/replicas/' + replica.id + '/reserve', 'NATIVE_PROFILE_INVALID');
    return Object.freeze(replica);
  });
  return Object.freeze({ ...value, replicas: Object.freeze(replicas) });
}

/** SDK configuration only; no issuer token, origin role or storage policy. */
export function nativeConfig(profile) {
  const value = validateNativeProfile(profile);
  return Object.freeze({ appId: value.appId, recoveryOrigin: value.recoveryOrigin, recoveryRpId: value.recoveryRpId });
}

/** Bind the runtime artifact to this exact page origin before offering actions.
 * Paths/query/fragment are permitted page locations; credentials and origin
 * aliases are not. Roles are deliberately only primary or recovery.
 */
export function validateNativeEnvironment(input, href, options = {}) {
  const now = nowValue(options), value = record(input, ['profile', 'role'], 'NATIVE_ENVIRONMENT_INVALID');
  check(value.role === 'primary' || value.role === 'recovery', 'NATIVE_ENVIRONMENT_INVALID');
  const profile = validateNativeProfile(value.profile, { now });
  check(typeof href === 'string' && href.length <= 8192, 'NATIVE_ENVIRONMENT_INVALID');
  let page;
  try { page = new URL(href); } catch { fail('NATIVE_ENVIRONMENT_INVALID'); }
  const expected = value.role === 'primary' ? profile.primaryOrigin : profile.recoveryOrigin;
  check(!page.username && !page.password && page.origin === expected, 'NATIVE_ORIGIN_MISMATCH');
  // Comparing the authority spelling also catches default ports, uppercase
  // hosts and numeric IP aliases before URL canonicalization hides them.
  check(href.startsWith(expected) && ['/', '?', '#', undefined].includes(href[expected.length]), 'NATIVE_ORIGIN_MISMATCH');
  return Object.freeze({ profile, role: value.role });
}

function uniqueJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { fail('NATIVE_GRANTS_INVALID'); }
  // JSON.parse alone accepts duplicate keys. Scan the already grammar-checked
  // input so escaped aliases cannot silently replace capability/context fields.
  const stack = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '{') stack.push(new Set());
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = index++;
      for (; index < text.length; index++) {
        if (text[index] === '\\') index++;
        else if (text[index] === '"') break;
      }
      let after = index + 1;
      while (/\s/.test(text[after] ?? '') && after < text.length) after++;
      if (text[after] === ':') {
        const key = JSON.parse(text.slice(start, index + 1)), keys = stack.at(-1);
        check(keys && !keys.has(key), 'NATIVE_GRANTS_INVALID'); keys.add(key);
      }
    }
  }
  return value;
}
function canonicalToken(value) {
  // 32 bytes encode as 43 base64url symbols. The final symbol's two padding
  // bits must be zero; checking them avoids decoding secrets into more buffers.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && TOKEN_ALPHABET.indexOf(value[42]) % 4 === 0;
}

/** Parse a trusted operator's short-lived capability handoff. This JSON is not
 * a signed attestation; local validation binds context and limits shape/time.
 * Tokens are returned only in this in-memory bundle, never included in errors.
 */
export function parseNativeGrants(text, suppliedProfile, options = {}) {
  const now = nowValue(options), profile = validateNativeProfile(suppliedProfile, { now });
  check(typeof text === 'string' && text.length <= MAX_GRANTS_BYTES && new TextEncoder().encode(text).length <= MAX_GRANTS_BYTES, 'NATIVE_GRANTS_INVALID');
  const value = record(uniqueJson(text), GRANT_FIELDS, 'NATIVE_GRANTS_INVALID');
  check(value.format === GRANT_FORMAT, 'NATIVE_GRANTS_INVALID');
  check(value.appId === profile.appId && value.recoveryOrigin === profile.recoveryOrigin, 'NATIVE_GRANTS_CONTEXT_MISMATCH');
  const replicas = array(value.replicas, 'NATIVE_GRANTS_INVALID'), tokens = new Set();
  check(replicas.length === profile.replicas.length, 'NATIVE_GRANTS_CONTEXT_MISMATCH');
  const copied = replicas.map((inputReplica, index) => {
    const replica = record(inputReplica, ['id', 'enrollmentToken', 'expiresAt'], 'NATIVE_GRANTS_INVALID');
    check(replica.id === profile.replicas[index].id, 'NATIVE_GRANTS_CONTEXT_MISMATCH');
    check(canonicalToken(replica.enrollmentToken) && !tokens.has(replica.enrollmentToken), 'NATIVE_GRANTS_INVALID');
    tokens.add(replica.enrollmentToken);
    const deadline = expiry(replica.expiresAt, now, 'NATIVE_GRANTS_INVALID', 'NATIVE_GRANTS_EXPIRED');
    check(deadline <= now + MAX_GRANT_LIFETIME_MS && deadline <= Date.parse(profile.expiresAt), 'NATIVE_GRANTS_INVALID');
    return Object.freeze(replica);
  });
  return Object.freeze({ ...value, replicas: Object.freeze(copied) });
}
