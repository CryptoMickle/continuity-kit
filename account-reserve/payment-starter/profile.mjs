import { checkReserveEnvironment } from '@continuitykit/account-reserve/preflight';
import { createTestnetPaymentAvailability } from '@continuitykit/account-reserve/payments';

const PROFILE_FIELDS = ['version', 'originalOrigin', 'recoveryOrigin', 'reserve', 'storeBasePath', 'payment'];
const RESERVE_FIELDS = ['appId', 'originalRpId', 'recoveryRpId', 'derivation'];
const PAYMENT_FIELDS = ['chainId', 'address', 'owner', 'issuer', 'expectedRuntimeCodeHash', 'expiresAt', 'claims'];
const normalizedProfiles = new WeakSet();
export const MAX_PAYMENT_STARTER_PROFILE_BYTES = 16384;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireValue = (value, code = 'PAYMENT_STARTER_PROFILE_INVALID') => { if (!value) fail(code); };

function record(input, fields) {
  try {
    requireValue(input && typeof input === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(input)));
    const keys = Reflect.ownKeys(input);
    requireValue(keys.length === fields.length && keys.every(key => fields.includes(key)));
    return Object.fromEntries(fields.map(key => {
      const field = Object.getOwnPropertyDescriptor(input, key);
      requireValue(field?.enumerable && Object.hasOwn(field, 'value'));
      return [key, field.value];
    }));
  } catch { fail('PAYMENT_STARTER_PROFILE_INVALID'); }
}
function claimsArray(input) {
  try {
    requireValue(Array.isArray(input));
    const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
    requireValue(Number.isInteger(length) && length >= 1 && length <= 8 && Reflect.ownKeys(input).length === length + 1);
    return Array.from({ length }, (_, index) => {
      const field = Object.getOwnPropertyDescriptor(input, String(index));
      requireValue(field?.enumerable && Object.hasOwn(field, 'value'));
      return field.value;
    });
  } catch { fail('PAYMENT_STARTER_PROFILE_INVALID'); }
}
function exactOrigin(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 300);
  let parsed;
  try { parsed = new URL(value); } catch { fail('PAYMENT_STARTER_PROFILE_INVALID'); }
  const local = parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost');
  requireValue((parsed.protocol === 'https:' || parsed.protocol === 'http:' && local) && parsed.origin === value &&
    !parsed.username && !parsed.password && !parsed.hostname.endsWith('.'));
  return parsed;
}
function decimal(value) {
  requireValue(typeof value === 'string' && value.length <= 78 && /^[1-9][0-9]*$/.test(value));
  const integer = BigInt(value);
  requireValue(integer.toString() === value && integer < 2n ** 256n);
  return integer;
}

/** Validate public JSON only. Previously returned frozen profiles can be reused;
 * arbitrary inputs must use canonical decimal strings for IDs and amounts.
 * The public SDK factory is constructed solely for static payment validation.
 * No credential, journal, Web Lock or network operation is performed.
 */
export function validatePaymentStarterProfile(input) {
  if (normalizedProfiles.has(input)) return input;
  try {
    const profile = record(input, PROFILE_FIELDS);
    requireValue(profile.version === 1);
    const original = exactOrigin(profile.originalOrigin), recovery = exactOrigin(profile.recoveryOrigin);
    requireValue(original.hostname !== recovery.hostname);
    const reserve = record(profile.reserve, RESERVE_FIELDS);
    requireValue(reserve.originalRpId === original.hostname && reserve.recoveryRpId === recovery.hostname);
    requireValue(typeof reserve.appId === 'string' && typeof reserve.derivation === 'string' &&
      !/[\r\n]/.test(reserve.appId + reserve.derivation));
    const preflight = checkReserveEnvironment({ config: reserve, role: 'recovery',
      originalOrigin: profile.originalOrigin, recoveryOrigin: profile.recoveryOrigin,
      environment: { origin: profile.recoveryOrigin, isSecureContext: true } });
    requireValue(preflight.checks.filter(item => ['config', 'role', 'origins', 'rp-origin-binding', 'current-origin', 'secure-context'].includes(item.id)).every(item => item.status === 'pass'));
    requireValue(typeof profile.storeBasePath === 'string' && profile.storeBasePath.length <= 256 &&
      /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(profile.storeBasePath) && !/[\r\n]/.test(profile.storeBasePath));
    const payment = record(profile.payment, PAYMENT_FIELDS);
    requireValue(payment.chainId === 10143);
    requireValue(typeof payment.expectedRuntimeCodeHash === 'string' && payment.expectedRuntimeCodeHash.length === 66);
    payment.claims = Object.freeze(claimsArray(payment.claims).map(inputClaim => {
      const claim = record(inputClaim, ['rightId', 'amount', 'nonce']);
      return Object.freeze({ rightId: decimal(claim.rightId), amount: decimal(claim.amount), nonce: claim.nonce });
    }));
    // Canonical ISO time and all monetary/nonce/address/runtime limits remain the
    // installed SDK's policy. Expiry does not invalidate historical read access.
    createTestnetPaymentAvailability({ profile: payment });
    const result = Object.freeze({ ...profile, reserve: Object.freeze(reserve), payment: Object.freeze(payment) });
    normalizedProfiles.add(result);
    return result;
  } catch { fail('PAYMENT_STARTER_PROFILE_INVALID'); }
}

/** Return a fresh JSON-safe public object; never include sessions or capabilities. */
export function serializePaymentStarterProfile(input) {
  const profile = validatePaymentStarterProfile(input);
  return { ...profile, reserve: { ...profile.reserve }, payment: { ...profile.payment,
    claims: profile.payment.claims.map(({ rightId, amount, nonce }) => ({ rightId: rightId.toString(), amount: amount.toString(), nonce })) } };
}

/** Reject duplicate keys, including escaped aliases, before interpreting policy. */
export function parsePaymentStarterProfile(text) {
  requireValue(typeof text === 'string' && text.length > 0 && text.length <= MAX_PAYMENT_STARTER_PROFILE_BYTES &&
    new TextEncoder().encode(text).length <= MAX_PAYMENT_STARTER_PROFILE_BYTES);
  let value;
  try {
    value = JSON.parse(text);
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
        while (after < text.length && /\s/.test(text[after])) after++;
        if (text[after] === ':') {
          const key = JSON.parse(text.slice(start, index + 1)), keys = stack.at(-1);
          requireValue(keys && !keys.has(key)); keys.add(key);
        }
      }
    }
  } catch { fail('PAYMENT_STARTER_PROFILE_INVALID'); }
  return validatePaymentStarterProfile(value);
}

/** In real browser clients omit environment: the SDK reads the actual page's
 * origin and API availability. Injected snapshots are static test data only.
 * A passing result never establishes credential/PRF support or live storage.
 */
export function checkPaymentStarterEnvironment(input, environment) {
  const profile = validatePaymentStarterProfile(input);
  const report = checkReserveEnvironment({ config: profile.reserve, role: 'recovery',
    originalOrigin: profile.originalOrigin, recoveryOrigin: profile.recoveryOrigin,
    ...(environment === undefined ? {} : { environment }) });
  const required = ['config', 'role', 'origins', 'rp-origin-binding', 'current-origin', 'secure-context', 'transport-apis'];
  const recoveryOnly = ['web-crypto', 'webauthn-api'];
  const readOnlyOk = required.every(id => report.checks.some(check => check.id === id && check.status === 'pass'))
    && report.checks.every(check => check.status !== 'fail' || recoveryOnly.includes(check.id));
  return Object.freeze({ ...report, readOnlyOk });
}
