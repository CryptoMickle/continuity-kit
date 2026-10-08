import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, keccak256, offchainLookupAbiItem, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { APPROVED_TESTNET_RPCS, PAYMENT_RIGHT_ABI, validateClientProfile } from '../release/client-profile.mjs';
import { createTestnetClaimExecutor, createTestnetPendingStore } from '../release/testnet-executor.mjs';
import { createClaimExecutor } from '../transaction.mjs';
import { createBrowserPendingStore } from '../pending-ticket.mjs';
import { createPacedRpcTransportFactory } from '../release/paced-rpc.mjs';

const address = '0x1000000000000000000000000000000000000001';
const issuer = '0x2000000000000000000000000000000000000002';
const runtime = '0x6001600055'; // Synthetic RPC fixture bytes, NOT a deployment.
const future = () => new Date(Date.now() + 86400000).toISOString();
function profile() {
  return { format: 'account-reserve-public/v1', enabled: true, chainId: 10143, contractAddress: address, expectedRuntimeCodeHash: keccak256(runtime), issuer, primaryOrigin: 'https://primary.example.com', recoveryOrigin: 'https://recovery.example.com', namespace: 'account-reserve-' + 'ab'.repeat(16), expiresAt: future(), physicalPasskeysVerified: false, rpcUrls: [...APPROVED_TESTNET_RPCS], claim: { rightId: '1', gasLimit: '300000', maxFeePerGasWei: '200000000000', maxPriorityFeePerGasWei: '2000000000', valueWei: '0' } };
}

