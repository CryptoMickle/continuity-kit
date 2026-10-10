import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { validateNativeProfile, nativeApps, nativeAppProfile, nativeConfig, parseNativeGrants } from '../text-native/profile.mjs';
import { issueNativeGrants, runtimeProfile } from '../text-native/operator.mjs';
import { initializeNativeOperator, readNativeOperatorState } from '../text-native/operator-state.mjs';
import { startNativeHost } from '../text-native/native-host.mjs';
import { initializeDatabase } from '../text-native/operator-runtime/store.mjs';
import { startOperatorHost } from '../text-native/operator-runtime/host.mjs';

const now = Date.parse('2090-10-10T12:00:00.000Z');
function profile(count = 2, copies = 2) {
  return { version: 2, apps: Array.from({ length: count }, (_, index) => ({ id: 'editor-' + index, label: 'Editor ' + index, appId: 'native-collection-app-' + index })),
    primaryOrigin: 'https://primary.example.test', recoveryOrigin: 'https://reserve.example.test', recoveryRpId: 'reserve.example.test',
    expiresAt: new Date(now + 3600000).toISOString(), replicas: ['alpha','beta','gamma'].slice(0, copies).map(id => ({ id, basePath: '/api/replicas/' + id + '/reserve' })) };
}
const grant = selected => ({ format: 'continuitykit/native-replica-grants/v1', appId: selected.appId, recoveryOrigin: selected.recoveryOrigin,
  replicas: selected.replicas.map(({ id }) => ({ id, enrollmentToken: randomBytes(32).toString('base64url'), expiresAt: new Date(now + 300000).toISOString() })) });
const throwsCode = (action, code) => assert.throws(action, error => error.code === code && error.message === code);

test('native collection policy supports bounded ordered apps and replicas with immutable per-app SDK views', () => {
  for (const count of [2, 8]) for (const copies of [2, 3]) {
    const input = profile(count, copies), copied = validateNativeProfile(input, { now }), apps = nativeApps(copied, { now });
    assert.deepEqual(copied, input); assert.equal(apps.length, count);
    assert.ok(Object.isFrozen(copied) && Object.isFrozen(copied.apps) && copied.apps.every(Object.isFrozen));
    assert.ok(Object.isFrozen(apps) && apps.every(app => Object.isFrozen(app) && Object.isFrozen(app.config)));
    const selected = nativeAppProfile(copied, 'editor-' + (count - 1), { now });
    assert.equal(selected.version, 1); assert.equal(selected.appId, input.apps[count - 1].appId); assert.equal(selected.replicas.length, copies);
    assert.deepEqual(nativeConfig(selected), apps[count - 1].config);
    input.apps[0].appId = 'changed'; input.apps.reverse(); input.replicas.reverse();
    assert.equal(copied.apps[0].appId, 'native-collection-app-0'); assert.equal(copied.replicas[0].id, 'alpha');
  }
});

test('native collection policy rejects duplicate, malformed, accessor and unbounded app definitions before evaluation', () => {
  const mutations = [v => v.apps = [], v => v.apps = v.apps.slice(0, 1), v => v.apps = profile(9).apps,
    v => v.apps[1].id = v.apps[0].id, v => v.apps[1].appId = v.apps[0].appId,
    v => v.apps[0].id = '../bad', v => v.apps[0].appId = '_invalid', v => v.apps[0].label = 'x'.repeat(65),
    v => v.apps[0].label = ' ', v => v.apps[0].label = 'bad\nlabel', v => v.apps[0].extra = true,
    v => v.appId = 'mixed-v1', v => v.version = 3, v => v.recoveryRpId = 'example.test',
    v => v.primaryOrigin = 'https://reserve.example.test:8443'];
  for (const mutate of mutations) { const input = profile(); mutate(input); throwsCode(() => validateNativeProfile(input, { now }), 'NATIVE_PROFILE_INVALID'); }
  let reads = 0;
  for (const mutate of [v => Object.defineProperty(v, 'version', { get() { reads++; return 2; } }),
    v => Object.defineProperty(v, 'apps', { get() { reads++; return []; } }),
    v => Object.defineProperty(v.apps, '0', { get() { reads++; return {}; } }),
    v => Object.defineProperty(v.apps[0], 'appId', { get() { reads++; return 'secret'; } })]) {
    const input = profile(); mutate(input); throwsCode(() => validateNativeProfile(input, { now }), 'NATIVE_PROFILE_INVALID');
  }
  assert.equal(reads, 0);
});

