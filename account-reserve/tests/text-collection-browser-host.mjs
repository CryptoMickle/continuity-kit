import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startCollectionStarter } from '../text-starter/collection-server.mjs';
import { validateCollectionEnvironment } from '../text-starter/collection-config.mjs';
import { loopbackFetch } from '../text-starter/loopback-fetch.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
async function assets(t) {
  const dist = await mkdtemp(join(tmpdir(), 'collection-host-assets-'));
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Local collection host fixture</title>');
  t.after(() => rm(dist, { recursive: true, force: true })); return dist;
}
async function fixture(t) {
  const dist = await assets(t), primaryPort = await freePort();
  let recoveryPort = await freePort(); while (recoveryPort === primaryPort) recoveryPort = await freePort();
  const app = await startCollectionStarter({ primaryPort, recoveryPort, dist }); t.after(() => app.close());
  const a = loopbackFetch(app.originalOrigin), b = loopbackFetch(app.recoveryOrigin);
  const post = (path, value) => b(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const control = (id, action, appId) => post('/api/replica-control', { id, action, ...(appId ? { appId } : {}) });
  const grant = async appId => { const response = await post('/api/replica-enrollment', { appId }); assert.equal(response.status, 201); return response.json(); };
  return { app, a, b, post, control, grant, recoveryPort, primaryPort };
}
function snapshot(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return { profile: JSON.parse(db.prepare('SELECT config FROM operator_meta').get().config),
    issued: db.prepare('SELECT issued FROM operator_meta').get().issued,
    used: db.prepare('SELECT coalesce(sum(used),0) AS n FROM operator_capabilities').get().n,
    rows: db.prepare('SELECT locator,ciphertext FROM operator_records ORDER BY locator').all().map(row => ({ locator: row.locator, ciphertext: Buffer.from(row.ciphertext) })) }; }
  finally { db.close(); }
}
// The host stores opaque protocol-shaped bytes. Authentication is deliberately
// not claimed by these routing/control fixtures; installed SDK smoke covers it.
function opaqueRecord() { return Buffer.from(JSON.stringify({ ciphertext: randomBytes(32).toString('base64url'), format: 'account-continuity/text-reserve-v1/index', nonce: randomBytes(12).toString('base64url') })); }
const randomLocator = () => randomBytes(32).toString('base64url');
const put = (f, id, token, locator, bytes = opaqueRecord()) => f.b('/api/replicas/' + id + '/reserve/' + locator, { method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ bytes: bytes.toString('base64url') }) });
async function uploadApp(f, appId) {
  const permission = await f.grant(appId), locator = randomLocator(), bytes = opaqueRecord();
  for (const { id, enrollmentToken } of permission.replicas) assert.equal((await put(f, id, enrollmentToken, locator, bytes)).status, 201);
  return { locator, bytes };
}
function raw(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers, agent: false, signal: AbortSignal.timeout(5000) }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.once('error', reject);
      response.once('end', () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }); req.once('error', reject); req.end(body);
  });
}

test('collection configuration fixes both app namespaces and accepts only the two explicit root selectors', { timeout: 15000 }, async t => {
  const f = await fixture(t), env = await (await f.b('/api/config')).json();
  assert.equal(env.collectionMode, true); assert.equal(env.synthetic, true); assert.equal(env.role, 'recovery');
  assert.deepEqual(env.apps.map(({ id, label, config }) => [id, label, config.appId]), [
    ['textarea', 'Text draft', 'continuity-collection-textarea-v1'], ['markdown', 'Markdown draft', 'continuity-collection-markdown-v1'],
  ]);
  const validated = validateCollectionEnvironment(env, f.app.recoveryOrigin + '/?app=markdown#setup-fragment');
  assert.ok(Object.isFrozen(validated.apps[0].config));
  const alter = change => { const value = structuredClone(env); change(value); return value; };
  for (const value of [alter(v => v.apps.reverse()), alter(v => v.apps[1].config.appId = v.apps[0].config.appId),
    alter(v => v.apps[0].label = 'Unconfigured'), alter(v => v.replicas.reverse()), alter(v => v.extra = true),
    alter(v => v.expiresAt = new Date(0).toISOString()), alter(v => v.role = 'primary')]) {
    assert.throws(() => validateCollectionEnvironment(value, f.app.recoveryOrigin));
  }
  for (const path of ['/', '/?app=textarea', '/?app=markdown']) assert.equal((await f.b(path)).status, 200);
  const host = new URL(f.app.recoveryOrigin).host;
  for (const path of ['/?app=unknown', '/?app=markdown&app=textarea', '/?app=%6Darkdown', '/api/config?app=markdown', '/?target=http://foreign.invalid']) {
    assert.equal((await raw(f.recoveryPort, path, { headers: { host } })).status, 400);
  }
  for (const replica of f.app.inspect().replicas) assert.deepEqual(snapshot(replica.database).profile.apps,
    env.apps.map(({ id, label, config }) => ({ id, label, appId: config.appId })));
});

