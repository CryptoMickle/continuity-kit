import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, chmodSync, rmSync, rmdirSync, unlinkSync, symlinkSync, linkSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { initializeNativeOperator, readNativeOperatorState } from '../text-native/operator-state.mjs';
import { openStore } from '../text-native/operator-runtime/store.mjs';
import { canonical, TEXT_FORMAT } from '../text-native/operator-runtime/profile.mjs';

const modulePath = fileURLToPath(new URL('../text-native/operator-state.mjs', import.meta.url));
const nativeRoot = dirname(modulePath);
const profile = () => ({ version: 1, appId: 'native-state-test', primaryOrigin: 'https://primary.example', recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example', expiresAt: '2090-10-10T12:00:00.000Z', replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] });
const ports = () => ({ primary: 6273, recovery: 6274, gateway: 6275, replicas: [{ id: 'alpha', port: 6276 }, { id: 'beta', port: 6277 }] });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, { initialize = true, three = false } = {}) {
  const parent = mkdtempSync('/tmp/continuity-native-state-');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const value = { profile: profile(), ports: ports(), state: join(parent, 'state') };
  if (three) { value.profile.replicas.push({ id: 'gamma', basePath: '/api/replicas/gamma/reserve' }); value.ports.replicas.push({ id: 'gamma', port: 6278 }); }
  const summary = initialize ? initializeNativeOperator(value) : undefined;
  return { ...value, parent, summary, read: () => readNativeOperatorState({ profile: value.profile, state: value.state }) };
}
function reject(action, code) {
  assert.throws(action, error => {
    assert.match(error.code, /^NATIVE_(STATE|PROFILE)_[A-Z_]+$/);
    if (code) assert.equal(error.code, code);
    assert.equal(error.message, error.code); assert.deepEqual(Object.keys(error), ['code']); return true;
  });
}
function snapshot(directory) {
  return readdirSync(directory).sort().map(name => {
    const path = join(directory, name), stat = lstatSync(path, { bigint: true });
    return { name, ino: String(stat.ino), mode: Number(stat.mode), mtime: String(stat.mtimeNs), bytes: stat.isFile() ? digest(readFileSync(path)) : undefined };
  });
}
function alterJson(path, mutate) { const value = JSON.parse(readFileSync(path, 'utf8')); mutate(value); writeFileSync(path, JSON.stringify(value) + '\n'); }
function sql(path, action) { const db = new DatabaseSync(path); try { action(db); } finally { db.close(); } }
function processResult(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}
const cli = args => processResult([modulePath, ...args]);

test('initialization binds 2–3 private stores and returns frozen non-secret paths', t => {
  for (const three of [false, true]) {
    const value = fixture(t, { three }), result = value.read();
    assert.deepEqual(value.summary, { initialized: true, replicas: three ? 3 : 2, passkeysCreated: false, servicesStarted: false });
    assert.ok(Object.isFrozen(value.summary)); assert.equal(result.directory, realpathSync(value.state));
    assert.deepEqual(result.profile, value.profile); assert.deepEqual(result.ports, value.ports);
    assert.deepEqual(result.gatewayConfiguration, { recoveryOrigin: value.profile.recoveryOrigin, replicas: value.ports.replicas });
    for (const item of [result, result.profile, result.profile.replicas, ...result.profile.replicas, result.ports, result.ports.replicas, ...result.ports.replicas, result.databasePaths, ...result.databasePaths, result.gatewayConfiguration]) assert.ok(Object.isFrozen(item));
    assert.equal(lstatSync(value.state).mode & 0o7777, 0o700);
    for (const name of readdirSync(value.state)) { const stat = lstatSync(join(value.state, name)); assert.equal(stat.mode & 0o7777, 0o600); assert.equal(stat.nlink, 1); }
    const invitations = JSON.parse(readFileSync(result.invitationsFile));
    assert.equal(new Set(invitations.replicas.map(item => item.invitation)).size, invitations.replicas.length);
    for (const item of invitations.replicas) { assert.match(item.invitation, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(result).includes(item.invitation), false); }
    value.profile.appId = 'changed'; value.ports.replicas[0].port = 9000;
    assert.equal(result.profile.appId, 'native-state-test'); assert.equal(result.ports.replicas[0].port, 6276);
  }
});

test('all invalid ports and context fail before creating any files', t => {
  const value = fixture(t, { initialize: false });
  const mutations = [p => { p.primary = 0; }, p => { p.recovery = 65536; }, p => { p.gateway = 1.5; }, p => { p.primary = p.gateway; },
    p => { p.replicas[0].port = p.recovery; }, p => { p.replicas[0].port = '6276'; }, p => { p.extra = true; }, p => { p.replicas[0].extra = true; },
    p => p.replicas.reverse(), p => p.replicas.pop(), p => { p.replicas[0].id = 'wrong'; }, p => { p.replicas.push({ id: 'gamma', port: 6278 }); }];
  for (const mutate of mutations) { const supplied = ports(); mutate(supplied); reject(() => initializeNativeOperator({ profile: value.profile, state: value.state, ports: supplied }), 'NATIVE_STATE_PORTS_INVALID'); assert.deepEqual(readdirSync(value.parent), []); }
  for (const change of [{ appId: 'invalid app' }, { expiresAt: '2000-01-01T00:00:00.000Z' }]) {
    reject(() => initializeNativeOperator({ profile: { ...value.profile, ...change }, state: value.state, ports: value.ports })); assert.deepEqual(readdirSync(value.parent), []);
  }
});

test('HTTP listener ports must match exact frontend origins; HTTPS may be proxied', t => {
  const value = fixture(t, { initialize: false });
  const local = { ...value.profile, primaryOrigin: 'http://primary.localhost:6273', recoveryOrigin: 'http://reserve.localhost:6274', recoveryRpId: 'reserve.localhost' };
  reject(() => initializeNativeOperator({ profile: { ...local, recoveryOrigin: 'http://reserve.localhost:9999' }, state: value.state, ports: value.ports }), 'NATIVE_STATE_PORTS_INVALID');
  assert.equal(existsSync(value.state), false);
  initializeNativeOperator({ profile: local, state: value.state, ports: value.ports });
  assert.equal(readNativeOperatorState({ profile: local, state: value.state }).ports.recovery, 6274);
});

test('accessors and unusual outer/port objects are rejected without evaluating getters', t => {
  const value = fixture(t, { initialize: false }); let calls = 0;
  const accessor = { enumerable: true, get() { calls++; throw new Error('private-secret'); } };
  for (const field of ['profile', 'state', 'ports']) {
    const options = { profile: value.profile, state: value.state, ports: value.ports }; Object.defineProperty(options, field, accessor); reject(() => initializeNativeOperator(options));
  }
  for (const field of ['primary', 'recovery', 'gateway', 'replicas']) {
    const supplied = ports(); Object.defineProperty(supplied, field, accessor); reject(() => initializeNativeOperator({ profile: value.profile, state: value.state, ports: supplied }));
  }
  const array = ports(); Object.defineProperty(array.replicas, '0', accessor);
  reject(() => initializeNativeOperator({ profile: value.profile, state: value.state, ports: array }));
  reject(() => initializeNativeOperator({ profile: value.profile, state: value.state, ports: value.ports, extra: true }));
  reject(() => readNativeOperatorState(Object.defineProperty({ state: value.state }, 'profile', accessor)));
  assert.equal(calls, 0); assert.deepEqual(readdirSync(value.parent), []);
});

test('existing empty or occupied directories are never overwritten or repaired', t => {
  const value = fixture(t, { initialize: false }); mkdirSync(value.state, { mode: 0o700 });
  reject(() => initializeNativeOperator({ profile: value.profile, state: value.state, ports: value.ports }), 'NATIVE_STATE_EXISTS');
  writeFileSync(join(value.state, 'keep.txt'), 'user-owned data', { mode: 0o600 }); const before = snapshot(value.state);
  reject(() => initializeNativeOperator({ profile: value.profile, state: value.state, ports: value.ports }), 'NATIVE_STATE_EXISTS');
  reject(value.read); assert.deepEqual(snapshot(value.state), before);
});

test('path boundaries reject traversal, source/public targets, symlinks and broad parents', t => {
  const value = fixture(t, { initialize: false });
  const broad = join(value.parent, 'broad'); mkdirSync(broad, { mode: 0o755 });
  const publicRole = join(value.parent, 'role'); mkdirSync(publicRole, { mode: 0o700 }); writeFileSync(join(publicRole, 'continuity-config.json'), '{}');
  const alias = join(value.parent, 'alias'); symlinkSync(value.parent, alias);
  for (const state of [join(broad, 'state'), join(publicRole, 'state'), join(alias, 'state'), join(nativeRoot, 'forbidden-state'), value.parent + '/child/../state', join(value.parent, 'missing-parent', 'state')]) {
    reject(() => initializeNativeOperator({ profile: value.profile, ports: value.ports, state }), 'NATIVE_STATE_PATH_INVALID');
  }
  assert.equal(existsSync(value.state), false); assert.equal(existsSync(join(nativeRoot, 'forbidden-state')), false);
  const target = join(value.parent, 'target'); symlinkSync(value.parent, target);
  reject(() => initializeNativeOperator({ profile: value.profile, ports: value.ports, state: target }), 'NATIVE_STATE_EXISTS');
  reject(() => readNativeOperatorState({ profile: value.profile, state: target }), 'NATIVE_STATE_PATH_INVALID');
});

test('package private subtree may be initialized and macOS /tmp aliases remain supported', t => {
  const privateRoot = join(nativeRoot, 'private'), existed = existsSync(privateRoot), root = join(privateRoot, 'state-test-' + randomBytes(8).toString('hex'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); if (!existed) try { rmdirSync(privateRoot); } catch {} });
  const state = join(root, 'session'); initializeNativeOperator({ profile: profile(), ports: ports(), state });
  assert.equal(readNativeOperatorState({ profile: profile(), state }).directory, realpathSync(state));
  const external = fixture(t); assert.equal(external.read().directory, realpathSync(external.state));
});