test('a selected native app is required for v2 grants and a valid bundle cannot be rebound to another app', () => {
  const full = profile(), first = nativeAppProfile(full, 'editor-0', { now }), second = nativeAppProfile(full, 'editor-1', { now });
  const encoded = JSON.stringify(grant(first));
  throwsCode(() => nativeConfig(full), 'NATIVE_APP_SELECTION_REQUIRED');
  for (const id of [undefined, '', 'missing', 'native-collection-app-0']) throwsCode(() => nativeAppProfile(full, id, { now }), 'NATIVE_APP_SELECTION_REQUIRED');
  throwsCode(() => parseNativeGrants(encoded, full, { now }), 'NATIVE_APP_SELECTION_REQUIRED');
  assert.equal(parseNativeGrants(encoded, first, { now }).appId, first.appId);
  throwsCode(() => parseNativeGrants(encoded, second, { now }), 'NATIVE_GRANTS_CONTEXT_MISMATCH');
  throwsCode(() => nativeAppProfile(full, 'editor-0', { now: Date.parse(full.expiresAt) }), 'NATIVE_PROFILE_EXPIRED');
});

test('single-app v1 keeps its existing runtime policy and explicit selection behavior', () => {
  const v1 = nativeAppProfile(profile(), 'editor-0', { now });
  assert.equal(nativeAppProfile(v1).appId, v1.appId); assert.equal(nativeAppProfile(v1, 'text').appId, v1.appId);
  assert.deepEqual(nativeApps(v1), [{ id: 'text', label: 'Text reserve', config: nativeConfig(v1) }]);
  assert.deepEqual(runtimeProfile(v1).apps, [{ id: 'text', label: 'Text reserve', appId: v1.appId }]);
  throwsCode(() => nativeAppProfile(v1, 'editor-0'), 'NATIVE_APP_SELECTION_REQUIRED');
});

test('durable native collection state binds every app and its order without rewriting an existing state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-collection-state-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const value = profile(), state = join(directory, 'state'), ports = { primary: 32171, recovery: 32172, gateway: 32173, replicas: [{ id: 'alpha', port: 32174 }, { id: 'beta', port: 32175 }] };
  initializeNativeOperator({ profile: value, state, ports });
  const saved = readNativeOperatorState({ profile: value, state });
  assert.deepEqual(JSON.parse(await readFile(saved.operatorProfilePath, 'utf8')).apps, value.apps);
  const files = await readdir(state), before = await Promise.all(files.map(file => readFile(join(state, file))));
  for (const change of [v => v.apps.reverse(), v => v.apps[1].appId = 'changed-app', v => v.apps[1].label = 'Changed label']) {
    const wrong = structuredClone(value); change(wrong); throwsCode(() => readNativeOperatorState({ profile: wrong, state }), 'NATIVE_STATE_BINDING_INVALID');
  }
  throwsCode(() => readNativeOperatorState({ profile: nativeAppProfile(value, 'editor-0'), state }), 'NATIVE_STATE_BINDING_INVALID');
  assert.deepEqual(await readdir(state), files); assert.deepEqual(await Promise.all(files.map(file => readFile(join(state, file)))), before);
});

function count(database) { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare('SELECT issued FROM operator_meta').get().issued; } finally { db.close(); } }
async function operatorFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'native-collection-issuer-')), full = profile(), hosts = [], databases = [], invitations = [];
  full.expiresAt = new Date(Date.now() + 3600000).toISOString();
  t.after(async () => { await Promise.all(hosts.map(host => host.close())); await rm(directory, { recursive: true, force: true }); });
  for (const { id } of full.replicas) {
    const invitation = randomBytes(32).toString('hex'), invitationFile = join(directory, id + '-invitation.txt'), database = join(directory, id + '.db');
    await writeFile(invitationFile, invitation, { mode: 0o600 }); initializeDatabase(database, runtimeProfile(full)); databases.push(database);
    const host = await startOperatorHost({ configuration: runtimeProfile(full), database, invitationFile }); hosts.push(host); invitations.push({ id, invitation, port: host.port });
  }
  const invitationsFile = join(directory, 'invitations.json'); await writeFile(invitationsFile, JSON.stringify({ replicas: invitations }), { mode: 0o600 });
  return { directory, profile: full, hosts, databases, invitationsFile };
}

