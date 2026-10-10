import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath, lstat } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initializeNativeOperator, readNativeOperatorState } from '../text-native/operator-state.mjs';
import { runtimeProfile } from '../text-native/operator.mjs';
import { openStore } from '../text-native/operator-runtime/store.mjs';
import { installedNativeFixture } from './native-installed-fixture.mjs';

const installed = await installedNativeFixture();
after(() => installed.close());
const { startNativeOperator } = await import(pathToFileURL(join(installed.directory, 'operate.mjs')));

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const workerPath = await realpath(join(installed.directory, 'operator-worker.mjs'));
async function freePorts(count) {
  const held = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer(socket => socket.destroy());
      await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }); held.push(server);
    }
    return held.map(server => server.address().port);
  } finally { await Promise.all(held.map(server => new Promise(done => server.close(done)))); }
}
async function fixture(t, { ids = ['alpha', 'beta'], lifetime = 3600000 } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'native-managed-test-'))), numbers = await freePorts(3 + ids.length);
  const profile = { version: 1, appId: 'native-managed-test', primaryOrigin: 'https://primary.example', recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example',
    expiresAt: new Date(Date.now() + lifetime).toISOString(), replicas: ids.map(id => ({ id, basePath: '/api/replicas/' + id + '/reserve' })) };
  const ports = { primary: numbers[0], recovery: numbers[1], gateway: numbers[2], replicas: ids.map((id, index) => ({ id, port: numbers[3 + index] })) };
  const state = join(directory, 'private'), out = join(directory, 'build');
  initializeNativeOperator({ profile, state, ports });
  const bound = readNativeOperatorState({ profile, state });
  const html = '<!doctype html><title>Native managed test fixture</title><script type="module" src="/assets/main-12345678.js"></script>';
  const js = 'export const fixture = true;';
  for (const role of ['primary', 'recovery']) {
    await mkdir(join(out, role, 'assets'), { recursive: true });
    await writeFile(join(out, role, 'continuity-config.json'), JSON.stringify({ profile, role }));
    await writeFile(join(out, role, 'index.html'), html); await writeFile(join(out, role, 'assets/main-12345678.js'), js);
  }
  await writeFile(join(out, 'build-report.json'), JSON.stringify({ version: 1, mode: 'native', nativeAssetsOnly: true,
    profileSha256: sha(JSON.stringify(profile)), assetFiles: ['index.html', 'assets/main-12345678.js'], assetSha256: { 'index.html': sha(html), 'assets/main-12345678.js': sha(js) } }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, profile, state, out, ports, bound, args: { profile, state, out } };
}
function query(port, origin, path = '/continuity-config.json') {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, agent: false, signal: AbortSignal.timeout(5000),
      headers: { host: new URL(origin).host, origin, connection: 'close' } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.once('error', reject);
      response.once('end', () => done({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }); req.once('error', reject); req.end();
  });
}
function counts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { issued: db.prepare('SELECT issued FROM operator_meta WHERE id=1').get().issued,
    records: db.prepare('SELECT count(*) AS n FROM operator_records').get().n, capabilities: db.prepare('SELECT count(*) AS n FROM operator_capabilities').get().n }; }
  finally { db.close(); }
}
async function bytes(f) { return Promise.all(f.bound.databasePaths.map(item => readFile(item.database))); }
async function assertClosed(f) {
  await assert.rejects(access(join(f.state, 'runtime.lock')), { code: 'ENOENT' });
  const held = [];
  try {
    for (const port of [f.ports.primary, f.ports.recovery, f.ports.gateway, ...f.ports.replicas.map(item => item.port)]) {
      const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); }); held.push(server);
    }
  } finally { await Promise.all(held.map(server => new Promise(done => server.close(done)))); }
}
async function withForkSpy(action, run) {
  const original = childProcess.fork;
  childProcess.fork = (...args) => action(original, args);
  syncBuiltinESMExports();
  try { return await run(); }
  finally { childProcess.fork = original; syncBuiltinESMExports(); }
}

