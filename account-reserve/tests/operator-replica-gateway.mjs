import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startReplicaGateway } from '../operator/replica-gateway.mjs';
import { startOperatorHost } from '../operator/host.mjs';
import { initializeDatabase } from '../operator/store.mjs';
import { canonical, TEXT_FORMAT } from '../operator/profile.mjs';

const recoveryOrigin = 'https://reserve.example.org';
const locator = () => randomBytes(32).toString('base64url');
const invitation = () => randomBytes(32).toString('hex');
const ciphertext = () => Buffer.from(canonical({ format: TEXT_FORMAT, nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(48).toString('base64url') }));
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
async function backend(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const close = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  t.after(close); return { port: server.address().port, close };
}
async function gateway(t, first, second) {
  const configuration = { recoveryOrigin, replicas: [{ id: 'alpha', port: first.port }, { id: 'beta', port: second.port }] };
  const running = await startReplicaGateway({ configuration }); t.after(() => running.close());
  return { ...running, configuration };
}
function call(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method,
      headers: { host: 'reserve.example.org', ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
      response.once('error', reject);
    });
    request.once('error', reject); request.end(body);
  });
}
const mutationHeaders = bearer => ({ origin: recoveryOrigin, 'content-type': 'application/json', authorization: 'Bearer ' + bearer });

test('gateway configuration pins 2–3 distinct local ports and bounded fixed replica IDs', async () => {
  const base = { recoveryOrigin, replicas: [{ id: 'alpha', port: 18081 }, { id: 'beta', port: 18082 }] };
  const invalid = [null, { ...base, extra: true }, { ...base, recoveryOrigin: 'http://public.example' }, { ...base, recoveryOrigin: recoveryOrigin + '/' },
    { ...base, replicas: [] }, { ...base, replicas: base.replicas.slice(0, 1) }, { ...base, replicas: [...base.replicas, { id: 'gamma', port: 18083 }, { id: 'delta', port: 18084 }] },
    { ...base, replicas: [base.replicas[0], { id: 'alpha', port: 18082 }] }, { ...base, replicas: [base.replicas[0], { id: 'beta', port: 18081 }] },
    { ...base, replicas: [base.replicas[0], { id: '../beta', port: 18082 }] }, { ...base, replicas: [base.replicas[0], { id: 'beta', port: 65536 }] },
    { ...base, replicas: [base.replicas[0], { id: 'beta', port: 0 }] }, { ...base, replicas: [base.replicas[0], { id: 'beta', port: 18082, host: 'elsewhere.example' }] }];
  for (const configuration of invalid) await assert.rejects(startReplicaGateway({ configuration }), error => error.code === 'GATEWAY_CONFIGURATION_INVALID');
  await assert.rejects(startReplicaGateway({ configuration: base, port: 18081 }), error => error.code === 'GATEWAY_CONFIGURATION_INVALID');
});

test('exact replica routing forwards only accepted Host/Origin and no ambient or arbitrary headers', async t => {
  const requests = [];
  const a = await backend(t, (req, res) => { requests.push({ replica: 'alpha', path: req.url, headers: req.headers }); json(res, { bytes: 'first' }); });
  const b = await backend(t, (req, res) => { requests.push({ replica: 'beta', path: req.url, headers: req.headers }); json(res, { bytes: 'second' }); });
  const g = await gateway(t, a, b), key = locator();
  const first = await call(g.port, '/api/replicas/alpha/reserve/' + key, { headers: { origin: recoveryOrigin, cookie: 'private=discard', authorization: 'Bearer discard', 'x-forwarded-host': 'evil.example', 'x-target': 'https://evil.example' } });
  assert.equal(first.status, 200); assert.equal(first.headers['cache-control'], 'no-store'); assert.equal(first.headers['access-control-allow-origin'], undefined);
  assert.equal((await call(g.port, '/api/replicas/beta/reserve/' + key)).status, 200);
  assert.deepEqual(requests.map(r => [r.replica, r.path]), [['alpha', '/api/reserve/' + key], ['beta', '/api/reserve/' + key]]);
  assert.equal(requests[0].headers.host, 'reserve.example.org'); assert.equal(requests[0].headers.origin, recoveryOrigin);
  for (const name of ['cookie', 'authorization', 'x-forwarded-host', 'x-target']) assert.equal(requests[0].headers[name], undefined);
  assert.equal(requests[1].headers.origin, undefined);
  // Snapshot configuration before the first asynchronous request.
  g.configuration.replicas[0].port = b.port;
  assert.equal((await call(g.port, '/api/replicas/alpha/reserve/' + key)).text, first.text);
});