function fixture(t, options = {}) {
  const p = profile(); const keyAccount = privateKeyToAccount(generatePrivateKey());
  let clock = 0;
  const rpcTransport = createPacedRpcTransportFactory({ now: () => clock, wait: async ms => { clock += ms; } });
  const records = new Map(); let lockTail = Promise.resolve();
  const counts = { signs: 0, broadcasts: 0, fetches: 0 }; const seenUrls = new Set(); const attemptedUrls = [];
  const state = { hash: undefined, signed: undefined, receiptUrls: new Set(), stateReads: [], requests: [] };
  const recovered = { owner: keyAccount.address.toLowerCase(), account: { ...keyAccount, async signTransaction(tx) { counts.signs++; return keyAccount.signTransaction(options.signWrongNonce ? { ...tx, nonce: 1 } : tx); } } };
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
  const locks = { request: async (key, settings, callback) => { const before = lockTail; let release; lockTail = new Promise(resolve => { release = resolve; }); await before; try { return await callback({ name: key }); } finally { release(); } } };
  const pendingStore = () => createTestnetPendingStore({ profile: p, owner: recovered.owner, storage, locks });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const suppliedUrl = typeof input === 'string' ? input : input.url;
    assert.equal(init?.redirect ?? input.redirect, 'error', 'Both public and wallet transports must reject redirects');
    const url = APPROVED_TESTNET_RPCS.find(allowed => suppliedUrl === allowed || suppliedUrl === allowed + '/') ?? suppliedUrl;
    attemptedUrls.push(url);
    assert.ok(APPROVED_TESTNET_RPCS.includes(url), 'No nonapproved RPC URL is ever requested');
    seenUrls.add(url); counts.fetches++;
    if (options.rpcRedirect) throw new TypeError('synthetic redirect rejected by redirect:error');
    const rpc = JSON.parse(init?.body ?? await input.text());
    const { method, params = [] } = rpc;
    state.requests.push({ url, method, at: clock });
    if (options.rpcRateLimit || (options.rateLimitAfterSign && counts.signs > 0 && !state.hash)) return new Response('synthetic rate limit', { status: 429 });
    let result;
    if (method === 'eth_chainId') result = options.wrongChain && url === APPROVED_TESTNET_RPCS[1] ? '0x1' : '0x279f';
    else if (method === 'eth_getCode') result = params[0].toLowerCase() === address.toLowerCase() ? (options.wrongRuntime || (options.changeRuntimeAfterSign && counts.signs > 0) ? '0x6000' : runtime) : '0x';
    else if (method === 'eth_getTransactionCount') result = options.wrongNonce ? '0x1' : '0x0';
    else if (method === 'eth_getBalance') result = options.lowBalance ? '0x0' : '0xde0b6b3a7640000';
    else if (method === 'eth_estimateGas') result = options.highEstimate ? '0x493e0' : '0x186a0';
    else if (method === 'eth_getBlockByNumber') {
      const secondary = url === APPROVED_TESTNET_RPCS[1];
      const lagging = params[0] === 'finalized' && options.notFinalized && secondary;
      const wrongCanonical = params[0] === '0x1' && secondary && (options.canonicalMismatch || (options.canonicalChangesAfterState && state.stateReads.some(read => read.url === url)));
      result = { number: lagging ? '0x0' : '0x1', hash: '0x' + (lagging ? '00' : wrongCanonical ? '33' : '11').repeat(32), parentHash: '0x' + '22'.repeat(32), timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: options.highBaseFee ? '0x2e90edd000' : '0x3b9aca00', transactions: [] };
    }
    else if (method === 'eth_call') {
      if (options.offchainLookup) return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: [offchainLookupAbiItem], errorName: 'OffchainLookup', args: [address, ['https://outside.example.com/{data}'], '0x1234', '0x12345678', '0x'] }) } }), { headers: { 'content-type': 'application/json' } });
      const decoded = decodeFunctionData({ abi: PAYMENT_RIGHT_ABI, data: params[0].data });
      const checkingReceiptState = Boolean(state.hash) && ['getRight', 'rightForOwner'].includes(decoded.functionName);
      if (checkingReceiptState) {
        assert.equal(params[1], '0x1', 'Postclaim state must be read at the receipt block, never latest');
        state.stateReads.push({ url, block: params[1], functionName: decoded.functionName });
      }
      const mismatch = checkingReceiptState && url === APPROVED_TESTNET_RPCS[1];
      const answer = decoded.functionName === 'issuer' ? issuer : decoded.functionName === 'rightForOwner' ? (mismatch && options.wrongStateMapping ? 2n : 1n) : {
        beneficiary: options.wrongBeneficiary || (mismatch && options.wrongStateOwner) ? issuer : recovered.owner,
        amount: mismatch && options.wrongStateAmount ? 200000000000000000n : 100000000000000000n,
        claimed: checkingReceiptState && !(mismatch && options.stateNotClaimed),
      };
      result = encodeFunctionResult({ abi: PAYMENT_RIGHT_ABI, functionName: decoded.functionName, result: answer });
    } else if (method === 'eth_sendRawTransaction') {
      counts.broadcasts++;
      state.signed = parseTransaction(params[0]); state.hash = keccak256(params[0]);
      const ticket = JSON.parse([...records.values()][0]);
      assert.equal(ticket.hash, state.hash, 'signed hash must be durable before any broadcast');
      if (options.loseResponse) throw new Error('synthetic accepted response lost');
      result = state.hash;
    } else if (method === 'eth_getTransactionReceipt') {
      state.receiptUrls.add(url);
      result = state.hash ? { transactionHash: state.hash, to: address, from: recovered.owner, status: '0x1', blockNumber: '0x1', blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', cumulativeGasUsed: '0x186a0', gasUsed: '0x186a0', effectiveGasPrice: '0x3b9aca00', type: '0x2', logsBloom: '0x' + '00'.repeat(256), logs: [{ address, topics: encodeEventTopics({ abi: PAYMENT_RIGHT_ABI, eventName: 'RightClaimed', args: { id: 1n, beneficiary: recovered.owner } }), data: encodeAbiParameters([{ type: 'uint256' }], [100000000000000000n]), logIndex: '0x0', transactionIndex: '0x0', transactionHash: state.hash, blockHash: '0x' + '11'.repeat(32), blockNumber: '0x1', removed: false }] } : null;
      if (url === APPROVED_TESTNET_RPCS[1] && result) {
        if (options.missingReceipt) result = null;
        else if (options.receiptDisagreement) result.logs[0].data = encodeAbiParameters([{ type: 'uint256' }], [200000000000000000n]);
      }
    } else throw new Error('Unexpected synthetic method: ' + method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(async () => { await rpcTransport.idle(); globalThis.fetch = realFetch; });
  const executor = () => createTestnetClaimExecutor({ profile: p, recovered, pendingStore: pendingStore() }, { rpcTransport });
  return { p, recovered, counts, state, records, seenUrls, attemptedUrls, executor, options };
}

test('browser transports share one FIFO per fixed endpoint across separate clients and never replay errors', async () => {
  let clock = 0;
  const configs = [], starts = [];
  const transports = createPacedRpcTransportFactory({ now: () => clock, wait: async ms => { clock += ms; }, httpTransport: (url, options) => {
    configs.push({ url, options });
    return () => ({ request: async (args, requestOptions) => {
      starts.push({ url, method: args.method, at: clock, requestOptions });
      if (args.method === 'eth_chainId') throw Object.assign(new Error('synthetic 429'), { status: 429 });
      return args.method;
    } });
  } });
  const primary = transports(APPROVED_TESTNET_RPCS[0])({});
  const anotherClient = transports(APPROVED_TESTNET_RPCS[0])({});
  const secondary = transports(APPROVED_TESTNET_RPCS[1])({});
  assert.throws(() => transports('https://unapproved.example.com'), /PUBLIC_RPC_NOT_APPROVED/);
  const results = await Promise.allSettled([
    primary.request({ method: 'eth_chainId' }, { retryCount: 0 }),
    anotherClient.request({ method: 'eth_getBalance' }, { retryCount: 0 }),
    primary.request({ method: 'eth_sendRawTransaction' }, { retryCount: 0 }),
    secondary.request({ method: 'eth_blockNumber' }, { retryCount: 0 }),
  ]);
  await transports.idle();
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.deepEqual(starts.filter(item => item.url === APPROVED_TESTNET_RPCS[0]).map(item => item.method), ['eth_chainId', 'eth_getBalance', 'eth_sendRawTransaction']);
  const primaryStarts = starts.filter(item => item.url === APPROVED_TESTNET_RPCS[0]);
  for (let index = 1; index < primaryStarts.length; index++) assert.ok(primaryStarts[index].at - primaryStarts[index - 1].at >= 250);
  assert.equal(starts.filter(item => item.method === 'eth_sendRawTransaction').length, 1);
  for (const { options } of configs) assert.deepEqual(options, { retryCount: 0, timeout: 10000, fetchOptions: { redirect: 'error' } });
});

test('one stalled endpoint does not block the other endpoint queue', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const transports = createPacedRpcTransportFactory({ httpTransport: url => () => ({ request: async () => url === APPROVED_TESTNET_RPCS[0] ? blocked : 'secondary-ready' }) });
  const first = transports(APPROVED_TESTNET_RPCS[0])({}).request({ method: 'eth_chainId' });
  assert.equal(await transports(APPROVED_TESTNET_RPCS[1])({}).request({ method: 'eth_chainId' }), 'secondary-ready');
  release('primary-ready'); assert.equal(await first, 'primary-ready');
});

