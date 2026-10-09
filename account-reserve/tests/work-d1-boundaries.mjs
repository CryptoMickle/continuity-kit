import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { createHostedD1WorkClient } from '../work-release/d1-host-worker.mjs';
import { createWorkD1Handler } from '../work-release/d1-handler.mjs';
import { createReserveHttpStore } from '../release/browser-store.mjs';
import { base64url, enrollmentTicketHash } from '../release/profile.mjs';

const primaryOrigin = 'https://work-primary.example.invalid';
const recoveryOrigin = 'https://work-reserve.example.invalid';
const attackerOrigin = 'https://attacker.example.invalid';
const locator = () => base64url(randomBytes(32));
const ciphertext = () => new Uint8Array([11, 22, 33, 44]);
const profile = () => ({ version: 1, enabled: true, releaseId: randomBytes(16).toString('hex'), primaryOrigin, recoveryOrigin, expiresAt: new Date(Date.now() + 60000).toISOString() });
const namespace = p => `accountreserve:v1:${p.releaseId}`;
const worker = p => createHostedD1WorkClient({ role: 'recovery', profile: p });
let mf, db, unmigratedDb;

async function grant(bound = '*') {
  const token = locator();
  return { token, configured: { hash: await enrollmentTicketHash(token), locator: bound } };
}
const environment = (grants = [], binding = db) => ({ DB: binding, RESERVE_ENROLLMENT_TICKET_HASHES: JSON.stringify(grants.map(g => g.configured)) });

