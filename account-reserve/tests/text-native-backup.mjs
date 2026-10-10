import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, chmodSync, rmSync, unlinkSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { initializeNativeOperator, readNativeOperatorState } from '../text-native/operator-state.mjs';
import { backupNativeOperator, restoreNativeOperator } from '../text-native/operator-backup.mjs';
import { openStore } from '../text-native/operator-runtime/store.mjs';
import { canonical, TEXT_FORMAT } from '../text-native/operator-runtime/profile.mjs';

const modulePath = fileURLToPath(new URL('../text-native/operator-backup.mjs', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const opaque = () => Buffer.from(canonical({ format: TEXT_FORMAT, nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(64).toString('base64url') }));
function fixture(t, { collection = true, three = false } = {}) {
  const parent = mkdtempSync('/tmp/continuity-native-backup-');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const profile = { version: collection ? 2 : 1, ...(collection ? { apps: [{ id: 'text', label: 'Text', appId: 'backup-text' }, { id: 'markdown', label: 'Markdown', appId: 'backup-markdown' }] } : { appId: 'backup-single' }), primaryOrigin: 'https://primary.example', recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example', expiresAt: '2090-10-10T12:00:00.000Z', replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] };
  const ports = { primary: 6273, recovery: 6274, gateway: 6275, replicas: [{ id: 'alpha', port: 6276 }, { id: 'beta', port: 6277 }] };
  if (three) { profile.replicas.push({ id: 'gamma', basePath: '/api/replicas/gamma/reserve' }); ports.replicas.push({ id: 'gamma', port: 6278 }); }
  const state = join(parent, 'original'), output = join(parent, 'backup.json'), restored = join(parent, 'restored');
  initializeNativeOperator({ profile, ports, state });
  const bound = readNativeOperatorState({ profile, state }), runtime = JSON.parse(readFileSync(bound.operatorProfilePath));
  const records = Array.from({ length: 2 }, () => ({ locator: randomBytes(32).toString('base64url'), bytes: opaque() }));
  const secrets = [];
  for (const { database } of bound.databasePaths) {
    const store = openStore(database, runtime);
    try {
      for (const record of records) { const grant = randomBytes(32).toString('hex'); secrets.push(grant); store.issue(grant); assert.equal(store.putIfAbsent(record.locator, record.bytes, grant), true); }
      const unused = randomBytes(32).toString('hex'); secrets.push(unused); store.issue(unused);
    } finally { store.close(); }
  }
  for (const item of JSON.parse(readFileSync(bound.invitationsFile)).replicas) secrets.push(item.invitation);
  const backup = () => backupNativeOperator({ profile, state, output });
  const restore = (options = {}) => restoreNativeOperator({ profile, ports, input: output, expectedSha256: digest(readFileSync(output)), state: restored, ...options });
  return { parent, profile, ports, state, output, restored, bound, records, secrets, backup, restore };
}
function snapshot(directory) {
  return readdirSync(directory).sort().map(name => { const stat = lstatSync(join(directory, name), { bigint: true }); return { name, ino: String(stat.ino), mode: Number(stat.mode), mtime: String(stat.mtimeNs), bytes: stat.isFile() ? digest(readFileSync(join(directory, name))) : null }; });
}
function reject(action) {
  assert.throws(action, error => { assert.match(error.code, /^NATIVE_(BACKUP|STATE|PROFILE|OPERATOR)_[A-Z_]+$/); assert.equal(error.message, error.code); assert.deepEqual(Object.keys(error), ['code']); return true; });
}
function dbRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { issued: db.prepare('SELECT issued FROM operator_meta').get().issued, records: db.prepare('SELECT locator,ciphertext FROM operator_records ORDER BY locator').all().map(row => ({ locator: row.locator, bytes: Buffer.from(row.ciphertext) })), capabilities: db.prepare('SELECT count(*) AS n FROM operator_capabilities').get().n }; }
  finally { db.close(); }
}

test('private backup/restore retains exact ciphertext and consumed quota for v1/v2 and 2/3 replicas', t => {
  for (const options of [{ collection: false }, { collection: true }, { collection: true, three: true }]) {
    const value = fixture(t, options), before = snapshot(value.state), result = value.backup(), bytes = readFileSync(value.output);
    assert.equal(result.sha256, digest(bytes)); assert.equal(result.bytes, bytes.length); assert.equal(result.backupWritten, true);
    assert.equal(lstatSync(value.output).mode & 0o7777, 0o600); assert.equal(lstatSync(value.output).nlink, 1);
    assert.deepEqual(snapshot(value.state), before); assert.equal(existsSync(join(value.state, 'runtime.lock')), false);
    const bundle = JSON.parse(bytes); assert.equal(canonical(bundle), bytes.toString()); assert.deepEqual(bundle.profile, value.profile);
    for (const secret of value.secrets) assert.equal(bytes.includes(secret), false);
    assert.equal(bytes.includes('operator_capabilities'), false); assert.equal(bytes.includes('ports'), false);
    const restored = value.restore(); assert.equal(restored.restored, true); assert.equal(restored.pendingCapabilitiesTransferred, false);
    assert.equal(restored.passkeysCreated, false); assert.equal(restored.servicesStarted, false);
    const target = readNativeOperatorState({ profile: value.profile, state: value.restored });
    const newInvitations = JSON.parse(readFileSync(target.invitationsFile)).replicas.map(item => item.invitation);
    for (const secret of newInvitations) assert.equal(value.secrets.includes(secret), false);
    for (let i = 0; i < target.databasePaths.length; i++) {
      const original = dbRows(value.bound.databasePaths[i].database), fresh = dbRows(target.databasePaths[i].database);
      assert.equal(original.capabilities, 3); assert.equal(fresh.capabilities, 0);
      assert.equal(fresh.issued, 3); assert.deepEqual(fresh.records, original.records);
    }
    for (const name of readdirSync(value.restored)) assert.equal(lstatSync(join(value.restored, name)).mode & 0o7777, 0o600);
    assert.equal(lstatSync(value.restored).mode & 0o7777, 0o700); assert.deepEqual(snapshot(value.state), before);
  }
});

test('backup refuses a live or stale managed lock without replacing it or reading damaged databases', t => {
  const value = fixture(t), lock = join(value.state, 'runtime.lock');
  writeFileSync(lock, 'owned elsewhere', { mode: 0o600 }); writeFileSync(value.bound.databasePaths[0].database, 'deliberately invalid database');
  const before = snapshot(value.state); reject(value.backup);
  assert.deepEqual(snapshot(value.state), before); assert.equal(existsSync(value.output), false);
  unlinkSync(lock); reject(value.backup); assert.equal(existsSync(lock), false); assert.equal(existsSync(value.output), false);
});

test('asymmetric replicas retain their own records and quotas rather than duplicating a sibling', t => {
  const value = fixture(t, { three: true }), runtime = JSON.parse(readFileSync(value.bound.operatorProfilePath));
  for (let index = 1; index < value.bound.databasePaths.length; index++) {
    const store = openStore(value.bound.databasePaths[index].database, runtime);
    try {
      for (let n = 0; n < index; n++) {
        const grant = randomBytes(32).toString('hex'); store.issue(grant);
        assert.equal(store.putIfAbsent(randomBytes(32).toString('base64url'), opaque(), grant), true);
      }
    } finally { store.close(); }
  }
  const before = value.bound.databasePaths.map(({ database }) => dbRows(database));
  const summary = value.backup(); assert.deepEqual(summary.replicas.map(x => x.records), [2, 3, 4]); assert.deepEqual(summary.replicas.map(x => x.issuedCapabilities), [3, 4, 5]);
  value.restore(); const after = readNativeOperatorState({ profile: value.profile, state: value.restored }).databasePaths.map(({ database }) => dbRows(database));
  assert.deepEqual(after.map(x => x.records), before.map(x => x.records)); assert.deepEqual(after.map(x => x.issued), [3, 4, 5]); assert.deepEqual(after.map(x => x.capabilities), [0, 0, 0]);
});

test('backup never overwrites an existing file, directory or alias and removes its own lock on failure', t => {
  const value = fixture(t), before = snapshot(value.state);
  for (const kind of ['file', 'directory', 'symlink']) {
    if (kind === 'file') writeFileSync(value.output, 'keep', { mode: 0o600 });
    if (kind === 'directory') mkdirSync(value.output, { mode: 0o700 });
    if (kind === 'symlink') symlinkSync(join(value.parent, 'not-created'), value.output);
    reject(value.backup); assert.equal(lstatSync(value.output).isSymbolicLink(), kind === 'symlink');
    if (kind === 'file') assert.equal(readFileSync(value.output, 'utf8'), 'keep');
    rmSync(value.output, { recursive: true }); assert.deepEqual(snapshot(value.state), before);
  }
});

test('backup destination requires a private non-public parent without symlink or traversal', t => {
  const value = fixture(t), broad = join(value.parent, 'broad'), role = join(value.parent, 'role'), alias = join(value.parent, 'alias');
  mkdirSync(broad, { mode: 0o755 }); mkdirSync(role, { mode: 0o700 }); writeFileSync(join(role, 'continuity-config.json'), '{}'); symlinkSync(value.parent, alias);
  for (const output of [join(broad, 'backup.json'), join(role, 'backup.json'), join(alias, 'backup.json'), value.parent + '/missing/../backup.json']) {
    reject(() => backupNativeOperator({ profile: value.profile, state: value.state, output })); assert.equal(existsSync(output), false);
  }
  assert.equal(existsSync(join(value.state, 'runtime.lock')), false);
});

test('restore requires the independently retained exact digest before any state creation', t => {
  const value = fixture(t); value.backup(); const before = snapshot(value.state);
  for (const expectedSha256 of [undefined, '', 'a'.repeat(64), digest(readFileSync(value.output)).toUpperCase(), '0'.repeat(63), '0'.repeat(65)]) {
    reject(() => value.restore({ expectedSha256 })); assert.equal(existsSync(value.restored), false);
  }
  assert.deepEqual(snapshot(value.state), before);
});

test('restore rejects canonical-shape, transfer, replica and trusted binding mutations before creating state', t => {
  const value = fixture(t); value.backup(); const clean = readFileSync(value.output), before = snapshot(value.state);
  const mutations = [
    b => { b.extra = true; }, b => { b.format = 'unknown'; }, b => { b.profile.apps[0].appId = 'other'; },
    b => b.replicas.pop(), b => b.replicas.push(b.replicas[0]), b => b.replicas.reverse(), b => { b.replicas[0].id = 'unknown'; },
    b => { b.replicas[0].extra = true; }, b => { b.replicas[0].transfer.sha256 = '0'.repeat(64); },
    b => { const p = b.replicas[0].transfer.payload; p.issuedCapabilities = 257; b.replicas[0].transfer.sha256 = digest(canonical(p)); },
    b => { const p = b.replicas[1].transfer.payload; p.records[0].bytes = 'not-ciphertext'; b.replicas[1].transfer.sha256 = digest(canonical(p)); },
    b => { const p = b.replicas[1].transfer.payload; p.records.push(p.records[0]); b.replicas[1].transfer.sha256 = digest(canonical(p)); },
    b => { const p = b.replicas[1].transfer.payload; p.profile.recoveryOrigin = 'https://other.example'; b.replicas[1].transfer.sha256 = digest(canonical(p)); },
  ];
  for (const mutate of mutations) {
    const bundle = JSON.parse(clean); mutate(bundle); writeFileSync(value.output, canonical(bundle));
    reject(value.restore); assert.equal(existsSync(value.restored), false); assert.deepEqual(snapshot(value.state), before);
  }
  for (const bytes of [Buffer.concat([clean, Buffer.from('\n')]), Buffer.from('{"format":"duplicate",' + clean.toString().slice(1)), Buffer.from([0xff, 0xfe]), clean.subarray(0, clean.length - 1)]) {
    writeFileSync(value.output, bytes); reject(value.restore); assert.equal(existsSync(value.restored), false);
  }
  writeFileSync(value.output, clean); value.restore();
});

test('restore will not change original bindings, expiry, apps or existing directories', t => {
  const value = fixture(t); value.backup(); const before = snapshot(value.state);
  for (const mutate of [p => { p.primaryOrigin = 'https://elsewhere.example'; }, p => { p.recoveryRpId = 'elsewhere.example'; }, p => { p.expiresAt = '2091-01-01T00:00:00.000Z'; }, p => p.apps.reverse()]) {
    const profile = structuredClone(value.profile); mutate(profile); reject(() => value.restore({ profile })); assert.equal(existsSync(value.restored), false);
  }
  reject(() => value.restore({ state: value.state })); assert.deepEqual(snapshot(value.state), before);
  mkdirSync(value.restored, { mode: 0o700 }); reject(value.restore); assert.deepEqual(readdirSync(value.restored), []);
  writeFileSync(join(value.restored, 'keep.txt'), 'keep', { mode: 0o600 }); reject(value.restore); assert.equal(readFileSync(join(value.restored, 'keep.txt'), 'utf8'), 'keep');
});

test('restore rejects public mode, symlink, hardlink, empty and oversized input', t => {
  const value = fixture(t); value.backup(); const clean = readFileSync(value.output);
  chmodSync(value.output, 0o644); reject(value.restore); chmodSync(value.output, 0o600);
  const alias = join(value.parent, 'linked.json'); linkSync(value.output, alias); reject(value.restore); unlinkSync(alias);
  symlinkSync(value.output, alias); reject(() => value.restore({ input: alias })); unlinkSync(alias);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(25 * 1024 * 1024, 32)]) { writeFileSync(value.output, bytes); reject(value.restore); assert.equal(existsSync(value.restored), false); }
  writeFileSync(value.output, clean); value.restore();
});