test('empty/disabled and unreviewed public profiles fail closed', () => {
  assert.throws(() => validateClientProfile(undefined), /PUBLIC_RELEASE_DISABLED/);
  assert.throws(() => validateClientProfile({ enabled: false }), /PUBLIC_RELEASE_DISABLED/);
  for (const changed of [
    { chainId: 143 }, { primaryOrigin: 'http://primary.example.com' }, { recoveryOrigin: 'https://primary.example.com' }, { expectedRuntimeCodeHash: '0x00' }, { contractAddress: '0x' + '00'.repeat(20) }, { namespace: 'loose' }, { arbitraryField: true },
  ]) assert.throws(() => validateClientProfile({ ...profile(), ...changed }), /PUBLIC_PROFILE_INVALID/);
  assert.throws(() => validateClientProfile({ ...profile(), expiresAt: '2020-01-01T00:00:00.000Z' }), /PUBLIC_RELEASE_EXPIRED/);
  for (const rpcUrls of [['https://mainnet.monad.xyz'], [APPROVED_TESTNET_RPCS[0], 'https://other.example.com'], [...APPROVED_TESTNET_RPCS].reverse()]) assert.throws(() => validateClientProfile({ ...profile(), rpcUrls }), /PUBLIC_RPC_NOT_APPROVED/);
  assert.throws(() => validateClientProfile({ ...profile(), claim: { ...profile().claim, gasLimit: '300001' } }), /PUBLIC_CLAIM_NOT_APPROVED/);
  assert.throws(() => validateClientProfile({ ...profile(), claim: { ...profile().claim, rightId: '2' } }), /PUBLIC_CLAIM_NOT_APPROVED/);
});

test('local exported APIs remain restricted to chain31337', () => {
  assert.throws(() => createClaimExecutor({ chainId: 10143, wallet: { chain: { id: 10143 } } }), /LOCAL_CHAIN_REQUIRED/);
  assert.throws(() => createBrowserPendingStore({ chainId: 10143 }), /LOCAL_CHAIN_REQUIRED/);
});

