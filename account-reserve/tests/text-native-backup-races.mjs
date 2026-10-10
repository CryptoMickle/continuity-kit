import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initializeNativeOperator } from '../text-native/operator-state.mjs';
import { backupNativeOperator, restoreNativeOperator, MAX_NATIVE_BACKUP_BYTES } from '../text-native/operator-backup.mjs';

const modulePath = fileURLToPath(new URL('../text-native/operator-backup.mjs', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const parent = mkdtempSync('/tmp/native-backup-race-'); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const profile = { version: 1, appId: 'backup-race-app', primaryOrigin: 'https://primary.example', recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example',
    expiresAt: '2090-10-10T12:00:00.000Z', replicas: ['alpha','beta'].map(id => ({ id, basePath: '/api/replicas/' + id + '/reserve' })) };
  const ports = { primary: 33111, recovery: 33112, gateway: 33113, replicas: [{ id: 'alpha', port: 33114 }, { id: 'beta', port: 33115 }] };
  const state = join(parent, 'original'), restored = join(parent, 'restored'), output = join(parent, 'backup.json');
  initializeNativeOperator({ profile, ports, state });
  return { parent, profile, ports, state, restored, output };
}
function run(script) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
  return JSON.parse(result.stdout.trim());
}
function stateSnapshot(state) { return readdirSync(state).sort().map(name => ({ name, digest: digest(readFileSync(join(state, name))) })); }

test('backup refuses an output parent replaced after temp write and does not clean through the replacement directory', t => {
  const f = fixture(t), destination = join(f.parent, 'destination'), displaced = destination + '-displaced'; mkdirSync(destination, { mode: 0o700 });
  const output = join(destination, 'backup.json'), before = stateSnapshot(f.state), options = { profile: f.profile, state: f.state, output };
  const result = run(`import fs from 'node:fs'; import {basename} from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    const originalOpen=fs.openSync, originalSync=fs.fsyncSync; let targetFd, temporaryName, replaced=false;
    fs.openSync=(path,...rest)=>{const fd=originalOpen(path,...rest); if(typeof path==='string'&&basename(path).startsWith('.native-backup-')){targetFd=fd;temporaryName=basename(path);} return fd;};
    fs.fsyncSync=fd=>{originalSync(fd);if(fd===targetFd&&!replaced){replaced=true;fs.renameSync(${JSON.stringify(destination)},${JSON.stringify(displaced)});fs.mkdirSync(${JSON.stringify(destination)},{mode:0o700});fs.writeFileSync(${JSON.stringify(destination)}+'/'+temporaryName,'replacement-owner',{mode:0o600,flag:'wx'});}};
    syncBuiltinESMExports(); const {backupNativeOperator}=await import(${JSON.stringify(modulePath)});
    let code;try{backupNativeOperator(${JSON.stringify(options)});code='UNEXPECTED_SUCCESS';}catch(error){code=error.code;}
    console.log(JSON.stringify({code,replaced,temporaryName}));`);
  assert.equal(result.code, 'NATIVE_BACKUP_PATH_CHANGED'); assert.equal(result.replaced, true);
  assert.equal(existsSync(output), false); assert.deepEqual(readdirSync(destination), [result.temporaryName]);
  assert.equal(readFileSync(join(destination, result.temporaryName), 'utf8'), 'replacement-owner');
  assert.ok(readFileSync(join(displaced, result.temporaryName)).length > 0); assert.equal(lstatSync(join(displaced, result.temporaryName)).mode & 0o7777, 0o600);
  assert.deepEqual(stateSnapshot(f.state), before); assert.equal(existsSync(join(f.state, 'runtime.lock')), false);
});

