import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPaymentActions } from '../integrations/payment-client/actions.mjs';

const code = expected => error => error?.code === expected;
const fail = value => Object.assign(new Error(value), { code: value });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
function profile() {
  return { chainId: 10143, address: '0x1111111111111111111111111111111111111111', owner: '0x3333333333333333333333333333333333333333',
    issuer: '0x2222222222222222222222222222222222222222', expectedRuntimeCodeHash: '0x' + '4'.repeat(64),
    expiresAt: new Date(Date.now() + 3600000).toISOString(), claims: [{ rightId: 1n, amount: 10n ** 16n, nonce: 0 }, { rightId: 2n, amount: 2n * 10n ** 16n, nonce: 1 }] };
}

// Only this test substitutes the public module import. The real helper body is
// evaluated unchanged and receives no production injection option. The real
// public import is independently exercised by the first test below; crypto/RPC
// behavior belongs to the installed consumer and local EVM integration suites.
const source = await readFile(new URL('../integrations/payment-client/actions.mjs', import.meta.url), 'utf8');
const importPattern = /^import \{([^}]+)\} from '@continuitykit\/account-reserve\/payments';\n/m;
const importMatch = source.match(importPattern);
assert.ok(importMatch, 'helper must retain its public package import');
const publicNames = importMatch[1].split(',').map(name => name.trim());
const factoryNames = ['createTestnetPaymentAvailability', 'createTestnetPaymentClient', 'createTestnetPaymentReader'];
assert.deepEqual([...publicNames].sort(), factoryNames.sort());
const controlledFactory = new Function('factories', source.replace(importPattern, `const {${publicNames.join(',')}} = factories;\n`).replace('export function createPaymentActions', 'function createPaymentActions') + '\nreturn createPaymentActions;');

function fixture(t, changes = {}) {
  const originalProfile = profile(), lifetimeTarget = new EventTarget();
  const counts = { opens: 0, closes: 0, clientCreates: 0, readerCreates: 0, availabilityCreates: 0, availability: [], claims: [], checks: [], clientCloses: 0, executorCloses: 0, network: 0 };
  const behavior = {}, sessions = [], capturedProfiles = [];
  function recovered() {
    const result = { owner: originalProfile.owner, account: { address: originalProfile.owner }, closed: false,
      close() { counts.closes++; result.closed = true; } };
    sessions.push(result);
    return result;
  }
  function funded(rightId, captured = originalProfile) {
    const intent = captured.claims.find(claim => claim.rightId === rightId);
    return Object.freeze({ chainId: captured.chainId, contract: captured.address, beneficiary: captured.owner, rightId, amount: intent.amount, readOnly: true, paymentVerified: false, status: 'funded', observedAt: new Date().toISOString(), blockNumber: 100n, blockHash: '0x' + '5'.repeat(64) });
  }
  const factories = {
    createTestnetPaymentAvailability({ profile: captured }) {
      counts.availabilityCreates++; capturedProfiles.push(captured);
      return { check({ rightId }) { counts.availability.push(rightId); return behavior.availability ? behavior.availability(rightId, captured) : Promise.resolve(funded(rightId, captured)); } };
    },
    createTestnetPaymentClient({ profile: captured, recovered: session }) {
      counts.clientCreates++; capturedProfiles.push(captured);
      if (session.owner !== captured.owner) throw fail('PAYMENT_SIGNER_MISMATCH');
      return { forRight(rightId) {
        if (!captured.claims.some(claim => claim.rightId === rightId)) throw fail('PAYMENT_NOT_APPROVED');
        return { get hash() { return behavior.hash; }, close() { counts.executorCloses++; },
          claim() { counts.claims.push(rightId); return behavior.claim ? behavior.claim(rightId) : Promise.resolve({ hash: '0x' + '1'.repeat(64), receipt: { status: 'success' } }); } };
      }, close() { counts.clientCloses++; session.close(); } };
    },
    createTestnetPaymentReader({ profile: captured }) {
      counts.readerCreates++; capturedProfiles.push(captured);
      return { check(rightId) { counts.checks.push(rightId); return behavior.check ? behavior.check(rightId) : Promise.reject(fail('PAYMENT_TRANSACTION_MISSING')); } };
    },
  };
  t.mock.method(globalThis, 'fetch', async () => { counts.network++; throw Error('PUBLIC_NETWORK_FORBIDDEN'); });
  const options = { profile: originalProfile, lifetimeTarget, openExistingAccount: options => {
    counts.opens++; return behavior.open ? behavior.open(options) : Promise.resolve(recovered());
  }, ...changes };
  const actions = controlledFactory(factories)(options);
  t.after(() => actions.dispose());
  return { actions, counts, originalProfile, lifetimeTarget, behavior, sessions, capturedProfiles, recovered, funded,
    ready: () => actions.refreshAvailability(), outcome: (rightId = 1n) => ({ hash: '0x' + String(rightId).repeat(64), receipt: { status: 'success' } }) };
}

