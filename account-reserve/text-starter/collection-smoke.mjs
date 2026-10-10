import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createTextReserveCredential, selectTextReserveCredential, prepareTextReserveReplicas, recoverTextReservesFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { startCollectionStarter } from './collection-server.mjs';
import { loopbackFetch } from './loopback-fetch.mjs';
import { syntheticClient } from './synthetic-client.mjs';
import { exportText } from './adapter.mjs';

export const COLLECTION_SAMPLES = Object.freeze(['\ufeffFictional text draft — ÆØÅ 🦊\r\nA calmer checkout.\r\n', '# Fictional Markdown\n\nA second app with its own encrypted snapshot.\n']);

export async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}

// Test-only setup through the generated server's ordinary HTTP routes. A real
// native authenticator is never called by this disposable simulation.
export async function prepareCollectionExamples(app, texts = COLLECTION_SAMPLES) {
  const fetcher = loopbackFetch(app.recoveryOrigin), environment = await (await fetcher('/api/config')).json();
  assert.equal(environment.collectionMode, true); assert.equal(environment.apps.length, texts.length);
  const client = syntheticClient(fetcher), counters = { creates: 0, assertions: 0 }, outputs = [], ready = [];
  const webAuthnClient = Object.fromEntries(['createCredential', 'getCredential'].map(method => [method, async request => {
    counters[method === 'createCredential' ? 'creates' : 'assertions']++;
    const output = await client[method](request); outputs.push(output); return output;
  }]));
  for (const [index, { config }] of environment.apps.entries()) {
    const response = await fetcher('/api/replica-enrollment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: config.appId }) });
    assert.equal(response.status, 201); const grant = await response.json(); assert.equal(grant.appId, config.appId);
    const replicas = environment.replicas.map(({ id, basePath }, position) => {
      assert.equal(grant.replicas[position].id, id);
      return { id, store: createReserveHttpStore({ fetcher, basePath, enrollmentToken: grant.replicas[position].enrollmentToken }) };
    });
    let credential;
    try {
      credential = index ? await selectTextReserveCredential({ config, webAuthnClient })
        : await createTextReserveCredential({ config, webAuthnClient, user: { name: 'Fictional collection', displayName: 'LOCAL SIMULATION' } });
      const result = await prepareTextReserveReplicas({ config, text: texts[index], recoveryCredential: credential, replicas, webAuthnClient });
      assert.equal(result.independentlyVerified, true); assert.equal(result.text, texts[index]); assert.ok(result.replicas.every(item => item.status === 'verified')); ready.push(result);
    } finally { credential?.close(); for (const { store } of replicas) store.clearEnrollmentCapability(); }
  }
  assert.deepEqual(counters, { creates: 1, assertions: 3 }); assert.ok(outputs.every(output => output.prfOutput.every(byte => byte === 0)));
  assert.equal(new Set(ready.map(item => item.locator)).size, environment.apps.length);
  return { environment, ready, counters };
}

export function collectionDatabaseSnapshot(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return { records: db.prepare('SELECT locator,ciphertext FROM operator_records ORDER BY locator').all().map(row => ({ locator: row.locator, bytes: Buffer.from(row.ciphertext) })),
    counters: { records: db.prepare('SELECT count(*) AS n FROM operator_records').get().n, issued: db.prepare('SELECT issued FROM operator_meta').get().issued, used: db.prepare('SELECT sum(used) AS n FROM operator_capabilities').get().n } }; }
  finally { db.close(); }
}

