import { createTestnetPaymentClient, createTestnetPaymentReader } from '@continuitykit/account-reserve/payments';

const fail = code => Object.assign(new Error(code), { code });

// Copyable integration example, not an authenticator or a new wallet. The host
// supplies its deliberate existing-account recovery action. No work starts here.
export function createPaymentActions({ profile, openExistingAccount, storage, locks, lifetimeTarget = globalThis.window, sessionMs = 300000 }) {
  if (typeof openExistingAccount !== 'function' || !Number.isInteger(sessionMs) || sessionMs < 1 || sessionMs > 300000 ||
      typeof lifetimeTarget?.addEventListener !== 'function' || typeof lifetimeTarget?.removeEventListener !== 'function') throw fail('PAYMENT_ACTION_OPTIONS_INVALID');
  const capturedProfile = structuredClone(profile);
  const options = { profile: capturedProfile, ...(storage ? { storage } : {}), ...(locks ? { locks } : {}) };
  const reader = createTestnetPaymentReader(options); // Validates before any passkey action.
  capturedProfile.claims.forEach(Object.freeze);
  Object.freeze(capturedProfile.claims); Object.freeze(capturedProfile);
  const expires = Date.parse(capturedProfile.expiresAt);
  let client, controller, timer, generation = 0, busy = false, disposed = false;
  const available = () => { if (disposed) throw fail('PAYMENT_ACTIONS_DISPOSED'); if (busy) throw fail('PAYMENT_ACTION_BUSY'); };
  function close() {
    generation++;
    controller?.abort(); controller = undefined;
    clearTimeout(timer); timer = undefined;
    const current = client; client = undefined;
    current?.close();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetimeTarget.removeEventListener('pagehide', dispose);
    close();
  }
  lifetimeTarget.addEventListener('pagehide', dispose);
  return Object.freeze({
    async open() {
      available(); close();
      if (expires <= Date.now()) throw fail('PAYMENT_PROFILE_EXPIRED');
      busy = true;
      const current = generation, abort = controller = new AbortController();
      let recovered;
      timer = setTimeout(close, Math.min(sessionMs, expires - Date.now()));
      try {
        recovered = await openExistingAccount({ signal: abort.signal });
        if (disposed || current !== generation || abort.signal.aborted) throw fail('PAYMENT_SESSION_CLOSED');
        client = createTestnetPaymentClient({ ...options, recovered });
        const owner = recovered.owner;
        recovered = undefined; // Client now owns the returned session's lifetime.
        return Object.freeze({ owner });
      } catch (error) {
        close(); throw error;
      } finally {
        try { recovered?.close(); }
        finally { busy = false; }
      }
    },
    async collect(rightId) {
      available();
      if (!client) throw fail('PAYMENT_SESSION_CLOSED');
      busy = true;
      try { return await client.forRight(rightId).claim(); }
      // Even a preflight failure or uncertain send ends the signing session.
      // A pending hash remains in the durable journal for credential-free check().
      finally { try { close(); } finally { busy = false; } }
    },
    async check(rightId) {
      available(); close(); busy = true;
      try { return await reader.check(rightId); }
      finally { busy = false; }
    },
    close, dispose,
    get isOpen() { return !!client; },
    get isBusy() { return busy; },
  });
}