test('real public helper construction and selection are inert; storage and locks remain untouched', async t => {
  const counts = { network: 0, open: 0, storage: 0, locks: 0 };
  t.mock.method(globalThis, 'fetch', async () => { counts.network++; throw Error('PUBLIC_NETWORK_FORBIDDEN'); });
  const storage = Object.defineProperties({}, Object.fromEntries(['getItem', 'setItem'].map(name => [name, { get() { counts.storage++; throw Error('STORAGE_NOT_ALLOWED'); } }])));
  const locks = Object.defineProperty({}, 'request', { get() { counts.locks++; throw Error('LOCKS_NOT_ALLOWED'); } });
  const actions = createPaymentActions({ profile: profile(), storage, locks, lifetimeTarget: new EventTarget(), openExistingAccount() { counts.open++; throw Error('NATIVE_NOT_ALLOWED'); } });
  t.after(() => actions.dispose());
  assert.equal(actions.selectedRightId, 1n);
  actions.select(2n);
  await assert.rejects(actions.open(), code('PAYMENT_AVAILABILITY_REQUIRED'));
  assert.deepEqual(counts, { network: 0, open: 0, storage: 0, locks: 0 });
});

test('state and approved payments are frozen, default first payment, explicit funded read precedes synchronous native call', async t => {
  const f = fixture(t);
  assert.equal(f.actions.selectedRightId, 1n); assert.equal(f.actions.state.selectedRightId, 1n);
  assert.ok(Object.isFrozen(f.actions.state)); assert.ok(Object.isFrozen(f.actions.approvedPayments));
  assert.ok(Object.isFrozen(f.actions.state.unresolvedPayments));
  assert.equal(f.counts.readerCreates, 0); assert.equal(f.counts.availabilityCreates, 1);
  await assert.rejects(f.actions.open(), code('PAYMENT_AVAILABILITY_REQUIRED'));
  assert.equal(f.counts.opens, 0);
  const observation = await f.ready();
  assert.equal(observation.status, 'funded'); assert.equal(f.actions.canOpen, true);
  const opening = f.actions.open();
  assert.equal(f.counts.opens, 1, 'native callback must run synchronously in the caller click stack');
  assert.equal(f.actions.state.authenticationPending, true);
  await opening;
  assert.equal(f.actions.isOpen, true); assert.equal(f.actions.isBusy, false);
  assert.equal(f.actions.state.availability, undefined); assert.equal(f.actions.canOpen, false);
  assert.equal(f.counts.claims.length, 0); assert.equal(f.counts.network, 0);
  f.actions.close(); assert.equal(f.counts.closes, 1);
});

test('selection validates approved bigint without requests and closes an old signer', async t => {
  const f = fixture(t); await f.ready(); await f.actions.open();
  assert.throws(() => f.actions.select('2'), code('PAYMENT_NOT_APPROVED'));
  assert.throws(() => f.actions.select(3n), code('PAYMENT_NOT_APPROVED'));
  const readCount = f.counts.availability.length;
  const selected = f.actions.select(2n);
  assert.equal(selected.selectedRightId, 2n); assert.equal(f.actions.selectedRightId, 2n);
  assert.equal(f.actions.state.availability, undefined); assert.equal(f.actions.canOpen, false);
  assert.equal(f.counts.availability.length, readCount); assert.equal(f.counts.closes, 1);
  await assert.rejects(f.actions.open(), code('PAYMENT_AVAILABILITY_REQUIRED'));
});

test('unfunded, collected and expired observations never open an account', async t => {
  const f = fixture(t);
  for (const observation of [{ status: 'not-available', reason: 'not-issued' }, { status: 'already-collected' }, { status: 'not-available', reason: 'expired' }]) {
    f.behavior.availability = rightId => Promise.resolve({ ...f.funded(rightId), ...observation });
    await f.ready(); assert.equal(f.actions.canOpen, false);
    await assert.rejects(f.actions.open(), code('PAYMENT_AVAILABILITY_REQUIRED'));
  }
  assert.equal(f.counts.opens, 0);
});

