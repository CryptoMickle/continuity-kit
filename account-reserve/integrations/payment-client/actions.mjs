import { createTestnetPaymentClient, createTestnetPaymentReader, createTestnetPaymentAvailability } from '@continuitykit/account-reserve/payments';

const fail = code => Object.assign(new Error(code), { code });
const errorCode = error => { try { return Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value; } catch { return undefined; } };
const reservationErrors = new Set(['PAYMENT_RECONCILIATION_REQUIRED', 'PAYMENT_PREPARATION_FAILED', 'PAYMENT_SIGNING_FAILED',
  'PAYMENT_TRANSACTION_MISMATCH', 'PAYMENT_SIGNED_TRANSACTION_INVALID', 'PAYMENT_SIGNED_OWNER_MISMATCH',
  'PAYMENT_STORE_READBACK_FAILED', 'PAYMENT_STORE_UNAVAILABLE', 'PAYMENT_SESSION_CLOSED']);
const accountErrors = new Set(['PAYMENT_ACCOUNT_BLOCKED', 'PAYMENT_JOURNAL_INVALID', 'PAYMENT_JOURNAL_CONFLICT', 'PAYMENT_INTENT_MISMATCH']);

// Copyable integration example, not an authenticator or a new wallet. The host
// supplies its deliberate existing-account recovery action. No work starts here.
export function createPaymentActions({ profile, openExistingAccount, storage, locks, lifetimeTarget = globalThis.window,
  sessionMs = 300000, readinessMs = 30000 }) {
  if (typeof openExistingAccount !== 'function' || !Number.isInteger(sessionMs) || sessionMs < 1 || sessionMs > 300000 ||
      !Number.isInteger(readinessMs) || readinessMs < 1 || readinessMs > 30000 ||
      typeof lifetimeTarget?.addEventListener !== 'function' || typeof lifetimeTarget?.removeEventListener !== 'function') throw fail('PAYMENT_ACTION_OPTIONS_INVALID');
  const capturedProfile = structuredClone(profile);
  // Validate without touching a credential, journal, Web Lock or network.
  const availabilityReader = createTestnetPaymentAvailability({ profile: capturedProfile });
  capturedProfile.claims.forEach(Object.freeze);
  Object.freeze(capturedProfile.claims); Object.freeze(capturedProfile);
  const options = { profile: capturedProfile, ...(storage ? { storage } : {}), ...(locks ? { locks } : {}) };
  const expires = Date.parse(capturedProfile.expiresAt), states = new Map();
  let selected = capturedProfile.claims[0].rightId, client, executor, openedRight, timer, sessionUntil = 0;
  let generation = 0, readOperation, authenticationPending, claimPending, disposed = false;
  let observation, readyUntil = 0, unscopedAccountBlock = false;
  const alive = () => { if (disposed) throw fail('PAYMENT_ACTIONS_DISPOSED'); };
  const approved = rightId => { if (!capturedProfile.claims.some(c => c.rightId === rightId)) throw fail('PAYMENT_NOT_APPROVED'); return rightId; };
  const blocked = () => unscopedAccountBlock || [...states.values()].some(s => s.unresolved);
  const fresh = () => readyUntil > 0 && performance.now() < readyUntil && Date.now() < expires;
  const busy = () => !!(readOperation || authenticationPending || claimPending);
  const canOpen = () => !disposed && !busy() && !client && !blocked() && !states.get(selected)?.confirmed && fresh();
  const state = () => Object.freeze({ selectedRightId: selected, availability: observation, canOpen: canOpen(),
    isOpen: !!client, isBusy: busy(), authenticationPending: !!authenticationPending, accountBlocked: blocked(),
    unscopedAccountBlock, unresolvedPayments: Object.freeze([...states].filter(([, s]) => s.unresolved).map(([id]) => id)),
    payment: states.get(selected) });
  function close() {
    generation++;
    observation = undefined; readyUntil = 0; readOperation = undefined;
    authenticationPending?.controller.abort();
    clearTimeout(timer); timer = undefined; sessionUntil = 0;
    const current = client; client = executor = openedRight = undefined;
    current?.close();
    // A native prompt or started claim remains pending until its own promise ends.
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetimeTarget.removeEventListener('pagehide', dispose);
    close();
  }
  function readAllowed() {
    alive();
    if (claimPending || readOperation || authenticationPending && !authenticationPending.controller.signal.aborted) throw fail('PAYMENT_ACTION_BUSY');
  }
  function remember(rightId, result) {
    if (!result?.hash) throw fail('PAYMENT_RESULT_INVALID');
    states.set(rightId, Object.freeze({ hash: result.hash, confirmed: !!result.receipt, unresolved: !result.receipt }));
  }
  function rememberError(rightId, error, claimAttempt = false, hash) {
    const code = errorCode(error);
    if (accountErrors.has(code)) unscopedAccountBlock = true;
    if (hash || code === 'PAYMENT_RECONCILIATION_REQUIRED' || claimAttempt && reservationErrors.has(code)) {
      states.set(rightId, Object.freeze({ hash: hash ?? states.get(rightId)?.hash, confirmed: false, unresolved: true }));
    }
  }
  lifetimeTarget.addEventListener('pagehide', dispose);
  return Object.freeze({
    select(rightId) {
      alive(); if (claimPending) throw fail('PAYMENT_ACTION_BUSY');
      approved(rightId);
      if (rightId !== selected) { close(); selected = rightId; }
      return state();
    },
    async refreshAvailability() {
      readAllowed(); close();
      const token = { generation, rightId: selected }; readOperation = token;
      try {
        const result = await availabilityReader.check({ rightId: token.rightId });
        if (disposed || token.generation !== generation) throw fail('PAYMENT_SESSION_CLOSED');
        const intent = capturedProfile.claims.find(c => c.rightId === token.rightId);
        const equal = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
        if (!result || result.rightId !== token.rightId || result.amount !== intent.amount || result.chainId !== capturedProfile.chainId ||
            !equal(result.beneficiary, capturedProfile.owner) || !equal(result.contract, capturedProfile.address) ||
            result.readOnly !== true || result.paymentVerified !== false || !['funded', 'already-collected', 'not-available'].includes(result.status)) throw fail('PAYMENT_AVAILABILITY_RESULT_INVALID');
        observation = result;
        readyUntil = result.status === 'funded' && Date.now() < expires ? performance.now() + readinessMs : 0;
        return result;
      } catch (error) {
        if (disposed || token.generation !== generation) throw fail('PAYMENT_SESSION_CLOSED');
        throw error;
      } finally { if (readOperation === token) readOperation = undefined; }
    },
    async open() {
      alive(); if (busy()) throw fail('PAYMENT_ACTION_BUSY');
      if (blocked()) throw fail('PAYMENT_ACCOUNT_BLOCKED');
      if (!fresh() || states.get(selected)?.confirmed) throw fail('PAYMENT_AVAILABILITY_REQUIRED');
      close();
      const token = { generation, rightId: selected, controller: new AbortController(), deadline: performance.now() + sessionMs }; authenticationPending = token;
      let recovered, created;
      timer = setTimeout(close, Math.min(sessionMs, Math.max(0, expires - Date.now())));
      try {
        // Intentionally no await before invoking the host's native callback.
        recovered = await openExistingAccount({ signal: token.controller.signal });
        if (disposed || token.generation !== generation || token.controller.signal.aborted || performance.now() >= token.deadline || Date.now() >= expires) throw fail('PAYMENT_SESSION_CLOSED');
        created = createTestnetPaymentClient({ ...options, recovered });
        const openedExecutor = created.forRight(token.rightId);
        client = created; executor = openedExecutor; openedRight = token.rightId; sessionUntil = token.deadline;
        const owner = recovered.owner;
        recovered = created = undefined; // Client now owns the signing session.
        return Object.freeze({ owner, rightId: token.rightId });
      } catch (error) {
        const stale = disposed || token.generation !== generation || token.controller.signal.aborted;
        if (!stale) { rememberError(token.rightId, error); close(); }
        if (stale) throw fail('PAYMENT_SESSION_CLOSED');
        throw error;
      } finally {
        try { if (created) created.close(); else recovered?.close(); }
        finally { if (authenticationPending === token) authenticationPending = undefined; }
      }
    },
    async collect(rightId = selected) {
      alive(); if (busy()) throw fail('PAYMENT_ACTION_BUSY');
      try { approved(rightId); if (rightId !== selected) throw fail('PAYMENT_SELECTION_MISMATCH'); }
      catch (error) { close(); throw error; }
      if (blocked()) { close(); throw fail('PAYMENT_ACCOUNT_BLOCKED'); }
      if (!client || !executor || openedRight !== rightId) throw fail('PAYMENT_SESSION_CLOSED');
      if (performance.now() >= sessionUntil || Date.now() >= expires) { close(); throw fail('PAYMENT_SESSION_CLOSED'); }
      const token = { generation, rightId, executor }; claimPending = token;
      try {
        const result = await token.executor.claim();
        // Preserve the actual claim result even if the user closed the view.
        remember(rightId, result);
        if (disposed || token.generation !== generation) throw fail('PAYMENT_SESSION_CLOSED');
        return result;
      } catch (error) {
        // A successful receipt already recorded above is never downgraded by UI cancellation.
        if (!states.get(rightId)?.confirmed) rememberError(rightId, error, true, token.executor.hash);
        throw error;
      } finally {
        try { if (token.generation === generation) close(); }
        finally { if (claimPending === token) claimPending = undefined; }
      }
    },
    async check(rightId = selected) {
      readAllowed(); approved(rightId); close();
      const token = { generation, rightId }; readOperation = token;
      try {
        // Journal access is needed only for explicit reconciliation, not readiness.
        const result = await createTestnetPaymentReader(options).check(rightId);
        if (disposed || token.generation !== generation) {
          // Cancel display, not a known safety fact. A late pending result belongs
          // to its captured right; a late successful read never clears a blocker.
          if (!disposed && result?.hash && !result.receipt && !states.get(rightId)?.confirmed) remember(rightId, result);
          throw fail('PAYMENT_SESSION_CLOSED');
        }
        remember(rightId, result);
        return result;
      } catch (error) {
        if (disposed || token.generation !== generation) {
          if (!disposed && (!states.get(rightId)?.confirmed || accountErrors.has(errorCode(error)))) rememberError(rightId, error);
          throw fail('PAYMENT_SESSION_CLOSED');
        }
        rememberError(rightId, error);
        throw error;
      } finally { if (readOperation === token) readOperation = undefined; }
    },
    close, dispose,
    get state() { return state(); },
    get selectedRightId() { return selected; },
    get approvedPayments() { return capturedProfile.claims; },
    get canOpen() { return canOpen(); },
    get isOpen() { return !!client; },
    get isBusy() { return busy(); },
  });
}
