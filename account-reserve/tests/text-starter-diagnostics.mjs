import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = process.env.CK_DIAGNOSTICS_PROJECT_ROOT
  ?? fileURLToPath(new URL('../', import.meta.url));
const templateRoot = process.env.CK_DIAGNOSTICS_TEMPLATE_ROOT ?? join(projectRoot, 'text-starter');
const { syntheticClient } = await import(pathToFileURL(join(templateRoot, 'synthetic-client.mjs')));
const { startTextStarter } = await import(pathToFileURL(join(projectRoot, 'text-starter/server.mjs')));
const SALT = Uint8Array.from(Buffer.from('20b9d60bc82e9d394a6e32b02bfb225927685add7cc924188fb8b7117e034d12', 'hex'));
const input = () => ({ rp: { id: 'text-starter-reserve.localhost' }, rpId: 'text-starter-reserve.localhost', prfSalt: new Uint8Array(SALT) });
const legacyFailure = error => error?.code === 'SYNTHETIC_CREDENTIAL_UNAVAILABLE';

function diagnostic(kind, action, status, error) {
  return { kind, method: 'POST', path: '/api/synthetic', action, status, error };
}
function assertDiagnostic(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.equal(Object.isFrozen(actual), true, 'diagnostics cannot be mutated by an observer');
  assert.deepEqual(Object.keys(actual).sort(), ['action', 'error', 'kind', 'method', 'path', 'status']);
}
function transport(origin, overrides = {}) {
  const base = new URL(origin);
  return (path, init = {}) => new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    const req = request({ hostname: '127.0.0.1', port: Number(base.port), path,
      method: init.method ?? 'GET', agent: false,
      headers: { ...headers, host: overrides.host ?? base.host, origin: overrides.origin ?? base.origin } }, response => {
      const chunks = [];
      response.on('data', bytes => chunks.push(bytes));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode, headers: { 'content-type': response.headers['content-type'] ?? 'application/json' },
      })));
    });
    req.on('error', reject); req.end(init.body);
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function serverFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ck-diagnostic-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Diagnostic test</title>');
  const primaryPort = await freePort();
  let recoveryPort = await freePort();
  while (primaryPort === recoveryPort) recoveryPort = await freePort();
  let server;
  t.after(async () => { await server?.close(); await rm(directory, { recursive: true, force: true }); });
  server = await startTextStarter({ primaryPort, recoveryPort, dist: directory });
  return { server, a: transport(server.originalOrigin), b: transport(server.recoveryOrigin) };
}

test('fresh B get returns missing-credential diagnostic; creating and getting afterward still works', async t => {
  const { b } = await serverFixture(t), events = [];
  const client = syntheticClient(b, { onDiagnostic: value => events.push(value) });
  await assert.rejects(client.getCredential(input()), legacyFailure);
  assert.equal(events.length, 1);
  assertDiagnostic(events[0], diagnostic('http', 'get', 404, 'CREDENTIAL_MISSING'));
  let status = await (await b('/api/status')).json();
  assert.equal(status.counts.creates, 0); assert.equal(status.counts.writes, 0); assert.equal(status.records, 0);

  const created = await client.createCredential(input()), recovered = await client.getCredential(input());
  assert.deepEqual(recovered.credentialId, created.credentialId);
  assert.deepEqual(recovered.prfOutput, created.prfOutput);
  assert.equal(created.prfOutput.byteLength, 32);
  assert.equal(events.length, 1, 'success cannot expose credential/PRF material through diagnostics');
  status = await (await b('/api/status')).json();
  assert.equal(status.counts.creates, 1); assert.equal(status.counts.assertions, 1);
  assert.equal(status.counts.writes, 0); assert.equal(status.records, 0);
});

test('repeated creation and wrong selection preserve the current simulated credential', async t => {
  const { b } = await serverFixture(t), events = [];
  const client = syntheticClient(b, { onDiagnostic: value => events.push(value) });
  const created = await client.createCredential(input());
  await assert.rejects(client.createCredential(input()), legacyFailure);
  assertDiagnostic(events.at(-1), diagnostic('http', 'create', 409, 'ONE_LOCAL_CREDENTIAL_PER_RUN'));
  const wrong = new Uint8Array(created.credentialId); wrong[0] ^= 0xff;
  await assert.rejects(client.getCredential({ ...input(), allowCredential: { credentialId: wrong } }), legacyFailure);
  assertDiagnostic(events.at(-1), diagnostic('http', 'get', 404, 'CREDENTIAL_MISSING'));
  const recovered = await client.getCredential(input());
  assert.deepEqual(recovered.credentialId, created.credentialId);
  assert.deepEqual(recovered.prfOutput, created.prfOutput);
  const status = await (await b('/api/status')).json();
  assert.equal(status.counts.creates, 1); assert.equal(status.counts.writes, 0);
});