test('unlisted routes, origins, methods and malformed mutation authority never reach a backend', async t => {
  let reached = 0;
  const a = await backend(t, (_req, res) => { reached++; json(res, {}); }), b = await backend(t, (_req, res) => { reached++; json(res, {}); });
  const g = await gateway(t, a, b), path = '/api/replicas/alpha/reserve/' + locator();
  for (const route of ['/', '/api/config', '/api/reserve/' + locator(), '/api/replicas/unknown/reserve/' + locator(), path + '?target=beta', path + '/', '/api/replicas/alpha/../beta/reserve/' + locator(), path.replace('alpha', '%61lpha')]) assert.equal((await call(g.port, route)).status, 404);
  assert.equal((await call(g.port, path, { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await call(g.port, path, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(g.port, path, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call(g.port, path, { method: 'DELETE' })).status, 405);
  assert.equal((await call(g.port, path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await call(g.port, path, { method: 'PUT', headers: mutationHeaders('bad'), body: '{}' })).status, 403);
  assert.equal((await call(g.port, '/api/replicas/alpha/enrollment/start', { method: 'POST', headers: mutationHeaders(invitation()), body: '{ }' })).status, 400);
  assert.equal((await call(g.port, path, { method: 'PUT', headers: { ...mutationHeaders(locator()), 'content-encoding': 'gzip' }, body: '{}' })).status, 400);
  assert.equal((await call(g.port, path, { body: 'get-body' })).status, 400);
  assert.equal((await call(g.port, path, { method: 'PUT', headers: mutationHeaders(locator()), body: 'a'.repeat(87441) })).status, 400);
  assert.equal(reached, 0);
});

test('two durable operator stores enforce separate admissions and receive the exact immutable ciphertext', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'replica-gateway-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { version: 1, primaryOrigin: 'https://writing.example.org', recoveryOrigin, expiresAt: new Date(Date.now() + 86400000).toISOString(), apps: [{ id: 'textarea', label: 'Textarea', appId: 'continuity-textarea-v1' }] };
  const hosts = [], invitations = [];
  for (const id of ['alpha', 'beta']) {
    const database = join(directory, id + '.db'), invitationFile = join(directory, id + '.invitation'), secret = invitation();
    initializeDatabase(database, config); await writeFile(invitationFile, secret, { mode: 0o600 });
    const running = await startOperatorHost({ configuration: config, database, invitationFile });
    let closed = false;
    const host = { port: running.port, async close() { if (!closed) { closed = true; await running.close(); } } };
    hosts.push(host); invitations.push(secret); t.after(() => host.close());
  }
  const g = await gateway(t, ...hosts), key = locator(), record = ciphertext(), body = JSON.stringify({ bytes: record.toString('base64url') });
  const admissions = [];
  for (const [index, id] of ['alpha', 'beta'].entries()) {
    const admission = await call(g.port, '/api/replicas/' + id + '/enrollment/start', { method: 'POST', headers: mutationHeaders(invitations[index]), body: '{}' });
    assert.equal(admission.status, 201); admissions.push(JSON.parse(admission.text).enrollmentToken);
  }
  assert.equal((await call(g.port, '/api/replicas/beta/reserve/' + key, { method: 'PUT', headers: mutationHeaders(admissions[0]), body })).status, 403);
  for (const [index, id] of ['alpha', 'beta'].entries()) {
    const path = '/api/replicas/' + id + '/reserve/' + key;
    assert.equal((await call(g.port, path, { method: 'PUT', headers: mutationHeaders(admissions[index]), body })).status, 201);
    assert.equal((await call(g.port, path, { method: 'PUT', headers: mutationHeaders(admissions[index]), body })).status, 403);
    assert.equal(JSON.parse((await call(g.port, path)).text).bytes, record.toString('base64url'));
  }
  await hosts[0].close();
  assert.equal((await call(g.port, '/api/replicas/alpha/reserve/' + key)).status, 503);
  assert.equal(JSON.parse((await call(g.port, '/api/replicas/beta/reserve/' + key)).text).bytes, record.toString('base64url'));
});

test('redirects, oversized or encoded responses are rejected without trying another replica', async t => {
  let mode = 'redirect', alphaCalls = 0, betaCalls = 0;
  const a = await backend(t, (_req, res) => {
    alphaCalls++;
    if (mode === 'redirect') { res.writeHead(302, { 'content-type': 'application/json', location: 'http://127.0.0.1/elsewhere' }); res.end('{}'); }
    if (mode === 'length') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 87441 }); res.end('a'.repeat(87441)); }
    if (mode === 'chunked') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('a'.repeat(45000)); res.end('b'.repeat(45000)); }
    if (mode === 'encoded') { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end('{}'); }
    if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>no</p>'); }
    if (mode === 'lost') res.destroy();
  });
  const b = await backend(t, (_req, res) => { betaCalls++; json(res, {}); });
  const g = await gateway(t, a, b), path = '/api/replicas/alpha/reserve/' + locator();
  for (mode of ['redirect', 'length', 'chunked', 'encoded', 'html']) assert.equal((await call(g.port, path)).status, 502);
  mode = 'lost'; assert.equal((await call(g.port, path, { method: 'PUT', headers: mutationHeaders(locator()), body: '{}' })).status, 503);
  assert.equal(alphaCalls, 6); assert.equal(betaCalls, 0);
});

