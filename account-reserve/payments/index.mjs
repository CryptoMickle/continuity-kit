import {
  createTestnetPaymentClient as internalClient,
  createTestnetPaymentReader as internalReader,
  createTestnetPaymentVerifier as internalVerifier,
  createTestnetPaymentAvailability as internalAvailability,
} from './testnet.mjs';

const invalid = () => Object.assign(new Error('PAYMENT_OPTIONS_INVALID'), { code: 'PAYMENT_OPTIONS_INVALID' });

// The public boundary accepts app-owned policy, signer and browser persistence.
// Transport injection remains internal to the repository's isolated tests.
function capture(input, required, optional, count) {
  try {
    if (count !== 1 || !input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw 0;
    const keys = Reflect.ownKeys(input), allowed = [...required, ...optional];
    if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) throw 0;
    const copied = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw 0;
      copied[key] = descriptor.value;
    }
    return copied;
  } catch { throw invalid(); }
}

/** Experimental fixed-Monad-testnet adapter. Construction performs no network,
 * credential or signing action. The caller owns signing-session lifetime. */
export function createTestnetPaymentClient(options) {
  return internalClient(capture(options, ['profile', 'recovered'], ['storage', 'locks'], arguments.length));
}

/** Credential-free reconciliation of an existing browser journal. Checking can
 * record a verified confirmation; it never signs or broadcasts a transaction. */
export function createTestnetPaymentReader(options) {
  return internalReader(capture(options, ['profile'], ['storage', 'locks'], arguments.length));
}

/** Verify an explicit transaction reference without a signer or local journal.
 * Construction performs no requests. Only check() reads the fixed RPCs. */
export function createTestnetPaymentVerifier(options) {
  return internalVerifier(capture(options, ['profile'], [], arguments.length));
}

/** Observe an approved right before requesting an account. No persistence or
 * authentication is used; signing still performs its own current checks. */
export function createTestnetPaymentAvailability(options) {
  return internalAvailability(capture(options, ['profile'], [], arguments.length));
}