test('native collection issuer requires a selector and checks the full operator app list before issuing private grants', { timeout: 15000 }, async t => {
  const f = await operatorFixture(t), output = join(f.directory, 'selected.json');
  for (const app of [undefined, 'unknown', f.profile.apps[0].appId]) {
    await assert.rejects(issueNativeGrants({ profile: f.profile, app, invitationsFile: '/missing/invitations', output: '/missing/output' }), { code: 'NATIVE_APP_SELECTION_REQUIRED' });
  }
  for (const change of [v => v.apps.reverse(), v => v.apps[1].appId = 'different-unselected-app']) {
    const changed = structuredClone(f.profile); change(changed);
    await assert.rejects(issueNativeGrants({ profile: changed, app: 'editor-0', invitationsFile: f.invitationsFile, output }), error => error.code === 'OPERATOR_PROFILE_MISMATCH' && error.issuedMayExist === false);
  }
  assert.deepEqual(f.databases.map(count), [0, 0]);
  for (const [index, app] of f.profile.apps.entries()) {
    const path = join(f.directory, 'selected-' + index + '.json');
    const result = await issueNativeGrants({ profile: f.profile, app: app.id, invitationsFile: f.invitationsFile, output: path });
    assert.equal(result.bundleWritten, true); assert.doesNotMatch(JSON.stringify(result), /enrollmentToken|invitation/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const text = await readFile(path, 'utf8'), selected = nativeAppProfile(f.profile, app.id);
    assert.equal(parseNativeGrants(text, selected).appId, app.appId);
    throwsCode(() => parseNativeGrants(text, nativeAppProfile(f.profile, f.profile.apps[1 - index].id)), 'NATIVE_GRANTS_CONTEXT_MISMATCH');
  }
  assert.deepEqual(f.databases.map(count), [2, 2]);
});

function get(port, origin, path) { return new Promise((done, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { host: new URL(origin).host }, signal: AbortSignal.timeout(5000) }, response => { response.resume(); response.once('end', () => done(response.statusCode)); response.once('error', reject); }); req.once('error', reject); req.end();
}); }
test('native collection host serves only configured app selector pages and exposes no simulation or issuer endpoint', { timeout: 15000 }, async t => {
  const f = await operatorFixture(t), assets = join(f.directory, 'recovery'); await mkdir(join(assets, 'assets'), { recursive: true });
  await writeFile(join(assets, 'index.html'), '<!doctype html><script type="module" src="/assets/main-12345678.js"></script>');
  await writeFile(join(assets, 'assets/main-12345678.js'), 'export const native=true;');
  await writeFile(join(assets, 'continuity-config.json'), JSON.stringify({ profile: f.profile, role: 'recovery' }));
  const host = await startNativeHost({ profile: f.profile, role: 'recovery', assets, gatewayPort: f.hosts[0].port }); f.hosts.push(host);
  for (const path of ['/', '/?app=editor-0', '/?app=editor-1']) assert.equal(await get(host.port, f.profile.recoveryOrigin, path), 200);
  for (const path of ['/?app=unknown', '/?app=editor-0&app=editor-1', '/?app=%65ditor-0', '/continuity-config.json?app=editor-0']) assert.equal(await get(host.port, f.profile.recoveryOrigin, path), 400);
  for (const path of ['/api/synthetic','/api/enrollment/start','/api/replica-enrollment','/api/replica-control','/api/status','/operator.mjs']) assert.equal(await get(host.port, f.profile.recoveryOrigin, path), 404);
  assert.deepEqual(f.databases.map(count), [0, 0]);
});
