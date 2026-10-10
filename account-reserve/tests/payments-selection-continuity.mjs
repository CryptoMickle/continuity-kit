import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, getAddress, http } from 'viem';
import { mountPaymentPage } from '../payments/page.mjs';
import { startSequentialPaymentChain } from '../payments/harness.mjs';
import { createPaymentGuard, PAYMENT_ABI, PAYMENT_LIMITS, validatePaymentProfile } from '../payments/guard.mjs';
import { createPaymentExecutor } from '../payments/executor.mjs';
import { createBrowserPaymentPendingStore, validatePaymentPolicy } from '../payments/pending.mjs';
import { recoverReserve } from '../sdk/index.mjs';
import { makeDerivedSdkFixture } from './sdk-derived-fixture.mjs';

const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`PAYMENT_UI_WAIT_FAILED: ${description}`);
    await delay(10);
  }
}

function browserPersistence() {
  const values = new Map();
  let queue = Promise.resolve();
  return {
    values,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    locks: { request(name, options, callback) {
      assert.equal(options.mode, 'exclusive');
      const next = queue.then(() => callback({ name, mode: 'exclusive' }));
      queue = next.catch(() => {});
      return next;
    } },
  };
}

async function primaryHost() {
  let offline = false, requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(offline ? 503 : 200, { 'content-type': 'text/plain' });
    response.end(offline ? 'Original app unavailable' : 'Original app available');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, offline() { offline = true; }, requests: () => requests, close: () => new Promise(resolve => server.close(resolve)) };
}