test('private modes and symlink or hardlink aliases on every required file fail closed', t => {
  const value = fixture(t), files = readdirSync(value.state);
  chmodSync(value.state, 0o755); reject(value.read, 'NATIVE_STATE_PATH_INVALID'); chmodSync(value.state, 0o700);
  for (const name of files) {
    const path = join(value.state, name); chmodSync(path, 0o644); reject(value.read); chmodSync(path, 0o600);
    const hard = join(value.parent, 'hard'); linkSync(path, hard); reject(value.read); unlinkSync(hard);
    const bytes = readFileSync(path), other = join(value.parent, 'other'); writeFileSync(other, bytes, { mode: 0o600 });
    unlinkSync(path); symlinkSync(other, path); reject(value.read); unlinkSync(path); writeFileSync(path, bytes, { mode: 0o600 }); unlinkSync(other);
  }
  assert.equal(value.read().databasePaths.length, 2);
});

test('saved app/origin/expiry, listener policy, operator and gateway bindings cannot drift', t => {
  const value = fixture(t);
  for (const change of [{ appId: 'another-app' }, { primaryOrigin: 'https://other.example' }, { expiresAt: '2091-01-01T00:00:00.000Z' }]) reject(() => readNativeOperatorState({ profile: { ...value.profile, ...change }, state: value.state }), 'NATIVE_STATE_BINDING_INVALID');
  const cases = [ ['native-state.json', p => { p.extra = true; }], ['native-state.json', p => { p.ports.replicas.reverse(); }],
    ['operator-profile.json', p => { p.apps[0].appId = 'other'; }], ['gateway.json', p => { p.replicas[0].port = 8888; }],
    ['invitations.json', p => { p.replicas.reverse(); }], ['invitations.json', p => { p.replicas[1].invitation = p.replicas[0].invitation; }] ];
  for (const [name, mutate] of cases) { const path = join(value.state, name), before = readFileSync(path); alterJson(path, mutate); reject(value.read); writeFileSync(path, before); }
  const invitation = join(value.state, 'alpha-invitation.txt'), before = readFileSync(invitation); writeFileSync(invitation, randomBytes(32).toString('hex') + '\n'); reject(value.read, 'NATIVE_STATE_BINDING_INVALID'); writeFileSync(invitation, before);
  assert.equal(value.read().ports.gateway, 6275);
});