function request(key, { token, method = 'PUT', bytes = ciphertext(), body, url, headers = {} } = {}) {
  const fields = new Headers(method === 'PUT' ? { origin: recoveryOrigin, 'content-type': 'application/json' } : {});
  if (token) fields.set('authorization', `Bearer ${token}`);
  for (const [name, value] of Object.entries(headers)) value === null ? fields.delete(name) : fields.set(name, value);
  const payload = method === 'PUT' ? (body === undefined ? JSON.stringify({ bytes: base64url(bytes) }) : body) : undefined;
  return new Request(url ?? `${recoveryOrigin}/api/reserve/${key}`, { method, headers: fields, ...(payload === undefined ? {} : { body: payload }), ...(payload instanceof ReadableStream ? { duplex: 'half' } : {}) });
}
function check(token, { body = '{}', headers = {}, suffix = '' } = {}) {
  return new Request(`${recoveryOrigin}/api/enrollment/check${suffix}`, { method: 'POST', headers: { origin: recoveryOrigin, 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body });
}
function trackedBinding() {
  const calls = { prepare: 0, batch: 0 };
  return { calls, binding: {
    prepare(sql) { calls.prepare++; return db.prepare(sql); },
    batch(statements) { calls.batch++; return db.batch(statements); },
  } };
}
async function snapshot(p) {
  return {
    header: await db.prepare('SELECT * FROM work_releases WHERE namespace=?').bind(namespace(p)).first(),
    records: (await db.prepare('SELECT * FROM work_records WHERE namespace=? ORDER BY locator').bind(namespace(p)).all()).results,
  };
}
function standalone(p, grants, binding, options) {
  const { primaryOrigin: _primary, ...releaseProfile } = p;
  return createWorkD1Handler({ profile: releaseProfile, allowedOrigins: [recoveryOrigin], enrollmentTickets: grants.map(g => g.configured), db: binding }, options);
}

// Requests exercise the production host/handler in Node and the production SQL
// in a disposable workerd D1 database. No cloud database or external fetch is used.
before(async () => {
  mf = new Miniflare({ modules: true, host: '127.0.0.1', script: 'export default { fetch() { return new Response("local D1 boundary fixture"); } }', compatibilityDate: '2026-07-30', d1Databases: ['DB', 'UNMIGRATED_DB'] });
  db = await mf.getD1Database('DB');
  unmigratedDb = await mf.getD1Database('UNMIGRATED_DB');
  const sql = await readFile(new URL('../work-release/drizzle/0000_fixed_mockingbird.sql', import.meta.url), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
});
after(async () => { await mf?.dispose(); });

test('D1 HTTP rejects unauthorized origins, tickets, routes and methods before database work', async () => {
  const p = profile(), g = await grant(), key = locator(), tracked = trackedBinding(), w = worker(p), env = environment([g], tracked.binding);
  const cases = [
    [request(key), 403],
    [request(key, { token: locator() }), 403],
    [request(key, { token: g.token, headers: { authorization: `Basic ${g.token}` } }), 403],
    [request(key, { token: g.token, headers: { origin: null } }), 403],
    [request(key, { token: g.token, headers: { origin: attackerOrigin } }), 403],
    [request(key, { token: g.token, headers: { 'sec-fetch-site': 'cross-site' } }), 403],
    [request(key, { token: g.token, headers: { 'content-type': 'text/plain' } }), 403],
    [request(key, { token: g.token, headers: { 'content-encoding': 'gzip' } }), 403],
    [request(key, { method: 'GET', headers: { origin: attackerOrigin } }), 403],
    [request(key, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }), 403],
    [request(key, { method: 'GET', url: `${attackerOrigin}/api/reserve/${key}` }), 421],
    [request(key, { token: g.token, url: `${recoveryOrigin}/api/reserve/${key}?token=${g.token}` }), 404],
    [request(key, { method: 'GET', url: `${recoveryOrigin}/api/reserve/${key}#fragment` }), 404],
    [request('A'.repeat(42) + 'B', { token: g.token }), 404],
    [request(key, { method: 'DELETE' }), 405],
  ];
  for (const [r, status] of cases) {
    const response = await w.fetch(r, env);
    assert.equal(response.status, status, `${r.method} ${r.url}`);
    assert.equal(response.headers.has('access-control-allow-origin'), false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(tracked.calls, { prepare: 0, batch: 0 });
  assert.deepEqual(await snapshot(p), { header: null, records: [] });
});

test('D1 HTTP locator-bound grants cannot write elsewhere or replace accepted ciphertext', async () => {
  const p = profile(), key = locator(), bound = await grant(key), other = await grant(), tracked = trackedBinding(), w = worker(p), env = environment([bound, other], tracked.binding);
  assert.equal((await w.fetch(request(locator(), { token: bound.token }), env)).status, 403);
  assert.deepEqual(tracked.calls, { prepare: 0, batch: 0 });
  assert.equal((await w.fetch(request(key, { token: bound.token }), env)).status, 201);
  const stored = await snapshot(p);
  for (const token of [bound.token, other.token]) assert.equal((await w.fetch(request(key, { token, bytes: new Uint8Array([99]) }), env)).status, 409);
  assert.deepEqual(await snapshot(p), stored);
  assert.equal((await w.fetch(request(locator(), { token: other.token }), env)).status, 201, 'a rejected overwrite must not consume an unused grant');
});

test('D1 HTTP accepts only canonical ciphertext JSON and enforces the exact 64 KiB limit', async () => {
  const p = profile(), g = await grant(), key = locator(), tracked = trackedBinding(), w = worker(p), env = environment([g], tracked.binding);
  const malformed = [
    '{"bytes":"AA","bytes":"AQ"}',
    '{"bytes":"AA","owner":"unexpected"}',
    '{ "bytes": "AA" }',
    '{"bytes":"AB"}',
    '{"bytes":"AA=="}',
    '{"bytes":""}',
    '{"bytes":null}',
    '[]',
    new Uint8Array([0xff]),
    JSON.stringify({ bytes: base64url(new Uint8Array(65537)) }),
  ];
  for (const body of malformed) {
    const response = await w.fetch(request(key, { token: g.token, body }), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'RECORD_INVALID' });
  }
  assert.deepEqual(tracked.calls, { prepare: 0, batch: 0 });
  assert.deepEqual(await snapshot(p), { header: null, records: [] });
  const maximum = new Uint8Array(65536).fill(37);
  assert.equal((await w.fetch(request(key, { token: g.token, bytes: maximum }), env)).status, 201);
  const read = await w.fetch(request(key, { method: 'GET' }), environment());
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { bytes: base64url(maximum) });
});

test('D1 HTTP bounds declared, streamed and stalled request bodies without touching storage', async () => {
  const p = profile(), g = await grant(), key = locator(), tracked = trackedBinding();
  const handle = standalone(p, [g], tracked.binding, { bodyTimeoutMs: 20 });
  assert.equal((await handle(request(key, { token: g.token, headers: { 'content-length': '90001' } }))).status, 400);
  let oversizedCancelled = false, stalledCancelled = false;
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(90001)); }, cancel() { oversizedCancelled = true; } });
  const tooLarge = await handle(request(key, { token: g.token, body: oversized, headers: { 'content-length': '2' } }));
  assert.equal(tooLarge.status, 400); assert.equal(oversizedCancelled, true);
  const stalled = new ReadableStream({ cancel() { stalledCancelled = true; } });
  assert.equal((await handle(request(key, { token: g.token, body: stalled }))).status, 400);
  assert.equal(stalledCancelled, true);
  assert.deepEqual(tracked.calls, { prepare: 0, batch: 0 });
  assert.deepEqual(await snapshot(p), { header: null, records: [] });
});

