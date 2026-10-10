import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPaymentActions } from '../integrations/payment-client/actions.mjs';

const code = expected => error => error.code === expected;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, change = {}) {
  const account = privateKeyToAccount(generatePrivateKey()), lifetimeTarget = new EventTarget(), values = new Map();
  const counts = { opens: 0, closes: 0, network: 0, signatures: 0 };
  const profile = { chainId: 10143, address: '0x1111111111111111111111111111111111111111', owner: account.address,
    issuer: '0x2222222222222222222222222222222222222222', expectedRuntimeCodeHash: '0x' + '3'.repeat(64),
    expiresAt: new Date(Date.now() + 3600000).toISOString(), claims: [{ rightId: 1n, amount: 10n ** 16n, nonce: 0 }] };
  const recovered = { owner: account.address, account: { ...account, async signTransaction() { counts.signatures++; throw Error('SIGNING_FORBIDDEN'); } }, close() { counts.closes++; } };
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const locks = { async request(name, _options, callback) { return callback({ name, mode: 'exclusive' }); } };
  t.mock.method(globalThis, 'fetch', async () => { counts.network++; throw Error('PUBLIC_NETWORK_FORBIDDEN'); });
  const options = { profile, storage, locks, lifetimeTarget, openExistingAccount: async () => { counts.opens++; return recovered; }, ...change };
  const actions = createPaymentActions(options); t.after(() => actions.dispose());
  return { actions, counts, profile, recovered, lifetimeTarget };
}

test('copyable helper opens only on request and never collects implicitly', async t => {
  const f = fixture(t);
  assert.deepEqual(f.counts, { opens: 0, closes: 0, network: 0, signatures: 0 });
  assert.equal((await f.actions.open()).owner, f.profile.owner);
  assert.equal(f.actions.isOpen, true); assert.equal(f.actions.isBusy, false);
  assert.equal(f.counts.network, 0); assert.equal(f.counts.signatures, 0);
  f.actions.close(); assert.equal(f.counts.closes, 1); assert.equal(f.actions.isOpen, false);
});

test('cancel closes late authentication instead of installing a signer', async t => {
  const pending = deferred(); let signal;
  const f = fixture(t, { openExistingAccount: options => { signal = options.signal; return pending.promise; } });
  const opening = f.actions.open();
  await assert.rejects(f.actions.open(), code('PAYMENT_ACTION_BUSY'));
  f.actions.close(); assert.equal(signal.aborted, true);
  pending.resolve(f.recovered);
  await assert.rejects(opening, code('PAYMENT_SESSION_CLOSED'));
  assert.equal(f.counts.closes, 1); assert.equal(f.actions.isOpen, false); assert.equal(f.actions.isBusy, false);
});

test('unknown right fails before networking and closes the parent signer', async t => {
  const f = fixture(t); await f.actions.open();
  await assert.rejects(f.actions.collect(2n), code('PAYMENT_NOT_APPROVED'));
  assert.equal(f.counts.closes, 1); assert.equal(f.counts.network, 0); assert.equal(f.counts.signatures, 0);
  assert.equal(f.actions.isOpen, false); assert.equal(f.actions.isBusy, false);
  await assert.rejects(f.actions.collect(1n), code('PAYMENT_SESSION_CLOSED'));
});

test('receipt checking closes an open signer and needs no new authentication', async t => {
  const f = fixture(t); await f.actions.open();
  await assert.rejects(f.actions.check(1n), code('PAYMENT_TRANSACTION_MISSING'));
  assert.equal(f.counts.opens, 1); assert.equal(f.counts.closes, 1); assert.equal(f.counts.signatures, 0);
  assert.equal(f.actions.isOpen, false); assert.equal(f.counts.network, 0);
});

test('page exit closes immediately and prevents another opening', async t => {
  const f = fixture(t); await f.actions.open(); f.lifetimeTarget.dispatchEvent(new Event('pagehide'));
  assert.equal(f.counts.closes, 1); assert.equal(f.actions.isOpen, false);
  await assert.rejects(f.actions.open(), code('PAYMENT_ACTIONS_DISPOSED'));
  f.lifetimeTarget.dispatchEvent(new Event('pagehide')); assert.equal(f.counts.closes, 1);
});

test('session deadline closes an idle signer without network activity', async t => {
  const closed = deferred(), f = fixture(t, { sessionMs: 15 });
  f.recovered.close = () => { f.counts.closes++; closed.resolve(); };
  await f.actions.open();
  await Promise.race([closed.promise, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(Error('SIGNER_NOT_CLOSED')), 1000); timer.unref(); })]);
  assert.equal(f.actions.isOpen, false); assert.equal(f.counts.closes, 1); assert.equal(f.counts.network, 0);
});

test('caller profile mutation during authentication cannot change captured policy', async t => {
  const pending = deferred(), f = fixture(t, { openExistingAccount: () => pending.promise });
  const opening = f.actions.open();
  f.profile.owner = f.profile.issuer; f.profile.claims[0].rightId = 2n; f.profile.expiresAt = '2000-01-01T00:00:00.000Z';
  pending.resolve(f.recovered); await opening;
  // The original owner and unapproved second right were captured before open.
  await assert.rejects(f.actions.collect(2n), code('PAYMENT_NOT_APPROVED'));
  assert.equal(f.counts.closes, 1); assert.equal(f.counts.network, 0);
});

test('construction failure after recovery closes the returned account', async t => {
  const f = fixture(t); f.recovered.owner = f.profile.issuer;
  await assert.rejects(f.actions.open(), code('PAYMENT_SIGNER_MISMATCH'));
  assert.equal(f.counts.closes, 1); assert.equal(f.actions.isOpen, false); assert.equal(f.actions.isBusy, false);
});
