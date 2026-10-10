import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access, rename, readdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installedNativeFixture } from './native-installed-fixture.mjs';
import { transport, synthetic, fresh, freePorts, killOwned } from './native-collection-fixture.mjs';

const jsdomPath = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url)).resolve('jsdom');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function snapshot(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return { records: db.prepare('SELECT locator,ciphertext FROM operator_records ORDER BY locator').all().map(row => ({ locator: row.locator, bytes: Buffer.from(row.ciphertext) })),
    issued: db.prepare('SELECT issued FROM operator_meta').get().issued,
    capabilities: db.prepare('SELECT used FROM operator_capabilities').all().map(row => row.used).sort() }; }
  finally { db.close(); }
}
async function files(directory) {
  const result = new Map();
  for (const name of (await readdir(directory)).sort()) result.set(name, await readFile(join(directory, name)));
  return result;
}
function run(args, cwd) {
  return new Promise((done, reject) => {
    const env = { ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''), NODE_PATH: '', NODE_NO_WARNINGS: '1', npm_config_offline: 'true', npm_config_update_notifier: 'false', ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}) };
    delete env.NODE_TEST_CONTEXT;
    const child = childProcess.spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', failed = false, escalation;
    const timer = setTimeout(() => { failed = true; child.kill(); escalation = setTimeout(() => child.kill('SIGKILL'), 2000); }, 20000);
    child.stdout.on('data', bytes => { if (stdout.length + bytes.length > 16000) { failed = true; child.kill('SIGKILL'); } else stdout += bytes; });
    child.stderr.resume(); child.once('error', () => { failed = true; });
    child.once('close', code => { clearTimeout(timer); clearTimeout(escalation); failed || code ? reject(Error('BACKUP_PACKAGE_COMMAND_FAILED')) : done(stdout); });
  });
}