test('readiness is bounded by monotonic elapsed time despite wall-clock rollback', async t => {
  let time = 0;
  t.mock.method(globalThis.performance, 'now', () => time);
  const f = fixture(t, { readinessMs: 30 }); await f.ready();
  assert.equal(f.actions.canOpen, true);
  const wall = Date.now(); t.mock.method(Date, 'now', () => wall - 3600000); time = 31;
  assert.equal(f.actions.canOpen, false);
  await assert.rejects(f.actions.open(), code('PAYMENT_AVAILABILITY_REQUIRED'));
  assert.equal(f.counts.opens, 0);
});

test('profile expiry invalidates funded readiness before a native call', async t => {
  const f = fixture(t); await f.ready();
  t.mock.method(Date, 'now', () => Date.parse(f.originalProfile.expiresAt) + 1);
  assert.equal(f.actions.canOpen, false);
  await assert.rejects(f.actions.open(), error => ['PAYMENT_AVAILABILITY_REQUIRED', 'PAYMENT_PROFILE_EXPIRED'].includes(error.code));
  assert.equal(f.counts.opens, 0);
});

for (const late of ['resolve', 'reject']) test(`old availability ${late} cannot replace a newer selected result`, async t => {
  const old = deferred(), f = fixture(t);
  f.behavior.availability = rightId => rightId === 1n ? old.promise : Promise.resolve(f.funded(rightId));
  const first = f.actions.refreshAvailability(); const rejected = assert.rejects(first, code('PAYMENT_SESSION_CLOSED'));
  f.actions.select(2n); await f.ready();
  const newer = f.actions.state.availability;
  if (late === 'resolve') old.resolve(f.funded(1n)); else old.reject(fail('PROVIDER_FAILURE'));
  await rejected;
  assert.equal(f.actions.selectedRightId, 2n); assert.deepEqual(f.actions.state.availability, newer);
  assert.equal(f.actions.canOpen, true); assert.equal(f.actions.isBusy, false);
});

test('canceled native opening blocks parallel authentication but not new read-only readiness', async t => {
  const pending = deferred(), f = fixture(t); let signal;
  f.behavior.open = options => { signal = options.signal; return pending.promise; };
  await f.ready(); const opening = f.actions.open(); const rejected = assert.rejects(opening, code('PAYMENT_SESSION_CLOSED'));
  f.actions.select(2n); assert.equal(signal.aborted, true);
  await f.ready(); assert.equal(f.actions.state.authenticationPending, true); assert.equal(f.actions.isBusy, true);
  await assert.rejects(f.actions.open(), code('PAYMENT_ACTION_BUSY'));
  assert.equal(f.counts.opens, 1);
  const late = f.recovered(); pending.resolve(late); await rejected;
  assert.equal(late.closed, true); assert.equal(f.counts.clientCreates, 0);
  assert.equal(f.actions.selectedRightId, 2n); assert.equal(f.actions.canOpen, true);
  assert.equal(f.actions.isBusy, false); assert.equal(f.actions.state.authenticationPending, false);
});

test('old native rejection and finally cannot clear a newer receipt operation', async t => {
  const native = deferred(), receipt = deferred(), f = fixture(t);
  f.behavior.open = () => native.promise; f.behavior.check = () => receipt.promise;
  await f.ready(); const opening = f.actions.open(); const rejected = assert.rejects(opening, code('PAYMENT_SESSION_CLOSED'));
  f.actions.select(2n); const checking = f.actions.check();
  native.reject(fail('NATIVE_CANCELED')); await rejected;
  assert.equal(f.actions.isBusy, true); assert.equal(f.actions.selectedRightId, 2n);
  receipt.resolve(f.outcome(2n)); await checking;
  assert.equal(f.actions.isBusy, false); assert.equal(f.actions.isOpen, false);
});

test('selection and close invalidate old receipt results before they can confirm a new payment', async t => {
  const old = deferred(), f = fixture(t); f.behavior.check = () => old.promise;
  const checking = f.actions.check(); const rejected = assert.rejects(checking, code('PAYMENT_SESSION_CLOSED'));
  f.actions.select(2n); await f.ready(); old.resolve(f.outcome(1n)); await rejected;
  assert.equal(f.actions.selectedRightId, 2n); assert.equal(f.actions.state.payment?.confirmed ?? false, false);
  assert.equal(f.actions.canOpen, true);
});