test('read-only inspection preserves real ciphertext, counters, file hashes and timestamps', t => {
  const value = fixture(t), result = value.read(), operatorProfile = JSON.parse(readFileSync(result.operatorProfilePath)), key = randomBytes(32).toString('base64url');
  const bytes = Buffer.from(canonical({ format: TEXT_FORMAT, nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(48).toString('base64url') }));
  for (const { database } of result.databasePaths) {
    const store = openStore(database, operatorProfile), cap = randomBytes(32).toString('hex');
    try { store.issue(cap); assert.equal(store.putIfAbsent(key, bytes, cap), true); assert.deepEqual(store.counts(), { records: 1, issued: 1 }); } finally { store.close(); }
  }
  writeFileSync(join(value.state, 'private-grants.json'), 'unrelated private file', { mode: 0o600 });
  writeFileSync(join(value.state, 'runtime.lock'), 'launcher-owned lock', { mode: 0o600 });
  // The reader never traverses additional files, including unrelated aliases.
  symlinkSync('/nonexistent/do-not-open', join(value.state, 'unrelated-alias'));
  const before = snapshot(value.state); value.read(); value.read(); assert.deepEqual(snapshot(value.state), before);
  for (const { database } of result.databasePaths) {
    const db = new DatabaseSync(database, { readOnly: true });
    try { assert.deepEqual(Buffer.from(db.prepare('SELECT ciphertext FROM operator_records WHERE locator=?').get(key).ciphertext), bytes); assert.equal(db.prepare('SELECT issued FROM operator_meta').get().issued, 1); } finally { db.close(); }
    assert.equal(existsSync(database + '-journal'), false); assert.equal(existsSync(database + '-wal'), false);
  }
});

