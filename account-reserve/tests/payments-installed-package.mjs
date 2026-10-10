import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
async function execute(cwd, args, timeout = 45000) {
  const env = { ...process.env, NODE_PATH: '', NODE_NO_WARNINGS: '1', FORCE_COLOR: '0', PATH: dirname(process.execPath) + ':' + process.env.PATH,
    npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_offline: 'true', npm_config_update_notifier: 'false' };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { if (output.length < 2 * 1024 * 1024) output += bytes; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 && !timedOut ? resolve(output) : reject(Error('INSTALLED_PAYMENT_CHECK_FAILED: ' + output)); });
  });
}

// Copied as a standalone consumer program, so none of its imports resolve to
// the checkout. The real public transport is exercised through mocked fetch.
async function installedBehavior() {
  const { default: assert } = await import('node:assert/strict');
  const api = await import('@continuitykit/account-reserve/payments');
  const { createSecp256k1SigningSession } = await import('@category-labs/mera');
  const { toViemAccount } = await import('@category-labs/mera/viem');
  const { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, keccak256, parseAbi, parseTransaction, toHex } = await import('viem');
  const { createTestnetPaymentClient, createTestnetPaymentReader } = api;
  const { createPaymentActions } = await import('./payment-actions.mjs');
  assert.deepEqual(Object.keys(api).sort(), ['createTestnetPaymentAvailability', 'createTestnetPaymentClient', 'createTestnetPaymentReader', 'createTestnetPaymentVerifier']);
  await assert.rejects(import('@continuitykit/account-reserve/payments/testnet.mjs'), error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  const abi = parseAbi(['function claim(uint256 id)', 'function issuer() view returns (address)', 'function rightForOwner(address owner) view returns (uint256)', 'function getRight(uint256 id) view returns ((address beneficiary,uint256 amount,bool claimed))', 'event RightClaimed(uint256 indexed id,address indexed beneficiary,uint256 amount)']);
  const secret = new Uint8Array(32).fill(3), address = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'), issuer = getAddress('0xbcdefabcdefabcdefabcdefabcdefabcdefabcde');
  const endpointNames = ['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com'];
  const key = n => '0x' + n.toString(16).padStart(64, '0');
  const code = expected => error => error.code === expected;
  let signatures = 0, sends = 0, closures = 0, nativeCalls = 0, writes = 0, nativeRequests = 0, inLock = 0, maxInLock = 0;
  const realNow = Date.now, originalFetch = globalThis.fetch;
  const sessions = [], actions = [], calls = [], lockNames = [], values = new Map(), transactions = new Map(), receipts = new Map(), scenarios = [];
  let queue = Promise.resolve(), finalized = false, corruptPrevious = false, currentRight = 1n;
  const storage = { getItem: name => values.get(name) ?? null, setItem(name, value) { writes++; values.set(name, value); } };
  const journal = () => values.size ? JSON.parse([...values.values()][0]) : undefined;
  const locks = { request(name, options, callback) {
    assert.deepEqual(options, { mode: 'exclusive' }); lockNames.push(name);
    const pending = queue.then(async () => { inLock++; maxInLock = Math.max(maxInLock, inLock); try { return await callback({ name, mode: 'exclusive' }); } finally { inLock--; } });
    queue = pending.catch(() => {}); return pending;
  } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { get() { nativeCalls++; throw Error('NATIVE_FORBIDDEN'); }, create() { nativeCalls++; throw Error('NATIVE_FORBIDDEN'); } } } });
  function recovered() {
    const session = createSecp256k1SigningSession({ privateKey: secret }), original = toViemAccount(session); sessions.push(session);
    const account = { ...original, async signTransaction(...args) { signatures++; assert.equal(journal().entries.at(-1).phase, 'reserved'); return original.signTransaction(...args); } };
    return { owner: original.address, account, close() { closures++; session.end(); } };
  }
  const firstSigner = recovered();
  const profile = { chainId: 10143, address, owner: firstSigner.owner, issuer, expectedRuntimeCodeHash: keccak256('0x6000'), expiresAt: new Date(realNow() + 86400000).toISOString(), claims: [{ rightId: 1n, amount: 10n ** 16n, nonce: 0 }, { rightId: 2n, amount: 10n ** 16n, nonce: 1 }] };
  const options = { profile, storage, locks };
  const latest = () => ({ number: toHex(100n + BigInt(transactions.size)), hash: key(100 + transactions.size), timestamp: toHex(BigInt(Math.floor(Date.now() / 1000))), baseFeePerGas: '0x1', transactions: [] });
  globalThis.fetch = async (url, init) => {
    nativeRequests++;
    assert.ok(endpointNames.includes(new URL(url).origin), 'network outside fixed publicRPC names is forbidden');
    assert.equal(init.redirect, 'error');
    const { id, method, params } = JSON.parse(init.body); calls.push({ endpoint: new URL(url).origin, method, params });
    let result;
    switch (method) {
      case 'eth_chainId': result = '0x279f'; break;
      case 'eth_getCode': result = params[0].toLowerCase() === address.toLowerCase() ? '0x6000' : '0x'; break;
      case 'eth_getTransactionCount': result = toHex(transactions.size); break;
      case 'eth_getBalance': result = toHex(10n ** 18n); break;
      case 'eth_estimateGas': result = '0xc350'; break;
      case 'eth_getBlockByNumber': result = /^0x/.test(params[0]) ? { ...latest(), number: params[0], hash: key(Number(BigInt(params[0]))) } : latest(); break;
      case 'eth_call': {
        const call = decodeFunctionData({ abi, data: params[0].data }); let answer;
        if (call.functionName === 'issuer') answer = issuer;
        else if (call.functionName === 'rightForOwner') answer = currentRight;
        else if (call.functionName === 'getRight') answer = { beneficiary: profile.owner, amount: profile.claims[Number(call.args[0]) - 1].amount, claimed: [...transactions.values()].some(tx => tx.right === call.args[0]) };
        else assert.fail('unexpected read');
        result = encodeFunctionResult({ abi, functionName: call.functionName, result: answer }); break;
      }
      case 'eth_sendRawTransaction': {
        sends++; const raw = params[0], parsed = parseTransaction(raw), hash = keccak256(raw), right = decodeFunctionData({ abi, data: parsed.data }).args[0];
        assert.equal(journal().entries.at(-1).phase, 'signed'); assert.equal(journal().entries.at(-1).hash, hash);
        assert.equal(journal().entries.length, Number(right)); assert.equal(parsed.nonce, Number(right) - 1);
        const number = 100 + Number(right), blockHash = key(number), blockNumber = toHex(number);
        transactions.set(hash, { right, hash, from: profile.owner, to: address, input: parsed.data, value: '0x0', nonce: toHex(parsed.nonce), chainId: '0x279f', type: '0x2', gas: toHex(parsed.gas), maxFeePerGas: toHex(parsed.maxFeePerGas), maxPriorityFeePerGas: toHex(parsed.maxPriorityFeePerGas), accessList: [], r: parsed.r, s: parsed.s, yParity: toHex(parsed.yParity), v: toHex(BigInt(parsed.yParity)), blockHash, blockNumber, transactionIndex: '0x0' });
        receipts.set(hash, { transactionHash: hash, from: profile.owner, to: address, contractAddress: null, blockHash, blockNumber, transactionIndex: '0x0', type: '0x2', status: '0x1', gasUsed: '0x7530', cumulativeGasUsed: '0x7530', effectiveGasPrice: '0x1', logsBloom: '0x' + '0'.repeat(512), logs: [{ address, topics: encodeEventTopics({ abi, eventName: 'RightClaimed', args: { id: right, beneficiary: profile.owner } }), data: encodeAbiParameters([{ type: 'uint256' }], [profile.claims[Number(right) - 1].amount]), blockHash, blockNumber, transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false }] });
        if (right === 1n) throw Error('simulated response lost after node acceptance');
        result = hash; break;
      }
      case 'eth_getTransactionReceipt': {
        result = finalized ? receipts.get(params[0]) ?? null : null;
        if (result && corruptPrevious && transactions.get(params[0]).right === 1n) result = { ...result, logs: [] };
        break;
      }
      case 'eth_getTransactionByHash': result = transactions.get(params[0]); break;
      default: assert.fail('unexpectedRPC method ' + method);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }, (_, value) => typeof value === 'bigint' ? toHex(value) : value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    let getterCalls = 0;
    for (const input of [{ ...options, rpcTransport() {} }, { ...options, rpcUrl: endpointNames[0] }, Object.defineProperty({ ...options }, 'profile', { enumerable: true, get() { getterCalls++; return profile; } })]) assert.throws(() => createTestnetPaymentReader(input), code('PAYMENT_OPTIONS_INVALID'));
    assert.throws(() => createTestnetPaymentReader(options, {}), code('PAYMENT_OPTIONS_INVALID'));
    assert.throws(() => createTestnetPaymentClient({ ...options, recovered: firstSigner }, {}), code('PAYMENT_OPTIONS_INVALID'));
    assert.throws(() => createTestnetPaymentReader({ ...options, profile: { ...profile, chainId: 31337 } }), code('PAYMENT_TESTNET_REQUIRED'));
    const reader = createTestnetPaymentReader(options), first = createPaymentActions({ ...options, openExistingAccount: async () => firstSigner, lifetimeTarget: new EventTarget() }); actions.push(first);
    assert.equal(getterCalls, 0); assert.equal(nativeRequests, 0); await assert.rejects(reader.check(1n), code('PAYMENT_TRANSACTION_MISSING')); assert.equal(nativeRequests, 0);
    scenarios.push('strict public boundary and inert construction');

    await first.open();
    const competingSigner = recovered(), competing = createTestnetPaymentClient({ ...options, recovered: competingSigner });
    const blocked = competing.forRight(2n);
    const attempts = await Promise.allSettled([first.collect(1n), blocked.claim()]);
    assert.equal(attempts[0].status, 'rejected'); assert.equal(attempts[0].reason.code, 'PAYMENT_BROADCAST_UNKNOWN');
    assert.equal(attempts[1].status, 'rejected'); assert.equal(attempts[1].reason.code, 'PAYMENT_ACCOUNT_BLOCKED');
    assert.equal(signatures, 1); assert.equal(sends, 1); assert.equal(maxInLock, 1); assert.equal(new Set(lockNames).size, 1);
    const firstHash = journal().entries[0].hash;
    assert.deepEqual(await competing.forRight(1n).claim(), { hash: firstHash }); assert.equal(signatures, 1); assert.equal(sends, 1);
    scenarios.push('account lock and unknown send never replay');

    assert.equal(first.isOpen, false); assert.equal(closures, 1); // Unknown send closed the helper's signer in finally.
    blocked.close(); assert.equal(closures, 1); // An executor is not the signer owner.
    competing.close(); assert.equal(closures, 2);
    await assert.rejects(firstSigner.account.signMessage({ message: 'must be closed' }), code('SESSION_ENDED'));
    await assert.rejects(competingSigner.account.signMessage({ message: 'must be closed' }), code('SESSION_ENDED'));
    await assert.rejects(first.collect(1n), code('PAYMENT_SESSION_CLOSED')); assert.throws(() => blocked.claim(), code('PAYMENT_SESSION_CLOSED'));
    scenarios.push('unknown-send helper finally and explicit client closure end actual Mera signers');

    const beforePending = writes;
    assert.deepEqual(await first.check(1n), { hash: firstHash }); assert.equal(writes, beforePending);
    finalized = true; currentRight = 2n;
    const confirmed = await first.check(1n); assert.equal(confirmed.receipt.status, 'success'); assert.equal(journal().active, null); assert.equal(writes, beforePending + 1);
    await reader.check(1n); assert.equal(writes, beforePending + 1); assert.equal(signatures, 1); assert.equal(sends, 1);
    scenarios.push('credential-free reconciliation survives signer closure');

    let secondSigner;
    const second = createPaymentActions({ ...options, openExistingAccount: async () => secondSigner = recovered(), lifetimeTarget: new EventTarget() }); actions.push(second); await second.open();
    corruptPrevious = true; const beforeRejected = writes;
    await assert.rejects(second.collect(2n), code('PAYMENT_EVENT_MISMATCH')); assert.equal(writes, beforeRejected); assert.equal(signatures, 1); assert.equal(sends, 1);
    assert.equal(second.isOpen, false); await assert.rejects(secondSigner.account.signMessage({ message: 'failed preflight closed signer' }), code('SESSION_ENDED'));
    corruptPrevious = false; await second.open();
    const secondResult = await second.collect(2n); assert.equal(secondResult.receipt.status, 'success'); assert.equal(signatures, 2); assert.equal(sends, 2);
    assert.equal(second.isOpen, false); await assert.rejects(secondSigner.account.signMessage({ message: 'success closed signer' }), code('SESSION_ENDED'));
    const settled = JSON.stringify(journal()), beforeRepeat = writes;
    await second.open(); assert.equal((await second.collect(1n)).receipt.status, 'success'); assert.equal((await second.check(2n)).receipt.status, 'success');
    assert.equal(JSON.stringify(journal()), settled); assert.equal(writes, beforeRepeat); assert.equal(signatures, 2); assert.equal(sends, 2);
    assert.deepEqual(journal().entries.map(entry => [entry.rightId, entry.nonce, entry.phase]), [['1', 0, 'confirmed'], ['2', 1, 'confirmed']]);
    await assert.rejects(secondSigner.account.signMessage({ message: 'completed intent also closed signer' }), code('SESSION_ENDED'));
    scenarios.push('prior receipt rechecked, next approved nonce settles once and helper success closes signer');

    const beforeBroken = nativeRequests;
    const broken = createTestnetPaymentReader({ ...options, storage: { getItem() { throw Error('storage unavailable'); }, setItem() { assert.fail(); } } });
    await assert.rejects(broken.check(1n), code('PAYMENT_STORE_UNAVAILABLE')); assert.equal(nativeRequests, beforeBroken);
    assert.equal(nativeCalls, 0); assert.ok(calls.every(call => endpointNames.includes(call.endpoint))); assert.deepEqual([...new Set(calls.map(call => call.endpoint))].sort(), endpointNames.sort());
    assert.ok([...values.values()].every(value => !value.includes(Buffer.from(secret).toString('hex')) && !value.includes('serializedTransaction')));
    scenarios.push('persistence failure closes safely and no native credentials');
    // Only publicly observable material crosses into the fresh verifier process.
    // No account object, private key, browser journal or lock adapter is exported.
    await (await import('node:fs/promises')).writeFile('public-claim-fixture.json', JSON.stringify({ profile, hash: firstHash, transaction: transactions.get(firstHash), receipt: receipts.get(firstHash) }, (_, value) => typeof value === 'bigint' ? value.toString() : value), { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ scenarios, nativeCalls, publicNetwork: false, rpcSimulated: true, actualEvm: false, signatures, sends, closures, maxConcurrentLockOwners: maxInLock, fixedRpcNames: true, journalEntries: journal().entries.length }) + '\n');
  } finally { actions.forEach(action => action.dispose()); sessions.forEach(session => session.end()); secret.fill(0); globalThis.fetch = originalFetch; }
}