test('each app gets one grant attempt, wrong-store tokens do not dispatch, and dispatched tokens cannot be reused', { timeout: 25000 }, async t => {
  const f = await fixture(t), ids = f.app.apps.map(app => app.config.appId), details = f.app.inspect();
  assert.equal((await f.post('/api/replica-enrollment', { appId: 'textarea' })).status, 400);
  const issued = await Promise.all([f.post('/api/replica-enrollment', { appId: ids[0] }), f.post('/api/replica-enrollment', { appId: ids[0] })]);
  assert.deepEqual(issued.map(value => value.status).sort(), [201, 409]);
  const first = await issued.find(value => value.status === 201).json(), second = await f.grant(ids[1]);
  assert.equal(new Set([...first.replicas, ...second.replicas].map(value => value.enrollmentToken)).size, 4);
  for (const appId of ids) assert.equal((await f.post('/api/replica-enrollment', { appId })).status, 409);
  const token = first.replicas[0].enrollmentToken, locator = randomLocator(), bytes = opaqueRecord();
  assert.equal((await put(f, 'beta', token, locator, bytes)).status, 403);
  assert.equal(snapshot(details.replicas[1].database).rows.length, 0);
  const writes = await Promise.all([put(f, 'alpha', token, locator, bytes), put(f, 'alpha', token, locator, bytes)]);
  assert.deepEqual(writes.map(value => value.status).sort(), [201, 403]);
  const badToken = second.replicas[0].enrollmentToken;
  assert.equal((await put(f, 'alpha', badToken, randomLocator(), Buffer.from('invalid record'))).status, 400);
  assert.equal((await put(f, 'alpha', badToken, randomLocator())).status, 403, 'failed upstream validation still consumes local dispatch permission');
  assert.deepEqual(f.app.inspect().replicas[0].locators, [{ appId: ids[0], locator }]);
  assert.deepEqual(details.replicas.map(item => snapshot(item.database).issued), [2, 2]);

  const partial = await fixture(t), [appOne, appTwo] = partial.app.apps.map(app => app.config.appId);
  assert.equal((await partial.control('beta', 'stop')).status, 200);
  assert.equal((await partial.post('/api/replica-enrollment', { appId: appOne })).status, 503);
  assert.equal((await partial.control('beta', 'start')).status, 200);
  assert.equal((await partial.post('/api/replica-enrollment', { appId: appOne })).status, 409, 'unknown/partial admission is never reissued');
  await partial.grant(appTwo);
  assert.deepEqual(partial.app.inspect().replicas.map(item => snapshot(item.database).issued), [2, 1]);
});