test('reviewed candidate uses two fixed mocked RPCs and signs only fixed zero-value claim on10143', async t => {
  const f = fixture(t); const executor = f.executor();
  const result = await executor.claim(1n);
  assert.equal(result.hash, f.state.hash); assert.equal(result.receipt.status, 'success');
  assert.equal(f.state.signed.chainId, 10143); assert.equal(f.state.signed.to, address); assert.equal(f.state.signed.value ?? 0n, 0n);
  assert.equal(f.state.signed.gas, 120000n); assert.equal(f.state.signed.maxFeePerGas, 200000000000n); assert.equal(f.state.signed.maxPriorityFeePerGas, 2000000000n);
  assert.equal(decodeFunctionData({ abi: PAYMENT_RIGHT_ABI, data: f.state.signed.data }).args[0], 1n);
  assert.deepEqual([...f.seenUrls].sort(), [...APPROVED_TESTNET_RPCS].sort());
  await assert.rejects(executor.claim(2n), /RIGHT_NOT_APPROVED/);
  await executor.claim(1n); assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 1);
  for (const url of APPROVED_TESTNET_RPCS) {
    const requests = f.state.requests.filter(request => request.url === url);
    for (let index = 1; index < requests.length; index++) assert.ok(requests[index].at - requests[index - 1].at >= 250, 'readiness, preflight, wallet preparation and send use the same endpoint queue');
  }
});

test('HTTP429 before signing is surfaced once per queued read without reserving or signing', async t => {
  const f = fixture(t, { rpcRateLimit: true });
  await assert.rejects(f.executor().claim(1n));
  assert.equal(f.counts.signs, 0); assert.equal(f.counts.broadcasts, 0); assert.equal(f.records.size, 0);
  assert.equal(f.state.requests.filter(request => request.method === 'eth_chainId').length, 1);
});

test('HTTP429 after signing preserves the hash and does not replay or broadcast the claim', async t => {
  const f = fixture(t, { rateLimitAfterSign: true }); const executor = f.executor();
  await assert.rejects(executor.claim(1n));
  assert.match(executor.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(JSON.parse([...f.records.values()][0]).hash, executor.hash);
  f.options.rateLimitAfterSign = false;
  const checked = await executor.claim(1n);
  assert.equal(checked.hash, executor.hash); assert.equal(checked.receipt, undefined);
  assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 0);
});

test('lost broadcast response is reconciled from durable ticket by fresh public wrapper', async t => {
  const f = fixture(t, { loseResponse: true }); const first = f.executor();
  await assert.rejects(first.claim(1n)); assert.equal(first.hash, f.state.hash);
  const fresh = f.executor(); const result = await fresh.claim(1n);
  assert.equal(result.hash, first.hash); assert.equal(result.receipt.status, 'success');
  assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 1);
});

test('expiry blocks new signing but keeps existing ticket available for read-only reconciliation', async t => {
  const f = fixture(t); await f.executor().claim(1n);
  f.p.expiresAt = '2020-01-01T00:00:00.000Z';
  const expired = f.executor(); assert.equal((await expired.check()).hash, f.state.hash);
  assert.equal((await expired.claim(1n)).hash, f.state.hash); // Existing hash is a check, never a send.
  // Independent empty storage scenario: an expired profile cannot start.
  f.records.clear();
  const newExpired = f.executor();
  await assert.rejects(newExpired.claim(1n), /PUBLIC_RELEASE_EXPIRED/); assert.equal(f.counts.signs, 1);
});

for (const [label, option, code] of [
  ['disagreeing chain', 'wrongChain', 'TESTNET_CHAIN_MISMATCH'],
  ['wrong runtime', 'wrongRuntime', 'TESTNET_RUNTIME_MISMATCH'],
  ['wrong beneficiary', 'wrongBeneficiary', 'TESTNET_RIGHT_MISMATCH'],
  ['changed nonce', 'wrongNonce', 'TESTNET_NONCE_NOT_APPROVED'],
  ['fee cap', 'highBaseFee', 'TESTNET_FEE_CAP_EXCEEDED'],
  ['estimate cap', 'highEstimate', 'TESTNET_GAS_NOT_APPROVED'],
  ['insufficient fee balance', 'lowBalance', 'TESTNET_FEE_BALANCE_INSUFFICIENT'],
]) test('public preflight rejects ' + label + ' before signing', async t => {
  const f = fixture(t, { [option]: true });
  await assert.rejects(f.executor().claim(1n), new RegExp(code));
  assert.equal(f.counts.signs, 0); assert.equal(f.counts.broadcasts, 0);
});

test('runtime changed after signing blocks broadcast while preserving public hash ticket', async t => {
  const f = fixture(t, { changeRuntimeAfterSign: true }); const executor = f.executor();
  await assert.rejects(executor.claim(1n), /TESTNET_RUNTIME_MISMATCH/);
  assert.match(executor.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(JSON.parse([...f.records.values()][0]).hash, executor.hash);
  assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 0);
});