test('managed native stack owns actual store children, verifies routes, and restarts with intact immutable records and quota', async t => {
  const f = await fixture(t, { ids: ['alpha', 'beta', 'gamma'] }), children = [], locator = randomBytes(32).toString('base64url');
  const ciphertext = Buffer.from(JSON.stringify({ ciphertext: randomBytes(48).toString('base64url'), format: 'account-continuity/text-reserve-v1/index', nonce: randomBytes(12).toString('base64url') }));
  for (const paths of f.bound.databasePaths) {
    const store = openStore(paths.database, runtimeProfile(f.profile)), capability = sha(randomBytes(32));
    try { store.issue(capability); assert.equal(store.putIfAbsent(locator, ciphertext, capability), true); } finally { store.close(); }
  }
  const before = await bytes(f), invitations = await readFile(f.bound.invitationsFile);
  await withForkSpy((fork, args) => { assert.equal(args[0], workerPath); assert.deepEqual(args[1], []); const child = fork(...args); children.push(child); return child; }, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const app = await startNativeOperator(f.args); t.after(() => app.close());
      assert.deepEqual(app.ports, f.ports); assert.equal((await lstat(join(f.state, 'runtime.lock'))).mode & 0o777, 0o600);
      for (const paths of f.bound.databasePaths) {
        const response = await query(f.ports.recovery, f.profile.recoveryOrigin, '/api/replicas/' + paths.id + '/reserve/' + locator);
        assert.equal(response.status, 200); assert.deepEqual(Buffer.from(response.body.bytes, 'base64url'), ciphertext);
        assert.deepEqual(counts(paths.database), { issued: 1, records: 1, capabilities: 1 });
      }
      assert.equal((await query(f.ports.primary, f.profile.primaryOrigin)).body.role, 'primary');
      assert.equal((await query(f.ports.recovery, f.profile.recoveryOrigin)).body.role, 'recovery');
      await app.close(); await app.close(); assert.equal(await app.failure, undefined); await assertClosed(f);
    }
  });
  assert.equal(children.length, 6); assert.equal(new Set(children.map(child => child.pid)).size, 6);
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  assert.deepEqual(await bytes(f), before); assert.deepEqual(await readFile(f.bound.invitationsFile), invitations);
});

test('occupied port is rejected before any store starts or persistent state changes', async t => {
  const f = await fixture(t), before = await bytes(f), server = createServer(); let forks = 0;
  await new Promise(done => server.listen(f.ports.replicas[1].port, '127.0.0.1', done));
  try {
    await withForkSpy(() => { forks++; throw Error('unexpected fork'); }, () => assert.rejects(startNativeOperator(f.args), { code: 'NATIVE_OPERATOR_PORT_IN_USE' }));
    assert.equal(forks, 0); assert.deepEqual(await bytes(f), before); assert.ok(server.listening);
  } finally { await new Promise(done => server.close(done)); }
  await assertClosed(f);
});

test('second launch and stale lock refuse startup without deleting another lock or disturbing its services', async t => {
  const f = await fixture(t), app = await startNativeOperator(f.args); t.after(() => app.close());
  const lock = await readFile(join(f.state, 'runtime.lock'));
  await assert.rejects(startNativeOperator(f.args), { code: 'NATIVE_OPERATOR_LOCKED' });
  assert.deepEqual(await readFile(join(f.state, 'runtime.lock')), lock); assert.equal((await query(f.ports.recovery, f.profile.recoveryOrigin)).status, 200);
  await app.close(); await assertClosed(f);
  const stale = '{"pid":1,"note":"never kill or automatically clear"}\n';
  await writeFile(join(f.state, 'runtime.lock'), stale, { flag: 'wx', mode: 0o600 });
  await assert.rejects(startNativeOperator(f.args), { code: 'NATIVE_OPERATOR_LOCKED' });
  assert.equal(await readFile(join(f.state, 'runtime.lock'), 'utf8'), stale);
});

test('partial child startup failure closes the first actual store and releases only owned resources', async t => {
  const f = await fixture(t), before = await bytes(f), children = [], beta = f.bound.databasePaths[1].invitationFile;
  const invitation = await readFile(beta);
  await withForkSpy((fork, args) => {
    const child = fork(...args); children.push(child);
    if (children.length === 1) child.once('message', value => { if (value?.type === 'ready') unlinkSync(beta); });
    return child;
  }, () => assert.rejects(startNativeOperator(f.args), { code: 'NATIVE_OPERATOR_CHILD_FAILED' }));
  await writeFile(beta, invitation, { flag: 'wx', mode: 0o600 });
  assert.equal(children.length, 2); assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  assert.deepEqual(await bytes(f), before); await assertClosed(f);
});

test('spawn error without exit cleans the no-process handle and removes its own runtime lock', async t => {
  const f = await fixture(t), children = [];
  await withForkSpy((fork, args) => {
    const child = fork(args[0], args[1], { ...args[2], execPath: join(f.directory, 'does-not-exist') }); children.push(child); return child;
  }, () => assert.rejects(startNativeOperator(f.args), { code: 'NATIVE_OPERATOR_CHILD_FAILED' }));
  assert.equal(children.length, 1); assert.equal(children[0].pid, undefined); await assertClosed(f);
});