test('wrong role, Host and Origin remain distinct and cannot create credentials', async t => {
  const { server, a, b } = await serverFixture(t);
  const cases = [
    { fetcher: a, expected: diagnostic('http', 'create', 404, 'ROUTE_UNAVAILABLE') },
    { fetcher: transport(server.recoveryOrigin, { host: 'localhost:' + new URL(server.recoveryOrigin).port }), expected: diagnostic('http', 'create', 421, 'HOST_REJECTED') },
    { fetcher: transport(server.recoveryOrigin, { origin: server.originalOrigin }), expected: diagnostic('http', 'create', 403, 'ORIGIN_REJECTED') },
  ];
  for (const item of cases) {
    const events = [], client = syntheticClient(item.fetcher, { onDiagnostic: value => events.push(value) });
    await assert.rejects(client.createCredential(input()), legacyFailure);
    assert.equal(events.length, 1); assertDiagnostic(events[0], item.expected);
  }
  const status = await (await b('/api/status')).json();
  assert.equal(status.counts.creates, 0); assert.equal(status.counts.writes, 0); assert.equal(status.records, 0);
});

test('diagnostics never expose malformed error bodies or arbitrary server strings', async () => {
  const privateMarker = 'PRIVATE-SENTINEL-DO-NOT-EMIT';
  const responses = [
    { body: `<html>${privateMarker}</html>`, type: 'text/html' },
    { body: JSON.stringify({ error: privateMarker, credentialId: privateMarker, prfOutput: privateMarker }), type: 'application/json' },
    { body: JSON.stringify([ { error: 'CREDENTIAL_MISSING', secret: privateMarker } ]), type: 'application/json' },
    { body: JSON.stringify({ error: { code: 'CREDENTIAL_MISSING', secret: privateMarker } }), type: 'application/json' },
    { body: '{"error":"' + privateMarker.repeat(10000) + '"}', type: 'application/json' },
  ];
  for (const item of responses) {
    const events = [];
    const client = syntheticClient(async () => new Response(item.body, { status: 404, headers: { 'content-type': item.type } }), { onDiagnostic: value => events.push(value) });
    await assert.rejects(client.getCredential(input()), legacyFailure);
    assert.equal(events.length, 1);
    assertDiagnostic(events[0], diagnostic('http', 'get', 404, 'UNRECOGNIZED_RESPONSE'));
    assert.equal(JSON.stringify(events).includes(privateMarker), false);
  }
  const events = [];
  const client = syntheticClient(async () => new Response(JSON.stringify({ error: 'CREDENTIAL_MISSING', credentialId: privateMarker, prfOutput: privateMarker, token: privateMarker }), {
    status: 404, headers: { 'content-type': 'application/json' },
  }), { onDiagnostic: value => events.push(value) });
  await assert.rejects(client.getCredential(input()), legacyFailure);
  assert.equal(events.length, 1);
  assert.ok(['CREDENTIAL_MISSING', 'UNRECOGNIZED_RESPONSE'].includes(events[0].error));
  assertDiagnostic(events[0], diagnostic('http', 'get', 404, events[0].error));
  assert.equal(JSON.stringify(events).includes(privateMarker), false);
});

test('a throwing diagnostic observer cannot replace failure or prevent a later success', async () => {
  let requests = 0, observations = 0;
  const client = syntheticClient(async () => {
    requests++;
    return requests === 1 ? new Response('{"error":"CREDENTIAL_MISSING"}', { status: 404 })
      : new Response(JSON.stringify({ credentialId: Buffer.alloc(24, 7).toString('base64url'), prfOutput: Buffer.alloc(32, 11).toString('base64url') }), { status: 200 });
  }, { onDiagnostic() { observations++; throw new Error('OBSERVER_MUST_NOT_ESCAPE'); } });
  await assert.rejects(client.getCredential(input()), legacyFailure);
  const result = await client.createCredential(input());
  assert.equal(result.credentialId.byteLength, 24); assert.equal(result.prfOutput.byteLength, 32);
  assert.equal(requests, 2); assert.equal(observations, 1);
});

test('network errors emit fixed metadata without leaking original details or retrying', async () => {
  const events = []; let requests = 0;
  const client = syntheticClient(async () => { requests++; throw new Error('PRIVATE-NETWORK-DETAIL'); }, { onDiagnostic: value => events.push(value) });
  await assert.rejects(client.createCredential(input()), legacyFailure);
  assert.equal(requests, 1); assert.equal(events.length, 1);
  assertDiagnostic(events[0], diagnostic('network', 'create', null, 'NETWORK_UNAVAILABLE'));
  assert.equal(JSON.stringify(events).includes('PRIVATE-NETWORK-DETAIL'), false);
});

test('malformed successful responses fail without leaking their payload', async () => {
  const responses = [
    '{not json',
    JSON.stringify({ credentialId: 'PRIVATE-PAYLOAD', prfOutput: null }),
    JSON.stringify({ credentialId: Buffer.alloc(24, 2).toString('base64url'), prfOutput: Buffer.alloc(1, 3).toString('base64url') }),
    JSON.stringify({ credentialId: '', prfOutput: Buffer.alloc(32, 3).toString('base64url') }),
  ];
  for (const body of responses) {
    const events = [], client = syntheticClient(async () => new Response(body, { status: 200 }), { onDiagnostic: value => events.push(value) });
    await assert.rejects(client.getCredential(input()), legacyFailure);
    assert.equal(events.length, 1);
    assertDiagnostic(events[0], diagnostic('invalid-response', 'get', 200, 'INVALID_RESPONSE'));
  }
});
