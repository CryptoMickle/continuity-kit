import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeEventTopics, http, keccak256, parseAbi, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createClaimExecutor, __createReviewedClaimExecutor } from '../transaction.mjs';
import { createBrowserPendingStore, __createTestnetPendingStore } from '../pending-ticket.mjs';
import { startLocalChain } from '../chain/harness.mjs';

const abi = parseAbi(['function claim(uint256 id)', 'event RightClaimed(uint256 indexed id, address indexed beneficiary, uint256 amount)']);
const address = '0x1000000000000000000000000000000000000001';
const another = '0x2000000000000000000000000000000000000002';
const chain = { id: 31337, name: 'Disposable local fixture', nativeCurrency: { name: 'Test', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:1'] } } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(options = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const fixtureChain = options.reviewed ? { ...chain, id: 10143 } : chain;
  const counts = { prepare: 0, sign: 0, broadcast: 0, receipt: 0 };
  const executors = [];
  let serialized;
  let missing = Boolean(options.missing);
  const wallet = {
    account, chain: fixtureChain,
    async prepareTransactionRequest(input) {
      counts.prepare++;
      if (options.prepareGate) await options.prepareGate.promise;
      return { ...input, nonce: 0, ...options.requestChanges };
    },
    async signTransaction(request) {
      counts.sign++;
      const { account: _, chain: __, ...transaction } = request;
      serialized = await account.signTransaction({ ...transaction, ...options.signedChanges });
      if (options.signGate) await options.signGate.promise;
      return serialized;
    },
  };
  function receipt() {
    const id = options.eventId ?? (options.reviewed ? 1n : 7n);
    const beneficiary = options.eventOwner ?? account.address;
    const event = { address, topics: encodeEventTopics({ abi, eventName: 'RightClaimed', args: { id, beneficiary } }), data: encodeAbiParameters([{ type: 'uint256' }], [options.eventAmount ?? (options.reviewed ? 100000000000000000n : 1000n)]) };
    return { transactionHash: keccak256(serialized), to: address, from: account.address, status: 'success', logs: options.noEvent ? [] : [event], ...options.receiptChanges };
  }
  const publicClient = {
    async getChainId() {
      if (options.chainReadError) throw options.chainReadError;
      return options.chainId ?? fixtureChain.id;
    },
    async sendRawTransaction({ serializedTransaction }) {
      counts.broadcast++;
      assert.equal(serializedTransaction, serialized);
      assert.ok(executors.some(executor => executor.hash === keccak256(serialized)), 'hash must exist before broadcast begins');
      if (options.broadcastGate) await options.broadcastGate.promise;
      if (options.loseResponse) throw new Error('RESPONSE_LOST_AFTER_ACCEPTANCE');
      return options.returnedHash ?? keccak256(serialized);
    },
    async getTransactionReceipt({ hash }) {
      counts.receipt++;
      assert.ok(executors.some(executor => executor.hash === hash));
      if (missing) throw Object.assign(new Error('Pending'), { name: 'TransactionReceiptNotFoundError' });
      return receipt();
    },
  };
  const pendingStore = options.makePendingStore?.(account.address);
  const createExecutor = () => {
    const args = { wallet, publicClient, chainId: fixtureChain.id, address, abi, owner: account.address, pendingStore };
    const created = options.reviewed ? __createReviewedClaimExecutor(args, options.guards) : createClaimExecutor(args);
    executors.push(created);
    return created;
  };
  const executor = createExecutor();
  return { executor, createExecutor, counts, wallet, publicClient, account, setMissing(v) { missing = v; }, transaction: () => parseTransaction(serialized) };
}

function ticketStore(chainId) {
  const records = new Map();
  const state = { locked: false, writes: 0 };
  let tail = Promise.resolve();
  const storage = { getItem: key => records.get(key) ?? null, setItem(key, value) { state.writes++; records.set(key, value); } };
  const locks = { async request(key, options, callback) {
    const previous = tail; const done = deferred(); tail = done.promise;
    await previous;
    assert.equal(state.locked, false); state.locked = true;
    try { return await callback({ name: key }); }
    finally { state.locked = false; done.resolve(); }
  } };
  const create = owner => (chainId === 10143 ? __createTestnetPendingStore : createBrowserPendingStore)({ chainId, owner, address, storage, locks });
  return { records, state, create };
}

test('chain read failure leaves no reserved ticket and the same executor can retry explicitly', async () => {
  const store = ticketStore(31337);
  const options = { makePendingStore: store.create, chainReadError: new Error('READ_ONLY_RPC_TIMEOUT') };
  const f = fixture(options);
  await assert.rejects(f.executor.claim(7n), /READ_ONLY_RPC_TIMEOUT/);
  assert.equal(store.state.writes, 0); assert.equal(store.records.size, 0);
  assert.deepEqual(f.counts, { prepare: 0, sign: 0, broadcast: 0, receipt: 0 });
  await assert.rejects(f.executor.check(), /PENDING_TICKET_MISSING/);
  options.chainReadError = undefined;
  const result = await f.executor.claim(7n);
  assert.equal(result.receipt.status, 'success');
  assert.deepEqual(f.counts, { prepare: 1, sign: 1, broadcast: 1, receipt: 1 });
  assert.equal(store.state.writes, 2);
});

test('reviewed read-only preflight stays under the browser lock without consuming an attempt on failure', async () => {
  const store = ticketStore(10143); let failRead = true; let checks = 0;
  const f = fixture({ reviewed: true, makePendingStore: store.create, guards: {
    async beforePrepare() {
      checks++;
      assert.equal(store.state.locked, true);
      assert.equal(store.records.size, 0, 'read-only preflight precedes the durable reservation');
      if (failRead) throw new Error('TESTNET_FEE_BALANCE_INSUFFICIENT');
      return 120000n;
    },
    async beforeBroadcast() { assert.equal(store.state.locked, true); },
    async beforeCheck() {},
  } });
  await assert.rejects(f.executor.claim(1n), /TESTNET_FEE_BALANCE_INSUFFICIENT/);
  assert.equal(store.state.writes, 0);
  assert.equal(f.executor.hash, undefined);
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.sign, 0); assert.equal(f.counts.broadcast, 0);
  failRead = false;
  assert.equal((await f.executor.claim(1n)).receipt.status, 'success');
  assert.equal(checks, 2); assert.equal(f.counts.sign, 1); assert.equal(f.counts.broadcast, 1);
});