test('reserve page collects the first selected payment after A is unavailable, using the same prepared beneficiary', { timeout: 60000 }, async t => {
  // Every network request, including the harness and viem transports, is
  // restricted to loopback. This test cannot accidentally use a public RPC.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.protocol, 'http:');
    assert.equal(url.hostname, '127.0.0.1');
    return originalFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(5000) });
  };
  let fixture, harness, primary, dom, mounted, recovered;
  const sessions = new Set(), executors = new Set();
  t.after(async () => {
    mounted?.close(); dom?.window.close();
    for (const executor of executors) executor.close();
    for (const session of sessions) session.close();
    fixture?.cleanup();
    try { await primary?.close(); } finally { try { await harness?.close(); } finally { globalThis.fetch = originalFetch; } }
  });
  fixture = await makeDerivedSdkFixture('iris');
  harness = await startSequentialPaymentChain();
  primary = await primaryHost();
  const chain = { id: 31337, name: 'Local reserve payment selection', nativeCurrency: { name: 'Synthetic test units', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: [harness.rpcUrl] } } };
  const clients = [0, 1].map(() => createPublicClient({ chain, cacheTime: 0, transport: http(harness.rpcUrl, { retryCount: 0, timeout: 5000 }) }));
  const owner = getAddress(fixture.originalAccount.address), amount = 10n ** 16n;
  const profile = validatePaymentProfile({ chainId: 31337, address: harness.contractAddress, owner, issuer: harness.issuer, expectedRuntimeCodeHash: harness.runtimeCodeHash, expiresAt: new Date(Date.now() + 3600000).toISOString(), claims: [{ rightId: 1n, amount, nonce: 0 }, { rightId: 2n, amount, nonce: 1 }] });
  const guard = createPaymentGuard({ profile, clients }), persistence = browserPersistence();
  const pendingStore = createBrowserPaymentPendingStore({ chainId: 31337, owner, storage: persistence.storage, locks: persistence.locks });
  const calls = { open: 0, broadcasts: 0, readerSign: 0, closed: 0, claim: 0, checks: 0, availability: [] };
  let lastResult;

  function executorFor(account, rightId) {
    const checked = guard.forRight(rightId);
    // The read-only adapter has no signing capability. Both operations still
    // use the actual durable executor and exact two-reader receipt guard.
    const wallet = account ? createWalletClient({ account, chain, transport: http(harness.rpcUrl, { retryCount: 0, timeout: 5000 }) }) : {
      account: { address: owner }, chain,
      prepareTransactionRequest() { calls.readerSign++; throw new Error('READ_ONLY_SIGNING_FORBIDDEN'); },
      signTransaction() { calls.readerSign++; throw new Error('READ_ONLY_SIGNING_FORBIDDEN'); },
    };
    const executor = createPaymentExecutor({ wallet, policy: checked.policy, pendingStore, publicClient: {
      getChainId: () => clients[0].getChainId(),
      sendRawTransaction: args => { assert.ok(account, 'read-only adapter cannot send'); calls.broadcasts++; return clients[0].sendRawTransaction(args); },
      getTransactionReceipt: ({ hash, policy = checked.policy }) => {
        assert.deepEqual(policy, validatePaymentPolicy(guard.policyFor(policy.rightId)));
        return guard.forRight(policy.rightId).getTransactionReceipt({ hash });
      },
    } }, checked.guards);
    executors.add(executor);
    return executor;
  }

  await fixture.prepare();
  const ciphertextBefore = fixture.store.records();
  const obligation = await harness.preparePayment(owner, { amount });
  assert.equal(obligation.id, 1n); assert.equal(obligation.beneficiary, owner);
  await harness.rpc('anvil_mine', ['0x40']);
  assert.equal((await fetch(primary.url)).status, 200);
  fixture.closeOriginal(); primary.offline();
  assert.equal((await fetch(primary.url)).status, 503);
  await assert.rejects(fixture.originalAccount.signMessage({ message: 'A is closed before the first claim' }), error => error.code === 'SESSION_ENDED');
  assert.equal((await harness.readRight(1n)).claimed, false);
  assert.equal(await clients[0].getTransactionCount({ address: owner }), 0);
  const primaryRequestsBefore = primary.requests(), authBefore = fixture.stats(), writesBefore = fixture.store.calls.put;
  const balanceBefore = await clients[0].getBalance({ address: owner });

  dom = new JSDOM('<div id="app"></div>', { url: `http://${fixture.config.recoveryRpId}/payments/` });
  const root = dom.window.document.getElementById('app'), $ = id => root.querySelector('#' + id);
  mounted = mountPaymentPage(root, {
    role: 'recovery', profile, window: dom.window,
    openAccount: async ({ signal }) => {
      calls.open++;
      assert.equal(primary.requests(), primaryRequestsBefore);
      recovered = await recoverReserve({ config: fixture.config, signal, webAuthnClient: fixture.newRecoveryClient(), store: { get: locator => fixture.store.get(locator) } });
      sessions.add(recovered);
      assert.equal(getAddress(recovered.owner), owner);
      return recovered;
    },
    createAvailability: () => ({ check: async ({ rightId }) => { calls.availability.push(rightId); return guard.availability(rightId); } }),
    createClient: session => ({
      forRight(rightId) {
        assert.equal(rightId, 1n);
        const executor = executorFor(session.account, rightId);
        return { get hash() { return executor.hash; }, close: () => executor.close(), claim: async () => { calls.claim++; lastResult = await executor.claim(); return lastResult; } };
      },
      close() { calls.closed++; session.close(); },
    }),
    createReader: () => ({ check: async rightId => {
      calls.checks++;
      const checker = executorFor(undefined, rightId);
      try { lastResult = await checker.check(); return lastResult; } finally { checker.close(); }
    } }),
    createVerifier: () => { throw new Error('REFERENCE_VERIFIER_NOT_USED_BY_THIS_TEST'); },
  });
  assert.equal($('payment-right').value, '1');
  assert.match(root.querySelector('label[for="payment-right"]').textContent, /Payment to collect/);
  await until(() => !$('payment-refresh').disabled, 'initial availability');
  assert.equal($('payment-open').hidden, false);
  assert.deepEqual(calls.availability, [1n]);
  assert.equal(calls.open, 0); assert.equal(calls.broadcasts, 0);

  // B can inspect another approved obligation without a key, then deliberately
  // select the first one. Nothing is inferred from the primary/recovery role.
  $('payment-right').value = '2'; $('payment-right').dispatchEvent(new dom.window.Event('change'));
  await until(() => !$('payment-refresh').disabled && calls.availability.includes(2n), 'unissued second payment');
  assert.equal($('payment-open').hidden, true);
  assert.match($('payment-status').textContent, /not been issued/);
  $('payment-right').value = '1'; $('payment-right').dispatchEvent(new dom.window.Event('change'));
  await until(() => !$('payment-refresh').disabled && !$('payment-open').hidden, 'reselected first payment');
  $('payment-open').click();
  await until(() => !$('payment-claim').hidden && !$('payment-claim').disabled, 'existing reserve open');
  assert.equal(calls.open, 1); assert.equal(calls.broadcasts, 0);
  assert.equal(primary.requests(), primaryRequestsBefore);
  $('payment-claim').click(); $('payment-claim').click();
  await until(() => lastResult?.hash && !$('payment-check').disabled, 'first claim attempt');
  assert.equal(calls.claim, 1); assert.equal(calls.broadcasts, 1);
  assert.equal(calls.closed, 1);
  await assert.rejects(recovered.account.signMessage({ message: 'UI closed signing session after the claim' }), error => error.code === 'SESSION_ENDED');
  if (!lastResult.receipt) {
    assert.equal($('payment-title').textContent === 'Payment received.', false);
    await harness.rpc('anvil_mine', ['0x40']);
    $('payment-check').click();
    await until(() => !!lastResult.receipt && !$('payment-check').disabled, 'finalized claim receipt');
  }
  const { hash, receipt } = lastResult;
  assert.equal(receipt.status, 'success'); assert.equal(receipt.transactionHash, hash);
  assert.equal(getAddress(receipt.from), owner); assert.equal(getAddress(receipt.to), profile.address);
  assert.ok(receipt.gasUsed > 0n && receipt.gasUsed <= PAYMENT_LIMITS.gas);
  assert.ok(receipt.effectiveGasPrice >= 0n && receipt.effectiveGasPrice <= PAYMENT_LIMITS.maxFeePerGas);
  assert.equal(await clients[0].getBalance({ address: owner }), balanceBefore + amount - receipt.gasUsed * receipt.effectiveGasPrice);
  const tx = await clients[0].getTransaction({ hash });
  assert.equal(tx.chainId, 31337); assert.equal(tx.nonce, 0); assert.equal(tx.value, 0n);
  assert.equal(getAddress(tx.from), owner); assert.equal(getAddress(tx.to), profile.address);
  assert.equal(tx.input, encodeFunctionData({ abi: PAYMENT_ABI, functionName: 'claim', args: [1n] }));
  const events = receipt.logs.filter(log => getAddress(log.address) === profile.address).map(log => decodeEventLog({ abi: PAYMENT_ABI, topics: log.topics, data: log.data })).filter(event => event.eventName === 'RightClaimed');
  assert.equal(events.length, 1); assert.deepEqual(events[0].args, { id: 1n, beneficiary: owner, amount });
  assert.equal($('payment-title').textContent, 'Payment received.');
  assert.equal($('payment-hash').textContent, hash);
  assert.equal($('payment-open').hidden, true); assert.equal($('payment-claim').hidden, true);

  // A fresh durable executor selected for the same completed obligation can
  // reconcile its receipt without any signer or another broadcast.
  const duplicate = executorFor(undefined, 1n);
  assert.equal((await duplicate.claim()).hash, hash); duplicate.close();
  assert.equal(calls.broadcasts, 1); assert.equal(calls.readerSign, 0);
  assert.equal(await clients[0].getTransactionCount({ address: owner }), 1);
  assert.equal((await harness.readRight(1n)).claimed, true);
  assert.equal(await clients[0].getBalance({ address: profile.address }), 0n);
  assert.equal(calls.open, 1);
  assert.equal(fixture.stats().creates, authBefore.creates);
  assert.equal(fixture.stats().originalRequests, authBefore.originalRequests);
  assert.ok(fixture.stats().recoveryRequests > authBefore.recoveryRequests);
  assert.equal(fixture.store.calls.put, writesBefore);
  assert.deepEqual(fixture.store.records(), ciphertextBefore);
  assert.equal(primary.requests(), primaryRequestsBefore);
  assert.equal((await fetch(primary.url)).status, 503);
  const journal = await pendingStore.read();
  assert.equal(journal.active, null); assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].rightId, '1'); assert.equal(journal.entries[0].hash, hash); assert.equal(journal.entries[0].phase, 'confirmed');
  console.log(JSON.stringify({ experiment: 'first-payment-from-selected-reserve', actualPaymentPage: true, selectedRightId: 1, selectorCheckedUnissuedRight: 2, primaryUnavailableBeforeFirstClaim: true, primaryHttpStatus: 503, primaryRequestsDuringRecoveryAndClaim: 0, deliberateExistingReserveOpens: calls.open, newCredentials: 0, reserveWritesDuringRecovery: 0, ciphertextPreserved: true, broadcasts: calls.broadcasts, duplicateBroadcasts: 0, exactBeneficiaryAndAmount: true, exactBalanceAfterGas: true, exactReceiptAndTransaction: true, durableJournalConfirmed: true, originalAndRecoveredSignerEnded: true, chainId: 31337, nativePasskey: false, publicNetwork: false, limits: ['source runtime consumer, not installed-package proof', 'JSDOM, not a physical browser', 'synthetic authenticator', 'disposable local EVM', 'two readers share one local EVM; not independent providers', 'local test funding is not customer demand'] }));
});
