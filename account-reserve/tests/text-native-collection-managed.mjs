import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installedNativeFixture } from './native-installed-fixture.mjs';
import { transport, synthetic, fresh, freePorts, killOwned } from './native-collection-fixture.mjs';

const testRequire = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
const jsdomPath = testRequire.resolve('jsdom');

function snapshot(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return { records: db.prepare('SELECT locator,ciphertext FROM operator_records ORDER BY locator').all().map(row => ({ locator: row.locator, bytes: Buffer.from(row.ciphertext) })),
    counts: { issued: db.prepare('SELECT issued FROM operator_meta').get().issued, used: db.prepare('SELECT sum(used) AS n FROM operator_capabilities').get().n, records: db.prepare('SELECT count(*) AS n FROM operator_records').get().n } }; }
  finally { db.close(); }
}


test('durable native collection survives managed restart and A/store loss with app-bound grants and fresh read-only recovery', { timeout: 180000 }, async t => {
  const installed = await installedNativeFixture(); let directory;
  try { directory = await realpath(await mkdtemp(join(tmpdir(), 'native-collection-managed-'))); } catch (error) { await installed.close(); throw error; }
  let app, currentChildren = [], currentServers = []; const ownedChildren = [], handles = [], key = randomBytes(32), credentialId = randomBytes(24);
  const originalFork = childProcess.fork, originalCreateServer = http.createServer, originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(async () => { childProcess.fork = originalFork; http.createServer = originalCreateServer; syncBuiltinESMExports(); handles.forEach(handle => handle.close()); key.fill(0); credentialId.fill(0);
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else delete globalThis.location;
    try { await app?.close(); } finally { await Promise.allSettled(ownedChildren.map(killOwned)); await rm(directory, { recursive: true, force: true }); await installed.close(); } });
  const load = name => import(pathToFileURL(join(installed.directory, name)));
  await writeFile(join(installed.directory, 'test-public-sdk.mjs'), "export * from '@continuitykit/account-reserve/text-reserve';\nexport {createReserveHttpStore} from '@continuitykit/account-reserve/http-store';\n", { flag: 'wx', mode: 0o600 });
  const sdk = await load('test-public-sdk.mjs'), { buildNative } = await load('build.mjs'), { startNativeOperator } = await load('operate.mjs');
  const { initializeNativeOperator, readNativeOperatorState } = await load('operator-state.mjs'), { issueNativeGrants, runtimeProfile } = await load('operator.mjs');
  const { nativeApps, nativeAppProfile, nativeConfig, parseNativeGrants } = await load('profile.mjs');
  const [primary, recovery, gateway, alpha, beta] = await freePorts(5);
  const profile = { version: 2, apps: [{ id: 'textarea', label: 'Text draft', appId: 'native-managed-textarea-v1' }, { id: 'markdown', label: 'Markdown draft', appId: 'native-managed-markdown-v1' }],
    primaryOrigin: 'https://writer.collection.test', recoveryOrigin: 'https://reserve.collection.test', recoveryRpId: 'reserve.collection.test', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] };
  const ports = { primary, recovery, gateway, replicas: [{ id: 'alpha', port: alpha }, { id: 'beta', port: beta }] }, state = join(directory, 'private'), out = join(directory, 'dist');
  const samples = ['\ufeffFictional native collection — ÆØÅ.\r\nFirst app survives independently.\r\n', '# Fictional Markdown\n\nSecond app — 界 and 🦊.\n'];
  await buildNative({ profile, out }); initializeNativeOperator({ profile, state, ports });
  const bound = readNativeOperatorState({ profile, state }); assert.deepEqual(bound.profile, profile); assert.deepEqual(JSON.parse(await readFile(bound.operatorProfilePath, 'utf8')).apps, profile.apps);
  assert.deepEqual(runtimeProfile(profile).apps, profile.apps); assert.throws(() => nativeConfig(profile), /NATIVE_APP_SELECTION_REQUIRED/);
  assert.equal(nativeAppProfile(profile, 'textarea').version, 1); assert.deepEqual(nativeConfig(nativeAppProfile(profile, 'textarea')), nativeApps(profile)[0].config);
  const fixedPaths = [join(state, 'native-state.json'), bound.operatorProfilePath, join(state, 'gateway.json'), bound.invitationsFile, ...bound.databasePaths.map(item => item.invitationFile)];
  const fixedBytes = await Promise.all(fixedPaths.map(path => readFile(path)));
  const wrongProfile = { ...profile, apps: [...profile.apps].reverse() }; assert.throws(() => readNativeOperatorState({ profile: wrongProfile, state }), /NATIVE_STATE_/);
  assert.throws(() => readNativeOperatorState({ profile: nativeAppProfile(profile, 'textarea'), state }), /NATIVE_STATE_/);
  for (const [index, path] of fixedPaths.entries()) assert.deepEqual(await readFile(path), fixedBytes[index]);
  const workerPath = await realpath(join(installed.directory, 'operator-worker.mjs'));
  async function start() {
    currentChildren = []; currentServers = [];
    childProcess.fork = (...args) => { assert.equal(args[0], workerPath); const child = originalFork(...args); currentChildren.push(child); ownedChildren.push(child); return child; };
    http.createServer = (...args) => { const server = originalCreateServer(...args); currentServers.push(server); return server; }; syncBuiltinESMExports();
    try { app = await startNativeOperator({ profile, state, out }); } finally { childProcess.fork = originalFork; http.createServer = originalCreateServer; syncBuiltinESMExports(); }
    assert.deepEqual(app.status(), { state: 'ready', unavailableReplicas: [] }); assert.equal(currentChildren.length, 2);
  }
  async function closeA() {
    const server = currentServers.find(value => value.address()?.port === primary); assert.ok(server, 'capture only the owned A listener');
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
    await assert.rejects(transport({ port: primary, origin: profile.primaryOrigin, calls: [] })('/continuity-config.json'));
  }
  async function close() { await app.close(); assert.equal(await app.failure, undefined); app = undefined; await assert.rejects(access(join(state, 'runtime.lock')), { code: 'ENOENT' }); }
  await start();
  const emptyCounts = bound.databasePaths.map(item => snapshot(item.database).counts);
  for (const selection of [undefined, 'unknown', profile.apps[0].appId]) {
    const output = join(state, 'invalid-' + (selection ?? 'none') + '.json');
    await assert.rejects(issueNativeGrants({ profile, ...(selection === undefined ? {} : { app: selection }), invitationsFile: bound.invitationsFile, output }), /NATIVE_APP_SELECTION_REQUIRED/);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
  for (const [index, invalidProfile] of [wrongProfile, { ...profile, apps: [profile.apps[0], { ...profile.apps[1], appId: 'other-app-binding-v1' }] }].entries()) {
    const output = join(state, 'mismatched-' + index + '.json');
    await assert.rejects(issueNativeGrants({ profile: invalidProfile, app: 'textarea', invitationsFile: bound.invitationsFile, output }), error => error.code === 'OPERATOR_PROFILE_MISMATCH' && error.issuedMayExist === false);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
  assert.deepEqual(bound.databasePaths.map(item => snapshot(item.database).counts), emptyCounts);
  const counters = { create: 0, get: 0 }, outputs = [], calls = [], client = synthetic({ key, credentialId, counters, outputs }), fetcher = transport({ port: recovery, origin: profile.recoveryOrigin, calls });
  globalThis.location = { origin: profile.recoveryOrigin }; const prepared = [];
  for (const [index, selected] of nativeApps(profile).entries()) {
    const grantPath = join(state, 'grant-' + selected.id + '.json'); await issueNativeGrants({ profile, app: selected.id, invitationsFile: bound.invitationsFile, output: grantPath });
    const text = await readFile(grantPath, 'utf8'), grants = parseNativeGrants(text, nativeAppProfile(profile, selected.id)); assert.equal(grants.appId, selected.config.appId);
    assert.throws(() => parseNativeGrants(text, nativeAppProfile(profile, profile.apps[1 - index].id)), /NATIVE_GRANTS_CONTEXT_MISMATCH/);
    const replicas = profile.replicas.map(({ id, basePath }, position) => ({ id, store: sdk.createReserveHttpStore({ fetcher, basePath, enrollmentToken: grants.replicas[position].enrollmentToken }) }));
    let credential;
    try { credential = index ? await sdk.selectTextReserveCredential({ config: selected.config, webAuthnClient: client }) : await sdk.createTextReserveCredential({ config: selected.config, webAuthnClient: client, user: { name: 'Fictional collection', displayName: 'TEST ONLY' } }); handles.push(credential);
      const ready = await sdk.prepareTextReserveReplicas({ config: selected.config, text: samples[index], replicas, recoveryCredential: credential, webAuthnClient: client });
      assert.equal(ready.independentlyVerified, true); assert.equal(ready.text, samples[index]); assert.ok(ready.replicas.every(item => item.status === 'verified')); prepared.push(ready);
    } finally { credential?.close(); replicas.forEach(item => item.store.clearEnrollmentCapability()); await unlink(grantPath); }
  }
  assert.deepEqual(counters, { create: 1, get: 3 }); assert.ok(outputs.every(value => value.prfOutput.every(byte => byte === 0))); assert.equal(calls.filter(value => value.method === 'PUT').length, 4);
  const original = bound.databasePaths.map(item => snapshot(item.database)); assert.deepEqual(original[0], original[1]); assert.deepEqual(original[0].counts, { issued: 2, used: 2, records: 2 });
  for (const item of bound.databasePaths) { const bytes = await readFile(item.database); for (const forbidden of [key, credentialId, ...samples.map(value => Buffer.from(value))]) assert.equal(bytes.includes(forbidden), false); }
  const cases = [], processes = new Set();
  async function recover(name, expected, { ui = false } = {}) {
    const before = await Promise.all(bound.databasePaths.map(item => readFile(item.database))), snapshots = bound.databasePaths.map(item => snapshot(item.database)), output = join(directory, name); await mkdir(output, { mode: 0o700 });
    const result = await fresh(installed.directory, { origin: profile.recoveryOrigin, port: recovery, output, key: key.toString('base64url'), credentialId: credentialId.toString('base64url'), ...(ui ? { ui, jsdomPath } : {}) });
    assert.equal(result.ok, true, result.code); processes.add(result.pid); assert.deepEqual(result.counters, { create: 0, get: 1 }); assert.equal(result.nativeCalls, 0); assert.equal(result.forbiddenNetwork, 0); assert.equal(result.prfErased, true); assert.equal(result.persistence, 0); assert.equal(result.uiExports, ui);
    assert.deepEqual(result.results.map(item => item.status), expected); assert.deepEqual(result.results.map(item => item.appId), profile.apps.map(item => item.appId)); assert.equal(result.requests.length, ui ? 6 : 5); assert.ok(result.requests.every(item => item.method === 'GET'));
    for (const [index, status] of expected.entries()) for (const format of ['txt', 'json']) {
      const path = join(output, 'app-' + index + '.' + format);
      if (status !== 'recovered') await assert.rejects(readFile(path), { code: 'ENOENT' });
      else if (format === 'txt') assert.deepEqual(await readFile(path), Buffer.from(samples[index]));
      else assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { format: 'continuity-text-export/v1', text: samples[index] });
    }
    for (const [index, item] of bound.databasePaths.entries()) { assert.deepEqual(await readFile(item.database), before[index]); assert.deepEqual(snapshot(item.database), snapshots[index]); }
    cases.push({ name, ui, statuses: result.results.map(item => item.status), oneExistingAssertion: true, exactExports: true, noRecoveryWrites: true }); return result;
  }
  await recover('healthy', ['recovered', 'recovered']); await recover('ui-healthy', ['recovered', 'recovered'], { ui: true }); await closeA(); await killOwned(currentChildren[0]); assert.deepEqual(app.status(), { state: 'degraded', unavailableReplicas: ['alpha'] });
  const survivor = await recover('A-closed-alpha-killed', ['recovered', 'recovered']); assert.ok(survivor.results.every(item => item.replicas[0].status === 'unavailable' && item.replicas[1].status === 'verified'));
  await recover('ui-A-closed-alpha-killed', ['recovered', 'recovered'], { ui: true });
  const beforeRestart = await Promise.all(bound.databasePaths.map(item => readFile(item.database))); await close(); await start();
  for (const [index, item] of bound.databasePaths.entries()) assert.deepEqual(await readFile(item.database), beforeRestart[index]);
  await closeA(); await recover('same-state-restart', ['recovered', 'recovered']); await close();
  const betaDb = new DatabaseSync(bound.databasePaths[1].database);
  try { const row = betaDb.prepare('SELECT ciphertext FROM operator_records WHERE locator=?').get(prepared[0].locator), value = JSON.parse(Buffer.from(row.ciphertext).toString('utf8')), bytes = Buffer.from(value.ciphertext, 'base64url'); bytes[0] ^= 1; value.ciphertext = bytes.toString('base64url'); betaDb.prepare('UPDATE operator_records SET ciphertext=? WHERE locator=?').run(Buffer.from(JSON.stringify(value)), prepared[0].locator); } finally { betaDb.close(); }
  await start(); await closeA(); await killOwned(currentChildren[0]); const corrupt = await recover('one-app-corrupt', ['rejected', 'recovered']); assert.equal(corrupt.results[0].code, 'REPLICA_RECOVERY_FAILED'); await recover('ui-one-app-corrupt', ['rejected', 'recovered'], { ui: true }); await close();
  for (const [index, item] of bound.databasePaths.entries()) {
    const db = new DatabaseSync(item.database); try { db.exec('BEGIN'); db.exec('DELETE FROM operator_records'); for (const record of original[index].records) if (record.locator !== prepared[0].locator) db.prepare('INSERT INTO operator_records VALUES(?,?)').run(record.locator, record.bytes); db.exec('COMMIT'); } finally { db.close(); }
  }
  await start(); await closeA(); await recover('one-app-missing', ['missing', 'recovered']);
  await killOwned(currentChildren[0]); await killOwned(currentChildren[1]); assert.deepEqual(app.status(), { state: 'unavailable', unavailableReplicas: ['alpha', 'beta'] });
  await recover('both-stores-killed', ['unavailable', 'unavailable']); await close();
  for (const [index, path] of fixedPaths.entries()) assert.deepEqual(await readFile(path), fixedBytes[index]);
  assert.equal(processes.size, 9); assert.equal(ownedChildren.length, 8);
  console.log(JSON.stringify({ installedNativeCollectionManaged: true, appNamespaces: 2, managedStarts: 4, sameStateRestart: true, freshRecoveryProcesses: processes.size,
    selectedGrantContextValidated: true, invalidSelectionConsumesNoQuota: true, grantFilesNotNeededForRecovery: true, actualPrimaryListenerClosed: true,
    oneExistingAssertionPerCollection: true, actualStoreProcessesKilled: true, exactExports: true, perAppCorruptAndMissingIsolation: true, noRecoveryWrites: true, staticStatePreserved: true, installedUiWithRealSdk: true, freshJsdomProcesses: 3,
    physicalPasskeyProof: false, nativeBrowserEngineProof: false, publicTlsVerified: false, independentProviders: false, opaqueStoreGrantsCryptographicallyAppScoped: false, cases }));
});