test('collection locks selection until settled and always ends its signing session', async t => {
  const pending = deferred(), f = fixture(t); f.behavior.claim = () => pending.promise;
  await f.ready(); await f.actions.open(); const collecting = f.actions.collect();
  assert.throws(() => f.actions.select(2n), code('PAYMENT_ACTION_BUSY'));
  await assert.rejects(f.actions.refreshAvailability(), code('PAYMENT_ACTION_BUSY'));
  assert.equal(f.actions.selectedRightId, 1n);
  pending.resolve(f.outcome(1n)); await collecting;
  assert.equal(f.actions.isOpen, false); assert.equal(f.actions.isBusy, false);
  assert.equal(f.counts.closes, 1); assert.deepEqual(f.counts.claims, [1n]);
  assert.equal(f.actions.state.payment.confirmed, true); assert.equal(f.actions.state.accountBlocked, false);
});

test('approved selection mismatch and unknown intent close signer without a claim', async t => {
  const f = fixture(t); await f.ready(); await f.actions.open();
  await assert.rejects(f.actions.collect(2n), code('PAYMENT_SELECTION_MISMATCH'));
  assert.equal(f.counts.closes, 1); assert.equal(f.counts.claims.length, 0);
  await f.ready(); await f.actions.open();
  await assert.rejects(f.actions.collect(3n), code('PAYMENT_NOT_APPROVED'));
  assert.equal(f.counts.closes, 2); assert.equal(f.counts.claims.length, 0);
});

test('unknown send blocks every selection until its own exact receipt is reconciled', async t => {
  const f = fixture(t); f.behavior.hash = '0x' + '1'.repeat(64);
  f.behavior.claim = () => Promise.reject(fail('PAYMENT_BROADCAST_UNKNOWN'));
  await f.ready(); await f.actions.open();
  await assert.rejects(f.actions.collect(), code('PAYMENT_BROADCAST_UNKNOWN'));
  assert.equal(f.counts.closes, 1); assert.equal(f.actions.state.accountBlocked, true);
  assert.deepEqual(f.actions.state.unresolvedPayments, [1n]);
  f.actions.select(2n); await f.ready();
  await assert.rejects(f.actions.open(), code('PAYMENT_ACCOUNT_BLOCKED'));
  f.behavior.check = rightId => Promise.resolve(f.outcome(rightId));
  await f.actions.check(2n); assert.equal(f.actions.state.accountBlocked, true);
  f.behavior.check = () => Promise.reject(fail('PAYMENT_TRANSACTION_MISSING'));
  await assert.rejects(f.actions.check(1n), code('PAYMENT_TRANSACTION_MISSING'));
  assert.equal(f.actions.state.accountBlocked, true);
  f.behavior.check = () => Promise.resolve({ hash: '0x' + '1'.repeat(64) });
  await f.actions.check(1n); assert.equal(f.actions.state.accountBlocked, true);
  f.behavior.check = () => Promise.resolve(f.outcome(1n));
  await f.actions.check(1n); assert.equal(f.actions.state.accountBlocked, false);
  assert.deepEqual(f.actions.state.unresolvedPayments, []); assert.equal(f.counts.opens, 1);
});

test('no-hash reservation uncertainty survives selection, close and an unrelated successful receipt', async t => {
  const f = fixture(t); f.behavior.claim = () => Promise.reject(fail('PAYMENT_RECONCILIATION_REQUIRED'));
  await f.ready(); await f.actions.open();
  await assert.rejects(f.actions.collect(), code('PAYMENT_RECONCILIATION_REQUIRED'));
  assert.equal(f.actions.state.accountBlocked, true); assert.deepEqual(f.actions.state.unresolvedPayments, [1n]);
  f.actions.close(); f.actions.select(2n); f.behavior.check = () => Promise.resolve(f.outcome(2n));
  await f.actions.check(2n); await f.ready();
  await assert.rejects(f.actions.open(), code('PAYMENT_ACCOUNT_BLOCKED'));
  assert.equal(f.counts.opens, 1); assert.equal(f.actions.state.accountBlocked, true);
});