test('growing restore input is read with a fixed bound and rejected before any destination state is created', t => {
  const f = fixture(t), backup = backupNativeOperator({ profile: f.profile, state: f.state, output: f.output }), before = stateSnapshot(f.state);
  const options = { profile: f.profile, ports: f.ports, input: f.output, expectedSha256: backup.sha256, state: f.restored };
  const result = run(`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const path=fs.realpathSync(${JSON.stringify(f.output)}),originalOpen=fs.openSync,originalRead=fs.readSync,originalWhole=fs.readFileSync;
    let inputFd,grown=false,total=0,maximumRequest=0,unbounded=false;
    fs.openSync=(name,...rest)=>{const fd=originalOpen(name,...rest);if(name===path&&inputFd===undefined)inputFd=fd;return fd;};
    fs.readFileSync=(name,...rest)=>{if(name===inputFd||name===path){unbounded=true;throw new Error('UNBOUNDED_READ_FORBIDDEN');}return originalWhole(name,...rest);};
    fs.readSync=(fd,buffer,offset,length,position)=>{if(fd===inputFd){if(!grown){grown=true;fs.truncateSync(path,${MAX_NATIVE_BACKUP_BYTES + 65536});} maximumRequest=Math.max(maximumRequest,length);const n=originalRead(fd,buffer,offset,length,position);total+=n;return n;}return originalRead(fd,buffer,offset,length,position);};
    syncBuiltinESMExports();const {restoreNativeOperator}=await import(${JSON.stringify(modulePath)});
    let code;try{restoreNativeOperator(${JSON.stringify(options)});code='UNEXPECTED_SUCCESS';}catch(error){code=error.code;}
    console.log(JSON.stringify({code,grown,total,maximumRequest,unbounded}));`);
  assert.equal(result.code, 'NATIVE_BACKUP_FILE_INVALID'); assert.equal(result.grown, true); assert.equal(result.unbounded, false);
  assert.equal(result.total, MAX_NATIVE_BACKUP_BYTES + 1); assert.ok(result.maximumRequest <= 65536);
  assert.equal(existsSync(f.restored), false); assert.deepEqual(stateSnapshot(f.state), before);
});

test('a growing owned lock is read only to its expected length and is retained once its contents change', t => {
  const f = fixture(t), options = { profile: f.profile, state: f.state, output: f.output };
  const result = run(`import fs from 'node:fs';import {basename} from 'node:path';import {syncBuiltinESMExports} from 'node:module';
    const originalOpen=fs.openSync,originalRead=fs.readSync,originalWhole=fs.readFileSync;
    let lockFd,lockPath,grown=false,total=0,expected=0,unbounded=false;
    fs.openSync=(name,...rest)=>{const fd=originalOpen(name,...rest);if(typeof name==='string'&&basename(name)==='runtime.lock'&&typeof rest[0]==='number'){lockFd=fd;lockPath=name;}return fd;};
    fs.readFileSync=(name,...rest)=>{if(name===lockFd||name===lockPath){unbounded=true;throw new Error('UNBOUNDED_LOCK_READ_FORBIDDEN');}return originalWhole(name,...rest);};
    fs.readSync=(fd,buffer,offset,length,position)=>{if(fd===lockFd){if(!grown){expected=fs.fstatSync(fd).size;grown=true;fs.truncateSync(lockPath,1048576);}const n=originalRead(fd,buffer,offset,length,position);total+=n;return n;}return originalRead(fd,buffer,offset,length,position);};
    syncBuiltinESMExports();const {backupNativeOperator}=await import(${JSON.stringify(modulePath)});
    let code;try{backupNativeOperator(${JSON.stringify(options)});code='UNEXPECTED_SUCCESS';}catch(error){code=error.code;}
    console.log(JSON.stringify({code,grown,total,expected,unbounded}));`);
  assert.equal(result.code, 'NATIVE_BACKUP_LOCK_CHANGED'); assert.equal(result.grown, true); assert.equal(result.unbounded, false);
  assert.equal(result.total, result.expected + 1); assert.equal(existsSync(f.output), false);
  assert.equal(lstatSync(join(f.state, 'runtime.lock')).size, 1048576, 'changed lock is not automatically removed');
});

test('a BOM-prefixed outer bundle is noncanonical even when its retained digest matches the exact modified bytes', t => {
  const f = fixture(t); backupNativeOperator({ profile: f.profile, state: f.state, output: f.output });
  const before = stateSnapshot(f.state), bytes = Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), readFileSync(f.output)]); writeFileSync(f.output, bytes);
  assert.throws(() => restoreNativeOperator({ profile: f.profile, ports: f.ports, input: f.output, expectedSha256: digest(bytes), state: f.restored }), { code: 'NATIVE_BACKUP_INVALID' });
  assert.equal(existsSync(f.restored), false); assert.deepEqual(stateSnapshot(f.state), before);
});