test('another executor queued behind a failed read-only preflight can proceed without clearing storage', async () => {
  const store = ticketStore(10143); const gate = deferred(); let checks = 0;
  const f = fixture({ reviewed: true, makePendingStore: store.create, guards: {
    async beforePrepare() {
      assert.equal(store.state.locked, true);
      if (++checks === 1) { await gate.promise; throw new Error('READ_ONLY_RPC_TIMEOUT'); }
      return 120000n;
    },
    async beforeBroadcast() {}, async beforeCheck() {},
  } });
  const other = f.createExecutor();
  const first = f.executor.claim(1n);
  const sameClick = f.executor.claim(1n);
  assert.equal(sameClick, first, 'concurrent clicks still share the read-only preflight');
  const second = other.claim(1n);
  const settled = Promise.allSettled([first, second]); gate.resolve();
  const results = await settled;
  assert.equal(results[0].status, 'rejected'); assert.match(results[0].reason.message, /READ_ONLY_RPC_TIMEOUT/);
  assert.equal(results[1].status, 'fulfilled'); assert.equal(results[1].value.receipt.status, 'success');
  assert.equal(store.state.writes, 2); assert.equal(f.counts.prepare, 1); assert.equal(f.counts.sign, 1); assert.equal(f.counts.broadcast, 1);
});

