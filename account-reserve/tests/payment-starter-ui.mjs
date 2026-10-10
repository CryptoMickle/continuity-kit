import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mountPaymentStarter, showPaymentStarterError } from '../payment-starter/page.mjs';

const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((done, failed) => { resolve = done; reject = failed; }); return { promise, resolve, reject }; }

test('configuration response validation aborts the fetch before opening any body reader or credential path', async () => {
  const source = (await readFile(new URL('../payment-starter/main.mjs', import.meta.url), 'utf8')).replace(/^import .+;\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('document', 'window', 'location', 'fetch', 'showPaymentStarterError', 'parsePaymentStarterProfile', 'checkPaymentStarterEnvironment', 'createReserveHttpStore', 'createPaymentActions', 'recoverReserve', 'mountPaymentStarter', source);
  for (const invalid of [{ status: 503 }, { redirected: true }, { length: 'not-a-length' }, { length: '16385' }]) {
    let fetched = 0, shown = 0, readers = 0, signal;
    const forbidden = () => { assert.fail('configuration failure must not reach parsing, account recovery or client construction'); };
    const root = {};
    await run({ getElementById: () => root }, { addEventListener() {} }, { href: 'https://reserve.example.test/', origin: 'https://reserve.example.test' }, async (url, options) => {
      fetched++; signal = options.signal;
      assert.equal(url.href, 'https://reserve.example.test/payment-config.json');
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      return { status: invalid.status ?? 200, redirected: invalid.redirected ?? false, headers: { get: () => invalid.length ?? null }, body: { getReader() { readers++; assert.fail('invalid response body must not be read'); } } };
    }, target => { assert.equal(target, root); shown++; }, forbidden, forbidden, forbidden, forbidden, forbidden, forbidden);
    assert.equal(fetched, 1); assert.equal(shown, 1); assert.equal(readers, 0);
    assert.equal(signal.aborted, true, 'invalid response connections must not outlive the error panel');
  }
});

function fixture(t, changes = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://reserve.example.test/' });
  const root = dom.window.document.getElementById('app');
  const profile = { payment: { chainId: 10143, address: '0x' + '2'.repeat(40), owner: '0x' + '3'.repeat(40), expiresAt: new Date(Date.now() + 3600000).toISOString(), claims: [{ rightId: 1n, amount: 10n ** 16n }, { rightId: 2n, amount: 2n * 10n ** 16n }] }, ...changes };
  const counts = { availability: 0, open: 0, collect: 0, check: 0, close: 0, dispose: 0, select: 0 };
  const behavior = {}, state = { selectedRightId: 1n, availability: undefined, canOpen: false, isOpen: false, isBusy: false, authenticationPending: false, accountBlocked: false, unscopedAccountBlock: false, unresolvedPayments: [], payment: undefined };
  const intervals = new Set();
  const setInterval = dom.window.setInterval.bind(dom.window), clearInterval = dom.window.clearInterval.bind(dom.window);
  dom.window.setInterval = (...args) => { const id = setInterval(...args); intervals.add(id); return id; };
  dom.window.clearInterval = id => { intervals.delete(id); clearInterval(id); };
  const observation = (status = 'funded', reason) => ({ status, ...(reason ? { reason } : {}), rightId: state.selectedRightId });
  const resetSession = () => Object.assign(state, { canOpen: false, isOpen: false, isBusy: false, authenticationPending: false, availability: undefined });
  const actions = {
    approvedPayments: profile.payment.claims,
    get state() { return Object.freeze({ ...state, unresolvedPayments: Object.freeze([...state.unresolvedPayments]) }); },
    select(id) { counts.select++; resetSession(); state.selectedRightId = id; state.payment = undefined; return this.state; },
    refreshAvailability() {
      counts.availability++; state.isBusy = true;
      if (behavior.availability) return behavior.availability();
      state.availability = observation(); state.canOpen = true; state.isBusy = false; return Promise.resolve(state.availability);
    },
    open() {
      counts.open++; state.canOpen = false; state.availability = undefined; state.isBusy = true; state.authenticationPending = true;
      if (behavior.open) return behavior.open();
      Object.assign(state, { isBusy: false, authenticationPending: false, isOpen: true });
      return Promise.resolve({ owner: profile.payment.owner });
    },
    collect() {
      counts.collect++; state.isBusy = true;
      if (behavior.collect) return behavior.collect();
      resetSession(); state.payment = { confirmed: true, unresolved: false, hash: '0x' + '1'.repeat(64) };
      return Promise.resolve({ hash: state.payment.hash, receipt: { status: 'success' } });
    },
    check() { counts.check++; if (behavior.check) return behavior.check(); return Promise.reject(Object.assign(new Error('private provider detail'), { code: 'PAYMENT_TRANSACTION_MISSING' })); },
    close() { counts.close++; resetSession(); },
    dispose() { counts.dispose++; resetSession(); },
  };
  const mounted = mountPaymentStarter(root, { profile, actions, window: dom.window });
  t.after(() => { mounted.dispose(); dom.window.close(); });
  return { dom, root, profile, counts, behavior, state, actions, observation, intervals, mounted, $: id => root.querySelector('#' + id),
    select(id) { const control = root.querySelector('#payment-right'); control.value = String(id); control.dispatchEvent(new dom.window.Event('change')); },
    async funded() { root.querySelector('#availability').click(); await tick(); },
  };
}

test('mounted starter is inert and shows the approved amount, beneficiary, contract and fee before collection', t => {
  const f = fixture(t);
  assert.deepEqual(f.counts, { availability: 0, open: 0, collect: 0, check: 0, close: 0, dispose: 0, select: 0 });
  assert.equal(f.$('payment-right').value, '1');
  assert.equal(f.$('payment-amount').textContent, '0.01 test-MON');
  assert.equal(f.$('payment-owner').textContent, f.profile.payment.owner);
  assert.equal(f.$('payment-contract').textContent, f.profile.payment.address);
  assert.equal(f.$('payment-fee').textContent, '0.06 test-MON');
  assert.equal(f.$('open').disabled, true); assert.equal(f.$('collect').disabled, true);
  assert.equal(f.$('payment-status').dataset.state, 'idle');
  assert.equal(f.$('payment-status').getAttribute('aria-live'), 'polite');
});

test('explicit check, synchronous native open and separate collection are three distinct actions', async t => {
  const f = fixture(t); await f.funded();
  assert.equal(f.counts.availability, 1); assert.equal(f.counts.open, 0); assert.equal(f.$('open').disabled, false);
  f.$('open').click(); assert.equal(f.counts.open, 1, 'native helper invocation stays in the click stack');
  await tick(); assert.equal(f.counts.collect, 0); assert.equal(f.$('collect').disabled, false);
  assert.equal(f.dom.window.document.activeElement, f.$('collect'));
  f.$('collect').click(); await tick();
  assert.equal(f.counts.collect, 1); assert.equal(f.$('payment-title').textContent, 'Payment received.');
  assert.equal(f.$('payment-status').dataset.state, 'confirmed');
  assert.equal(f.$('payment-hash').textContent, '0x' + '1'.repeat(64));
  assert.equal(f.$('open').disabled, true); assert.equal(f.$('collect').disabled, true);
});

test('selected payment changes locally without an availability call or authentication', async t => {
  const f = fixture(t); await f.funded();
  f.select(2n);
  assert.equal(f.counts.select, 1); assert.equal(f.counts.availability, 1); assert.equal(f.counts.open, 0);
  assert.equal(f.$('payment-amount').textContent, '0.02 test-MON'); assert.equal(f.$('open').disabled, true);
  assert.equal(f.$('payment-status').dataset.state, 'idle');
});

for (const result of ['success', 'failure']) test(`late availability ${result} never replaces the selected payment state`, async t => {
  const old = deferred(), f = fixture(t); f.behavior.availability = () => old.promise;
  f.$('availability').click(); assert.equal(f.$('close').disabled, false);
  f.select(2n); f.behavior.availability = undefined; await f.funded();
  if (result === 'success') old.resolve({ status: 'already-collected', rightId: 1n });
  else old.reject(Object.assign(new Error('<img src=x onerror=alert(1)>'), { code: 'RAW_PRIVATE_ERROR' }));
  await tick(); assert.equal(f.$('payment-right').value, '2');
  assert.equal(f.$('payment-status').dataset.state, 'funded'); assert.equal(f.$('open').disabled, false);
  assert.equal(f.root.textContent.includes('RAW_PRIVATE_ERROR'), false); assert.equal(f.root.querySelector('img'), null);
});

test('native opening and read checks keep cancellation available; canceled result cannot reopen the view', async t => {
  const pending = deferred(), f = fixture(t); f.behavior.open = () => pending.promise;
  await f.funded(); f.$('open').click();
  assert.equal(f.$('close').disabled, false); assert.equal(f.$('close').textContent, 'Cancel opening');
  f.$('close').click(); assert.equal(f.counts.close, 1);
  pending.resolve({ owner: f.profile.payment.owner }); await tick();
  assert.equal(f.$('collect').disabled, true); assert.equal(f.$('payment-status').dataset.state, 'idle');
  assert.equal(f.counts.collect, 0);
});

test('an in-flight claim locks selection and duplicate click handlers until the attempt settles', async t => {
  const pending = deferred(), f = fixture(t); f.behavior.collect = () => pending.promise;
  await f.funded(); f.$('open').click(); await tick(); f.$('collect').click(); f.$('collect').click();
  assert.equal(f.counts.collect, 1); assert.equal(f.$('payment-right').disabled, true);
  f.select(2n); assert.equal(f.counts.select, 0); assert.equal(f.$('payment-right').value, '1');
  Object.assign(f.state, { isOpen: false, isBusy: false, payment: { hash: '0x' + '1'.repeat(64), confirmed: false, unresolved: true }, accountBlocked: true, unresolvedPayments: [1n] });
  pending.resolve({ hash: f.state.payment.hash }); await tick();
  assert.equal(f.$('payment-status').dataset.state, 'pending'); assert.equal(f.$('payment-right').disabled, false);
  assert.equal(f.$('open').disabled, true); assert.equal(f.$('collect').disabled, true); assert.equal(f.$('check').disabled, false);
  assert.match(f.$('unresolved').textContent, /1/);
});

test('late defensive account block renders even when the old operation no longer owns the screen', async t => {
  const pending = deferred(), f = fixture(t);
  f.behavior.check = () => { f.state.isBusy = true; return pending.promise; };
  f.$('check').click(); f.select(2n); await f.funded();
  Object.assign(f.state, { accountBlocked: true, unresolvedPayments: [1n], canOpen: false });
  pending.reject(Object.assign(new Error('closed'), { code: 'PAYMENT_SESSION_CLOSED' })); await tick();
  assert.equal(f.$('payment-right').value, '2'); assert.equal(f.$('payment-status').dataset.state, 'pending');
  assert.equal(f.$('open').disabled, true); assert.match(f.$('unresolved').textContent, /1/);
});

test('collected and unavailable observations are separate from a verified receipt', async t => {
  const f = fixture(t);
  for (const [status, reason, kind] of [['already-collected', undefined, 'collected'], ['not-available', 'not-issued', 'unavailable']]) {
    f.behavior.availability = () => {
      Object.assign(f.state, { isBusy: false, canOpen: false, availability: f.observation(status, reason) });
      return Promise.resolve(f.state.availability);
    };
    f.$('availability').click(); await tick();
    assert.equal(f.$('payment-status').dataset.state, kind); assert.equal(f.$('payment-receipt').hidden, true);
    assert.equal(f.$('open').disabled, true); assert.equal(f.counts.open, 0);
  }
});

test('status errors never render provider details or error-controlled HTML', async t => {
  const f = fixture(t); f.$('check').click(); await tick();
  assert.equal(f.$('payment-status').dataset.state, 'error');
  assert.match(f.$('payment-status').textContent, /No transaction is recorded/);
  assert.equal(f.root.textContent.includes('private provider detail'), false);
  f.behavior.check = () => Promise.reject({ code: '<img src=x onerror=alert(1)>', message: 'secret' });
  f.$('check').click(); await tick(); assert.equal(f.root.querySelector('img'), null); assert.equal(f.root.textContent.includes('secret'), false);
});

test('dynamic profile and transaction fields use literal text rather than HTML', async t => {
  const attack = '<img src=x onerror=alert(1)>', original = fixture(t);
  original.profile.payment.owner = attack; original.profile.payment.address = attack;
  const otherRoot = original.dom.window.document.createElement('div'); original.root.after(otherRoot);
  const page = mountPaymentStarter(otherRoot, { profile: original.profile, actions: original.actions, window: original.dom.window });
  t.after(() => page.dispose());
  assert.equal(otherRoot.querySelector('#payment-owner').textContent, attack); assert.equal(otherRoot.querySelector('img'), null);
  original.state.payment = { confirmed: false, unresolved: true, hash: attack };
  original.dom.window.dispatchEvent(new original.dom.window.Event('focus'));
  assert.equal(otherRoot.querySelector('#payment-hash').textContent, attack); assert.equal(otherRoot.querySelector('img'), null);
});

test('focus refreshes expired readiness and closes an expired profile session without a network call', async t => {
  const f = fixture(t); await f.funded(); f.state.canOpen = false;
  f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));
  assert.equal(f.$('payment-status').dataset.state, 'stale'); assert.equal(f.$('open').disabled, true);
  f.state.isOpen = true;
  const expires = Date.parse(f.profile.payment.expiresAt); t.mock.method(Date, 'now', () => expires + 1);
  f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  assert.equal(f.counts.close, 1); assert.equal(f.$('payment-status').dataset.state, 'expired'); assert.equal(f.counts.availability, 1);
  f.dom.window.dispatchEvent(new f.dom.window.Event('focus')); assert.equal(f.counts.close, 1);
});

test('pagehide disposes the helper, clears render timers and ignores late async work', async t => {
  const pending = deferred(), f = fixture(t); f.behavior.availability = () => pending.promise;
  f.$('availability').click(); assert.equal(f.intervals.size, 1);
  f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));
  assert.equal(f.intervals.size, 0); assert.equal(f.counts.dispose, 1); assert.equal(f.$('payment-status').dataset.state, 'closed');
  pending.resolve({ status: 'funded' }); await tick();
  assert.equal(f.$('open').disabled, true); assert.equal(f.$('payment-status').dataset.state, 'closed');
  f.mounted.dispose(); assert.equal(f.counts.dispose, 1);
});

test('unconfigured panel gives fixed setup guidance and contains no interactive credential action', t => {
  const f = fixture(t); f.mounted.dispose(); showPaymentStarterError(f.root);
  assert.match(f.root.textContent, /exact recovery origin/); assert.match(f.root.textContent, /generated README/);
  assert.match(f.root.textContent, /No passkey or transaction was requested/); assert.equal(f.root.querySelector('button'), null);
});
