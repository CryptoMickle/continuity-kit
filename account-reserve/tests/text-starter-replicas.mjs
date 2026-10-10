import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startReplicaStarter } from '../text-starter/replica-server.mjs';
import { loopbackFetch } from '../text-starter/loopback-fetch.mjs';
import { syntheticClient } from '../text-starter/synthetic-client.mjs';
import { createReserveHttpStore } from '../sdk/http-store.mjs';
import { createTextReserveCredential, prepareTextReserveReplicas, recoverTextReserveFromReplicas } from '../sdk/text-reserve.mjs';

async function freePort() {
  const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
async function fixture(t) {
  const dist = await mkdtemp(join(tmpdir(), 'text-starter-replica-assets-')); await writeFile(join(dist, 'index.html'), '<!doctype html><title>Local replica test</title>');
  t.after(() => rm(dist, { recursive: true, force: true }));
  const primaryPort = await freePort(); let recoveryPort = await freePort(); while (primaryPort === recoveryPort) recoveryPort = await freePort();
  const app = await startReplicaStarter({ primaryPort, recoveryPort, dist }); t.after(() => app.close());
  const b = loopbackFetch(app.recoveryOrigin), a = loopbackFetch(app.originalOrigin);
  const post = (path, value) => b(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const control = async (id, action, expected = 200) => { const response = await post('/api/replica-control', { id, action }); assert.equal(response.status, expected); return response.json(); };
  return { app, a, b, post, control, recoveryPort };
}
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
function rows(path) { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT locator,ciphertext FROM operator_records').all(); } finally { db.close(); } }

test('local replica starter uses real child stores, durable corruption and authenticated surviving-copy recovery', { timeout: 30000 }, async t => {
  const f = await fixture(t), env = await (await f.b('/api/config')).json(), details = f.app.inspect();
  assert.equal(env.replicaMode, true); assert.equal(env.synthetic, true); assert.equal(env.enrollmentToken, undefined);
  assert.deepEqual(env.replicas, ['alpha', 'beta'].map(id => ({ id, basePath: '/api/replicas/' + id + '/reserve' })));
  assert.equal(new Set(details.replicas.map(item => item.pid)).size, 2); assert.ok(details.replicas.every(item => item.pid !== process.pid));
  assert.notEqual(details.replicas[0].database, details.replicas[1].database);
  const issued = await Promise.all([f.post('/api/replica-enrollment', {}), f.post('/api/replica-enrollment', {})]);
  assert.deepEqual(issued.map(value => value.status).sort(), [201, 409]);
  const grants = (await issued.find(value => value.status === 201).json()).replicas;
  assert.notEqual(grants[0].enrollmentToken, grants[1].enrollmentToken);
  const foreignRecord = Buffer.from(JSON.stringify({ ciphertext: randomBytes(32).toString('base64url'), format: 'account-continuity/text-reserve-v1/index', nonce: randomBytes(12).toString('base64url') }));
  const wrongGrant = await f.b('/api/replicas/beta/reserve/' + randomBytes(32).toString('base64url'), { method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + grants[0].enrollmentToken }, body: JSON.stringify({ bytes: foreignRecord.toString('base64url') }) });
  assert.equal(wrongGrant.status, 403, 'alpha admission cannot authorize beta');
  assert.equal(rows(details.replicas[1].database).length, 0);
  const previous = globalThis.location; globalThis.location = { origin: env.recoveryOrigin }; t.after(() => { globalThis.location = previous; });
  const client = syntheticClient(f.b), replicas = env.replicas.map(({ id, basePath }) => ({ id, store: createReserveHttpStore({ basePath, fetcher: f.b, enrollmentToken: grants.find(item => item.id === id).enrollmentToken }) }));
  const credential = await createTextReserveCredential({ config: env.config, webAuthnClient: client, user: { name: 'Replica starter test', displayName: 'SYNTHETIC' } }); t.after(() => credential.close());
  const sample = '\ufeffFictional starter draft\r\nKeep this correction: ÆØÅ 🦊\r\n';
  const ready = await prepareTextReserveReplicas({ config: env.config, recoveryCredential: credential, replicas, text: sample, webAuthnClient: client });
  credential.close(); replicas.forEach(item => item.store.clearEnrollmentCapability());
  assert.equal(ready.independentlyVerified, true); assert.ok(ready.replicas.every(item => item.status === 'verified'));
  const original = details.replicas.map(item => rows(item.database));
  assert.equal(original[0].length, 1); assert.equal(original[1].length, 1); assert.deepEqual(original[0][0].ciphertext, original[1][0].ciphertext);
  for (const store of details.replicas) {
    assert.deepEqual(await readdir(join(details.directory, store.id)), ['reserve.db'], 'private startup invitation is removed');
    const bytes = await readFile(store.database); assert.equal(bytes.includes(Buffer.from(sample)), false);
    for (const grant of grants) assert.equal(bytes.includes(Buffer.from(grant.enrollmentToken)), false);
  }
  const recover = () => recoverTextReserveFromReplicas({ config: env.config, webAuthnClient: client,
    replicas: env.replicas.map(({ id, basePath }) => ({ id, store: createReserveHttpStore({ basePath, fetcher: f.b }) })) });
  assert.equal((await recover()).reserve.text, sample);
  assert.equal((await f.post('/api/primary', { online: false })).status, 200);
  assert.equal((await f.a('/')).status, 503); assert.equal((await f.a('/api/config')).status, 503);
  await f.control('alpha', 'corrupt', 409);
  await f.control('alpha', 'stop');
  const offline = await recover(); assert.equal(offline.reserve.text, sample);
  assert.deepEqual(offline.replicas.map(item => item.status), ['unavailable', 'verified']);
  await f.control('alpha', 'corrupt'); await f.control('alpha', 'corrupt', 409);
  assert.notDeepEqual(rows(details.replicas[0].database)[0].ciphertext, original[0][0].ciphertext);
  await f.control('alpha', 'start'); assert.notEqual(f.app.inspect().replicas[0].pid, details.replicas[0].pid);
  const corrupted = await recover(); assert.equal(corrupted.reserve.text, sample);
  assert.deepEqual(corrupted.replicas.map(item => item.status), ['rejected', 'verified']);
  const reported = await (await f.b('/api/status')).json();
  assert.deepEqual(Object.keys(reported).sort(), ['primaryOnline', 'replicas', 'synthetic']);
  assert.deepEqual(reported.replicas[0], { id: 'alpha', running: true, corrupted: true });
  await f.control('beta', 'stop');
  await assert.rejects(recover(), error => { assert.equal(error.text, undefined); assert.deepEqual(error.replicas.map(item => item.status), ['rejected', 'unavailable']); return true; });
  await f.control('beta', 'start');
  const healthyPid = f.app.inspect().replicas[1].pid; process.kill(healthyPid, 'SIGKILL');
  for (let index = 0; index < 100 && f.app.inspect().replicas[1].running; index++) await sleep(10);
  assert.equal((await (await f.b('/api/status')).json()).replicas[1].running, false, 'child death is observed without an automatic restart');
  await f.control('beta', 'start'); assert.equal((await recover()).reserve.text, sample);
  const closing = f.app.inspect(); await f.app.close(); await f.app.close();
  await assert.rejects(access(closing.directory));
  for (const item of closing.replicas) assert.throws(() => process.kill(item.pid, 0), error => error.code === 'ESRCH');
});

function raw(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false, headers, signal: AbortSignal.timeout(5000) }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.once('error', reject);
      response.once('end', () => done({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    }); req.once('error', reject); req.end(body);
  });
}
test('replica control and transport reject foreign origins, paths, bodies and arbitrary targets', { timeout: 20000 }, async t => {
  const f = await fixture(t), host = new URL(f.app.recoveryOrigin).host;
  assert.equal((await raw(f.recoveryPort, '/api/config', { headers: { host: 'attacker.invalid' } })).status, 421);
  const headers = { host, origin: f.app.recoveryOrigin, 'content-type': 'application/json' };
  for (const origin of ['https://foreign.example', f.app.originalOrigin, 'null']) assert.equal((await raw(f.recoveryPort, '/api/replica-control', { method: 'POST', headers: { ...headers, origin }, body: '{"id":"alpha","action":"stop"}' })).status, 403);
  assert.equal((await f.post('/api/replica-control', { id: 'alpha', action: 'stop', port: 80 })).status, 400);
  assert.equal((await f.post('/api/replica-control', { id: '../beta', action: 'stop' })).status, 400);
  assert.equal((await f.post('/api/replica-control', { id: 'alpha', action: 'repair' })).status, 400);
  for (const path of ['/api/replicas/alpha/enrollment/start', '/api/replicas/gamma/reserve/' + 'A'.repeat(43), '/api/synthetic/']) assert.equal((await f.post(path, {})).status, 404);
  assert.equal((await raw(f.recoveryPort, '/x/../api/config', { headers: { host } })).status, 400);
  assert.equal((await raw(f.recoveryPort, '/api/config?override=1', { headers: { host } })).status, 400);
  assert.equal((await raw(f.recoveryPort, '/api/config', { headers: { host, 'content-length': '1' }, body: 'x' })).status, 400);
  assert.equal((await raw(f.recoveryPort, '/api/replica-enrollment', { method: 'POST', headers, body: ' '.repeat(100) })).status, 400);
  await f.control('alpha', 'stop'); await f.control('alpha', 'corrupt', 409);
  const partial = await f.post('/api/replica-enrollment', {}); assert.equal(partial.status, 503);
  await f.control('alpha', 'start'); assert.equal((await f.post('/api/replica-enrollment', {})).status, 409, 'a partial/unknown admission is never repeated');
  const status = await (await f.b('/api/status')).json(); assert.ok(status.replicas.every(item => item.running));
  assert.doesNotMatch(JSON.stringify(status), /database|invitation|enrollmentToken|port|verified/);
});