test('D1 HTTP rechecks release expiry after reading the authorized request body', async () => {
  const p = profile(), g = await grant(), tracked = trackedBinding();
  let now = Date.parse(p.expiresAt) - 1, controller;
  const handle = standalone(p, [g], tracked.binding, { now: () => now });
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const pending = handle(request(locator(), { token: g.token, body: stream }));
  now = Date.parse(p.expiresAt);
  controller.enqueue(new TextEncoder().encode('{"bytes":"AA"}')); controller.close();
  const response = await pending;
  assert.equal(response.status, 410); assert.deepEqual(await response.json(), { error: 'RELEASE_EXPIRED' });
  assert.deepEqual(tracked.calls, { prepare: 0, batch: 0 });
});

test('D1 enrollment check rejects invalid body, cross-site and locator-bound grants before querying', async () => {
  const p = profile(), g = await grant(), bound = await grant(locator()), tracked = trackedBinding(), w = worker(p), env = environment([g, bound], tracked.binding);
  for (const r of [
    check(locator()), check(bound.token), check(g.token, { body: '{"owner":"unexpected"}' }),
    check(g.token, { body: '{ }' }), check(g.token, { headers: { origin: attackerOrigin } }),
    check(g.token, { headers: { 'sec-fetch-site': 'cross-site' } }),
    check(g.token, { headers: { 'content-encoding': 'gzip' } }), check(g.token, { suffix: '?ready=true' }),
  ]) {
    const response = await w.fetch(r, env);
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'ENROLLMENT_DENIED' });
  }
  assert.deepEqual(tracked.calls, { prepare: 0, batch: 0 });
  assert.equal((await w.fetch(check(g.token), env)).status, 200);
  assert.equal(tracked.calls.batch, 0);
  assert.deepEqual(await snapshot(p), { header: null, records: [] });
});

test('D1 HTTP distinguishes absent ciphertext from a missing schema without leaking SQL details', async () => {
  const p = profile(), g = await grant(), key = locator(), w = worker(p);
  const absent = await w.fetch(request(key, { method: 'GET' }), environment());
  assert.equal(absent.status, 404); assert.deepEqual(await absent.json(), { error: 'RESERVE_MISSING' });
  const env = environment([g], unmigratedDb);
  for (const [r, error] of [[request(key, { method: 'GET' }), 'STORE_UNAVAILABLE'], [request(key, { token: g.token }), 'STORE_WRITE_UNKNOWN'], [check(g.token), 'STORE_UNAVAILABLE']]) {
    const response = await w.fetch(r, env);
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error });
  }
  assert.deepEqual(await snapshot(p), { header: null, records: [] });
});

test('D1 lost write response is sanitized and never retried; fresh recovery omits authorization', async () => {
  const p = profile(), g = await grant(), key = locator(), bytes = ciphertext(), requests = [], responses = [];
  let batches = 0;
  const lostResponse = {
    prepare: sql => db.prepare(sql),
    async batch(statements) { batches++; await db.batch(statements); throw new Error('SYNTHETIC_SQL_PROVIDER_DETAIL_MUST_NOT_ESCAPE'); },
  };
  function browser(target, env) {
    return async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.method === 'PUT') headers.set('origin', recoveryOrigin);
      headers.set('sec-fetch-site', 'same-origin');
      requests.push({ path, method: init.method ?? 'GET', authorization: headers.get('authorization'), credentials: init.credentials });
      const response = await target.fetch(new Request(new URL(path, recoveryOrigin), { ...init, headers }), env);
      responses.push({ status: response.status, json: await response.clone().json() });
      return response;
    };
  }
  const preparing = createReserveHttpStore({ enrollmentToken: g.token, fetcher: browser(worker(p), environment([g], lostResponse)) });
  await assert.rejects(preparing.putIfAbsent(key, bytes), /STORE_WRITE_UNKNOWN/);
  assert.deepEqual(responses, [{ status: 503, json: { error: 'STORE_WRITE_UNKNOWN' } }]);
  await assert.rejects(preparing.putIfAbsent(key, bytes), /ENROLLMENT_DENIED/);
  assert.equal(batches, 1); assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${g.token}`);
  const committed = await snapshot(p);
  assert.equal(committed.records.length, 1);
  const recovering = createReserveHttpStore({ fetcher: browser(worker(p), environment()) });
  assert.deepEqual(await recovering.get(key), bytes);
  assert.deepEqual(requests[1], { path: `/api/reserve/${key}`, method: 'GET', authorization: null, credentials: 'omit' });
  assert.ok(requests.every(r => !r.path.includes(g.token)));
  assert.equal(batches, 1); assert.deepEqual(await snapshot(p), committed);
  const second = await grant();
  assert.equal((await worker(p).fetch(request(key, { token: second.token, bytes: new Uint8Array([99]) }), environment([second]))).status, 409);
  assert.deepEqual(await snapshot(p), committed);
});
