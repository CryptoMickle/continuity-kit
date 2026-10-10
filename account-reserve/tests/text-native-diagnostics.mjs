import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, chmodSync, rmSync, unlinkSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { initializeNativeOperator, readNativeOperatorState } from '../text-native/operator-state.mjs';
import { installedNativeFixture } from './native-installed-fixture.mjs';
import { openStore } from '../text-native/operator-runtime/store.mjs';
import { canonical, TEXT_FORMAT } from '../text-native/operator-runtime/profile.mjs';

const installed = await installedNativeFixture();
after(() => installed.close());
const { diagnoseNativeOperator } = await import(pathToFileURL(join(installed.directory, 'operator-diagnostics.mjs')));

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, { collection = false } = {}) {
  const parent = mkdtempSync('/tmp/continuity-native-diagnostics-'); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const profile = { version: collection ? 2 : 1, ...(collection ? { apps: [{ id: 'text', label: 'Text', appId: 'diagnostic-text' }, { id: 'markdown', label: 'Markdown', appId: 'diagnostic-markdown' }] } : { appId: 'diagnostic-single' }), primaryOrigin: 'https://primary.example', recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example', expiresAt: '2090-10-10T12:00:00.000Z', replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] };
  const ports = { primary: 33211, recovery: 33212, gateway: 33213, replicas: [{ id: 'alpha', port: 33214 }, { id: 'beta', port: 33215 }] };
  const state = join(parent, 'state'), out = join(parent, 'dist'); initializeNativeOperator({ profile, ports, state });
  const bound = readNativeOperatorState({ profile, state }), runtime = JSON.parse(readFileSync(bound.operatorProfilePath)), locator = randomBytes(32).toString('base64url'), grant = randomBytes(32).toString('hex');
  const bytes = Buffer.from(canonical({ format: TEXT_FORMAT, nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(40).toString('base64url') }));
  for (const { database } of bound.databasePaths) { const store = openStore(database, runtime); try { store.issue(grant); store.putIfAbsent(locator, bytes, grant); } finally { store.close(); } }
  const html = '<!doctype html><title>Diagnostic fixture</title><script type="module" src="/assets/main-12345678.js"></script>', js = 'export const fixture=true;';
  for (const role of ['primary', 'recovery']) {
    mkdirSync(join(out, role, 'assets'), { recursive: true });
    writeFileSync(join(out, role, 'continuity-config.json'), JSON.stringify({ profile: bound.profile, role }));
    writeFileSync(join(out, role, 'index.html'), html); writeFileSync(join(out, role, 'assets/main-12345678.js'), js);
  }
  writeFileSync(join(out, 'build-report.json'), JSON.stringify({ version: 1, mode: 'native', nativeAssetsOnly: true, profileSha256: hash(JSON.stringify(bound.profile)), assetFiles: ['index.html', 'assets/main-12345678.js'], assetSha256: { 'index.html': hash(html), 'assets/main-12345678.js': hash(js) } }));
  const secrets = [parent, state, out, locator, grant, bytes.toString('base64url'), ...JSON.parse(readFileSync(bound.invitationsFile)).replicas.map(x => x.invitation)];
  return { profile: bound.profile, parent, state, out, ports, secrets, args: { profile: bound.profile, state, out } };
}
function snapshot(directory) {
  return readdirSync(directory).sort().map(name => { const path = join(directory, name), stat = lstatSync(path, { bigint: true }); return { name, ino: String(stat.ino), mode: Number(stat.mode), mtime: String(stat.mtimeNs), contents: stat.isSymbolicLink() ? null : stat.isDirectory() ? snapshot(path) : hash(readFileSync(path)) }; });
}
function failure(report, code) { assert.equal(report.ok, false); assert.ok(report.checks.some(x => x.ok === false && x.code === code), JSON.stringify(report)); }
function frozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); for (const item of Object.values(value)) frozen(item); } }
function safe(report, f) {
  assert.equal(report.readOnly, true); assert.equal(report.advisory, true); assert.equal(report.applicationServicesStarted, false); assert.equal(report.grantsIssued, false); assert.equal(report.physicalPasskeyVerified, false); assert.equal(report.cryptographicRecoveryVerified, false);
  const text = JSON.stringify(report); for (const secret of f.secrets) assert.equal(text.includes(secret), false);
  for (const check of report.checks.filter(x => !x.ok)) { assert.equal(typeof check.message, 'string'); assert.ok(check.message.length > 0); assert.equal(typeof check.action, 'string'); assert.ok(check.action.length > 0); }
  frozen(report);
}