test('invalid database binding, schema, ciphertext and capability counters are rejected without repair', t => {
  const mutations = [db => db.prepare('UPDATE operator_meta SET config=?').run('{}'), db => db.exec('CREATE TABLE unexpected(x)'),
    db => db.exec('CREATE VIEW unexpected AS SELECT * FROM operator_meta'), db => db.exec('CREATE TRIGGER unexpected AFTER INSERT ON operator_records BEGIN SELECT 1; END'),
    db => { db.prepare('INSERT INTO operator_records VALUES(?,?)').run(randomBytes(32).toString('base64url'), Buffer.from('!')); },
    db => { db.exec('UPDATE operator_meta SET issued=1'); db.prepare('INSERT INTO operator_capabilities VALUES(?,?,?)').run('bad-hash', Date.now() + 1000, 0); },
    db => { db.prepare('INSERT INTO operator_capabilities VALUES(?,?,?)').run(randomBytes(32).toString('hex'), Date.now() + 1000, 0); } ];
  for (const mutate of mutations) { const value = fixture(t); sql(join(value.state, 'alpha.db'), mutate); const before = snapshot(value.state); reject(value.read, 'NATIVE_STATE_DATABASE_INVALID'); assert.deepEqual(snapshot(value.state), before); }
  const value = fixture(t); writeFileSync(join(value.state, 'alpha.db'), 'not SQLite, no secrets in error'); const before = snapshot(value.state); reject(value.read, 'NATIVE_STATE_DATABASE_INVALID'); assert.deepEqual(snapshot(value.state), before);
});