test('a stalled upstream is bounded and never retried', async t => {
  let reached = 0;
  const a = await backend(t, () => { reached++; }), b = await backend(t, (_req, res) => json(res, {}));
  const g = await gateway(t, a, b), original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => original(callback, milliseconds === 8000 ? 30 : milliseconds, ...args);
  try { assert.equal((await call(g.port, '/api/replicas/alpha/reserve/' + locator())).status, 503); assert.equal(reached, 1); }
  finally { globalThis.setTimeout = original; }
});

test('stalled and disconnected request bodies do not dispatch or disable the gateway', { timeout: 5000 }, async t => {
  let alphaCalls = 0;
  const a = await backend(t, (_req, res) => { alphaCalls++; json(res, {}); }), b = await backend(t, (_req, res) => json(res, {}));
  const g = await gateway(t, a, b), path = '/api/replicas/alpha/reserve/' + locator();
  const options = { hostname: '127.0.0.1', port: g.port, path, method: 'PUT', headers: { host: 'reserve.example.org', ...mutationHeaders(locator()), 'content-length': 100 } };
  const disconnected = httpRequest(options); disconnected.on('error', () => {}); disconnected.write('{');
  await new Promise(resolve => setTimeout(resolve, 20)); disconnected.destroy();
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => original(callback, milliseconds === 8000 ? 30 : milliseconds, ...args);
  let stalled;
  try {
    const status = await new Promise((resolve, reject) => {
      stalled = httpRequest(options, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
      stalled.once('error', reject); stalled.write('{');
    });
    assert.equal(status, 503); assert.equal(alphaCalls, 0);
  } finally { globalThis.setTimeout = original; stalled?.destroy(); }
  assert.equal((await call(g.port, '/api/replicas/beta/reserve/' + locator())).status, 200);
});

test('client disconnect aborts its one upstream dispatch and leaves the gateway usable', { timeout: 5000 }, async t => {
  let alphaCalls = 0, started, closed;
  const began = new Promise(resolve => { started = resolve; }), ended = new Promise(resolve => { closed = resolve; });
  const a = await backend(t, (_req, res) => { alphaCalls++; res.once('close', closed); started(); });
  const b = await backend(t, (_req, res) => json(res, {}));
  const g = await gateway(t, a, b);
  const pending = httpRequest({ hostname: '127.0.0.1', port: g.port, path: '/api/replicas/alpha/reserve/' + locator(), headers: { host: 'reserve.example.org' } });
  pending.on('error', () => {}); pending.end();
  await began; pending.destroy(); await ended;
  assert.equal(alphaCalls, 1); assert.equal((await call(g.port, '/api/replicas/beta/reserve/' + locator())).status, 200);
});
