import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTextReserveCredential, prepareTextReserveReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { configuration } from './config.mjs';
import { startReplicaStarter } from './replica-server.mjs';
import { loopbackFetch } from './loopback-fetch.mjs';
import { syntheticClient } from './synthetic-client.mjs';
import { runDoctor } from './doctor.mjs';

async function port() { const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }); const value = server.address().port; await new Promise(done => server.close(done)); return value; }
async function fresh(origin, directory) {
  await mkdir(directory);
  return new Promise((done, reject) => {
    const child = fork(new URL('./replica-recover-process.mjs', import.meta.url), [], { stdio: ['ignore','ignore','ignore','ipc'] }); let report, problem, escalation;
    const timer = setTimeout(() => { problem = new Error('FRESH_RECOVERY_TIMEOUT'); child.kill(); escalation = setTimeout(() => child.kill('SIGKILL'), 3000); }, 30000);
    child.once('error', error => { problem = error; if (!child.pid) { clearTimeout(timer); reject(error); } }); child.on('message', value => { report = value; });
    child.once('exit', code => { clearTimeout(timer); clearTimeout(escalation); if (problem || code || !report) reject(problem ?? new Error('FRESH_RECOVERY_FAILED')); else done(report); });
    child.send({ origin, directory });
  });
}
function stored(replica) {
  const db = new DatabaseSync(replica.database, { readOnly: true });
  try { const rows = db.prepare('SELECT locator,ciphertext FROM operator_records').all(); assert.equal(rows.length, 1); return Buffer.from(rows[0].ciphertext); }
  finally { db.close(); }
}
const primaryPort = await port(); let recoveryPort = await port(); while (recoveryPort === primaryPort) recoveryPort = await port();
const settings = configuration(primaryPort, recoveryPort), directory = await mkdtemp(join(tmpdir(), 'continuity-replica-consumer-'));
let app, credential, replicas = []; const previousLocation = globalThis.location;
try {
  assert.equal((await runDoctor({ settings, replicas: true })).ok, true);
  app = await startReplicaStarter({ primaryPort, recoveryPort });
  assert.equal((await runDoctor({ settings, replicas: true, live: true })).ok, true);
  assert.equal((await runDoctor({ settings, live: true })).ok, false, 'a single-store doctor cannot pass against replica mode');
  const a = loopbackFetch(app.originalOrigin), b = loopbackFetch(app.recoveryOrigin);
  const post = async (path, value) => { const response = await b(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); assert.ok(response.ok, 'control must complete'); return response.json(); };
  const env = await (await b('/api/config')).json(), grant = await post('/api/replica-enrollment', {});
  globalThis.location = { origin: app.recoveryOrigin };
  replicas = env.replicas.map(({ id, basePath }) => ({ id, store: createReserveHttpStore({ fetcher: b, basePath, enrollmentToken: grant.replicas.find(item => item.id === id).enrollmentToken }) }));
  const sample = '\uFEFF# Fictional replica brief — ÆØÅ 📝\r\n\r\nThe surviving copy keeps this correction.\r\n';
  const auth = syntheticClient(b); credential = await createTextReserveCredential({ config: env.config, webAuthnClient: auth, user: { name: 'Fictional replica test', displayName: 'LOCAL SIMULATION' } });
  const ready = await prepareTextReserveReplicas({ config: env.config, recoveryCredential: credential, text: sample, replicas, webAuthnClient: auth });
  assert.equal(ready.independentlyVerified, true); assert.equal(ready.text, sample); assert.ok(ready.replicas.every(item => item.status === 'verified'));
  credential.close(); replicas.forEach(item => item.store.clearEnrollmentCapability());
  const local = app.inspect(); assert.equal(new Set(local.replicas.map(item => item.pid)).size, 2); assert.ok(local.replicas.every(item => item.pid !== process.pid));
  const original = stored(local.replicas[0]); assert.deepEqual(original, stored(local.replicas[1])); assert.ok(!original.includes(Buffer.from(sample)));
  await post('/api/primary', { online: false }); assert.equal((await a('/')).status, 503); assert.equal((await a('/api/config')).status, 503);
  const cases = [];
  async function recover(name, expected) {
    const target = join(directory, name), report = await fresh(app.recoveryOrigin, target);
    assert.equal(report.ok, true); assert.equal(report.noSetupInputs, true); assert.equal(report.noRecoveryWrites, true);
    for (const [id, status] of Object.entries(expected)) assert.equal(report.replicas.find(item => item.id === id).status, status);
    assert.deepEqual(await readFile(join(target, 'original.txt')), Buffer.from(sample));
    assert.equal(JSON.parse(await readFile(join(target, 'original.json'), 'utf8')).text, sample);
    assert.deepEqual(await readFile(join(target, 'edited.txt')), Buffer.from(sample + '\nFinished in B.'));
    cases.push({ name, replicas: report.replicas });
  }
  await recover('both', { alpha: 'verified', beta: 'verified' });
  await post('/api/replica-control', { id: 'alpha', action: 'stop' });
  await recover('one-process-stopped', { alpha: 'unavailable', beta: 'verified' });
  assert.deepEqual(stored(local.replicas[0]), original); assert.deepEqual(stored(local.replicas[1]), original);
  await post('/api/replica-control', { id: 'alpha', action: 'corrupt' }); await post('/api/replica-control', { id: 'alpha', action: 'start' });
  await recover('one-copy-altered', { alpha: 'rejected', beta: 'verified' });
  assert.deepEqual(stored(local.replicas[1]), original); const altered = stored(local.replicas[0]); assert.notDeepEqual(altered, original);
  await post('/api/replica-control', { id: 'beta', action: 'stop' });
  const failedFolder = join(directory, 'no-valid-copy'), failed = await fresh(app.recoveryOrigin, failedFolder);
  assert.equal(failed.ok, false); assert.equal(failed.error, 'REPLICA_RECOVERY_FAILED'); assert.deepEqual(await readdir(failedFolder), []);
  assert.deepEqual(stored(local.replicas[0]), altered); assert.deepEqual(stored(local.replicas[1]), original);
  assert.equal((await a('/')).status, 503);
  console.log(JSON.stringify({ ok: true, mode: 'synthetic local replica demonstration', publicSdk: true,
    independentStoreProcesses: 2, separateSqliteFiles: 2, freshRecoveryProcesses: 4, primaryHttp503: true,
    exactUtf8Exports: true, noRecoveryWrites: true, rejectsOnlyCorruptCopy: true, cases,
    physicalPasskeyProof: false, independentProviders: false, productionServer: false }));
} finally { credential?.close(); replicas.forEach(item => item.store.clearEnrollmentCapability()); globalThis.location = previousLocation; await app?.close(); await rm(directory, { recursive: true, force: true }); }