test('corruption requires a stopped store and a confirmed upload for the exact configured app', { timeout: 20000 }, async t => {
  const f = await fixture(t), [one, two] = f.app.apps.map(app => app.config.appId), details = f.app.inspect();
  assert.equal((await f.control('alpha', 'corrupt', one)).status, 409);
  assert.equal((await f.control('alpha', 'stop')).status, 200);
  assert.equal((await f.control('alpha', 'corrupt', one)).status, 409, 'unrecorded app cannot select an arbitrary database record');
  assert.equal((await f.control('alpha', 'corrupt', 'unconfigured-app')).status, 400);
  assert.equal((await f.post('/api/replica-control', { id: 'alpha', action: 'corrupt', appId: one, locator: randomLocator() })).status, 400);
  assert.equal((await f.control('alpha', 'start')).status, 200);
  const first = await uploadApp(f, one);
  assert.equal((await f.control('alpha', 'stop')).status, 200);
  assert.equal((await f.control('alpha', 'corrupt', two)).status, 409, 'a different saved app is not a fallback corruption target');
  assert.equal((await f.control('alpha', 'start')).status, 200);
  const second = await uploadApp(f, two), before = details.replicas.map(item => snapshot(item.database));
  assert.equal((await f.control('alpha', 'corrupt', one)).status, 409, 'running storage cannot be directly mutated');
  assert.equal((await f.control('alpha', 'stop')).status, 200);
  assert.equal((await f.control('alpha', 'corrupt', one)).status, 200);
  assert.equal((await f.control('alpha', 'corrupt', one)).status, 409, 'repeating XOR corruption cannot silently repair the record');
  const after = details.replicas.map(item => snapshot(item.database));
  assert.notDeepEqual(after[0].rows.find(row => row.locator === first.locator).ciphertext, first.bytes);
  assert.deepEqual(after[0].rows.find(row => row.locator === second.locator).ciphertext, second.bytes);
  assert.deepEqual(after[1], before[1]); assert.equal(after[0].used, before[0].used); assert.equal(after[0].issued, before[0].issued);
  const status = await (await f.b('/api/status')).json();
  assert.deepEqual(status.replicas, [{ id: 'alpha', running: false, corruptedApps: [one] }, { id: 'beta', running: true, corruptedApps: [] }]);
  assert.doesNotMatch(JSON.stringify(status), /locator|invitation|enrollmentToken|database|verified/);
});

test('collection mutation routes reject foreign origins and arbitrary app, port or replica targets without changing stores', { timeout: 15000 }, async t => {
  const f = await fixture(t), host = new URL(f.app.recoveryOrigin).host;
  const before = f.app.inspect().replicas.map(item => snapshot(item.database));
  const headers = { host, origin: f.app.recoveryOrigin, 'content-type': 'application/json' };
  for (const origin of ['https://foreign.invalid', f.app.originalOrigin, 'null']) {
    for (const [path, body] of [['/api/replica-enrollment', { appId: f.app.apps[0].config.appId }], ['/api/replica-control', { id: 'alpha', action: 'stop' }]]) {
      assert.equal((await raw(f.recoveryPort, path, { method: 'POST', headers: { ...headers, origin }, body: JSON.stringify(body) })).status, 403);
    }
  }
  assert.equal((await raw(f.recoveryPort, '/api/config', { headers: { host: 'foreign.invalid' } })).status, 421);
  for (const body of [{ id: 'alpha', action: 'stop', port: 80 }, { id: '../beta', action: 'stop' }, { id: 'alpha', action: 'repair' }, { id: 'alpha', action: 'corrupt', appId: f.app.apps[0].config.appId, url: 'http://foreign.invalid' }]) {
    assert.equal((await f.post('/api/replica-control', body)).status, 400);
  }
  for (const path of ['/api/replicas/alpha/enrollment/start', '/api/replicas/gamma/reserve/' + randomLocator(), '/api/replica-enrollment/']) assert.equal((await f.post(path, {})).status, 404);
  assert.equal((await f.a('/api/replica-enrollment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: f.app.apps[0].config.appId }) })).status, 404);
  assert.deepEqual(f.app.inspect().replicas.map(item => snapshot(item.database)), before);
});

test('occupied collection startup closes only its owned children and releases its opened frontend', { timeout: 20000 }, async t => {
  const dist = await assets(t), occupied = createServer();
  await new Promise(done => occupied.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => occupied.close(done)));
  const recoveryPort = occupied.address().port; let primaryPort = await freePort(); while (primaryPort === recoveryPort) primaryPort = await freePort();
  const original = childProcess.fork, owned = [], directories = [];
  childProcess.fork = (...args) => {
    const child = original(...args), send = child.send.bind(child); owned.push(child);
    child.send = (message, ...rest) => { if (message?.synthetic === true) directories.push(message.directory); return send(message, ...rest); };
    return child;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(startCollectionStarter({ primaryPort, recoveryPort, dist }), error => error.code === 'EADDRINUSE'); }
  finally { childProcess.fork = original; syncBuiltinESMExports(); }
  assert.equal(owned.length, 2); assert.equal(directories.length, 2);
  assert.ok(owned.every(child => child.exitCode !== null || child.signalCode !== null));
  for (const directory of directories) await assert.rejects(access(directory), error => error.code === 'ENOENT');
  assert.equal(occupied.listening, true, 'the unowned conflicting listener stays running');
  const probe = createServer();
  await new Promise((done, reject) => { probe.once('error', reject); probe.listen(primaryPort, '127.0.0.1', done); }); await new Promise(done => probe.close(done));
});
