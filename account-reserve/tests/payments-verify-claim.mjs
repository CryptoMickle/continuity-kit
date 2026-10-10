import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PAYMENT_ABI, PAYMENT_LIMITS } from '../payments/guard.mjs';
import { parseClaimVerificationArguments, runClaimVerification } from '../payments/verify-claim.mjs';
import { APPROVED_TESTNET_RPCS } from '../release/client-profile.mjs';
import { publicTestnetTransport } from '../release/paced-rpc.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const h = n => '0x' + n.toString(16).padStart(64, '0');
// Deterministic unfunded fixture. Only this offline fixture signs anything.
const account = privateKeyToAccount('0x' + '03'.repeat(32));
const signed = await account.signTransaction({ chainId: 10143, type: 'eip1559', to: address(1), data: encodeFunctionData({ abi: PAYMENT_ABI, functionName: 'claim', args: [1n] }), value: 0n, nonce: 1, ...PAYMENT_LIMITS });
const hash = keccak256(signed), signature = parseTransaction(signed);
const args = (path = 'public-profile.json', id = '1', transactionHash = hash) => ['--profile', path, '--right-id', id, '--hash', transactionHash];
const code = expected => error => error.code === expected && error.message === expected;
const cli = fileURLToPath(new URL('../payments/verify-claim.mjs', import.meta.url));

function fixture() {
  const profile = { chainId: 10143, address: address(1), owner: account.address, issuer: address(3), expectedRuntimeCodeHash: keccak256('0x6000'), expiresAt: '2020-01-01T00:00:00.000Z', claims: [{ rightId: '1', amount: '10000000000000000', nonce: 1 }, { rightId: '2', amount: '10000000000000000', nonce: 2 }] };
  const block = { number: 100n, hash: h(10) };
  const receipt = { transactionHash: hash, blockHash: block.hash, blockNumber: 100n, transactionIndex: 0, from: profile.owner, to: profile.address, type: 'eip1559', contractAddress: null, status: 'success', gasUsed: 30000n, effectiveGasPrice: 1n, logs: [{ address: profile.address, topics: encodeEventTopics({ abi: PAYMENT_ABI, eventName: 'RightClaimed', args: { id: 1n, beneficiary: profile.owner } }), data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(profile.claims[0].amount)]), blockHash: block.hash, blockNumber: 100n, transactionHash: hash, transactionIndex: 0, logIndex: 0, removed: false }] };
  const transaction = { ...signature, hash, from: profile.owner, to: profile.address, input: signature.data, value: 0n, blockHash: block.hash, blockNumber: 100n, transactionIndex: 0 };
  const calls = [];
  const client = {
    async getChainId() { calls.push('chain'); return 10143; },
    async getCode() { calls.push('code'); return '0x6000'; },
    async readContract(query) { calls.push(query.functionName); return query.functionName === 'issuer' ? profile.issuer : { beneficiary: profile.owner, amount: BigInt(profile.claims[0].amount), claimed: true }; },
    async getBlock() { calls.push('block'); return block; },
    async getTransactionReceipt() { calls.push('receipt'); return receipt; },
    async getTransaction() { calls.push('transaction'); return transaction; },
    async sendRawTransaction() { assert.fail('verifier must never broadcast'); },
    async signTransaction() { assert.fail('verifier must never sign'); },
  };
  const clients = [client, { ...client }];
  return { profile, block, receipt, transaction, calls, clients, deps: { readProfile: async () => JSON.stringify(profile), createClients: () => clients } };
}