test('post-ready child death retains B and surviving stores, reports degraded, and never restarts or issues grants', async t => {
  const f = await fixture(t), children = [], before = await bytes(f), states = [];
  await withForkSpy((fork, args) => { const child = fork(...args); children.push(child); return child; }, async () => {
    const app = await startNativeOperator({ ...f.args, onState(value) { states.push(value); } }); t.after(() => app.close());
    assert.deepEqual(app.status(), { state: 'ready', unavailableReplicas: [] });
    const firstClosed = new Promise(done => children[0].once('close', done)); children[0].kill('SIGKILL'); await firstClosed;
    assert.deepEqual(app.status(), { state: 'degraded', unavailableReplicas: ['alpha'] }); assert.ok(Object.isFrozen(app.status().unavailableReplicas));
    assert.equal((await query(f.ports.recovery, f.profile.recoveryOrigin)).status, 200);
    const locator = randomBytes(32).toString('base64url');
    assert.equal((await query(f.ports.recovery, f.profile.recoveryOrigin, '/api/replicas/alpha/reserve/' + locator)).status, 503);
    assert.equal((await query(f.ports.recovery, f.profile.recoveryOrigin, '/api/replicas/beta/reserve/' + locator)).status, 404);
    assert.equal((await query(f.ports.replicas[1].port, f.profile.recoveryOrigin, '/api/config')).status, 200);
    const lastClosed = new Promise(done => children[1].once('close', done)); children[1].kill('SIGKILL'); await lastClosed;
    assert.deepEqual(app.status(), { state: 'unavailable', unavailableReplicas: ['alpha', 'beta'] });
    assert.equal((await query(f.ports.recovery, f.profile.recoveryOrigin)).status, 200);
    assert.deepEqual(states.map(value => value.state), ['ready', 'degraded', 'unavailable']);
    await app.close(); assert.equal(await app.failure, undefined); assert.equal(app.status().state, 'closed');
    assert.equal(children.length, 2); assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  });
  assert.deepEqual(await bytes(f), before); await assertClosed(f);
});

test('aborted startup, active abort, and profile expiry shut down all owned listeners', async t => {
  const f = await fixture(t), aborted = new AbortController(); aborted.abort();
  await assert.rejects(startNativeOperator({ ...f.args, signal: aborted.signal }), { code: 'NATIVE_OPERATOR_ABORTED' }); await assertClosed(f);
  const signal = new AbortController(), app = await startNativeOperator({ ...f.args, signal: signal.signal }); t.after(() => app.close());
  signal.abort(); assert.equal((await app.failure).code, 'NATIVE_OPERATOR_ABORTED'); await assertClosed(f);
  const expiring = await fixture(t, { lifetime: 1800 }), limited = await startNativeOperator(expiring.args); t.after(() => limited.close());
  assert.equal((await limited.failure).code, 'NATIVE_OPERATOR_EXPIRED'); await assertClosed(expiring);
});

test('mismatched assets fail before taking a lock, opening stores or consuming a capability', async t => {
  const f = await fixture(t), before = await bytes(f);
  await writeFile(join(f.out, 'recovery', 'assets/main-12345678.js'), 'altered');
  await assert.rejects(startNativeOperator(f.args), { code: 'NATIVE_OPERATOR_BUILD_INVALID' });
  assert.deepEqual(await bytes(f), before); await assertClosed(f);
});

test('CLI tolerates repeated termination signals while cleaning its owned workers and lock', { timeout: 20000 }, async t => {
  const f = await fixture(t), profilePath = join(f.directory, 'profile.json');
  await writeFile(profilePath, JSON.stringify(f.profile), { mode: 0o600 });
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = childProcess.spawn(process.execPath, [join(installed.directory, 'operate.mjs'), '--profile', profilePath, '--state', f.state, '--out', f.out],
      { env: { PATH: process.env.PATH ?? '', LANG: 'C', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    const closed = new Promise(done => child.once('close', (code, signal) => done({ code, signal })));
    child.stderr.on('data', bytes => { stderr += bytes; });
    await new Promise((done, reject) => {
      child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('\n')) done(); });
      child.once('error', reject); child.once('exit', code => { if (!stdout.includes('\n')) reject(Error('CLI_NOT_READY_' + code)); });
    });
    assert.equal(JSON.parse(stdout.split('\n')[0]).ready, true);
    child.kill('SIGTERM');
    const repeat = setInterval(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }, 1);
    let ended; try { ended = await closed; } finally { clearInterval(repeat); }
    assert.deepEqual(ended, { code: 0, signal: null }); assert.equal(stderr, ''); await assertClosed(f);
  }
});

test('fixed worker exits when its parent disconnects and rejects arbitrary startup fields', { timeout: 15000 }, async t => {
  const env = { PATH: process.env.PATH ?? '', LANG: 'C', TZ: 'UTC', NODE_NO_WARNINGS: '1' };
  const f = await fixture(t), child = childProcess.fork(workerPath, [], { execArgv: [], env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const closed = new Promise(done => { child.once('close', done); child.once('exit', done); });
  const ready = new Promise((done, reject) => { child.once('message', value => value.type === 'ready' ? done(value) : reject(Error('worker failed'))); child.once('error', reject); });
  child.send({ type: 'start', nonce: randomBytes(32).toString('hex'), id: 'alpha', profile: f.profile, state: f.state });
  assert.equal((await ready).port, f.ports.replicas[0].port); child.disconnect(); await closed;
  await assertClosed(f);
  const invalid = childProcess.fork(workerPath, [], { execArgv: [], env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (invalid.exitCode === null && invalid.signalCode === null) invalid.kill('SIGKILL'); });
  const invalidClosed = new Promise(done => invalid.once('close', done));
  invalid.send({ type: 'start', code: 'process.exit(0)', module: 'arbitrary', profile: f.profile, state: f.state });
  await invalidClosed; assert.equal(invalid.exitCode, 1); await assertClosed(f);
});