async function freshRecovery(origin, directory) {
  await mkdir(directory, { mode: 0o700 });
  const child = fork(new URL(import.meta.url), ['--recover-child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1', NODE_PATH: '' } });
  return new Promise((done, reject) => {
    let report, error, closed = false, escalation;
    const timer = setTimeout(() => { error = Error('FRESH_RECOVERY_TIMEOUT'); child.kill(); escalation = setTimeout(() => child.kill('SIGKILL'), 2000); }, 20000);
    const finish = code => { if (closed) return; closed = true; clearTimeout(timer); clearTimeout(escalation); error || code !== 0 || !report ? reject(error ?? Error('FRESH_RECOVERY_FAILED')) : done({ ...report, pid: child.pid }); };
    child.once('error', () => { error = Error('FRESH_RECOVERY_FAILED'); }); child.once('close', finish); child.on('message', value => { report = value; });
    child.send({ origin, directory }, sendError => { if (sendError) { error = Error('FRESH_RECOVERY_FAILED'); child.kill('SIGKILL'); } });
  });
}

async function recoverChild({ origin, directory }) {
  const calls = [], outputs = []; let assertions = 0, nativeCalls = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { create() { nativeCalls++; throw Error('NATIVE_FORBIDDEN'); }, get() { nativeCalls++; throw Error('NATIVE_FORBIDDEN'); } } } });
  globalThis.fetch = () => { throw Error('UNBOUND_NETWORK_FORBIDDEN'); };
  const local = loopbackFetch(origin), fetcher = (path, options = {}) => {
    const method = options.method ?? 'GET';
    assert.ok(path === '/api/config' && method === 'GET' || path === '/api/synthetic' && method === 'POST' || /^\/api\/replicas\/(alpha|beta)\/reserve\/[A-Za-z0-9_-]{43}$/.test(path) && method === 'GET');
    if (path.includes('/reserve/')) { assert.equal(new Headers(options.headers).has('authorization'), false); calls.push(method); }
    return local(path, options);
  };
  const environment = await (await fetcher('/api/config')).json(), client = syntheticClient(fetcher);
  const webAuthnClient = { createCredential() { throw Error('CREATION_FORBIDDEN'); }, async getCredential(options) { assertions++; const output = await client.getCredential(options); outputs.push(output); return output; } };
  globalThis.location = { origin };
  const replicas = environment.replicas.map(({ id, basePath }) => ({ id, store: createReserveHttpStore({ fetcher, basePath, timeoutMs: 1500 }) }));
  const pending = recoverTextReservesFromReplicas({ apps: environment.apps.map(({ config }) => ({ config, replicas })), webAuthnClient });
  assert.equal(assertions, 1); const results = await pending;
  for (const [index, result] of results.entries()) if (result.status === 'recovered') {
    for (const format of ['txt', 'json']) await writeFile(join(directory, 'app-' + index + '.' + format), exportText({ getText: () => result.reserve.text }, format), { flag: 'wx', mode: 0o600 });
  }
  assert.equal(assertions, 1); assert.equal(nativeCalls, 0); assert.ok(outputs.every(output => output.prfOutput.every(byte => byte === 0))); assert.equal(calls.length, environment.apps.length * 2);
  return { ok: true, assertions, reads: calls.length, noRecoveryWrites: calls.every(method => method === 'GET'), nativeCalls, prfErased: true,
    results: results.map(({ appId, status, code, replicas }) => ({ appId, status, ...(code ? { code } : {}), replicas })) };
}