test('failed listener startup closes spawned children and releases its already opened frontend', { timeout: 15000 }, async t => {
  const dist = await mkdtemp(join(tmpdir(), 'text-starter-replica-failed-')); t.after(() => rm(dist, { recursive: true, force: true }));
  await writeFile(join(dist, 'index.html'), '<!doctype html>');
  const occupied = createServer(); await new Promise(done => occupied.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => occupied.close(done)));
  const recoveryPort = occupied.address().port; let primaryPort = await freePort(); while (primaryPort === recoveryPort) primaryPort = await freePort();
  const before = process.getActiveResourcesInfo().filter(item => item === 'ProcessWrap').length;
  await assert.rejects(startReplicaStarter({ primaryPort, recoveryPort, dist }), error => error.code === 'EADDRINUSE');
  assert.equal(process.getActiveResourcesInfo().filter(item => item === 'ProcessWrap').length, before);
  const probe = createServer(); await new Promise((done, reject) => { probe.once('error', reject); probe.listen(primaryPort, '127.0.0.1', done); }); await new Promise(done => probe.close(done));
  const executable = process.execPath;
  try {
    // Simulate spawn ENOENT: Node emits error/close, but need not emit exit.
    process.execPath = join(dist, 'nonexistent-local-runtime');
    await assert.rejects(startReplicaStarter({ primaryPort, recoveryPort, dist }), error => error.code === 'REPLICA_START_FAILED');
  } finally { process.execPath = executable; }
  assert.equal(process.getActiveResourcesInfo().filter(item => item === 'ProcessWrap').length, before);
});