async function installedStatelessVerifier() {
  const { default: assert } = await import('node:assert/strict');
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile('public-claim-fixture.json', 'utf8'));
  assert.deepEqual(Object.keys(fixture).sort(), ['hash', 'profile', 'receipt', 'transaction']);
  let forbiddenAccess = 0, calls = [], mode = 'finalized';
  const forbidden = () => { forbiddenAccess++; throw Error('BROWSER_PERSISTENCE_OR_CREDENTIAL_ACCESS_FORBIDDEN'); };
  for (const property of ['localStorage', 'navigator']) Object.defineProperty(globalThis, property, { configurable: true, get: forbidden });
  globalThis.fetch = () => { throw Error('NETWORK_DURING_IMPORT_FORBIDDEN'); };
  const { createTestnetPaymentVerifier } = await import('@continuitykit/account-reserve/payments');
  const { decodeFunctionData, encodeFunctionResult, parseAbi } = await import('viem');
  const abi = parseAbi(['function issuer() view returns (address)', 'function getRight(uint256 id) view returns ((address beneficiary,uint256 amount,bool claimed))']);
  const profile = { ...fixture.profile, expiresAt: '2020-01-01T00:00:00.000Z', claims: fixture.profile.claims.map(claim => ({ ...claim, rightId: BigInt(claim.rightId), amount: BigInt(claim.amount) })) };
  const code = expected => error => error.code === expected;
  const allowed = ['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com'];
  globalThis.fetch = async (url, init) => {
    assert.ok(allowed.includes(new URL(url).origin)); assert.equal(init.redirect, 'error');
    const request = JSON.parse(init.body), { method, params } = request; calls.push({ endpoint: new URL(url).origin, method });
    let result;
    switch (method) {
      case 'eth_getTransactionReceipt':
        assert.equal(params[0], fixture.hash);
        result = mode === 'pending' ? null : mode === 'reverted' ? { ...fixture.receipt, status: '0x0', logs: [] } : mode === 'mismatch' ? { ...fixture.receipt, logs: [] } : fixture.receipt;
        break;
      case 'eth_getTransactionByHash': assert.equal(params[0], fixture.hash); result = fixture.transaction; break;
      case 'eth_chainId': result = '0x279f'; break;
      case 'eth_getCode': assert.equal(params[0].toLowerCase(), profile.address.toLowerCase()); result = '0x6000'; break;
      case 'eth_getBlockByNumber': result = { number: fixture.receipt.blockNumber, hash: fixture.receipt.blockHash, transactions: [] }; break;
      case 'eth_call': {
        const call = decodeFunctionData({ abi, data: params[0].data });
        const resultValue = call.functionName === 'issuer' ? profile.issuer : { beneficiary: profile.owner, amount: profile.claims[0].amount, claimed: true };
        if (call.functionName === 'getRight') assert.equal(call.args[0], 1n);
        result = encodeFunctionResult({ abi, functionName: call.functionName, result: resultValue }); break;
      }
      default: assert.fail('stateless verifier attempted nonreceipt operation: ' + method);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  for (const option of [{ profile, storage: {} }, { profile, locks: {} }, { profile, recovered: {} }, { profile, rpcTransport() {} }]) assert.throws(() => createTestnetPaymentVerifier(option), code('PAYMENT_OPTIONS_INVALID'));
  assert.throws(() => createTestnetPaymentVerifier({ profile }, {}), code('PAYMENT_OPTIONS_INVALID'));
  const verifier = createTestnetPaymentVerifier({ profile }); assert.equal(calls.length, 0);
  let queryGetters = 0;
  for (const query of [{ rightId: 1n }, { rightId: '1', hash: fixture.hash }, { rightId: 1n, hash: fixture.hash + '\n' }, { rightId: 1n, hash: fixture.hash, rpcUrl: allowed[0] }, Object.defineProperty({ rightId: 1n }, 'hash', { enumerable: true, get() { queryGetters++; return fixture.hash; } })]) {
    await assert.rejects(async () => verifier.check(query), code('PAYMENT_VERIFICATION_INPUT_INVALID'));
  }
  await assert.rejects(async () => verifier.check({ rightId: 1n, hash: fixture.hash }, {}), code('PAYMENT_VERIFICATION_INPUT_INVALID'));
  await assert.rejects(async () => verifier.check({ rightId: 3n, hash: fixture.hash }), code('PAYMENT_NOT_APPROVED'));
  assert.equal(calls.length, 0); assert.equal(forbiddenAccess, 0); assert.equal(queryGetters, 0);
  const good = await verifier.check({ rightId: 1n, hash: fixture.hash });
  assert.equal(good.status, 'finalized'); assert.equal(good.finalized, true); assert.equal(good.paymentVerified, true); assert.equal(good.rightId, 1n); assert.equal(good.amount, profile.claims[0].amount); assert.equal(good.hash, fixture.hash); assert.equal(good.blockNumber, BigInt(fixture.receipt.blockNumber)); assert.ok(Object.isFrozen(good));
  mode = 'pending'; const pending = await verifier.check({ rightId: 1n, hash: fixture.hash });
  assert.equal(pending.status, 'pending-or-unknown'); assert.equal(pending.finalized, false); assert.equal(pending.paymentVerified, false); assert.equal(Object.hasOwn(pending, 'blockNumber'), false);
  mode = 'reverted'; const reverted = await verifier.check({ rightId: 1n, hash: fixture.hash });
  assert.equal(reverted.status, 'reverted'); assert.equal(reverted.finalized, true); assert.equal(reverted.paymentVerified, false);
  mode = 'mismatch'; await assert.rejects(verifier.check({ rightId: 1n, hash: fixture.hash }), code('PAYMENT_EVENT_MISMATCH'));
  assert.equal(forbiddenAccess, 0); assert.ok(calls.every(call => !/send|sign|estimate|getBalance|getTransactionCount/.test(call.method)));
  assert.deepEqual([...new Set(calls.map(call => call.endpoint))].sort(), allowed.sort());
  assert.deepEqual(JSON.parse(await readFile('public-claim-fixture.json', 'utf8')), fixture);
  process.stdout.write(JSON.stringify({ freshProcess: true, noJournal: true, noAccount: true, forbiddenBrowserAccess: forbiddenAccess, observations: [good.status, pending.status, reverted.status, 'mismatch-rejected'], expiredProfileRead: true, fixedRpcNames: true, publicNetwork: false, persistenceUntouched: true }) + '\n');
}

async function installedAvailability() {
  const { default: assert } = await import('node:assert/strict');
  const { readFile } = await import('node:fs/promises');
  const before = await readFile('public-claim-fixture.json'), fixture = JSON.parse(before);
  let forbiddenAccess = 0, mode = 'funded'; const calls = [];
  const forbidden = () => { forbiddenAccess++; throw Error('BROWSER_STATE_FORBIDDEN'); };
  for (const name of ['navigator', 'localStorage']) Object.defineProperty(globalThis, name, { configurable: true, get: forbidden });
  globalThis.fetch = () => { throw Error('NETWORK_DURING_IMPORT_FORBIDDEN'); };
  const { createTestnetPaymentAvailability } = await import('@continuitykit/account-reserve/payments');
  const { decodeFunctionData, encodeFunctionResult, parseAbi, toHex } = await import('viem');
  const abi = parseAbi(['function issuer() view returns (address)', 'function nextId() view returns (uint256)', 'function rightForOwner(address owner) view returns (uint256)', 'function getRight(uint256 id) view returns ((address beneficiary,uint256 amount,bool claimed))']);
  const profile = { ...fixture.profile, claims: fixture.profile.claims.map(claim => ({ ...claim, rightId: BigInt(claim.rightId), amount: BigInt(claim.amount) })) };
  const allowed = ['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com'], hash = '0x' + 'a1'.repeat(32), alternate = '0x' + 'b2'.repeat(32);
  const timestamp = toHex(BigInt(Math.floor(Date.now() / 1000))), blockNumber = 102n;
  const code = expected => error => error.code === expected;
  globalThis.fetch = async (url, init) => {
    const endpoint = new URL(url).origin; assert.ok(allowed.includes(endpoint)); assert.equal(init.redirect, 'error');
    const { id, method, params } = JSON.parse(init.body); calls.push({ endpoint, method, params, mode });
    if (mode === 'rpc-failure' && endpoint === allowed[1]) throw Error('private provider message never shown');
    let result;
    switch (method) {
      case 'eth_chainId': result = '0x279f'; break;
      case 'eth_getBlockByNumber': {
        const numbered = /^0x/.test(params[0]);
        result = { number: toHex(numbered ? BigInt(params[0]) : blockNumber), hash: mode === 'rpc-disagreement' && numbered && endpoint === allowed[1] ? alternate : hash, timestamp, baseFeePerGas: '0x1', transactions: [] }; break;
      }
      case 'eth_getCode': result = params[0].toLowerCase() === profile.address.toLowerCase() ? '0x6000' : '0x'; break;
      case 'eth_getTransactionCount': result = '0x0'; break;
      case 'eth_getBalance': result = mode === 'gas-empty' && params[0].toLowerCase() === profile.owner.toLowerCase() ? '0x0' : toHex(10n ** 18n); break;
      case 'eth_estimateGas': result = '0xc350'; break;
      case 'eth_call': {
        const call = decodeFunctionData({ abi, data: params[0].data }); let answer;
        if (call.functionName === 'issuer') answer = profile.issuer;
        else if (call.functionName === 'nextId') answer = mode === 'not-issued' ? 1n : 2n;
        else if (call.functionName === 'rightForOwner') answer = mode === 'not-issued' ? 0n : 1n;
        else {
          assert.notEqual(mode, 'not-issued', 'canonical unissued ID must not be treated as an existing funded right');
          assert.equal(call.args[0], 1n); answer = { beneficiary: profile.owner, amount: profile.claims[0].amount, claimed: mode === 'already-collected' };
        }
        result = encodeFunctionResult({ abi, functionName: call.functionName, result: answer }); break;
      }
      default: assert.fail('availability attempted a non-read operation: ' + method);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  for (const input of [{ profile, storage: {} }, { profile, locks: {} }, { profile, recovered: {} }, { profile, rpcTransport() {} }]) assert.throws(() => createTestnetPaymentAvailability(input), code('PAYMENT_OPTIONS_INVALID'));
  assert.throws(() => createTestnetPaymentAvailability({ profile }, {}), code('PAYMENT_OPTIONS_INVALID'));
  const availability = createTestnetPaymentAvailability({ profile }); assert.equal(calls.length, 0);
  let queryGetters = 0;
  for (const input of [{ rightId: '1' }, { rightId: 1n, hash: fixture.hash }, Object.defineProperty({}, 'rightId', { enumerable: true, get() { queryGetters++; return 1n; } })]) await assert.rejects(async () => availability.check(input), code('PAYMENT_AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(async () => availability.check({ rightId: 1n }, {}), code('PAYMENT_AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(async () => availability.check({ rightId: 3n }), code('PAYMENT_NOT_APPROVED'));
  assert.equal(calls.length, 0); assert.equal(queryGetters, 0);
  const outcomes = [];
  function identity(value) {
    assert.ok(Object.isFrozen(value)); assert.equal(value.chainId, 10143); assert.equal(value.contract.toLowerCase(), profile.address.toLowerCase()); assert.equal(value.beneficiary.toLowerCase(), profile.owner.toLowerCase()); assert.equal(value.rightId, 1n); assert.equal(value.amount, profile.claims[0].amount);
    assert.equal(value.readOnly, true); assert.equal(value.paymentVerified, false); assert.equal(value.blockNumber, blockNumber); assert.equal(value.blockHash, hash); assert.equal(new Date(value.observedAt).toISOString(), value.observedAt);
  }
  const funded = await availability.check({ rightId: 1n }); identity(funded); assert.equal(funded.status, 'funded'); outcomes.push(funded.status);
  mode = 'not-issued'; const absent = await availability.check({ rightId: 1n }); identity(absent); assert.equal(absent.status, 'not-available'); assert.equal(absent.reason, 'not-issued'); outcomes.push(absent.reason);
  const expiredAvailability = createTestnetPaymentAvailability({ profile: { ...profile, expiresAt: '2020-01-01T00:00:00.000Z' } });
  mode = 'already-collected'; const collected = await expiredAvailability.check({ rightId: 1n }); identity(collected); assert.equal(collected.status, 'already-collected'); outcomes.push(collected.status);
  mode = 'expired'; const expired = await expiredAvailability.check({ rightId: 1n }); identity(expired); assert.equal(expired.status, 'not-available'); assert.equal(expired.reason, 'expired'); outcomes.push(expired.reason);
  mode = 'gas-empty'; const unfunded = await availability.check({ rightId: 1n }); identity(unfunded); assert.equal(unfunded.status, 'not-available'); assert.equal(unfunded.reason, 'insufficient-gas'); outcomes.push(unfunded.reason);
  const errors = [];
  for (const [state, expected] of [['rpc-disagreement', 'PAYMENT_CANONICAL_BLOCK_MISMATCH'], ['rpc-failure', 'PAYMENT_AVAILABILITY_FAILED']]) {
    mode = state; await assert.rejects(availability.check({ rightId: 1n }), error => { assert.equal(error.code, expected); assert.equal(error.message, error.code); assert.ok(!error.message.includes('private provider')); errors.push(error.code); return true; }); outcomes.push(state + '-rejected');
  }
  assert.equal(forbiddenAccess, 0); assert.ok(calls.every(call => !/send|sign|TransactionReceipt|TransactionByHash/.test(call.method)));
  assert.deepEqual([...new Set(calls.map(call => call.endpoint))].sort(), allowed.sort()); assert.deepEqual(await readFile('public-claim-fixture.json'), before);
  process.stdout.write(JSON.stringify({ freshProcess: true, noJournal: true, noAccount: true, forbiddenBrowserAccess: forbiddenAccess, observations: outcomes, errors, availabilityIsNotPaymentProof: true, fixedRpcNames: true, publicNetwork: false, persistenceUntouched: true }) + '\n');
}

const types = `
import {createTestnetPaymentClient,createTestnetPaymentReader,createTestnetPaymentVerifier,createTestnetPaymentAvailability,type PaymentProfile,type PaymentClient,type PaymentResult,type PaymentLocks} from '@continuitykit/account-reserve/payments';
import type {RecoveredReserve} from '@continuitykit/account-reserve';
declare const recovered:RecoveredReserve;
declare const locks:LockManager;
const compatible:PaymentLocks=locks;void compatible;
const profile:PaymentProfile={chainId:10143,address:'0x01',owner:recovered.owner,issuer:'0x03',expectedRuntimeCodeHash:'0x04',expiresAt:'2026-11-10T00:00:00.000Z',claims:[{rightId:1n,amount:1n,nonce:0}]};
const client:PaymentClient=createTestnetPaymentClient({profile,recovered,locks,storage:localStorage});
const executor=client.forRight(1n);const result:PaymentResult=await executor.check();const status:string=executor.deliveryStatus;void status;void result;
executor.close();client.close();await createTestnetPaymentReader({profile,locks,storage:localStorage}).check(1n);
// @ts-expect-error No transport injection on the public boundary.
createTestnetPaymentReader({profile},{rpcTransport:()=>{}});
// @ts-expect-error No RPC override in public options.
createTestnetPaymentClient({profile,recovered,rpcUrl:'https://untrusted.invalid'});
// @ts-expect-error Reader requires no signing-session input.
createTestnetPaymentReader({profile,recovered});
// @ts-expect-error Mainnet and localchains are not the public adapter.
const wrongChain:PaymentProfile={...profile,chainId:1};
// @ts-expect-error JSON decimal strings require deliberate conversion.
const jsonClaim:PaymentProfile={...profile,claims:[{rightId:'1',amount:'1',nonce:0}]};
// @ts-expect-error A signing action requires the recovered account.
createTestnetPaymentClient({profile});
// @ts-expect-error Results are immutable.
result.hash='0x00';
// @ts-expect-error Right ids use bigint.
client.forRight('1');
const verifier=createTestnetPaymentVerifier({profile});
const verification=await verifier.check({rightId:1n,hash:'0x00'});
const readOnly:true=verification.readOnly;const verified:boolean=verification.paymentVerified;void readOnly;void verified;
if(verification.status==='pending-or-unknown'){
// @ts-expect-error An unconfirmed observation has no finalized block.
verification.blockNumber;
}else{const height:bigint=verification.blockNumber;void height;}
// @ts-expect-error Stateless verification takes no browser persistence.
createTestnetPaymentVerifier({profile,storage:localStorage});
// @ts-expect-error Stateless verification takes no account.
createTestnetPaymentVerifier({profile,recovered});
// @ts-expect-error No public transport override.
createTestnetPaymentVerifier({profile},{rpcTransport:()=>{}});
// @ts-expect-error An exact hash is required; no discovery.
verifier.check({rightId:1n});
// @ts-expect-error Query inputs do not configure endpoints.
verifier.check({rightId:1n,hash:'0x00',rpcUrl:'https://untrusted.invalid'});
// @ts-expect-error Query results are immutable.
verification.paymentVerified=true;
const availability=createTestnetPaymentAvailability({profile});
const availabilityResult=await availability.check({rightId:1n});
const noPaymentProof:false=availabilityResult.paymentVerified;const observedHeight:bigint=availabilityResult.blockNumber;void noPaymentProof;void observedHeight;
if(availabilityResult.status==='not-available'){const reason:string=availabilityResult.reason;void reason;}
// @ts-expect-error Availability requires no signer.
createTestnetPaymentAvailability({profile,recovered});
// @ts-expect-error Availability takes no persistence configuration.
createTestnetPaymentAvailability({profile,storage:localStorage});
// @ts-expect-error Availability is an exact right read, not receipt verification.
availability.check({rightId:1n,hash:'0x00'});
// @ts-expect-error Query rights must use bigint.
availability.check({rightId:'1'});
// @ts-expect-error Read-only availability is not evidence of payment.
const paid:true=availabilityResult.paymentVerified;
`;

test('public payment adapter installs offline, typechecks, bundles for browsers and reconciles without private SDK imports', { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'payments-installed-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const packed = JSON.parse(await execute(root, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  assert.equal(packed.length, 1);
  const files = packed[0].files.map(file => file.path), forbidden = /^(?:payments\/(?:operator|proposal|harness|verify-claim|site-handler|build|main|page|SequentialPayment)|artifacts\/|tests\/)|(?:^|\/)private\//;
  assert.equal(files.some(path => forbidden.test(path)), false);
  for (const path of ['payments/index.mjs', 'payments/index.d.ts', 'payments/testnet.mjs', 'payments/executor.mjs', 'payments/pending.mjs', 'payments/guard.mjs', 'release/paced-rpc.mjs']) assert.ok(files.includes(path), path);
  const consumer = join(temporary, 'consumer'); await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'isolated-payment-consumer', version: '0.0.0', private: true, type: 'module', dependencies: { '@continuitykit/account-reserve': 'file:../' + packed[0].filename, '@category-labs/mera': '0.2.0', viem: '2.56.9' }, devDependencies: { typescript: '5.9.3', vite: '8.3.1' } }));
  await execute(consumer, [npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
  const installed = JSON.parse(await readFile(join(consumer, 'node_modules/@continuitykit/account-reserve/package.json'), 'utf8'));
  assert.ok(installed.exports['./payments']);
  await writeFile(join(consumer, 'payment-types.mts'), types);
  await execute(consumer, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'payment-types.mts']);
  await writeFile(join(consumer, 'payment-actions.mjs'), await readFile(join(root, 'integrations/payment-client/actions.mjs'), 'utf8'));
  await writeFile(join(consumer, 'payment-entry.mjs'), "export {createTestnetPaymentClient,createTestnetPaymentReader,createTestnetPaymentVerifier,createTestnetPaymentAvailability} from '@continuitykit/account-reserve/payments';\nexport {createPaymentActions} from './payment-actions.mjs';\n");
  await writeFile(join(consumer, 'build-consumer.mjs'), `
import assert from 'node:assert/strict';import {build} from 'vite';
const built=await build({configFile:false,logLevel:'silent',build:{write:false,minify:false,lib:{entry:'payment-entry.mjs',formats:['es'],fileName:'payments'}}});
const chunks=(Array.isArray(built)?built:[built]).flatMap(part=>part.output).filter(part=>part.type==='chunk');
const modules=[...new Set(chunks.flatMap(chunk=>Object.keys(chunk.modules)))];
assert.ok(modules.some(path=>path.endsWith('/payments/index.mjs')));assert.ok(modules.some(path=>path.endsWith('/payments/testnet.mjs')));
assert.ok(modules.every(path=>!/(?:operator|harness|site-handler|verify-claim|build-sites|native-host|SequentialPayment|prism-art)/i.test(path)));
assert.ok(modules.every(path=>!path.slice(process.cwd().length).includes('/private/')));
assert.ok(modules.every(path=>!path.includes(${JSON.stringify(root)})));
const own=modules.filter(path=>path.includes('/@continuitykit/account-reserve/')).map(path=>path.split('/@continuitykit/account-reserve/')[1]);
assert.ok(own.every(path=>['payments/index.mjs','payments/testnet.mjs','payments/executor.mjs','payments/pending.mjs','payments/guard.mjs','release/client-profile.mjs','release/profile.mjs','release/paced-rpc.mjs'].includes(path)));
assert.ok(chunks.every(chunk=>!chunk.code.includes('node:fs')&&!chunk.code.includes('node:child_process')&&!chunk.code.includes('eth_sendUnsignedTransaction')));
console.log(JSON.stringify({browserBundle:true,publicModules:own.sort(),moduleCount:modules.length}));
`);
  const bundle = JSON.parse((await execute(consumer, ['build-consumer.mjs'])).trim());
  await writeFile(join(consumer, 'payment-consumer.mjs'), `await (${installedBehavior.toString()})();\n`);
  const behavior = JSON.parse((await execute(consumer, ['payment-consumer.mjs'])).trim());
  assert.equal(behavior.scenarios.length, 6); assert.equal(behavior.signatures, 2); assert.equal(behavior.sends, 2); assert.equal(behavior.closures, 5); assert.equal(behavior.nativeCalls, 0);
  const publicFixtureBefore = await readFile(join(consumer, 'public-claim-fixture.json'));
  await writeFile(join(consumer, 'payment-stateless-consumer.mjs'), `await (${installedStatelessVerifier.toString()})();\n`);
  const stateless = JSON.parse((await execute(consumer, ['payment-stateless-consumer.mjs'])).trim());
  assert.deepEqual(await readFile(join(consumer, 'public-claim-fixture.json')), publicFixtureBefore);
  assert.equal(stateless.freshProcess, true); assert.equal(stateless.forbiddenBrowserAccess, 0);
  await writeFile(join(consumer, 'payment-availability-consumer.mjs'), `await (${installedAvailability.toString()})();\n`);
  const availability = JSON.parse((await execute(consumer, ['payment-availability-consumer.mjs'])).trim());
  assert.deepEqual(await readFile(join(consumer, 'public-claim-fixture.json')), publicFixtureBefore);
  assert.equal(availability.freshProcess, true); assert.equal(availability.forbiddenBrowserAccess, 0);
  console.log(JSON.stringify({ experiment: 'installed-public-payment-adapter', strictTypes: true, browserBundle: bundle.browserBundle, publicModules: bundle.publicModules, ...behavior, stateless, availability, limits: ['simulated RPC responses', 'disposable local Mera signing sessions', 'no native passkey', 'no EVM or public transaction', 'same-origin in-memory lock adapter'] }));
});