test('accessor options are never evaluated and extra fields are rejected', t => {
  const value = fixture(t); value.backup(); let calls = 0;
  const options = { profile: value.profile, ports: value.ports, input: value.output, expectedSha256: digest(readFileSync(value.output)), state: value.restored };
  for (const field of Object.keys(options)) {
    const supplied = { ...options }; Object.defineProperty(supplied, field, { enumerable: true, get() { calls++; throw new Error('private-secret'); } }); reject(() => restoreNativeOperator(supplied));
  }
  for (const field of ['profile', 'state', 'output']) {
    const supplied = { profile: value.profile, state: value.state, output: join(value.parent, 'another.json') }; Object.defineProperty(supplied, field, { enumerable: true, get() { calls++; throw new Error('private-secret'); } }); reject(() => backupNativeOperator(supplied));
  }
  reject(() => restoreNativeOperator({ ...options, extra: true })); assert.equal(calls, 0); assert.equal(existsSync(value.restored), false);
});

test('documented backup and restore CLI return only non-secret summaries', t => {
  const value = fixture(t), profile = join(value.parent, 'profile.json'), ports = join(value.parent, 'ports.json');
  writeFileSync(profile, JSON.stringify(value.profile), { mode: 0o600 }); writeFileSync(ports, JSON.stringify(value.ports), { mode: 0o600 });
  const run = args => spawnSync(process.execPath, [modulePath, ...args], { encoding: 'utf8' });
  const backup = run(['backup', '--profile', profile, '--state', value.state, '--out', value.output]);
  assert.equal(backup.status, 0, backup.stderr); const result = JSON.parse(backup.stdout); assert.equal(result.sha256, digest(readFileSync(value.output)));
  const restore = run(['restore', '--profile', profile, '--ports', ports, '--in', value.output, '--sha256', result.sha256, '--state', value.restored]);
  assert.equal(restore.status, 0, restore.stderr); assert.equal(JSON.parse(restore.stdout).restored, true);
  for (const secret of value.secrets) assert.equal((backup.stdout + backup.stderr + restore.stdout + restore.stderr).includes(secret), false);
  const missing = run(['restore', '--profile', profile, '--ports', ports, '--in', value.output, '--state', join(value.parent, 'missing-digest')]);
  assert.equal(missing.status, 1); assert.equal(missing.stdout, ''); assert.equal(existsSync(join(value.parent, 'missing-digest')), false);
});

