import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn, fork } from 'node:child_process';
import { randomBytes, createHmac, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, keccak256 } from 'viem';
import { createPaymentStarter } from '../scripts/create-payment-starter.mjs';
import { startSequentialPaymentChain } from '../payments/harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
process.env.SDK_TEST_NPM_CACHE ??= '/tmp/continuity-reserve-npm';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const env = () => { const value = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH, NODE_PATH: '', npm_config_cache: process.env.SDK_TEST_NPM_CACHE, npm_config_offline: 'true', npm_config_update_notifier: 'false' }; delete value.NODE_TEST_CONTEXT; return value; };
function run(args, cwd) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', expired = false, force;
    const timer = setTimeout(() => { expired = true; child.kill(); force = setTimeout(() => child.kill('SIGKILL'), 2000); }, 60000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (output.length < 50000) output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(force); code === 0 && !expired ? done(output) : reject(new Error('CONSUMER_COMMAND_FAILED: ' + output)); });
  });
}
function freshPage(directory, input) {
  return new Promise((done, reject) => {
    const child = fork(join(directory, 'proof-worker.mjs'), [], { cwd: directory, env: env(), execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let message, output = '', expired = false, force, settled = false;
    const timer = setTimeout(() => { expired = true; child.kill(); force = setTimeout(() => child.kill('SIGKILL'), 2000); }, 100000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (output.length < 50000) output += chunk; });
    child.on('message', value => { message = value; }); child.once('error', error => { clearTimeout(timer); reject(error); });
    const ended = code => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(force);
      try { assert.equal(expired, false); assert.equal(code, 0, output); assert.equal(message?.ok, true, message?.error ?? output); done(message.result); } catch (error) { reject(error); }
    };
    child.once('exit', ended); child.once('close', ended); child.send(input);
  });
}

async function hosts(records) {
  const stats = { primary: 0, config: 0, reads: 0, writes: 0 }; let offline = false, configBytes;
  const primary = createServer((request, response) => { stats.primary++; response.writeHead(offline ? 503 : 200, { 'content-type': 'text/plain' }); response.end(offline ? 'A is unavailable' : 'A is available'); });
  const recovery = createServer((request, response) => {
    if (request.method !== 'GET') { stats.writes++; response.writeHead(405); response.end(); return; }
    if (request.url === '/payment-config.json' && configBytes) {
      stats.config++; response.writeHead(200, { 'content-type': 'application/json', 'content-length': configBytes.length, 'cache-control': 'no-store' }); response.end(configBytes); return;
    }
    const match = /^\/api\/reserve\/([A-Za-z0-9_-]{43})$/.exec(request.url);
    if (match) {
      stats.reads++; const bytes = records.get(match[1]);
      if (bytes) { const body = JSON.stringify({ bytes: Buffer.from(bytes).toString('base64url') }); response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); response.end(body); return; }
    }
    response.writeHead(404); response.end();
  });
  const listen = server => new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const closeServer = server => new Promise(done => { if (!server.listening) return done(); server.close(done); server.closeAllConnections(); });
  try { await listen(primary); await listen(recovery); }
  catch (error) { await Promise.all([closeServer(primary), closeServer(recovery)]); throw error; }
  return { primaryUrl: 'http://127.0.0.1:' + primary.address().port, recoveryUrl: 'http://127.0.0.1:' + recovery.address().port,
    originalOrigin: 'http://payment-a.localhost:' + primary.address().port, recoveryOrigin: 'http://payment-b.localhost:' + recovery.address().port,
    stats, offline() { offline = true; }, setConfig(bytes) { configBytes = Buffer.from(bytes); }, close: () => Promise.all([closeServer(primary), closeServer(recovery)]) };
}