test('signed but stopped before delivery is known only in the active executor and is never automatically resent', async () => {
  const store = ticketStore(10143); let beforeBroadcasts = 0;
  const f = fixture({ reviewed: true, missing: true, makePendingStore: store.create, guards: {
    async beforePrepare() { return 120000n; },
    async beforeBroadcast() { beforeBroadcasts++; throw new Error('TESTNET_GAS_CHANGED'); },
    async beforeCheck() {},
  } });
  await assert.rejects(f.executor.claim(1n), /TESTNET_GAS_CHANGED/);
  assert.match(f.executor.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(f.executor.deliveryStatus, 'not-attempted');
  assert.equal(JSON.parse([...store.records.values()][0]).phase, 'signed');
  assert.equal((await f.executor.check()).receipt, undefined);
  assert.equal(f.executor.deliveryStatus, 'not-attempted', 'same-instance hydration preserves its known delivery boundary');
  await f.executor.claim(1n);
  const fresh = f.createExecutor();
  assert.equal((await fresh.check()).hash, f.executor.hash);
  assert.equal(fresh.deliveryStatus, 'unknown', 'persisted hash alone cannot prove a send did or did not happen');
  await fresh.claim(1n);
  assert.equal(beforeBroadcasts, 1); assert.equal(f.counts.sign, 1); assert.equal(f.counts.broadcast, 0);
  assert.equal(store.state.writes, 2);
});

test('fixed claim signs exactly one scoped transaction and verifies its matching receipt', async () => {
  const f = fixture();
  const result = await f.executor.claim(7n);
  assert.equal(result.hash, f.executor.hash);
  assert.equal(result.receipt.status, 'success');
  const tx = f.transaction();
  assert.equal(tx.chainId, 31337); assert.equal(tx.to, address); assert.equal(tx.value ?? 0n, 0n);
  assert.equal(tx.gas, 150000n); assert.equal(tx.maxFeePerGas, 3000000000n); assert.equal(tx.maxPriorityFeePerGas, 1000000000n);
  await f.executor.claim(7n);
  assert.deepEqual(f.counts, { prepare: 1, sign: 1, broadcast: 1, receipt: 2 });
});

test('accepted broadcast with lost response keeps the exact hash and never signs or broadcasts again', async () => {
  const f = fixture({ loseResponse: true });
  await assert.rejects(f.executor.claim(7n), /RESPONSE_LOST_AFTER_ACCEPTANCE/);
  const hash = f.executor.hash;
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(f.executor.deliveryStatus, 'attempted');
  const result = await f.executor.claim(7n);
  assert.equal(result.hash, hash); assert.equal(result.receipt.status, 'success');
  await f.executor.check();
  assert.deepEqual(f.counts, { prepare: 1, sign: 1, broadcast: 1, receipt: 2 });
});

test('concurrent double clicks share one in-flight signing and broadcast attempt', async () => {
  const gate = deferred(); const f = fixture({ prepareGate: gate });
  const a = f.executor.claim(7n); const b = f.executor.claim(7n);
  assert.equal(a, b); gate.resolve();
  assert.equal((await a).hash, (await b).hash);
  assert.deepEqual(f.counts, { prepare: 1, sign: 1, broadcast: 1, receipt: 1 });
});

test('pending receipt is a checkable state, never permission to send again', async () => {
  const f = fixture({ missing: true });
  const pending = await f.executor.claim(7n); assert.equal(pending.receipt, undefined);
  assert.equal((await f.executor.claim(7n)).hash, pending.hash);
  f.setMissing(false); assert.equal((await f.executor.check()).receipt.status, 'success');
  assert.equal(f.counts.sign, 1); assert.equal(f.counts.broadcast, 1);
});

test('closed session cannot begin a claim; existing hash remains readable after close', async () => {
  const f = fixture(); await f.executor.claim(7n); f.executor.close();
  assert.throws(() => f.executor.claim(7n), /SESSION_CLOSED/);
  assert.equal((await f.executor.check()).receipt.status, 'success'); assert.equal(f.counts.sign, 1);
  const unopened = fixture(); unopened.executor.close();
  assert.throws(() => unopened.executor.claim(7n), /SESSION_CLOSED/); assert.equal(unopened.counts.prepare, 0);
});

test('session closure while preparing prevents signing', async () => {
  const gate = deferred(); const f = fixture({ prepareGate: gate });
  const attempt = f.executor.claim(7n); await Promise.resolve();
  f.executor.close(); gate.resolve(); await assert.rejects(attempt, /SESSION_CLOSED/);
  assert.equal(f.counts.sign, 0); assert.equal(f.counts.broadcast, 0);
});

test('session closure while signing prevents broadcasting the late signed result', async () => {
  const gate = deferred(); const f = fixture({ signGate: gate });
  const attempt = f.executor.claim(7n);
  while (f.counts.sign === 0) await Promise.resolve();
  f.executor.close(); gate.resolve(); await assert.rejects(attempt, /SESSION_CLOSED/);
  assert.equal(f.counts.broadcast, 0);
});

test('failed preparation is latched, so another click cannot request a fresh signature', async () => {
  const f = fixture({ requestChanges: { value: 1n } });
  await assert.rejects(f.executor.claim(7n), /TRANSACTION_SCOPE_MISMATCH/);
  await assert.rejects(f.executor.claim(7n), /TRANSACTION_SCOPE_MISMATCH/);
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.sign, 0); assert.equal(f.counts.broadcast, 0);
});

