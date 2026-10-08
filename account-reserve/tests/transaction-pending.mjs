import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createClaimExecutor } from '../transaction.mjs';
import { createBrowserPendingStore } from '../pending-ticket.mjs';

const abi = parseAbi(['function claim(uint256 id)', 'event RightClaimed(uint256 indexed id, address indexed beneficiary, uint256 amount)']);
const address = '0x1000000000000000000000000000000000000001';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function world(options = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const records = new Map();
  const queue = new Map();
  const counts = { writes: 0, prepare: 0, sign: 0, broadcast: 0, checks: 0 };
  const storage = {
    getItem(key) { return records.get(key) ?? null; },
    setItem(key, value) {
      counts.writes++;
      if (options.failWrite === counts.writes) throw new Error('Quota');
      records.set(key, value);
      if (options.loseWriteResponse === counts.writes) throw new Error('Unknown write');
    },
  };
  const locks = {
    async request(key, opts, callback) {
      assert.equal(opts.mode, 'exclusive');
      const previous = queue.get(key) ?? Promise.resolve();
      const done = deferred(); queue.set(key, done.promise);
      await previous;
      try { return await callback({ name: key, mode: 'exclusive' }); }
      finally { done.resolve(); }
    },
  };
  const wallet = {
    account, chain: { id: 31337 },
    async prepareTransactionRequest(input) {
      counts.prepare++;
      assert.equal([...records.values()].map(JSON.parse)[0].phase, 'reserved');
      if (options.failPrepare) throw new Error('PREPARATION_INTERRUPTED');
      return { ...input, nonce: 0 };
    },
    async signTransaction(request) {
      counts.sign++;
      const { account: _, chain: __, ...tx } = request;
      return account.signTransaction(tx);
    },
  };
  const accepted = new Set();
  const publicClient = {
    async getChainId() { return 31337; },
    async sendRawTransaction({ serializedTransaction }) {
      counts.broadcast++;
      const hash = keccak256(serializedTransaction);
      const ticket = [...records.values()].map(JSON.parse)[0];
      assert.equal(ticket.phase, 'signed');
      assert.equal(ticket.hash, hash, 'exact hash must be durable before broadcast');
      accepted.add(hash);
      if (options.broadcastGate) await options.broadcastGate.promise;
      if (options.loseResponse) throw new Error('RESPONSE_LOST_AFTER_ACCEPTANCE');
      return hash;
    },
    async getTransactionReceipt({ hash }) {
      counts.checks++;
      if (!accepted.has(hash)) throw Object.assign(new Error('Missing'), { name: 'TransactionReceiptNotFoundError' });
      return { transactionHash: hash, to: address, from: account.address, status: 'success', logs: [{
        address,
        topics: encodeEventTopics({ abi, eventName: 'RightClaimed', args: { id: 7n, beneficiary: account.address } }),
        data: encodeAbiParameters([{ type: 'uint256' }], [1000n]),
      }] };
    },
  };
  const scope = { chainId: 31337, address, owner: account.address };
  const store = () => createBrowserPendingStore({ ...scope, storage, locks });
  const executor = () => createClaimExecutor({ ...scope, wallet, publicClient, abi, pendingStore: store() });
  const rawTicket = () => JSON.parse([...records.values()][0]);
  return { account, scope, records, counts, storage, locks, store, executor, rawTicket };
}

test('two executors serialize under one browser lock; lost response and reload never resign or rebroadcast', async () => {
  const gate = deferred(); const w = world({ loseResponse: true, broadcastGate: gate });
  const first = w.executor(); const second = w.executor();
  const a = first.claim(7n); const b = second.claim(7n);
  while (w.counts.broadcast === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.counts.sign, 1);
  gate.resolve();
  const result = await Promise.allSettled([a, b]);
  assert.equal(result[0].status, 'rejected'); assert.match(result[0].reason.message, /RESPONSE_LOST/);
  assert.equal(result[1].status, 'fulfilled');
  assert.equal(result[1].value.hash, first.hash);
  assert.equal(second.hash, first.hash);
  const fresh = w.executor();
  const checked = await fresh.check();
  assert.equal(checked.hash, first.hash); assert.equal(checked.receipt.status, 'success');
  assert.equal((await fresh.claim(7n)).hash, first.hash);
  assert.deepEqual(w.counts, { writes: 2, prepare: 1, sign: 1, broadcast: 1, checks: 3 });
});

test('fresh executor claim hydrates a pending transaction even without a preceding check', async () => {
  const w = world({ loseResponse: true }); const first = w.executor();
  await assert.rejects(first.claim(7n), /RESPONSE_LOST/);
  const fresh = w.executor(); const result = await fresh.claim(7n);
  assert.equal(result.hash, first.hash); assert.equal(result.receipt.status, 'success');
  assert.equal(w.counts.sign, 1); assert.equal(w.counts.broadcast, 1);
});