test('incomplete committed state is rejected without recreating any missing file', t => {
  for (const name of ['native-state.json', 'operator-profile.json', 'gateway.json', 'invitations.json', 'alpha.db', 'beta-invitation.txt']) {
    const value = fixture(t); unlinkSync(join(value.state, name)); const before = snapshot(value.state); reject(value.read); assert.deepEqual(snapshot(value.state), before);
    reject(() => initializeNativeOperator({ profile: value.profile, state: value.state, ports: value.ports }), 'NATIVE_STATE_EXISTS'); assert.deepEqual(snapshot(value.state), before);
  }
});

test('failed initialization removes only owned files and never competing contents or a replacement directory', async t => {
  for (const replace of [false, true]) {
    const value = fixture(t, { initialize: false });
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const target=${JSON.stringify(value.state)};
      fs.linkSync=()=>{ ${replace ? "fs.renameSync(target,target+'-displaced'); fs.mkdirSync(target,{mode:0o700});" : "fs.writeFileSync(target+'/competing.txt','keep me',{mode:0o600,flag:'wx'});"}
        throw Object.assign(new Error('private details must not escape'),{code:'EACCES'}); };
      syncBuiltinESMExports();
      const {initializeNativeOperator}=await import(${JSON.stringify(modulePath)});
      try { initializeNativeOperator(${JSON.stringify({ profile: value.profile, ports: value.ports, state: value.state })}); process.exitCode=2; }
      catch(error){ console.log(error.code); }
    `;
    const result = await processResult(['--input-type=module', '-e', script]);
    assert.equal(result.code, 0); assert.equal(result.stdout.trim(), 'NATIVE_STATE_INITIALIZATION_FAILED'); assert.equal((result.stdout + result.stderr).includes('private details'), false);
    assert.equal(existsSync(value.state), true);
    if (replace) { assert.deepEqual(readdirSync(value.state), []); assert.ok(readdirSync(value.state + '-displaced').includes('alpha.db')); }
    else { assert.deepEqual(readdirSync(value.state), ['competing.txt']); assert.equal(readFileSync(join(value.state, 'competing.txt'), 'utf8'), 'keep me'); }
    const before = snapshot(value.state); reject(value.read); assert.deepEqual(snapshot(value.state), before);
  }
});

test('concurrent CLI initializers have exactly one winner and never disclose invitations', async t => {
  const value = fixture(t, { initialize: false }), profileFile = join(value.parent, 'profile.json'), portsFile = join(value.parent, 'ports.json');
  writeFileSync(profileFile, JSON.stringify(value.profile), { mode: 0o600 }); writeFileSync(portsFile, JSON.stringify(value.ports), { mode: 0o600 });
  const args = ['init', '--profile', profileFile, '--state', value.state, '--ports', portsFile];
  const results = await Promise.all([cli(args), cli(args)]); assert.deepEqual(results.map(x => x.code).sort(), [0, 1]);
  const success = results.find(x => x.code === 0), failure = results.find(x => x.code === 1);
  assert.deepEqual(JSON.parse(success.stdout), { initialized: true, replicas: 2, passkeysCreated: false, servicesStarted: false });
  assert.match(failure.stderr, /NATIVE_STATE_EXISTS/); assert.equal(failure.stdout, '');
  const output = results.map(x => x.stdout + x.stderr).join(''), state = value.read(), invitations = JSON.parse(readFileSync(state.invitationsFile));
  for (const { invitation } of invitations.replicas) assert.equal(output.includes(invitation), false);
  const before = snapshot(value.state); const again = await cli(args); assert.equal(again.code, 1); assert.deepEqual(snapshot(value.state), before);
});