test('only the three explicit arguments are accepted, without reading or constructing clients', async () => {
  const parsed = parseClaimVerificationArguments(args('public.json', '2', hash.toUpperCase()));
  assert.deepEqual(parsed, { profile: 'public.json', rightId: 2n, hash }); assert.ok(Object.isFrozen(parsed));
  let reads = 0, factories = 0, getters = 0;
  const accessor = Object.defineProperty(args(), '1', { enumerable: true, get() { getters++; return 'public.json'; } });
  for (const input of [[], args().slice(0, 4), [...args(), '--rpc', 'https://untrusted.invalid'], [...args(), '--signer', 'secret'], [...args(), '--approval', 'approval.json'], [...args(), '--journal', 'journal'], [...args(), '--reset', 'true'], ['--profile', 'x', '--profile', 'y', '--hash', hash], args('x', '01'), args('x', '0'), args('x', '-1'), args('x', '1e2'), args('x', '1\n'), args('x', String(2n ** 256n)), args('x', '1', hash + '\n'), args('x', '1', '0x01'), args(''), args('x\0y'), accessor]) {
    await assert.rejects(runClaimVerification(input, { readProfile: async () => { reads++; }, createClients: () => { factories++; } }), code('CLAIM_ARGUMENTS_INVALID'));
  }
  assert.deepEqual({ reads, factories, getters }, { reads: 0, factories: 0, getters: 0 });
});

test('public JSON policy, testnet chain and selected approved right are validated before factory construction', async () => {
  let factories = 0;
  const factory = () => { factories++; throw new Error('must not construct'); };
  const p = fixture().profile;
  for (const profile of [{ ...p, signer: 'private' }, { ...p, rpc: 'https://untrusted.invalid' }, { ...p, claims: [{ ...p.claims[0], amount: 1 }] }, { ...p, claims: [{ ...p.claims[0], rightId: '01' }] }, { ...p, claims: [{ ...p.claims[0], rightId: '1\n' }] }, { ...p, claims: [{ ...p.claims[0], amount: '1\n' }] }, { ...p, claims: [p.claims[0], p.claims[0]] }, { ...p, owner: p.address }]) {
    await assert.rejects(runClaimVerification(args(), { readProfile: async () => JSON.stringify(profile), createClients: factory }), code('CLAIM_PROFILE_INVALID'));
  }
  for (const invalid of ['', '{', ' '.repeat(16385), new String(JSON.stringify(p))]) await assert.rejects(runClaimVerification(args(), { readProfile: async () => invalid, createClients: factory }), code('CLAIM_PROFILE_INVALID'));
  await assert.rejects(runClaimVerification(args(), { readProfile: async () => JSON.stringify({ ...p, chainId: 31337 }), createClients: factory }), code('PAYMENT_TESTNET_REQUIRED'));
  await assert.rejects(runClaimVerification(args('public.json', '3'), { readProfile: async () => JSON.stringify(p), createClients: factory }), code('PAYMENT_NOT_APPROVED'));
  assert.equal(factories, 0);
});

test('a corroborated authentic finalized receipt is verified after profile expiry without signer or journal', async () => {
  const f = fixture(), result = await runClaimVerification(args(), f.deps);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { chainId: 10143, contract: f.profile.address, beneficiary: f.profile.owner, rightId: '1', amount: f.profile.claims[0].amount, hash, readOnly: true, status: 'finalized', finalized: true, paymentVerified: true, blockNumber: '100', blockHash: f.block.hash });
  assert.ok(Object.isFrozen(result)); assert.equal(f.calls.filter(name => name === 'receipt').length, 2); assert.equal(f.calls.filter(name => name === 'transaction').length, 2);
});

test('missing receipts and unfinished finality are pending-or-unknown, never a verified payment', async () => {
  for (const missing of [true, false]) {
    const f = fixture();
    if (missing) f.clients[1].getTransactionReceipt = async () => { throw Object.assign(new Error('provider detail'), { name: 'TransactionReceiptNotFoundError' }); };
    else f.clients[1].getBlock = async query => query.blockTag ? { number: 99n, hash: h(9) } : f.block;
    const result = await runClaimVerification(args(), f.deps);
    assert.equal(result.status, 'pending-or-unknown'); assert.equal(result.finalized, false); assert.equal(result.paymentVerified, false); assert.equal(result.blockNumber, undefined);
    assert.ok(!JSON.stringify(result).includes('provider detail'));
  }
});

test('a finalized reverted receipt is explicitly distinguished from successful payment', async () => {
  const f = fixture(); f.receipt.status = 'reverted'; f.receipt.logs = [];
  const result = await runClaimVerification(args(), f.deps);
  assert.equal(result.status, 'reverted'); assert.equal(result.finalized, true); assert.equal(result.paymentVerified, false); assert.equal(result.blockNumber, '100');
});