test('clean generated payment page survives A503, reconciles its real local payment and independently verifies a reference without a journal or WebAuthn', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'payment-starter-survival-')), consumer = join(directory, 'consumer');
  let chain, servers, originalSession, originalAccount;
  const privateKey = new Uint8Array(randomBytes(32)), credentialId = randomBytes(24), credentialSecret = randomBytes(32), records = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (resource, init) => {
    const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    return originalFetch(resource, { ...init, signal: init?.signal ?? AbortSignal.timeout(5000) });
  };
  t.after(async () => {
    originalSession?.end(); privateKey.fill(0); credentialId.fill(0); credentialSecret.fill(0);
    try { await servers?.close(); } finally { try { await chain?.close(); } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); } }
  });
  await createPaymentStarter(consumer);
  await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  // This bridge is test-only and outside the production entry/module graph.
  await writeFile(join(consumer, 'proof-public.mjs'), `export {prepareReserve} from '@continuitykit/account-reserve';\nexport {createSecp256k1SigningSession} from '@category-labs/mera';\nexport {toViemAccount} from '@category-labs/mera/viem';\n`);
  const installed = await import(pathToFileURL(join(consumer, 'proof-public.mjs')));
  originalSession = installed.createSecp256k1SigningSession({ privateKey }); originalAccount = installed.toViemAccount(originalSession);
  const owner = getAddress(originalAccount.address), amount = 10n ** 16n;
  servers = await hosts(records); chain = await startSequentialPaymentChain({ chainId: 10143 }); assert.equal(chain.chainId, 10143);
  const reserve = { appId: 'generated-payment-survival-v1', originalRpId: 'payment-a.localhost', recoveryRpId: 'payment-b.localhost', derivation: 'eoa:v1' };
  const setupCounts = { assertions: 0, creates: 0, puts: 0 };
  const store = { async get(locator) { const bytes = records.get(locator); return bytes && new Uint8Array(bytes); }, async putIfAbsent(locator, bytes) { setupCounts.puts++; if (records.has(locator)) return false; records.set(locator, new Uint8Array(bytes)); return true; } };
  const prepared = await installed.prepareReserve({ privateKey, policy: { ...reserve, expectedOwner: owner.toLowerCase() }, recoveryCredential: { credentialId: credentialId.toString('base64url') }, store,
    webAuthnClient: { async createCredential() { setupCounts.creates++; throw new Error('PREEXISTING_FIXTURE_ONLY'); }, async getCredential(request) {
      setupCounts.assertions++; assert.equal(request.rpId, reserve.recoveryRpId);
      if (request.allowCredential) assert.deepEqual(Buffer.from(request.allowCredential.credentialId), credentialId);
      return { credentialId: new Uint8Array(credentialId), prfOutput: new Uint8Array(createHmac('sha256', credentialSecret).update(request.prfSalt).digest()) };
    } } });
  assert.equal(prepared.independentlyVerified, true); assert.equal(setupCounts.puts, 1); assert.equal(setupCounts.creates, 0); assert.equal(records.size, 1);
  const snapshot = [...records].map(([locator, bytes]) => [locator, Buffer.from(bytes).toString('base64url')]);
  for (const [, bytes] of records) { assert.equal(Buffer.from(bytes).includes(Buffer.from(privateKey)), false); assert.equal(Buffer.from(bytes).includes(credentialSecret), false); }
  await chain.preparePayment(owner, { amount }); await chain.rpc('anvil_mine', ['0x40', '0x0']);
  const publicClient = createPublicClient({ chain: { id: 10143, name: 'Owned local fixture', nativeCurrency: { name: 'Test', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } }, cacheTime: 0, transport: http(chain.rpcUrl, { retryCount: 0, timeout: 5000 }) });
  const beforeBalance = await publicClient.getBalance({ address: owner }); assert.equal(await publicClient.getTransactionCount({ address: owner }), 0);
  const profile = { version: 1, originalOrigin: servers.originalOrigin, recoveryOrigin: servers.recoveryOrigin, reserve, storeBasePath: '/api/reserve', payment: {
    chainId: 10143, address: chain.contractAddress, owner, issuer: chain.issuer, expectedRuntimeCodeHash: chain.runtimeCodeHash, expiresAt: new Date(Date.now() + 3600000).toISOString(),
    claims: [{ rightId: '1', amount: amount.toString(), nonce: 0 }, { rightId: '2', amount: amount.toString(), nonce: 1 }],
  } };
  await writeFile(join(consumer, 'profile.json'), JSON.stringify(profile));
  await run(['build.mjs', '--profile', 'profile.json', '--out', 'dist'], consumer);
  const report = JSON.parse(await readFile(join(consumer, 'dist/build-report.json'), 'utf8'));
  const hashes = Object.fromEntries(await Promise.all([...report.assetFiles, 'payment-config.json', 'build-report.json'].map(async name => [name, digest(await readFile(join(consumer, 'dist', name)))])));
  servers.setConfig(await readFile(join(consumer, 'dist/payment-config.json')));
  for (const name of ['main.mjs', 'page.mjs']) assert.deepEqual(await readFile(join(consumer, name)), await readFile(join(root, 'payment-starter', name)));
  assert.deepEqual(await readFile(join(consumer, 'actions.mjs')), await readFile(join(root, 'integrations/payment-client/actions.mjs')));
  for (const name of report.assetFiles) assert.doesNotMatch(await readFile(join(consumer, 'dist', name), 'utf8'), /proof-worker|proof-observer|__paymentProofObservation|TEST_ONLY_ACCEPTED_REPLY_LOST|createHmac|test-only.*oracle/i);
  // Test adapters are added only AFTER building and remain outside dist.
  await cp(join(root, 'tests/payment-starter-continuity-worker.mjs'), join(consumer, 'proof-worker.mjs'));
  await writeFile(join(consumer, 'proof-observer.mjs'), `
    import {createPaymentActions as canonical} from './actions.mjs';
    export function createPaymentActions(options){
      const observed=globalThis.__paymentProofObservation;
      const result=canonical({...options,openExistingAccount(...args){
        const pending=options.openExistingAccount(...args);
        return Promise.resolve(pending).then(session=>{observed.sessions.push(session);return session;});
      }});
      observed.actions.push(result);return result;
    }
  `);
  assert.equal((await fetch(servers.primaryUrl)).status, 200);
  originalSession.end(); privateKey.fill(0); servers.offline();
  await assert.rejects(originalAccount.signMessage({ message: 'Original app is closed' }), error => error.code === 'SESSION_ENDED');
  assert.equal((await fetch(servers.primaryUrl)).status, 503); const requestsBefore = servers.stats.primary;
  const base = { profile, primaryUrl: servers.primaryUrl, recoveryUrl: servers.recoveryUrl, rpcUrl: chain.rpcUrl,
    jsdomPackage: join(root, 'integrations/multi-app/package.json') };
  const attempted = await freshPage(consumer, { ...base, phase: 'claim', credential: { id: credentialId.toString('base64url'), secret: credentialSecret.toString('base64url') } });
  assert.equal(attempted.counts.sends, 1); assert.equal(attempted.counts.acceptedSends, 1); assert.equal(attempted.signerEnded, true);
  assert.equal(servers.stats.primary, requestsBefore); assert.equal(servers.stats.reads, 1); assert.equal(servers.stats.writes, 0);
  const signed = JSON.parse(attempted.journal[0][1]); assert.equal(signed.entries[0].phase, 'signed'); assert.equal(signed.entries[0].hash, attempted.hash);
  await chain.rpc('anvil_mine', ['0x40', '0x0']);
  // No original key, signer, credential secret or locator is sent to this new
  // process. It receives the public journal that the first page persisted.
  const confirmed = await freshPage(consumer, { ...base, phase: 'reconcile', journal: attempted.journal });
  assert.equal(confirmed.hash, attempted.hash); assert.equal(confirmed.counts.nativeGet, 0); assert.equal(confirmed.counts.sends, 0); assert.equal(confirmed.counts.reserveGets, 0);
  const journal = JSON.parse(confirmed.journal[0][1]); assert.equal(journal.active, null); assert.equal(journal.entries.length, 1); assert.equal(journal.entries[0].phase, 'confirmed');
  for (const [name, hash] of Object.entries(hashes)) assert.equal(digest(await readFile(join(consumer, 'dist', name))), hash);
  // This third process receives only public reference data. Its expired public
  // configuration is served from the test host; production assets are unchanged.
  const historicalProfile = { ...profile, payment: { ...profile.payment, expiresAt: '2020-01-01T00:00:00.000Z' } };
  servers.setConfig(Buffer.from(JSON.stringify(historicalProfile)));
  const reference = await freshPage(consumer, { ...base, profile: historicalProfile, phase: 'reference', hash: attempted.hash });
  assert.equal(reference.hash, attempted.hash); assert.equal(reference.historicalReferenceVerified, true);
  assert.equal(reference.journalFreeReferenceWithoutWebAuthn, true);
  assert.equal(reference.wrongApprovedRightRejected, true); assert.equal(reference.unknownReferencePending, true);
  for (const name of ['nativeGet', 'nativeCreate', 'reserveGets', 'reserveWrites', 'sends', 'journalReads', 'journalWrites', 'locks', 'persistenceAccess']) assert.equal(reference.counts[name], 0, name);
  servers.setConfig(await readFile(join(consumer, 'dist/payment-config.json')));
  const receipt = await publicClient.getTransactionReceipt({ hash: attempted.hash }), transaction = await publicClient.getTransaction({ hash: attempted.hash });
  assert.equal(receipt.status, 'success'); assert.equal(getAddress(receipt.from), owner); assert.equal(getAddress(receipt.to), chain.contractAddress);
  assert.equal(transaction.chainId, 10143); assert.equal(transaction.nonce, 0); assert.equal(transaction.value, 0n); assert.equal(getAddress(transaction.from), owner);
  assert.equal(transaction.input, encodeFunctionData({ abi: chain.abi, functionName: 'claim', args: [1n] }));
  const events = receipt.logs.filter(log => getAddress(log.address) === chain.contractAddress).map(log => decodeEventLog({ abi: chain.abi, topics: log.topics, data: log.data })).filter(log => log.eventName === 'RightClaimed');
  assert.equal(events.length, 1); assert.deepEqual(events[0].args, { id: 1n, beneficiary: owner, amount });
  assert.equal(await publicClient.getTransactionCount({ address: owner }), 1);
  assert.equal(await publicClient.getBalance({ address: owner }), beforeBalance + amount - receipt.gasUsed * receipt.effectiveGasPrice);
  assert.equal(await publicClient.getBalance({ address: chain.contractAddress }), 0n); assert.equal((await chain.readRight(1n)).claimed, true);
  assert.equal(servers.stats.primary, requestsBefore); assert.equal((await fetch(servers.primaryUrl)).status, 503);
  assert.deepEqual([...records].map(([locator, bytes]) => [locator, Buffer.from(bytes).toString('base64url')]), snapshot); assert.equal(setupCounts.puts, 1);
  for (const [name, hash] of Object.entries(hashes)) assert.equal(digest(await readFile(join(consumer, 'dist', name))), hash);
  for (const name of ['main.mjs', 'page.mjs']) assert.deepEqual(await readFile(join(consumer, name)), await readFile(join(root, 'payment-starter', name)));
  assert.deepEqual(await readFile(join(consumer, 'actions.mjs')), await readFile(join(root, 'integrations/payment-client/actions.mjs')));
  assert.equal(keccak256(await publicClient.getCode({ address: chain.contractAddress })), profile.payment.expectedRuntimeCodeHash);
  console.log(JSON.stringify({ experiment: 'generated-payment-survival-proof', generatedPaymentSurvival: true, installedSdk: true, generatedMainAndPageBodiesUnchanged: true, canonicalHelperBytesUnchanged: true,
    productionAssetsUnchanged: true, originalHttpStatus: 503, originalRequestsDuringRecoveryAndClaim: 0, existingReserveCiphertextPreserved: true,
    actualDefaultWebAuthnAdapter: true, browserCredentialOracle: true, actualMeraSigner: true, chainId: 10143, localEvm: true,
    claimBroadcasts: attempted.counts.sends, acceptedReplyDeliberatelyLost: true, signedHashStoredBeforeSend: true, exactBeneficiaryAmountNonceAndEvent: true,
    beneficiaryBalanceMatchesPaymentMinusGas: true, originalAndRecoveredSignerEnded: true, freshProcessReconciliation: true,
    freshProcessCredentials: confirmed.counts.nativeGet, freshProcessBroadcasts: confirmed.counts.sends, durableJournalConfirmed: true,
    journalFreeReferenceProcess: true, journalFreeReferenceVerified: true, journalFreeReferenceWithoutWebAuthn: true,
    historicalExpiredProfileVerified: true, wrongApprovedRightRejected: true, unknownReferencePending: true,
    referenceCredentials: reference.counts.nativeGet, referenceJournalReads: reference.counts.journalReads, referenceLocks: reference.counts.locks, referenceBroadcasts: reference.counts.sends,
    referencePersistenceAccesses: reference.counts.persistenceAccess, referenceDidNotMutateJournal: true, historicalConfigServedOnlyByTestHost: true,
    publicNetwork: false, physicalPasskeyVerified: false, deployed: false,
    limits: ['generated source modules executed; built bundle verified but not executed', 'Node/JSDOM with CSS loader and transparent helper-session observer', 'synthetic existing WebAuthn PRF credential; no physical device', 'fixed public RPC names redirected to one owned local EVM; no provider independence', 'expired public configuration served only by the test host; built assets unchanged', 'disposable local payment funding; no customer demand'] }));
});