test('unknown attempt before a durable hash stays blocked across reloads', async () => {
  const w = world({ failPrepare: true });
  await assert.rejects(w.executor().claim(7n), /PREPARATION_INTERRUPTED/);
  assert.equal(w.rawTicket().phase, 'reserved'); assert.equal(w.rawTicket().hash, null);
  const fresh = w.executor();
  await assert.rejects(fresh.claim(7n), /PENDING_ATTEMPT_REQUIRES_RECONCILIATION/);
  await assert.rejects(fresh.check(), /PENDING_ATTEMPT_REQUIRES_RECONCILIATION/);
  assert.equal(w.counts.prepare, 1); assert.equal(w.counts.sign, 0); assert.equal(w.counts.broadcast, 0);
});

test('storage failure before reserving prevents any signing', async () => {
  const w = world({ failWrite: 1 });
  await assert.rejects(w.executor().claim(7n), /PENDING_STORE_UNAVAILABLE/);
  assert.equal(w.counts.prepare, 0); assert.equal(w.counts.sign, 0); assert.equal(w.counts.broadcast, 0);
});

test('failure persisting signed hash prevents broadcast and leaves prehash attempt blocked', async () => {
  const w = world({ failWrite: 2 }); const first = w.executor();
  await assert.rejects(first.claim(7n), /PENDING_STORE_UNAVAILABLE/);
  assert.match(first.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(w.rawTicket().phase, 'reserved');
  await assert.rejects(w.executor().claim(7n), /PENDING_ATTEMPT_REQUIRES_RECONCILIATION/);
  assert.equal(w.counts.sign, 1); assert.equal(w.counts.broadcast, 0);
});

test('unknown signed-hash persistence never broadcasts; reload only checks the known hash', async () => {
  const w = world({ loseWriteResponse: 2 }); const first = w.executor();
  await assert.rejects(first.claim(7n), /PENDING_STORE_UNAVAILABLE/);
  assert.equal(w.rawTicket().phase, 'signed');
  const result = await w.executor().claim(7n);
  assert.equal(result.hash, first.hash); assert.equal(result.receipt, undefined);
  assert.equal(w.counts.sign, 1); assert.equal(w.counts.broadcast, 0);
});

test('corrupt or mismatched pending metadata rejects without signing', async t => {
  const variants = [
    ['invalid JSON', () => '{'],
    ['extra data', ticket => JSON.stringify({ ...ticket, rawKey: 'forbidden' })],
    ['wrong owner', ticket => JSON.stringify({ ...ticket, owner: address })],
    ['wrong chain', ticket => JSON.stringify({ ...ticket, chainId: 1 })],
    ['wrong contract', ticket => JSON.stringify({ ...ticket, address: '0x2000000000000000000000000000000000000002' })],
    ['invalid phase', ticket => JSON.stringify({ ...ticket, phase: 'retry' })],
    ['invalid hash', ticket => JSON.stringify({ ...ticket, hash: '0x1234' })],
    ['invalid right', ticket => JSON.stringify({ ...ticket, rightId: '-7' })],
    ['duplicate JSON key', ticket => JSON.stringify(ticket).replace('"version":1', '"version":2,"version":1')],
  ];
  for (const [label, corrupt] of variants) await t.test(label, async () => {
    const w = world(); await w.executor().claim(7n);
    const [key] = w.records.keys(); w.records.set(key, corrupt(w.rawTicket()));
    await assert.rejects(w.executor().claim(7n), /PENDING_TICKET_INVALID/);
    assert.equal(w.counts.sign, 1); assert.equal(w.counts.broadcast, 1);
  });
});

test('missing reliable navigator lock fails closed', () => {
  const w = world();
  assert.throws(() => createBrowserPendingStore({ ...w.scope, storage: w.storage, locks: null }), /PENDING_LOCK_UNAVAILABLE/);
});

test('retained ticket cannot change right or downgrade a signed attempt', async () => {
  const w = world(); await w.executor().claim(7n);
  await assert.rejects(w.executor().claim(8n), /RIGHT_ALREADY_SELECTED/);
  await assert.rejects(w.store().put({ ...w.rawTicket(), phase: 'reserved', hash: null }), /PENDING_TICKET_CONFLICT/);
  await assert.rejects(w.store().put(w.rawTicket()), /PENDING_TICKET_CONFLICT/);
  assert.equal(w.counts.sign, 1); assert.equal(w.counts.broadcast, 1);
});

test('stored ticket contains public metadata only, never key or signed transaction bytes', async () => {
  const w = world(); await w.executor().claim(7n);
  const ticket = w.rawTicket();
  assert.deepEqual(Object.keys(ticket), ['version', 'chainId', 'address', 'owner', 'rightId', 'phase', 'hash']);
  assert.equal(ticket.owner, w.account.address.toLowerCase()); assert.equal(ticket.rightId, '7');
  assert.equal(ticket.hash.length, 66); assert.ok([...w.records.values()][0].length < 400);
});
