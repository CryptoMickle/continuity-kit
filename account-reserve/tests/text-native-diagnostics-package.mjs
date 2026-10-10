import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createServer, request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, writeFile, readdir, rm, realpath, lstat, chmod, unlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installedNativeFixture } from './native-installed-fixture.mjs';
import { freePorts, killOwned } from './native-collection-fixture.mjs';

const guardedSource = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
const counters={childProcesses:0,filesystemMutations:0,credentials:0,outboundRequests:0};
const deny=field=>(...args)=>{counters[field]++;throw Error('FORBIDDEN_DIAGNOSTIC_SIDE_EFFECT');};
for(const name of ['fork','spawn','spawnSync','exec','execSync','execFile','execFileSync'])childProcess[name]=deny('childProcesses');
for(const name of ['writeFile','appendFile','mkdir','unlink','rename','chmod','link','symlink','rm','rmdir','truncate','copyFile','chown','utimes']){
 if(typeof fs[name]==='function')fs[name]=deny('filesystemMutations');
 if(typeof fs[name+'Sync']==='function')fs[name+'Sync']=deny('filesystemMutations');
 if(typeof fsp[name]==='function')fsp[name]=deny('filesystemMutations');
}
for(const name of ['write','writeSync','createWriteStream','fchmod','fchmodSync','ftruncate','ftruncateSync'])fs[name]=deny('filesystemMutations');
const readFlags=flags=>typeof flags==='string'?flags==='r'||flags==='rs':Number.isInteger(flags)&&(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))===0;
for(const [object,name]of [[fs,'open'],[fs,'openSync'],[fsp,'open']]){const original=object[name];object[name]=function(path,flags,...rest){if(!readFlags(flags))return deny('filesystemMutations')();return original.call(this,path,flags,...rest);};}
for(const object of [http,https])for(const name of ['request','get'])object[name]=deny('outboundRequests');
for(const name of ['connect','createConnection'])net[name]=deny('outboundRequests');
globalThis.fetch=deny('outboundRequests');
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{credentials:{get:deny('credentials'),create:deny('credentials')}}});
syncBuiltinESMExports();
const {diagnoseNativeOperator}=await import('./operator-diagnostics.mjs');
function frozen(value){if(value&&typeof value==='object'){assert.equal(Object.isFrozen(value),true);for(const item of Object.values(value))frozen(item);}}
process.once('message',async options=>{
 try{const report=await diagnoseNativeOperator(options);frozen(report);process.send({ok:true,report,counters});}
 catch{process.send({ok:false,counters});}
 finally{process.disconnect();}
});
`;

function execute(args, cwd, expected = 0) {
  return new Promise((done, reject) => {
    const env = { ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''), NODE_PATH: '', NODE_NO_WARNINGS: '1', npm_config_offline: 'true', npm_config_update_notifier: 'false', ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}) }; delete env.NODE_TEST_CONTEXT;
    const child = childProcess.spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failed = false, force;
    const timer = setTimeout(() => { failed = true; child.kill(); force = setTimeout(() => child.kill('SIGKILL'), 2000); }, 45000);
    const collect = (bytes, output) => { if (stdout.length + stderr.length + bytes.length > 100000) { failed = true; child.kill('SIGKILL'); } else if (output) stdout += bytes; else stderr += bytes; };
    child.stdout.on('data', bytes => collect(bytes, true)); child.stderr.on('data', bytes => collect(bytes, false)); child.once('error', () => { failed = true; });
    child.once('close', code => { clearTimeout(timer); clearTimeout(force); failed || code !== expected ? reject(Error('DIAGNOSTICS_PACKAGE_COMMAND_FAILED')) : done({ stdout, stderr }); });
  });
}
function guarded(directory, options) {
  return new Promise((done, reject) => {
    const child = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', guardedSource], { cwd: directory, env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1', NODE_PATH: '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result, failed = false, force;
    const timer = setTimeout(() => { failed = true; child.kill(); force = setTimeout(() => child.kill('SIGKILL'), 2000); }, 20000);
    child.on('message', value => { result = value; }); child.once('error', () => { failed = true; });
    child.once('close', code => { clearTimeout(timer); clearTimeout(force); failed || code || !result ? reject(Error('GUARDED_DIAGNOSTICS_FAILED')) : done(result); });
    child.send(options, error => { if (error) { failed = true; child.kill('SIGKILL'); } });
  });
}
async function tree(root) {
  const entries = [];
  async function walk(relative) {
    const path = join(root, relative), stat = await lstat(path, { bigint: true });
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) { entries.push({ name: relative, mode: Number(stat.mode), ino: String(stat.ino) });
      for (const name of (await readdir(path)).sort()) if (name !== 'node_modules') await walk(join(relative, name));
    } else { assert.equal(stat.isFile(), true); entries.push({ name: relative, mode: Number(stat.mode), ino: String(stat.ino), mtime: String(stat.mtimeNs), size: String(stat.size), sha256: createHash('sha256').update(await readFile(path)).digest('hex') }); }
  }
  await walk(''); return entries;
}
function counts(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return { issued: db.prepare('SELECT issued FROM operator_meta').get().issued, records: db.prepare('SELECT count(*) AS n FROM operator_records').get().n, capabilities: db.prepare('SELECT count(*) AS n FROM operator_capabilities').get().n, used: db.prepare('SELECT sum(used) AS n FROM operator_capabilities').get().n }; }
  finally { db.close(); }
}
async function response(port) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method: 'GET', path: '/', agent: false, signal: AbortSignal.timeout(3000) }, res => {
      let text = ''; res.on('data', bytes => { text += bytes; if (text.length > 64) req.destroy(); }); res.once('end', () => done({ status: res.statusCode, text })); res.once('error', reject);
    }); req.once('error', reject); req.end();
  });
}
function reportFrom(command) { return JSON.parse(command.stdout.trim() || command.stderr.trim()); }

test('installed native diagnostics distinguish repair actions while preserving private state, locks and unrelated listeners', { timeout: 180000 }, async t => {
  const installed = await installedNativeFixture(); let directory;
  try { directory = await realpath(await mkdtemp(join(tmpdir(), 'native-diagnostics-installed-'))); } catch (error) { await installed.close(); throw error; }
  let running, occupied; const ownedChildren = [], originalFork = childProcess.fork;
  t.after(async () => {
    childProcess.fork = originalFork; syncBuiltinESMExports();
    try { await running?.close(); } finally {
      if (occupied?.listening) await new Promise(done => { occupied.close(done); occupied.closeAllConnections(); });
      await Promise.allSettled(ownedChildren.map(killOwned)); await rm(directory, { recursive: true, force: true }); await installed.close();
    }
  });
  const consumer = join(directory, 'consumer'), npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(JSON.parse((await execute([join(installed.directory, 'node_modules/@continuitykit/account-reserve/scripts/create-native-text-starter.mjs'), consumer], installed.directory)).stdout).directory, consumer);
  await execute([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  const manifest = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8')); assert.deepEqual(Object.keys(manifest.dependencies), ['@continuitykit/account-reserve']);
  assert.equal(manifest.scripts['operator:diagnose'], 'node operator-diagnostics.mjs');
  const load = name => import(pathToFileURL(join(consumer, name)));
  const { buildNative } = await load('build.mjs'), { startNativeOperator } = await load('operate.mjs');
  const { initializeNativeOperator, readNativeOperatorState } = await load('operator-state.mjs');
  const { openStore } = await load('operator-runtime/store.mjs'), { canonical, TEXT_FORMAT } = await load('operator-runtime/profile.mjs');
  const profile = { version: 2, apps: [{ id: 'textarea', label: 'Text draft', appId: 'diagnostic-text-v1' }, { id: 'markdown', label: 'Markdown draft', appId: 'diagnostic-markdown-v1' }], primaryOrigin: 'https://writer.diagnostics.test', recoveryOrigin: 'https://reserve.diagnostics.test', recoveryRpId: 'reserve.diagnostics.test', expiresAt: new Date(Date.now() + 3600000).toISOString(), replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] };
  const [primary, recovery, gateway, alpha, beta] = await freePorts(5), ports = { primary, recovery, gateway, replicas: [{ id: 'alpha', port: alpha }, { id: 'beta', port: beta }] };
  const state = join(directory, 'state'), out = join(directory, 'dist'), profilePath = join(directory, 'profile.json'), wrongPath = join(directory, 'wrong-profile.json');
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const wrong = { ...profile, apps: [{ ...profile.apps[0], appId: 'different-binding-v1' }, profile.apps[1]] }; await writeFile(wrongPath, JSON.stringify(wrong), { mode: 0o600 });
  await buildNative({ profile, out }); initializeNativeOperator({ profile, state, ports });
  const bound = readNativeOperatorState({ profile, state }), operatorProfile = JSON.parse(await readFile(bound.operatorProfilePath, 'utf8'));
  for (const { database } of bound.databasePaths) {
    const store = openStore(database, operatorProfile);
    try { const grant = randomBytes(32).toString('hex'); store.issue(grant); store.putIfAbsent(randomBytes(32).toString('base64url'), Buffer.from(canonical({ format: TEXT_FORMAT, nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(64).toString('base64url') })), grant); store.issue(randomBytes(32).toString('hex')); }
    finally { store.close(); }
  }
  assert.deepEqual(bound.databasePaths.map(item => counts(item.database)), [0, 1].map(() => ({ issued: 2, records: 1, capabilities: 2, used: 1 })));
  const snapshots = async () => ({ state: await tree(state), source: await tree(consumer), build: await tree(out), counts: bound.databasePaths.map(item => counts(item.database)) });
  const cases = [];
  const args = (name = 'operator:diagnose', file = profilePath) => [npmCli, 'run', '--silent', name, '--', '--profile', file, '--state', state, '--out', out, ...(name === 'operator:diagnose' ? ['--check-ports', 'true'] : [])];
  async function diagnose(name, code, supplied = profile, file = profilePath) {
    const before = await snapshots();
    const value = await guarded(consumer, { profile: supplied, state, out, checkPorts: true }); assert.equal(value.ok, true);
    assert.deepEqual(value.counters, { childProcesses: 0, filesystemMutations: 0, credentials: 0, outboundRequests: 0 });
    const report = value.report; assert.equal(report.ok, !code); assert.equal(report.readOnly, true); assert.equal(report.advisory, true); assert.equal(report.applicationServicesStarted, false); assert.equal(report.grantsIssued, false); assert.equal(report.physicalPasskeyVerified, false); assert.equal(report.cryptographicRecoveryVerified, false);
    if (code) { const failed = report.checks.filter(item => !item.ok); assert.ok(failed.some(item => item.code === code)); for (const item of failed) { assert.equal(typeof item.message, 'string'); assert.ok(item.message.length > 10); assert.equal(typeof item.action, 'string'); assert.ok(item.action.length > 10); } }
    else { assert.equal(report.portAvailabilityChecked, true); assert.ok(report.checks.every(item => item.ok)); }
    assert.equal(JSON.stringify(report).includes(directory), false);
    assert.deepEqual(await snapshots(), before);
    const cli = reportFrom(await execute(args('operator:diagnose', file), consumer, code ? 1 : 0)); assert.deepEqual(cli, report);
    assert.deepEqual(await snapshots(), before);
    cases.push({ name, code: code ?? 'READY', readOnly: true, sameCliAndApi: true }); return report;
  }
  await diagnose('healthy');
  const mismatch = await diagnose('profile-mismatch', 'PROFILE_STATE_MISMATCH', wrong, wrongPath);
  await chmod(bound.databasePaths[0].database, 0o644);
  const permissions = await diagnose('private-file-permissions', 'PRIVATE_PERMISSIONS_INVALID');
  assert.notEqual(mismatch.checks.find(item => !item.ok).action, permissions.checks.find(item => !item.ok).action);
  await chmod(bound.databasePaths[0].database, 0o600);
  const workerPath = await realpath(join(consumer, 'operator-worker.mjs'));
  childProcess.fork = (...values) => { assert.equal(values[0], workerPath); const child = originalFork(...values); ownedChildren.push(child); return child; }; syncBuiltinESMExports();
  try { running = await startNativeOperator({ profile, state, out }); } finally { childProcess.fork = originalFork; syncBuiltinESMExports(); }
  assert.equal(ownedChildren.length, 2); const liveLock = await readFile(join(state, 'runtime.lock'));
  await diagnose('existing-live-lock', 'RUNTIME_LOCK_PRESENT'); assert.deepEqual(await readFile(join(state, 'runtime.lock')), liveLock); assert.deepEqual(running.status(), { state: 'ready', unavailableReplicas: [] });
  await running.close(); assert.equal(await running.failure, undefined); running = undefined;
  await diagnose('healthy-before-changes');
  const lockPath = join(state, 'runtime.lock'), staleLock = JSON.stringify({ version: 1, nonce: randomBytes(32).toString('hex') }) + '\n'; await writeFile(lockPath, staleLock, { mode: 0o600, flag: 'wx' });
  await diagnose('retained-stale-lock', 'RUNTIME_LOCK_PRESENT');
  const staleBefore = await snapshots(); await assert.rejects(startNativeOperator({ profile, state, out }), { code: 'NATIVE_OPERATOR_LOCKED' });
  const lockedStart = reportFrom(await execute(args('operator:start'), consumer, 1)); assert.equal(lockedStart.ok, false); assert.ok(lockedStart.checks.some(item => item.code === 'RUNTIME_LOCK_PRESENT')); assert.deepEqual(await snapshots(), staleBefore);
  assert.equal(await readFile(lockPath, 'utf8'), staleLock); await unlink(lockPath);
  await diagnose('healthy-before-port-change');
  let requests = 0, connections = 0;
  occupied = createServer((req, res) => { requests++; res.end('owned unrelated listener'); }); occupied.on('connection', () => { connections++; });
  await new Promise((done, reject) => { occupied.once('error', reject); occupied.listen(recovery, '127.0.0.1', done); });
  const blocked = await diagnose('occupied-recovery-port', 'PORT_OCCUPIED'); assert.equal(requests, 0); assert.equal(connections, 0);
  const portCheck = blocked.checks.find(item => item.code === 'PORT_OCCUPIED'); assert.equal(portCheck.port, recovery); assert.match(portCheck.target, /recovery/i);
  const beforeStart = await snapshots(); let rejectedChildren = 0;
  childProcess.fork = () => { rejectedChildren++; throw Error('NO_CHILD_EXPECTED'); }; syncBuiltinESMExports();
  try { await assert.rejects(startNativeOperator({ profile, state, out }), { code: 'NATIVE_OPERATOR_PORT_IN_USE' }); } finally { childProcess.fork = originalFork; syncBuiltinESMExports(); }
  assert.equal(rejectedChildren, 0); assert.deepEqual(await snapshots(), beforeStart); await assert.rejects(access(lockPath), { code: 'ENOENT' });
  const occupiedStart = reportFrom(await execute(args('operator:start'), consumer, 1)); assert.equal(occupiedStart.ok, false); assert.ok(occupiedStart.checks.some(item => item.code === 'PORT_OCCUPIED')); assert.deepEqual(await snapshots(), beforeStart);
  assert.equal(connections, 0); assert.deepEqual(await response(recovery), { status: 200, text: 'owned unrelated listener' }); assert.equal(occupied.listening, true); assert.equal(requests, 1);
  await new Promise(done => { occupied.close(done); occupied.closeAllConnections(); }); occupied = undefined;
  await diagnose('healthy-after-port-release');
  console.log(JSON.stringify({ installedNativeDiagnosticsPackage: true, installedGeneratorReplay: true, offlineConsumerInstall: true, actionableProfileAndPermissionDistinction: true,
    liveAndStaleLocksPreserved: true, occupiedListenerNeverProbedOrStopped: true, startupRechecksLockAndPort: true, sourceStateBuildBytesAndCountersPreserved: true,
    diagnosticChildren: 0, diagnosticFilesystemMutations: 0, diagnosticGrants: 0, diagnosticCredentials: 0, diagnosticOutboundRequests: 0,
    checkPortsAdvisoryOnly: true, physicalPasskeyVerified: false, cryptographicRecoveryVerified: false, sameMachineOnly: true, cases }));
});