for (const journalCode of ['PAYMENT_JOURNAL_INVALID', 'PAYMENT_JOURNAL_CONFLICT', 'PAYMENT_INTENT_MISMATCH']) test(`${journalCode} creates an unscoped blocker that another receipt cannot clear`, async t => {
  const f = fixture(t); f.behavior.check = () => Promise.reject(fail(journalCode));
  await assert.rejects(f.actions.check(1n), code(journalCode));
  assert.equal(f.actions.state.unscopedAccountBlock, true); assert.equal(f.actions.state.accountBlocked, true);
  f.actions.select(2n); f.behavior.check = () => Promise.resolve(f.outcome(2n)); await f.actions.check(2n);
  await f.ready(); await assert.rejects(f.actions.open(), code('PAYMENT_ACCOUNT_BLOCKED'));
  assert.equal(f.actions.state.unscopedAccountBlock, true); assert.equal(f.counts.opens, 0);
});

test('checking is lazy, closes an existing signer and never authenticates again', async t => {
  const f = fixture(t); await f.ready(); await f.actions.open(); assert.equal(f.counts.readerCreates, 0);
  await assert.rejects(f.actions.check(), code('PAYMENT_TRANSACTION_MISSING'));
  assert.equal(f.counts.readerCreates, 1); assert.equal(f.counts.closes, 1); assert.equal(f.counts.opens, 1);
  assert.equal(f.actions.state.availability, undefined); assert.equal(f.actions.isOpen, false);
});

test('pagehide permanently closes the helper and closes late recovered material', async t => {
  const pending = deferred(), f = fixture(t); f.behavior.open = () => pending.promise;
  await f.ready(); const opening = f.actions.open(); const rejected = assert.rejects(opening, code('PAYMENT_SESSION_CLOSED'));
  f.lifetimeTarget.dispatchEvent(new Event('pagehide'));
  const late = f.recovered(); pending.resolve(late); await rejected;
  assert.equal(late.closed, true); assert.equal(f.counts.clientCreates, 0);
  await assert.rejects(f.actions.open(), code('PAYMENT_ACTIONS_DISPOSED'));
  await assert.rejects(f.actions.refreshAvailability(), code('PAYMENT_ACTIONS_DISPOSED'));
  assert.throws(() => f.actions.select(2n), code('PAYMENT_ACTIONS_DISPOSED'));
});

test('idle session deadline closes signer and requires fresh readiness', async t => {
  const f = fixture(t, { sessionMs: 15 }); await f.ready(); await f.actions.open();
  await delay(30); assert.equal(f.actions.isOpen, false); assert.equal(f.counts.closes, 1);
  await assert.rejects(f.actions.open(), code('PAYMENT_AVAILABILITY_REQUIRED'));
});

test('late native result is closed after monotonic session deadline even if the timer has not run', async t => {
  let time = 0;
  t.mock.method(globalThis.performance, 'now', () => time);
  const pending = deferred(), f = fixture(t, { sessionMs: 20 });
  f.behavior.open = () => pending.promise;
  await f.ready(); const opening = f.actions.open(); const rejected = assert.rejects(opening, code('PAYMENT_SESSION_CLOSED'));
  time = 21; const late = f.recovered(); pending.resolve(late); await rejected;
  assert.equal(late.closed, true); assert.equal(f.counts.clientCreates, 0); assert.equal(f.actions.isOpen, false);
});

test('collect refuses an expired monotonic session before a delayed timer can fire', async t => {
  let time = 0;
  t.mock.method(globalThis.performance, 'now', () => time);
  const f = fixture(t, { sessionMs: 20 }); await f.ready(); await f.actions.open();
  time = 21;
  await assert.rejects(f.actions.collect(), code('PAYMENT_SESSION_CLOSED'));
  assert.equal(f.counts.closes, 1); assert.equal(f.counts.claims.length, 0); assert.equal(f.actions.isOpen, false);
});

test('absolute profile expiry during authentication closes material without waiting for timers', async t => {
  const pending = deferred(), f = fixture(t); f.behavior.open = () => pending.promise;
  await f.ready(); const opening = f.actions.open(); const rejected = assert.rejects(opening, code('PAYMENT_SESSION_CLOSED'));
  const expires = Date.parse(f.originalProfile.expiresAt);
  t.mock.method(Date, 'now', () => expires + 1);
  const late = f.recovered(); pending.resolve(late); await rejected;
  assert.equal(late.closed, true); assert.equal(f.counts.clientCreates, 0);
});