test('installed native backup restores two app reserves into fresh private state and survives replica loss without original state', { timeout: 180000 }, async t => {
  const installed = await installedNativeFixture(); let directory;
  try { directory = await realpath(await mkdtemp(join(tmpdir(), 'native-backup-installed-'))); } catch (error) { await installed.close(); throw error; }
  let app, currentChildren = [], currentServers = []; const ownedChildren = [], handles = [], key = randomBytes(32), credentialId = randomBytes(24);
  const originalFork = childProcess.fork, originalCreateServer = http.createServer, originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(async () => {
    childProcess.fork = originalFork; http.createServer = originalCreateServer; syncBuiltinESMExports(); handles.forEach(value => value.close()); key.fill(0); credentialId.fill(0);
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else delete globalThis.location;
    try { await app?.close(); } finally { await Promise.allSettled(ownedChildren.map(killOwned)); await rm(directory, { recursive: true, force: true }); await installed.close(); }
  });
  const consumer = join(directory, 'consumer'), npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const generated = JSON.parse(await run([join(installed.directory, 'node_modules/@continuitykit/account-reserve/scripts/create-native-text-starter.mjs'), consumer], installed.directory));
  assert.equal(generated.directory, consumer);
  await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  const load = name => import(pathToFileURL(join(consumer, name)));
  const manifest = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies), ['@continuitykit/account-reserve']);
  assert.equal(manifest.scripts['operator:backup'], 'node operator-backup.mjs backup');
  assert.equal(manifest.scripts['operator:restore'], 'node operator-backup.mjs restore');
  await writeFile(join(consumer, 'test-public-sdk.mjs'), "export * from '@continuitykit/account-reserve/text-reserve';\nexport {createReserveHttpStore} from '@continuitykit/account-reserve/http-store';\n", { flag: 'wx', mode: 0o600 });
  const sdk = await load('test-public-sdk.mjs'), { buildNative } = await load('build.mjs'), { startNativeOperator } = await load('operate.mjs');
  const { initializeNativeOperator, readNativeOperatorState } = await load('operator-state.mjs'), { issueNativeGrants } = await load('operator.mjs');
  const { nativeApps, nativeAppProfile, parseNativeGrants } = await load('profile.mjs'), { backupNativeOperator, restoreNativeOperator } = await load('operator-backup.mjs');
  const profile = { version: 2, apps: [{ id: 'textarea', label: 'Text draft', appId: 'native-backup-textarea-v1' }, { id: 'markdown', label: 'Markdown draft', appId: 'native-backup-markdown-v1' }],
    primaryOrigin: 'https://writer.backup.test', recoveryOrigin: 'https://reserve.backup.test', recoveryRpId: 'reserve.backup.test', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] };
  const numbers = await freePorts(10), ports = offset => ({ primary: numbers[offset], recovery: numbers[offset + 1], gateway: numbers[offset + 2], replicas: [{ id: 'alpha', port: numbers[offset + 3] }, { id: 'beta', port: numbers[offset + 4] }] });
  const sourcePorts = ports(0), restoredPorts = ports(5), source = join(directory, 'source'), relocated = join(directory, 'unavailable-source'), restored = join(directory, 'restored');
  const out = join(directory, 'dist'), archive = join(directory, 'operator-backup.json'), profilePath = join(directory, 'profile.json'), portsPath = join(directory, 'ports.json');
  const samples = ['\ufeffFictional portable reserve — ÆØÅ.\r\nSame key, newly restored storage.\r\n', '# Fictional restored Markdown\n\nThe sibling draft survives — 界 🦊.\n'];
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 }); await writeFile(portsPath, JSON.stringify(restoredPorts), { mode: 0o600 });
  await buildNative({ profile, out }); initializeNativeOperator({ profile, state: source, ports: sourcePorts });
  const original = readNativeOperatorState({ profile, state: source }), workerPath = await realpath(join(consumer, 'operator-worker.mjs'));
  async function start(state) {
    currentChildren = []; currentServers = [];
    childProcess.fork = (...args) => { assert.equal(args[0], workerPath); const child = originalFork(...args); currentChildren.push(child); ownedChildren.push(child); return child; };
    http.createServer = (...args) => { const server = originalCreateServer(...args); currentServers.push(server); return server; }; syncBuiltinESMExports();
    try { app = await startNativeOperator({ profile, state, out }); } finally { childProcess.fork = originalFork; http.createServer = originalCreateServer; syncBuiltinESMExports(); }
    assert.deepEqual(app.status(), { state: 'ready', unavailableReplicas: [] }); assert.equal(currentChildren.length, 2);
  }
  async function close(state) { await app.close(); assert.equal(await app.failure, undefined); app = undefined; await assert.rejects(access(join(state, 'runtime.lock')), { code: 'ENOENT' }); }
  await start(source);
  assert.throws(() => backupNativeOperator({ profile, state: source, output: archive }), { code: 'NATIVE_OPERATOR_LOCKED' });
  await assert.rejects(access(archive), { code: 'ENOENT' });
  globalThis.location = { origin: profile.recoveryOrigin };
  const counters = { create: 0, get: 0 }, outputs = [], calls = [], client = synthetic({ key, credentialId, counters, outputs });
  const fetcher = transport({ port: sourcePorts.recovery, origin: profile.recoveryOrigin, calls });
  for (const [index, selected] of nativeApps(profile).entries()) {
    const grantPath = join(source, 'temporary-grant-' + index + '.json'); await issueNativeGrants({ profile, app: selected.id, invitationsFile: original.invitationsFile, output: grantPath });
    const grants = parseNativeGrants(await readFile(grantPath, 'utf8'), nativeAppProfile(profile, selected.id));
    const replicas = profile.replicas.map(({ id, basePath }, position) => ({ id, store: sdk.createReserveHttpStore({ fetcher, basePath, enrollmentToken: grants.replicas[position].enrollmentToken }) }));
    let credential;
    try {
      credential = index ? await sdk.selectTextReserveCredential({ config: selected.config, webAuthnClient: client }) : await sdk.createTextReserveCredential({ config: selected.config, webAuthnClient: client, user: { name: 'Fictional backup', displayName: 'TEST ONLY' } }); handles.push(credential);
      const ready = await sdk.prepareTextReserveReplicas({ config: selected.config, text: samples[index], replicas, recoveryCredential: credential, webAuthnClient: client });
      assert.equal(ready.independentlyVerified, true); assert.equal(ready.text, samples[index]); assert.ok(ready.replicas.every(item => item.status === 'verified'));
    } finally { credential?.close(); replicas.forEach(item => item.store.clearEnrollmentCapability()); await unlink(grantPath); }
  }
  assert.deepEqual(counters, { create: 1, get: 3 }); assert.ok(outputs.every(value => value.prfOutput.every(byte => byte === 0))); assert.equal(calls.filter(value => value.method === 'PUT').length, 4);
  const pendingPath = join(source, 'unused-grants.json'); await issueNativeGrants({ profile, app: 'textarea', invitationsFile: original.invitationsFile, output: pendingPath });
  const pending = parseNativeGrants(await readFile(pendingPath, 'utf8'), nativeAppProfile(profile, 'textarea')); await unlink(pendingPath);
  await close(source);
  const originalFiles = await files(source), originalDatabases = original.databasePaths.map(item => snapshot(item.database));
  for (const value of originalDatabases) { assert.equal(value.records.length, 2); assert.equal(value.issued, 3); assert.deepEqual(value.capabilities, [0, 1, 1]); }
  const backupOutput = await run([npmCli, 'run', '--silent', 'operator:backup', '--', '--profile', profilePath, '--state', source, '--out', archive], consumer);
  const backup = JSON.parse(backupOutput), archiveBytes = await readFile(archive), bundle = JSON.parse(archiveBytes);
  assert.equal(backup.backupWritten, true); assert.equal(backup.sha256, digest(archiveBytes)); assert.equal(backup.bytes, archiveBytes.length); assert.equal(backup.pendingCapabilitiesTransferred, false);
  assert.deepEqual(backup.replicas, profile.replicas.map(({ id }) => ({ id, records: 2, issuedCapabilities: 3 })));
  assert.deepEqual(Object.keys(bundle).sort(), ['format', 'profile', 'replicas']); assert.equal(bundle.format, 'continuitykit/native-operator-backup/v1'); assert.deepEqual(bundle.profile, profile);
  assert.deepEqual(bundle.replicas.map(item => item.id), profile.replicas.map(item => item.id)); assert.equal((await stat(archive)).mode & 0o777, 0o600);
  const secretBytes = [key, credentialId, Buffer.from(key.toString('base64url')), Buffer.from(credentialId.toString('base64url')),
    ...pending.replicas.map(item => Buffer.from(item.enrollmentToken)), ...original.databasePaths.map(item => originalFiles.get(item.id + '-invitation.txt').subarray(0, 64)), ...samples.map(value => Buffer.from(value))];
  for (const secret of secretBytes) assert.equal(archiveBytes.includes(secret), false);
  for (const role of ['primary', 'recovery']) {
    const path = join(out, role); assert.deepEqual((await readdir(path)).sort(), ['assets', 'continuity-config.json', 'index.html']);
    const deployable = [await readFile(join(path, 'index.html')), await readFile(join(path, 'continuity-config.json'))];
    for (const name of await readdir(join(path, 'assets'))) { assert.match(name, /^[A-Za-z0-9_-]+\.(?:js|css)$/); deployable.push(await readFile(join(path, 'assets', name))); }
    for (const bytes of deployable) {
      for (const secret of secretBytes) assert.equal(bytes.includes(secret), false);
      assert.doesNotMatch(bytes.toString('utf8'), /jsdom|native-collection-fixture|test-public-sdk|\/api\/(?:synthetic|replica-control|replica-enrollment)|operator-backup\.mjs|unused-grants/);
    }
  }
  assert.deepEqual(await files(source), originalFiles);
  const wrongDigest = (backup.sha256[0] === '0' ? '1' : '0') + backup.sha256.slice(1), failedState = join(directory, 'must-not-exist');
  assert.throws(() => restoreNativeOperator({ profile, ports: restoredPorts, input: archive, expectedSha256: wrongDigest, state: failedState }), { code: 'NATIVE_BACKUP_DIGEST_MISMATCH' });
  await assert.rejects(access(failedState), { code: 'ENOENT' });
  await rename(source, relocated); await assert.rejects(access(source), { code: 'ENOENT' });
  const restoredOutput = JSON.parse(await run([npmCli, 'run', '--silent', 'operator:restore', '--', '--profile', profilePath, '--ports', portsPath, '--in', archive, '--sha256', backup.sha256, '--state', restored], consumer));
  assert.equal(restoredOutput.restored, true); assert.equal(restoredOutput.passkeysCreated, false); assert.equal(restoredOutput.servicesStarted, false); assert.equal(restoredOutput.pendingCapabilitiesTransferred, false); assert.deepEqual(restoredOutput.replicas, backup.replicas);
  const bound = readNativeOperatorState({ profile, state: restored }); assert.deepEqual(bound.profile, profile); assert.deepEqual(bound.ports, restoredPorts);
  const restoredFiles = await files(restored);
  for (const [index, item] of bound.databasePaths.entries()) {
    const value = snapshot(item.database); assert.deepEqual(value.records, originalDatabases[index].records); assert.equal(value.issued, originalDatabases[index].issued); assert.deepEqual(value.capabilities, []);
    assert.notDeepEqual(restoredFiles.get(item.id + '-invitation.txt'), originalFiles.get(item.id + '-invitation.txt'));
  }
  assert.throws(() => restoreNativeOperator({ profile, ports: restoredPorts, input: archive, expectedSha256: backup.sha256, state: restored }), { code: 'NATIVE_STATE_EXISTS' });
  assert.deepEqual(await files(restored), restoredFiles);
  await start(restored);
  const a = currentServers.find(server => server.address()?.port === restoredPorts.primary); assert.ok(a); await new Promise(done => { a.close(done); a.closeAllConnections(); });
  await assert.rejects(transport({ port: restoredPorts.primary, origin: profile.primaryOrigin, calls: [] })('/continuity-config.json'));
  const restoredFetch = transport({ port: restoredPorts.recovery, origin: profile.recoveryOrigin, calls: [] });
  for (const [index, replica] of profile.replicas.entries()) {
    const record = originalDatabases[index].records[0], before = snapshot(bound.databasePaths[index].database);
    const denied = await restoredFetch(replica.basePath + '/' + record.locator, { method: 'PUT', headers: { authorization: 'Bearer ' + pending.replicas[index].enrollmentToken }, body: JSON.stringify({ bytes: record.bytes.toString('base64url') }) });
    assert.equal(denied.status, 403); await denied.arrayBuffer(); assert.deepEqual(snapshot(bound.databasePaths[index].database), before);
  }
  const cases = [];
  for (const degraded of [false, true]) {
    if (degraded) { await killOwned(currentChildren[0]); assert.deepEqual(app.status(), { state: 'degraded', unavailableReplicas: ['alpha'] }); }
    const before = await files(restored), rows = bound.databasePaths.map(item => snapshot(item.database)), output = join(directory, degraded ? 'surviving-copy' : 'restored-copy'); await mkdir(output, { mode: 0o700 });
    const result = await fresh(consumer, { origin: profile.recoveryOrigin, port: restoredPorts.recovery, output, key: key.toString('base64url'), credentialId: credentialId.toString('base64url'), ui: true, jsdomPath });
    assert.equal(result.ok, true, result.code); assert.deepEqual(result.counters, { create: 0, get: 1 }); assert.equal(result.uiExports, true); assert.equal(result.nativeCalls, 0); assert.equal(result.forbiddenNetwork, 0); assert.equal(result.persistence, 0); assert.equal(result.prfErased, true);
    assert.deepEqual(result.results.map(item => item.appId), profile.apps.map(item => item.appId)); assert.ok(result.results.every(item => item.status === 'recovered'));
    assert.equal(result.requests.length, 6); assert.ok(result.requests.every(item => item.method === 'GET'));
    for (const item of result.results) assert.deepEqual(item.replicas.map(value => value.status), degraded ? ['unavailable', 'verified'] : ['verified', 'verified']);
    for (const [index, sample] of samples.entries()) { assert.deepEqual(await readFile(join(output, 'app-' + index + '.txt')), Buffer.from(sample)); assert.deepEqual(JSON.parse(await readFile(join(output, 'app-' + index + '.json'), 'utf8')), { format: 'continuity-text-export/v1', text: sample }); }
    assert.deepEqual(await files(restored), before); assert.deepEqual(bound.databasePaths.map(item => snapshot(item.database)), rows);
    cases.push({ oneReplicaUnavailable: degraded, freshInstalledUi: true, oneExistingCredentialAssertion: true, exactExports: true, noRecoveryWrites: true });
  }
  await close(restored); assert.deepEqual(await files(relocated), originalFiles); await assert.rejects(access(source), { code: 'ENOENT' });
  assert.deepEqual(await readFile(archive), archiveBytes); assert.equal(ownedChildren.length, 4);
  console.log(JSON.stringify({ installedNativeBackupPackage: true, installedGeneratorReplay: true, offlineConsumerInstall: true, appNamespaces: 2, distinctPrivateStates: 2, explicitNewPorts: true, sameExactProfileAndExpiry: true, managedStarts: 2,
    stoppedAllReplicaBackup: true, liveBackupRefused: true, digestMismatchRefusedBeforeCreation: true, existingStateRefusedWithoutMutation: true, sourceStateUnavailableAtOriginalPath: true,
    byteExactCiphertextPreserved: true, fullIssuedQuotaPreserved: true, freshInvitations: true, pendingCapabilitiesTransferred: false, oldPendingGrantsRejected: true,
    freshRecoveryProcesses: 2, installedUiWithRealSdk: true, exactExports: true, primaryListenerClosed: true, replicaFailoverAfterRestore: true, noRecoveryWrites: true,
    sourceStateOrGrantsSuppliedToRecovery: false, secretsOrTestDependenciesInDeployableAssets: false, sameMachineOnly: true, physicalPasskeyProof: false, nativeBrowserEngineProof: false, publicTlsVerified: false, independentProviders: false, cases }));
});