test('signed transaction is independently checked against the fixed scope before broadcast', async () => {
  const f = fixture({ signedChanges: { to: another } });
  await assert.rejects(f.executor.claim(7n), /TRANSACTION_SCOPE_MISMATCH/);
  assert.equal(f.counts.sign, 1); assert.equal(f.counts.broadcast, 0);
});

test('one executor cannot switch rights or send to a different chain', async () => {
  const f = fixture(); await f.executor.claim(7n);
  await assert.rejects(f.executor.claim(8n), /RIGHT_ALREADY_SELECTED/); assert.equal(f.counts.sign, 1);
  const wrongChain = fixture({ chainId: 1 });
  await assert.rejects(wrongChain.executor.claim(7n), /LOCAL_CHAIN_REQUIRED/); assert.equal(wrongChain.counts.prepare, 0);
});

test('receipt identity, success and the exact contract event are mandatory', async t => {
  for (const [label, options, code] of [
    ['wrong hash', { receiptChanges: { transactionHash: '0x' + 'ab'.repeat(32) } }, 'RECEIPT_MISMATCH'],
    ['wrong recipient', { receiptChanges: { to: another } }, 'RECEIPT_MISMATCH'],
    ['wrong signer', { receiptChanges: { from: another } }, 'RECEIPT_MISMATCH'],
    ['reverted', { receiptChanges: { status: 'reverted' } }, 'CLAIM_REVERTED'],
    ['missing event', { noEvent: true }, 'CLAIM_EVENT_MISMATCH'],
    ['wrong right', { eventId: 8n }, 'CLAIM_EVENT_MISMATCH'],
    ['wrong beneficiary', { eventOwner: another }, 'CLAIM_EVENT_MISMATCH'],
    ['zero amount', { eventAmount: 0n }, 'CLAIM_EVENT_MISMATCH'],
  ]) await t.test(label, async () => {
    const f = fixture(options);
    await assert.rejects(f.executor.claim(7n), new RegExp(code)); assert.match(f.executor.hash, /^0x[0-9a-f]{64}$/);
    await assert.rejects(f.executor.claim(7n), new RegExp(code)); assert.equal(f.counts.sign, 1); assert.equal(f.counts.broadcast, 1);
  });
});

test('different broadcast response hash does not replace the locally signed hash', async () => {
  const wrong = '0x' + '12'.repeat(32); const f = fixture({ returnedHash: wrong });
  await assert.rejects(f.executor.claim(7n), /BROADCAST_HASH_MISMATCH/);
  assert.notEqual(f.executor.hash, wrong); assert.equal((await f.executor.check()).receipt.status, 'success');
});

test('actual viem wallet executes the fixed claim on disposable loopback Anvil', async t => {
  const harness = await startLocalChain(); t.after(() => harness.close());
  const actualChain = { ...chain, rpcUrls: { default: { http: [harness.rpcUrl] } } };
  const account = privateKeyToAccount(generatePrivateKey());
  const right = await harness.prepareRight(account.address);
  const wallet = createWalletClient({ account, chain: actualChain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
  const publicClient = createPublicClient({ chain: actualChain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
  const executor = createClaimExecutor({ wallet, publicClient, chainId: 31337, address: harness.contractAddress, abi: harness.abi, owner: account.address });
  let result = await executor.claim(right.id);
  if (!result.receipt) { await publicClient.waitForTransactionReceipt({ hash: result.hash, timeout: 5000 }); result = await executor.check(); }
  assert.equal(result.receipt.status, 'success'); assert.equal((await harness.readRight(right.id)).claimed, true);
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  assert.equal((await executor.claim(right.id)).hash, result.hash);
  assert.equal(await publicClient.getTransactionCount({ address: account.address }), nonce); executor.close();
});
