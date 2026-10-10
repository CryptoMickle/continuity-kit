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
  assert.deepEqual(Object.keys(api).sort(), ['createTestnetPaymentClient', 'createTestnetPaymentReader']);
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
    process.stdout.write(JSON.stringify({ scenarios, nativeCalls, publicNetwork: false, rpcSimulated: true, actualEvm: false, signatures, sends, closures, maxConcurrentLockOwners: maxInLock, fixedRpcNames: true, journalEntries: journal().entries.length }) + '\n');
  } finally { actions.forEach(action => action.dispose()); sessions.forEach(session => session.end()); secret.fill(0); globalThis.fetch = originalFetch; }
}

const types = `
import {createTestnetPaymentClient,createTestnetPaymentReader,type PaymentProfile,type PaymentClient,type PaymentResult,type PaymentLocks} from '@continuitykit/account-reserve/payments';
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
  await writeFile(join(consumer, 'payment-entry.mjs'), "export {createTestnetPaymentClient,createTestnetPaymentReader} from '@continuitykit/account-reserve/payments';\nexport {createPaymentActions} from './payment-actions.mjs';\n");
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
  console.log(JSON.stringify({ experiment: 'installed-public-payment-adapter', strictTypes: true, browserBundle: bundle.browserBundle, publicModules: bundle.publicModules, ...behavior, limits: ['simulated RPC responses', 'disposable local Mera signing sessions', 'no native passkey', 'no EVM or public transaction', 'same-origin in-memory lock adapter'] }));
});