test('healthy v1/v2 read-only diagnostics preserve populated state and return immutable bounded reports', async t => {
  for (const collection of [false, true]) { const f = fixture(t, { collection }), before = snapshot(f.parent), report = await diagnoseNativeOperator(f.args);
    assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.portAvailabilityChecked, false); safe(report, f); assert.deepEqual(snapshot(f.parent), before);
  }
});

test('changed original app binding is distinct from private-file permissions and malformed state', async t => {
  const f = fixture(t), path = join(f.state, 'native-state.json'), original = readFileSync(path);
  let before = snapshot(f.parent), report = await diagnoseNativeOperator({ ...f.args, profile: { ...f.profile, appId: 'different-existing-app' } });
  failure(report, 'PROFILE_STATE_MISMATCH'); safe(report, f); assert.deepEqual(snapshot(f.parent), before);
  chmodSync(path, 0o644); before = snapshot(f.parent); report = await diagnoseNativeOperator(f.args);
  failure(report, 'PRIVATE_PERMISSIONS_INVALID'); safe(report, f); assert.deepEqual(snapshot(f.parent), before); chmodSync(path, 0o600);
  writeFileSync(path, '{invalid-private-state-with-sensitive-detail'); before = snapshot(f.parent); report = await diagnoseNativeOperator(f.args);
  failure(report, 'STATE_INVALID'); safe(report, f); assert.equal(JSON.stringify(report).includes('sensitive-detail'), false); assert.deepEqual(snapshot(f.parent), before); writeFileSync(path, original);
});

test('every private-state file with unsafe permissions is rejected without repairing or disclosing it', async t => {
  const f = fixture(t);
  for (const name of readdirSync(f.state)) { const path = join(f.state, name); chmodSync(path, 0o644); const before = snapshot(f.parent), report = await diagnoseNativeOperator(f.args);
    failure(report, 'PRIVATE_PERMISSIONS_INVALID'); safe(report, f); assert.deepEqual(snapshot(f.parent), before); chmodSync(path, 0o600);
  }
});

test('unreadable private files give permission guidance without changing mode or contents', async t => {
  const f = fixture(t);
  for (const name of ['native-state.json', 'alpha.db', 'alpha-invitation.txt']) {
    for (const mode of [0o000, 0o200]) {
      const path = join(f.state, name), before = snapshot(f.parent); chmodSync(path, mode);
      try {
        const report = await diagnoseNativeOperator(f.args); failure(report, 'PRIVATE_PERMISSIONS_INVALID'); safe(report, f); assert.equal(lstatSync(path).mode & 0o7777, mode);
      } finally { chmodSync(path, 0o600); }
      assert.deepEqual(snapshot(f.parent), before);
    }
  }
});

test('unsafe state-directory permissions, aliases and source targets remain rejected', async t => {
  const f = fixture(t); chmodSync(f.state, 0o755); let before = snapshot(f.parent), report = await diagnoseNativeOperator(f.args);
  assert.equal(report.ok, false); safe(report, f); assert.deepEqual(snapshot(f.parent), before); chmodSync(f.state, 0o700);
  const alias = join(f.parent, 'alias'); symlinkSync(f.state, alias);
  for (const state of [alias, f.parent + '/missing/../state', installed.directory]) { before = snapshot(f.parent); report = await diagnoseNativeOperator({ ...f.args, state }); failure(report, 'STATE_PATH_INVALID'); safe(report, f); assert.deepEqual(snapshot(f.parent), before); }
});

test('symlinked and hardlinked private files cannot be diagnosed as usable state', async t => {
  const f = fixture(t), target = join(f.state, 'alpha-invitation.txt'), alias = join(f.parent, 'aliased-invitation'), bytes = readFileSync(target);
  linkSync(target, alias); let before = snapshot(f.parent), report = await diagnoseNativeOperator(f.args); assert.equal(report.ok, false); safe(report, f); assert.deepEqual(snapshot(f.parent), before); unlinkSync(alias);
  writeFileSync(alias, bytes, { mode: 0o600 }); unlinkSync(target); symlinkSync(alias, target); before = snapshot(f.parent); report = await diagnoseNativeOperator(f.args); assert.equal(report.ok, false); safe(report, f); assert.deepEqual(snapshot(f.parent), before);
});