test('the existing guard rejects provider disagreement, wrong events and forged signed hashes', async () => {
  for (const [mutate, expected] of [
    [f => { f.clients[1].getTransactionReceipt = async () => ({ ...f.receipt, gasUsed: 1n }); }, 'PAYMENT_RECEIPT_DISAGREEMENT'],
    [f => { f.receipt.logs = []; }, 'PAYMENT_EVENT_MISMATCH'],
    [f => { f.transaction.gas -= 1n; }, 'PAYMENT_TRANSACTION_HASH_MISMATCH'],
    [f => { f.clients[1].getTransactionReceipt = async () => { throw new Error('secret provider message'); }; }, 'PAYMENT_RECEIPT_UNAVAILABLE'],
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(runClaimVerification(args(), f.deps), code(expected));
  }
});

test('unexpected provider and factory errors expose only a fixed diagnostic', async () => {
  const f = fixture(); f.clients[1].getTransaction = async () => { throw Object.assign(new Error('private path/token'), { code: 'PRIVATE_PROVIDER_DATA' }); };
  await assert.rejects(runClaimVerification(args(), f.deps), code('CLAIM_VERIFICATION_FAILED'));
  let invoked = 0;
  await assert.rejects(runClaimVerification(args(), { ...f.deps, createClients() { throw Object.defineProperty(new Error('private'), 'code', { get() { invoked++; return 'private'; } }); } }), code('CLAIM_VERIFICATION_FAILED'));
  assert.equal(invoked, 0);
});

test('default factory uses exactly both fixed paced public RPCs for reads despite environment overrides', async t => {
  const f = fixture(), requests = [];
  const previous = process.env.MONAD_RPC_URL; process.env.MONAD_RPC_URL = 'https://untrusted.invalid';
  t.after(() => { if (previous === undefined) delete process.env.MONAD_RPC_URL; else process.env.MONAD_RPC_URL = previous; });
  const mocked = t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url: String(url), method: body.method, redirect: init.redirect });
    assert.equal(body.method, 'eth_getTransactionReceipt');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await runClaimVerification(args(), { readProfile: f.deps.readProfile });
  await publicTestnetTransport.idle(); mocked.mock.restore();
  assert.equal(result.status, 'pending-or-unknown'); assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.url).sort(), APPROVED_TESTNET_RPCS.map(url => new URL(url).href).sort());
  assert.ok(requests.every(request => request.redirect === 'error'));
});

test('bounded file reads and the actual CLI reject unsafe inputs without modifying any files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'payment-receipt-readonly-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = join(directory, 'profile.json'), oversized = join(directory, 'large.json'), alias = join(directory, 'alias.json');
  await writeFile(profile, JSON.stringify(fixture().profile)); await writeFile(oversized, ' '.repeat(16385)); await symlink(profile, alias);
  const before = await Promise.all([profile, oversized].map(async path => [await readFile(path, 'utf8'), (await stat(path)).mtimeMs]));
  let factories = 0;
  for (const path of [directory, oversized, alias, join(directory, 'absent.json')]) await assert.rejects(runClaimVerification(args(path), { createClients() { factories++; } }), code('CLAIM_PROFILE_UNAVAILABLE'));
  await assert.rejects(runClaimVerification(args(profile, '3'), { createClients() { factories++; } }), code('PAYMENT_NOT_APPROVED'));
  assert.equal(factories, 0);
  for (const argv of [[...args(profile), '--signer', 'do-not-echo'], args(profile, '3'), args(alias)]) {
    const processResult = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', timeout: 10000 });
    assert.equal(processResult.status, 1); assert.equal(processResult.stdout, '');
    const result = JSON.parse(processResult.stderr); assert.equal(result.status, 'error'); assert.equal(result.paymentVerified, false); assert.equal(result.readOnly, true);
    assert.ok(!processResult.stderr.includes(directory) && !processResult.stderr.includes('do-not-echo'));
  }
  assert.deepEqual(await readdir(directory), ['alias.json', 'large.json', 'profile.json']);
  assert.deepEqual(await Promise.all([profile, oversized].map(async path => [await readFile(path, 'utf8'), (await stat(path)).mtimeMs])), before);
});