test('client expiry rejects beyond45days even for read-only profile validation', () => {
  const now = Date.now();
  const boundary = { ...profile(), expiresAt: new Date(now + 45 * 86400000).toISOString() };
  assert.equal(validateClientProfile(boundary, { now }).expiresAt, boundary.expiresAt);
  const excessive = { ...boundary, expiresAt: new Date(now + 45 * 86400000 + 1).toISOString() };
  assert.throws(() => validateClientProfile(excessive, { now }), /PUBLIC_PROFILE_INVALID/);
  assert.throws(() => validateClientProfile(excessive, { now, allowExpired: true }), /PUBLIC_PROFILE_INVALID/);
});

test('RPC redirect failure stops before signing and never follows an external URL', async t => {
  const f = fixture(t, { rpcRedirect: true });
  await assert.rejects(f.executor().claim(1n), /redirect rejected/);
  assert.equal(f.counts.signs, 0); assert.equal(f.counts.broadcasts, 0);
  assert.ok(f.attemptedUrls.every(url => APPROVED_TESTNET_RPCS.includes(url)));
});

test('CCIP OffchainLookup returned by approved RPC is rejected without offchain fetching', async t => {
  const f = fixture(t, { offchainLookup: true });
  await assert.rejects(f.executor().claim(1n));
  assert.equal(f.counts.signs, 0); assert.equal(f.counts.broadcasts, 0);
  assert.ok(f.attemptedUrls.every(url => APPROVED_TESTNET_RPCS.includes(url)));
});

test('actual serialized nonce1 is rejected although both RPC preflights report approved nonce0', async t => {
  const f = fixture(t, { signWrongNonce: true });
  await assert.rejects(f.executor().claim(1n), /TRANSACTION_SCOPE_MISMATCH/);
  assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 0);
  assert.equal(JSON.parse([...f.records.values()][0]).phase, 'reserved');
});


test('public completion corroborates two receipts and reads both states at the canonical finalized receipt block', async t => {
  const f = fixture(t); const result = await f.executor().claim(1n);
  assert.equal(result.receipt.status, 'success');
  assert.deepEqual([...f.state.receiptUrls].sort(), [...APPROVED_TESTNET_RPCS].sort());
  assert.equal(f.state.stateReads.length, 4);
  for (const url of APPROVED_TESTNET_RPCS) assert.deepEqual(f.state.stateReads.filter(read => read.url === url).map(read => read.functionName).sort(), ['getRight', 'rightForOwner']);
  assert.ok(f.state.stateReads.every(read => read.block === '0x1'));
});

for (const [label, flag] of [['one finalized head lags', 'notFinalized'], ['one RPC lacks the receipt', 'missingReceipt']]) test(label + ' remains pending and later reconciles without another send', async t => {
  const f = fixture(t, { [flag]: true }); const first = f.executor();
  const pending = await first.claim(1n);
  assert.equal(pending.hash, f.state.hash); assert.equal(pending.receipt, undefined);
  assert.equal(f.state.stateReads.length, 0);
  f.options[flag] = false;
  const reconciled = await f.executor().check();
  assert.equal(reconciled.receipt.status, 'success'); assert.equal(reconciled.hash, pending.hash);
  assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 1);
});

for (const [label, flag, code] of [
  ['receipt event disagreement', 'receiptDisagreement', 'TESTNET_RECEIPT_DISAGREEMENT'],
  ['canonical block mismatch', 'canonicalMismatch', 'TESTNET_CANONICAL_BLOCK_MISMATCH'],
  ['canonical block changes during state reads', 'canonicalChangesAfterState', 'TESTNET_CANONICAL_BLOCK_MISMATCH'],
  ['state not claimed', 'stateNotClaimed', 'TESTNET_CLAIMED_STATE_MISMATCH'],
  ['state owner mismatch', 'wrongStateOwner', 'TESTNET_CLAIMED_STATE_MISMATCH'],
  ['state amount mismatch', 'wrongStateAmount', 'TESTNET_CLAIMED_STATE_MISMATCH'],
  ['owner right mapping mismatch', 'wrongStateMapping', 'TESTNET_CLAIMED_STATE_MISMATCH'],
]) test('public confirmation rejects ' + label + ' and retains the one signed attempt', async t => {
  const f = fixture(t, { [flag]: true }); const first = f.executor();
  await assert.rejects(first.claim(1n), new RegExp(code));
  assert.equal(first.hash, f.state.hash); assert.equal(JSON.parse([...f.records.values()][0]).hash, f.state.hash);
  const fresh = f.executor(); await assert.rejects(fresh.claim(1n), new RegExp(code));
  assert.equal(f.counts.signs, 1); assert.equal(f.counts.broadcasts, 1);
});