test('a present lock stays present regardless of valid, malformed, oversized or symlinked contents', async t => {
  const f = fixture(t), lock = join(f.state, 'runtime.lock'), privateNonce = randomBytes(32).toString('hex'); f.secrets.push(privateNonce);
  for (const content of [JSON.stringify({ version: 1, nonce: privateNonce }) + '\n', 'private-malformed-lock', 'x'.repeat(1024 * 1024)]) {
    writeFileSync(lock, content, { flag: 'wx', mode: 0o600 }); const before = snapshot(f.parent), report = await diagnoseNativeOperator({ ...f.args, checkPorts: true });
    failure(report, 'RUNTIME_LOCK_PRESENT'); safe(report, f); assert.equal(report.portAvailabilityChecked, false); assert.deepEqual(snapshot(f.parent), before); unlinkSync(lock);
  }
  symlinkSync('/nonexistent-do-not-follow', lock); const before = snapshot(f.parent), report = await diagnoseNativeOperator(f.args); failure(report, 'RUNTIME_LOCK_PRESENT'); safe(report, f); assert.deepEqual(snapshot(f.parent), before);
});

test('invalid/expired profiles and missing or changed builds get useful distinct guidance without writes', async t => {
  const f = fixture(t), before = snapshot(f.parent);
  for (const [profile, code] of [[{ ...f.profile, appId: 'invalid app' }, 'PROFILE_INVALID'], [{ ...f.profile, expiresAt: '2000-01-01T00:00:00.000Z' }, 'PROFILE_EXPIRED']]) {
    const report = await diagnoseNativeOperator({ ...f.args, profile }); failure(report, code); safe(report, f); assert.deepEqual(snapshot(f.parent), before);
  }
  const report = await diagnoseNativeOperator({ ...f.args, out: join(f.parent, 'not-built') }); failure(report, 'BUILD_INVALID'); safe(report, f); assert.deepEqual(snapshot(f.parent), before);
  writeFileSync(join(f.out, 'recovery/assets/main-12345678.js'), 'changed'); const changed = snapshot(f.parent), altered = await diagnoseNativeOperator(f.args); failure(altered, 'BUILD_INVALID'); safe(altered, f); assert.deepEqual(snapshot(f.parent), changed);
});

test('invalid, extra, symbolic and accessor options never execute getters or disclose errors', async t => {
  const f = fixture(t), before = snapshot(f.parent); let calls = 0;
  const variants = [null, undefined, [], { ...f.args, extra: 'private-secret' }, { ...f.args, checkPorts: 'true' }, { ...f.args, [Symbol('secret')]: true }];
  for (const key of ['profile', 'state', 'out', 'checkPorts']) { const options = { ...f.args, checkPorts: false }; Object.defineProperty(options, key, { enumerable: true, get() { calls++; throw new Error('private-secret'); } }); variants.push(options); }
  for (const options of variants) { const report = await diagnoseNativeOperator(options); failure(report, 'OPTIONS_INVALID'); safe(report, f); assert.equal(JSON.stringify(report).includes('private-secret'), false); }
  assert.equal(calls, 0); assert.deepEqual(snapshot(f.parent), before);
});

test('occupied port remains under its existing owner and receives no connection from diagnostics', async t => {
  const f = fixture(t), server = createServer(socket => { connections++; socket.destroy(); }); let connections = 0;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(f.ports.recovery, '127.0.0.1', done); });
  t.after(() => new Promise(done => server.close(done)));
  const before = snapshot(f.parent), report = await diagnoseNativeOperator({ ...f.args, checkPorts: true });
  failure(report, 'PORT_OCCUPIED'); safe(report, f); assert.equal(connections, 0); assert.equal(server.listening, true); assert.deepEqual(snapshot(f.parent), before);
  const occupied = report.checks.find(x => x.code === 'PORT_OCCUPIED'); assert.equal(occupied.port, f.ports.recovery);
});

test('available-port probes release every temporary listener and make no lasting state change', async t => {
  const f = fixture(t), before = snapshot(f.parent), report = await diagnoseNativeOperator({ ...f.args, checkPorts: true });
  assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.portAvailabilityChecked, true); safe(report, f); assert.deepEqual(snapshot(f.parent), before);
  const servers = [];
  try { for (const port of [f.ports.primary, f.ports.recovery, f.ports.gateway, ...f.ports.replicas.map(x => x.port)]) { const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); }); servers.push(server); } }
  finally { await Promise.all(servers.map(server => new Promise(done => server.close(done)))); }
});