export async function runCollectionSmoke({ dist } = {}) {
  const primaryPort = await unusedPort(); let recoveryPort = await unusedPort(); while (recoveryPort === primaryPort) recoveryPort = await unusedPort();
  const directory = await mkdtemp(join(tmpdir(), 'continuity-collection-smoke-')); let app;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    app = await startCollectionStarter({ primaryPort, recoveryPort, ...(dist ? { dist } : {}) });
    globalThis.location = { origin: app.recoveryOrigin };
    const prepared = await prepareCollectionExamples(app), b = loopbackFetch(app.recoveryOrigin), a = loopbackFetch(app.originalOrigin);
    const post = async (path, value) => { const response = await b(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); assert.ok(response.ok, 'control must complete'); return response.json(); };
    const local = app.inspect(); assert.equal(new Set(local.replicas.map(item => item.pid)).size, 2); assert.ok(local.replicas.every(item => item.pid !== process.pid));
    const original = local.replicas.map(item => collectionDatabaseSnapshot(item.database)); assert.deepEqual(original[0], original[1]);
    assert.deepEqual(original[0].counters, { records: 2, issued: 2, used: 2 });
    for (const replica of local.replicas) { const bytes = await readFile(replica.database); for (const sample of COLLECTION_SAMPLES) assert.equal(bytes.includes(Buffer.from(sample)), false); }
    await post('/api/primary', { online: false }); assert.equal((await a('/')).status, 503); assert.equal((await a('/api/config')).status, 503);
    const cases = [], clients = new Set();
    async function recover(name, expected) {
      const snapshots = local.replicas.map(item => collectionDatabaseSnapshot(item.database)), bytes = await Promise.all(local.replicas.map(item => readFile(item.database))), target = join(directory, name);
      const result = await freshRecovery(app.recoveryOrigin, target); clients.add(result.pid); assert.equal(result.ok, true); assert.equal(result.assertions, 1); assert.equal(result.noRecoveryWrites, true); assert.equal(result.nativeCalls, 0); assert.equal(result.prfErased, true);
      assert.deepEqual(result.results.map(item => item.status), expected);
      for (const [index, status] of expected.entries()) for (const format of ['txt', 'json']) {
        const path = join(target, 'app-' + index + '.' + format);
        if (status !== 'recovered') await assert.rejects(readFile(path), { code: 'ENOENT' });
        else if (format === 'txt') assert.deepEqual(await readFile(path), Buffer.from(COLLECTION_SAMPLES[index]));
        else assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { format: 'continuity-text-export/v1', text: COLLECTION_SAMPLES[index] });
      }
      for (const [index, replica] of local.replicas.entries()) { assert.deepEqual(await readFile(replica.database), bytes[index]); assert.deepEqual(collectionDatabaseSnapshot(replica.database), snapshots[index]); }
      cases.push({ name, results: result.results }); return result;
    }
    await recover('both', ['recovered', 'recovered']);
    const stoppedPid = local.replicas[0].pid; await post('/api/replica-control', { id: 'alpha', action: 'stop' });
    assert.throws(() => process.kill(stoppedPid, 0), { code: 'ESRCH' });
    const survivor = await recover('one-process-stopped', ['recovered', 'recovered']); assert.ok(survivor.results.every(item => item.replicas[0].status === 'unavailable' && item.replicas[1].status === 'verified'));
    await post('/api/replica-control', { id: 'beta', action: 'stop' }); await post('/api/replica-control', { id: 'beta', action: 'corrupt', appId: prepared.environment.apps[0].config.appId }); await post('/api/replica-control', { id: 'beta', action: 'start' });
    const corrupt = await recover('one-app-corrupt', ['rejected', 'recovered']); assert.equal(corrupt.results[0].code, 'REPLICA_RECOVERY_FAILED');
    await post('/api/replica-control', { id: 'beta', action: 'stop' }); await recover('both-processes-stopped', ['unavailable', 'unavailable']);
    assert.equal((await a('/')).status, 503); assert.equal(clients.size, 4);
    return { ok: true, mode: 'synthetic local collection replicas', publicSdk: true, apps: 2, existingCredentialReused: true,
      independentStoreProcesses: 2, separateSqliteFiles: 2, freshRecoveryProcesses: clients.size, primaryHttp503: true, exactUtf8Exports: true,
      sdkAssertionsPerCollection: 1, noRecoveryWrites: true, corruptedAppIsolated: true, cases,
      physicalPasskeyProof: false, independentProviders: false, nativeMultiAppUiVerified: false, productionServer: false };
  } finally { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; await app?.close(); await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[2] === '--recover-child' && process.send) process.once('message', async message => {
  try { process.send(await recoverChild(message)); } catch { process.send({ ok: false, code: 'COLLECTION_SMOKE_RECOVERY_FAILED' }); } finally { process.disconnect(); }
});
else if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runCollectionSmoke()));