test('restore rolls back owned files when a later replica import or final manifest fails', t => {
  for (const failingFile of ['beta.db', 'native-state.json']) {
    const value = fixture(t); value.backup(); const before = snapshot(value.state);
    const options = { profile: value.profile, ports: value.ports, input: value.output, expectedSha256: digest(readFileSync(value.output)), state: value.restored };
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs.linkSync;
      fs.linkSync=(from,to)=>{ if(to.endsWith(${JSON.stringify('/' + failingFile)})) throw new Error('private-failure-details'); return original(from,to); };
      syncBuiltinESMExports(); const {restoreNativeOperator}=await import(${JSON.stringify(modulePath)});
      try { restoreNativeOperator(${JSON.stringify(options)}); process.exitCode=2; } catch(error){ console.log(error.code); }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.match(result.stdout.trim(), /^NATIVE_/); assert.equal((result.stdout + result.stderr).includes('private-failure-details'), false);
    assert.equal(existsSync(value.restored), false); assert.deepEqual(snapshot(value.state), before);
  }
});

test('restore failure preserves unexpected competing files instead of recursively deleting them', t => {
  const value = fixture(t); value.backup(); const before = snapshot(value.state);
  const options = { profile: value.profile, ports: value.ports, input: value.output, expectedSha256: digest(readFileSync(value.output)), state: value.restored };
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.linkSync;
    fs.linkSync=(from,to)=>{ if(to.endsWith('/native-state.json')) { fs.writeFileSync(${JSON.stringify(join(value.restored, 'keep.txt'))},'competing user data',{mode:0o600,flag:'wx'}); throw new Error('stop'); } return original(from,to); };
    syncBuiltinESMExports(); const {restoreNativeOperator}=await import(${JSON.stringify(modulePath)});
    try { restoreNativeOperator(${JSON.stringify(options)}); process.exitCode=2; } catch(error){ console.log(error.code); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.deepEqual(readdirSync(value.restored), ['keep.txt']); assert.equal(readFileSync(join(value.restored, 'keep.txt'), 'utf8'), 'competing user data');
  reject(() => readNativeOperatorState({ profile: value.profile, state: value.restored })); assert.deepEqual(snapshot(value.state), before);
});

test('backup refuses a replaced locked state directory and leaves replacement lock untouched', t => {
  const value = fixture(t), displaced = value.state + '-displaced';
  const options = { profile: value.profile, state: value.state, output: value.output };
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.fsyncSync; let replaced=false;
    fs.fsyncSync=fd=>{ original(fd); if(!replaced){replaced=true; fs.renameSync(${JSON.stringify(value.state)},${JSON.stringify(displaced)}); fs.mkdirSync(${JSON.stringify(value.state)},{mode:0o700}); fs.writeFileSync(${JSON.stringify(join(value.state, 'runtime.lock'))},'replacement-owner',{mode:0o600,flag:'wx'}); } };
    syncBuiltinESMExports(); const {backupNativeOperator}=await import(${JSON.stringify(modulePath)});
    try { backupNativeOperator(${JSON.stringify(options)}); process.exitCode=2; } catch(error){ console.log(error.code); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'NATIVE_BACKUP_LOCK_CHANGED');
  assert.equal(existsSync(value.output), false); assert.deepEqual(readdirSync(value.state), ['runtime.lock']); assert.equal(readFileSync(join(value.state, 'runtime.lock'), 'utf8'), 'replacement-owner');
  assert.equal(existsSync(join(displaced, 'alpha.db')), true);
});