for (const outcome of ['pending', 'reserved', 'journal-invalid']) test(`late canceled ${outcome} receipt check preserves its defensive blocker across selection`, async t => {
  const pending = deferred(), f = fixture(t); f.behavior.check = () => pending.promise;
  const checking = f.actions.check(1n), rejected = assert.rejects(checking, code('PAYMENT_SESSION_CLOSED'));
  f.actions.select(2n); await f.ready(); assert.equal(f.actions.canOpen, true);
  if (outcome === 'pending') pending.resolve({ hash: '0x' + '1'.repeat(64) });
  else pending.reject(fail(outcome === 'reserved' ? 'PAYMENT_RECONCILIATION_REQUIRED' : 'PAYMENT_JOURNAL_INVALID'));
  await rejected;
  assert.equal(f.actions.selectedRightId, 2n); assert.equal(f.actions.state.accountBlocked, true);
  assert.equal(f.actions.isBusy, false); assert.equal(f.actions.canOpen, false);
  if (outcome === 'journal-invalid') assert.equal(f.actions.state.unscopedAccountBlock, true);
  else assert.deepEqual(f.actions.state.unresolvedPayments, [1n]);
  await assert.rejects(f.actions.open(), code('PAYMENT_ACCOUNT_BLOCKED'));
  assert.equal(f.counts.opens, 0);
});

test('late canceled successful receipt cannot silently release an existing uncertain payment', async t => {
  const pending = deferred(), f = fixture(t); f.behavior.claim = () => Promise.reject(fail('PAYMENT_RECONCILIATION_REQUIRED'));
  await f.ready(); await f.actions.open(); await assert.rejects(f.actions.collect(), code('PAYMENT_RECONCILIATION_REQUIRED'));
  f.behavior.check = () => pending.promise;
  const checking = f.actions.check(1n), rejected = assert.rejects(checking, code('PAYMENT_SESSION_CLOSED'));
  f.actions.select(2n); await f.ready(); pending.resolve(f.outcome(1n)); await rejected;
  assert.equal(f.actions.state.accountBlocked, true); assert.deepEqual(f.actions.state.unresolvedPayments, [1n]);
  f.behavior.check = () => Promise.resolve(f.outcome(1n)); await f.actions.check(1n);
  assert.equal(f.actions.state.accountBlocked, false); assert.deepEqual(f.actions.state.unresolvedPayments, []);
});

test('late journal corruption creates an account block even when the selected old right was confirmed', async t => {
  const pending = deferred(), f = fixture(t); f.behavior.check = () => Promise.resolve(f.outcome(1n));
  await f.actions.check(1n); assert.equal(f.actions.state.payment.confirmed, true);
  f.behavior.check = () => pending.promise;
  const checking = f.actions.check(1n), rejected = assert.rejects(checking, code('PAYMENT_SESSION_CLOSED'));
  f.actions.select(2n); await f.ready(); pending.reject(fail('PAYMENT_JOURNAL_CONFLICT')); await rejected;
  assert.equal(f.actions.state.accountBlocked, true); assert.equal(f.actions.state.unscopedAccountBlock, true);
  f.actions.select(1n); assert.equal(f.actions.state.payment.confirmed, true);
});

test('caller profile mutation during authentication cannot change captured policy', async t => {
  const pending = deferred(), f = fixture(t); f.behavior.open = () => pending.promise;
  await f.ready(); const session = f.recovered(), opening = f.actions.open();
  f.originalProfile.owner = f.originalProfile.issuer; f.originalProfile.claims[0].rightId = 9n; f.originalProfile.expiresAt = '2000-01-01T00:00:00.000Z';
  pending.resolve(session); await opening;
  assert.equal(f.actions.selectedRightId, 1n);
  await assert.rejects(f.actions.collect(9n), code('PAYMENT_NOT_APPROVED'));
  assert.equal(f.counts.closes, 1); assert.equal(f.counts.claims.length, 0);
  assert.ok(f.capturedProfiles.every(value => Object.isFrozen(value) && Object.isFrozen(value.claims)));
});

test('client construction failure closes returned session and invalidates readiness', async t => {
  const f = fixture(t); f.behavior.open = () => Promise.resolve({ ...f.recovered(), owner: f.originalProfile.issuer });
  await f.ready(); await assert.rejects(f.actions.open(), code('PAYMENT_SIGNER_MISMATCH'));
  assert.equal(f.counts.closes, 1); assert.equal(f.actions.isOpen, false); assert.equal(f.actions.isBusy, false); assert.equal(f.actions.canOpen, false);
});

test('readiness option rejects values outside the bounded window', t => {
  for (const readinessMs of [0, -1, 30001, NaN, Infinity, 1.5, '30']) {
    assert.throws(() => fixture(t, { readinessMs }), code('PAYMENT_ACTION_OPTIONS_INVALID'));
  }
});
