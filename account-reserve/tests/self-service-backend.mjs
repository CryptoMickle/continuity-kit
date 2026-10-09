import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { createSelfServiceHostedClient } from '../self-service/backend/host.mjs';
import { createSelfServiceStore } from '../self-service/backend/store.mjs';
import { LIMITS, SELF_SERVICE_SCHEMA, selfServiceConfig, validateSelfServiceProfile } from '../self-service/backend/profile.mjs';
import { base64url, enrollmentTicketHash } from '../release/profile.mjs';
import { createReserveHttpStore } from '../sdk/http-store.mjs';
import { prepareWorkReserve, recoverWorkReserve, WORK_SCHEMA } from '../sdk/work-reserve.mjs';
import { makeSdkFixture } from './sdk-fixture.mjs';

const primaryOrigin = 'https://judge-primary.example.invalid', recoveryOrigin = 'https://judge-recovery.example.invalid';
const token = () => base64url(randomBytes(32));
const hash = () => randomBytes(32).toString('hex');
const profile = (offset = 600000) => ({ version: 1, enabled: true, releaseId: randomBytes(16).toString('hex'), primaryOrigin, recoveryOrigin, expiresAt: new Date(Date.now() + offset).toISOString() });
const namespace = p => `continuity-judge:v1:${p.releaseId}`;
const worker = (p, role = 'recovery', options) => createSelfServiceHostedClient({ profile: p, role, assets: { '/index.html': { base64: Buffer.from('fictional judge demo').toString('base64'), contentType: 'text/html' } } }, options);
const store = (p, db) => createSelfServiceStore({ db, profile: validateSelfServiceProfile(p) });
const enroll = (changes = {}) => new Request(recoveryOrigin + '/api/enrollment/start' + (changes.suffix ?? ''), {
  method: changes.method ?? 'POST', headers: { origin: recoveryOrigin, 'content-type': 'application/json', ...(changes.headers ?? {}) }, ...(changes.method === 'GET' ? {} : { body: changes.body ?? '{}' }),
});
const put = (locator, capability, options = {}) => new Request(options.url ?? recoveryOrigin + '/api/reserve/' + locator, {
  method: 'PUT', headers: { origin: recoveryOrigin, 'content-type': 'application/json', authorization: 'Bearer ' + capability, ...(options.headers ?? {}) },
  body: options.body ?? JSON.stringify({ bytes: base64url(options.bytes ?? new Uint8Array([1, 2, 3])) }), ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {}),
});
const get = locator => new Request(recoveryOrigin + '/api/reserve/' + locator);
let mf, sequence = 0;
async function database() {
  const db = await mf.getD1Database('DB' + sequence++);
  const sql = await readFile(new URL('../self-service/backend/schema.sql', import.meta.url), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint').map(x => x.trim()).filter(Boolean)) await db.prepare(statement).run();
  return db;
}
async function snapshot(db) {
  return Object.fromEntries(await Promise.all(['ss_release', 'ss_records', 'ss_capabilities'].map(async table => [table, (await db.prepare(`SELECT * FROM ${table}`).all()).results])));
}
before(async () => {
  mf = new Miniflare({ modules: true, host: '127.0.0.1', script: 'export default {fetch(){return new Response("local D1 fixture")}}', compatibilityDate: '2026-07-30', d1Databases: Array.from({ length: 30 }, (_, n) => 'DB' + n) });
});
after(async () => { await mf?.dispose(); });

test('test schema is byte-identical to the generated Sites migration with isolated metadata', async () => {
  const base = new URL('../self-service/backend/', import.meta.url);
  assert.equal(await readFile(new URL('schema.sql', base), 'utf8'), await readFile(new URL('drizzle/0000_self_service_judge.sql', base), 'utf8'));
  const journal = JSON.parse(await readFile(new URL('drizzle/meta/_journal.json', base), 'utf8'));
  assert.equal(journal.dialect, 'sqlite'); assert.equal(journal.entries.length, 1); assert.equal(journal.entries[0].tag, '0000_self_service_judge');
  const metadata = JSON.parse(await readFile(new URL('drizzle/meta/0000_snapshot.json', base), 'utf8'));
  assert.deepEqual(Object.keys(metadata.tables).sort(), ['ss_capabilities', 'ss_records', 'ss_release']);
});

test('public issuance stores only a random capability hash, pins the release and reserves a slot', async () => {
  const db = await database(), p = profile(), w = worker(p);
  const response = await w.fetch(enroll(), { DB: db });
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json(); assert.match(value.enrollmentToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(value).sort(), ['enrollmentToken', 'expiresAt', 'serverNow']);
  assert.equal(new Date(value.serverNow).toISOString(), value.serverNow);
  assert.ok(Date.parse(value.expiresAt) - Date.parse(value.serverNow) > 0 && Date.parse(value.expiresAt) - Date.parse(value.serverNow) <= LIMITS.capabilityTtlMs);
  assert.ok(Date.parse(value.expiresAt) > Date.now() && Date.parse(value.expiresAt) <= Date.now() + LIMITS.capabilityTtlMs);
  const saved = await snapshot(db); assert.equal(saved.ss_records.length, 0); assert.equal(saved.ss_capabilities.length, 1);
  assert.equal(saved.ss_capabilities[0].capability_hash, await enrollmentTicketHash(value.enrollmentToken));
  assert.equal(JSON.stringify(saved).includes(value.enrollmentToken), false);
  assert.equal(saved.ss_release[0].namespace, namespace(p)); assert.equal(saved.ss_release[0].schema, SELF_SERVICE_SCHEMA);
});

test('admission timestamps use the D1 clock even when the injected host clock is two minutes behind', async () => {
  const db = await database(), p = profile(), before = Date.now();
  const w = worker(p, 'recovery', { now: () => Date.now() - 120000 });
  const response = await w.fetch(enroll(), { DB: db }); assert.equal(response.status, 201);
  const value = await response.json(), serverNow = Date.parse(value.serverNow), expiry = Date.parse(value.expiresAt);
  assert.ok(serverNow >= before - 1000 && serverNow <= Date.now() + 1000, 'server time follows actual database time, not the stale application clock');
  assert.ok(serverNow - (Date.now() - 120000) >= 119000);
  assert.ok(expiry - serverNow > 0 && expiry - serverNow <= LIMITS.capabilityTtlMs);
  assert.equal((await snapshot(db)).ss_capabilities[0].expires_ms, expiry);
});

test('near release expiry, database-clock admission duration is clamped to the fixed deadline', async () => {
  const db = await database(), p = profile(5000), response = await worker(p).fetch(enroll(), { DB: db });
  assert.equal(response.status, 201); const value = await response.json();
  assert.equal(value.expiresAt, p.expiresAt);
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.serverNow);
  assert.ok(lifetime > 0 && lifetime <= 5000);
  assert.deepEqual(Object.keys(value).sort(), ['enrollmentToken', 'expiresAt', 'serverNow']);
});

test('unsafe or incoherent database clock metadata yields unknown once without retrying issuance', async () => {
  for (const bad of [undefined, '1791568800000', Number.NaN, 1.5, -1, Number.MAX_SAFE_INTEGER]) {
    const db = await database(), p = profile(); let batches = 0;
    const corrupted = { prepare: sql => db.prepare(sql), batch: async statements => {
      batches++; const result = await db.batch(statements); result[2].results[0].server_now_ms = bad; return result;
    } };
    const response = await worker(p).fetch(enroll(), { DB: corrupted });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'ENROLLMENT_ISSUE_UNKNOWN' });
    assert.equal(batches, 1); assert.equal((await snapshot(db)).ss_capabilities.length, 1);
  }
});

test('D1 atomic admission reserves at most 64 live record slots even across concurrent issuers', async () => {
  const db = await database(), p = profile(), s = store(p, db), hashes = Array.from({ length: 80 }, hash);
  const issued = await Promise.all(hashes.map(h => s.issue(h)));
  assert.equal(issued.filter(v => v.state === 'issued').length, 64); assert.equal(issued.filter(v => v.state === 'limit').length, 16);
  assert.equal((await snapshot(db)).ss_capabilities.length, 64);
  const accepted = hashes.filter((_, i) => issued[i].state === 'issued');
  const results = await Promise.all(accepted.map(h => s.putIfAbsent(token(), new Uint8Array([8]), h)));
  assert.ok(results.every(v => v === 'created')); assert.equal((await snapshot(db)).ss_records.length, 64);
  assert.equal((await s.issue(hash())).state, 'limit');
});

test('expired unused reservations free active capacity but never reset the 256 issuance lifetime cap', async () => {
  const db = await database(), p = profile(), s = store(p, db); let expiredHash;
  for (let batch = 0; batch < 4; batch++) {
    const hashes = Array.from({ length: 64 }, hash); expiredHash = hashes[0];
    const results = await Promise.all(hashes.map(h => s.issue(h))); assert.ok(results.every(v => v.state === 'issued'));
    assert.equal((await s.issue(hash())).state, 'limit');
    await db.prepare('UPDATE ss_capabilities SET expires_ms=?').bind(Date.now() - 1000).run();
  }
  assert.equal((await snapshot(db)).ss_capabilities.length, 256); assert.equal((await s.issue(hash())).state, 'limit');
  assert.equal(await s.putIfAbsent(token(), new Uint8Array([1]), expiredHash), 'denied');
});

test('conversion of a reservation into a record does not free capacity; expired pending slots do', async () => {
  const db = await database(), p = profile(), s = store(p, db), hashes = Array.from({ length: 64 }, hash);
  await Promise.all(hashes.map(h => s.issue(h)));
  await s.putIfAbsent(token(), new Uint8Array([1]), hashes[0]);
  assert.equal((await s.issue(hash())).state, 'limit');
  await db.prepare('UPDATE ss_capabilities SET expires_ms=? WHERE capability_hash=?').bind(Date.now() - 1000, hashes[1]).run();
  assert.equal((await s.issue(hash())).state, 'issued'); assert.equal((await s.issue(hash())).state, 'limit');
  assert.equal(await s.putIfAbsent(token(), new Uint8Array([2]), hashes[1]), 'denied');
});

test('single-use redemption and immutable records survive concurrent calls and locator collisions', async () => {
  const db = await database(), p = profile(), s = store(p, db), h = hash(), key = token(); await s.issue(h);
  const results = await Promise.all(Array.from({ length: 10 }, () => s.putIfAbsent(key, new Uint8Array([1]), h)));
  assert.equal(results.filter(v => v === 'created').length, 1); assert.equal(results.filter(v => v === 'conflict').length, 9);
  assert.equal(await s.putIfAbsent(token(), new Uint8Array([2]), h), 'consumed');
  const second = hash(); await s.issue(second); assert.equal(await s.putIfAbsent(key, new Uint8Array([9]), second), 'conflict');
  assert.deepEqual(await s.get(key), new Uint8Array([1]));
  assert.equal(await s.putIfAbsent(token(), new Uint8Array([2]), second), 'created');
});

test('singleton DB refuses a second namespace or changed expiry and never reads old release tables', async () => {
  const db = await database(), p = profile(), s = store(p, db), h = hash(), key = token(); await s.issue(h); await s.putIfAbsent(key, new Uint8Array([1]), h);
  for (const other of [profile(), { ...p, expiresAt: new Date(Date.parse(p.expiresAt) + 1000).toISOString() }]) {
    await assert.rejects(store(other, db).issue(hash()), /ENROLLMENT_ISSUE_UNKNOWN/);
    await assert.rejects(store(other, db).get(key), /STORE_UNAVAILABLE/);
  }
  await db.prepare('CREATE TABLE work_records(locator TEXT, ciphertext TEXT)').run();
  const oldLocator = token(); await db.prepare('INSERT INTO work_records VALUES (?,?)').bind(oldLocator, 'AQ').run();
  assert.equal(await s.get(oldLocator), undefined);
  assert.equal((await snapshot(db)).ss_records.length, 1);
});

test('D1 clock rejects expired capabilities and releases even when the worker clock is stale', async () => {
  const db = await database(), p = profile(-1000), key = token(), h = hash();
  await db.prepare('INSERT INTO ss_release(id,namespace,schema,expires_ms) VALUES (1,?,?,?)').bind(namespace(p), SELF_SERVICE_SCHEMA, Date.parse(p.expiresAt)).run();
  await db.prepare('INSERT INTO ss_capabilities(namespace,capability_hash,expires_ms) VALUES (?,?,?)').bind(namespace(p), h, Date.now() + 60000).run();
  await db.prepare('INSERT INTO ss_records(namespace,locator,capability_hash,ciphertext) VALUES (?,?,?,?)').bind(namespace(p), key, h, 'AQ').run();
  const s = store(p, db); assert.equal((await s.issue(hash())).state, 'expired'); await assert.rejects(s.get(key), /RELEASE_EXPIRED/);
  assert.equal(await s.putIfAbsent(token(), new Uint8Array([1]), h), 'expired');
  const w = worker(p, 'recovery', { now: () => Date.parse(p.expiresAt) - 1000 });
  assert.equal((await w.fetch(get(key), { DB: db })).status, 410);
  assert.equal((await w.fetch(enroll(), { DB: db })).status, 410);
});

test('origin, route, method and framing rejects happen before D1 access', async () => {
  const p = profile(); let touched = 0;
  const db = { prepare() { touched++; throw Error('UNEXPECTED'); }, batch() { touched++; throw Error('UNEXPECTED'); } };
  const cases = [
    [enroll({ headers: { origin: primaryOrigin } }), 403], [enroll({ headers: { origin: 'null' } }), 403],
    [enroll({ headers: { 'sec-fetch-site': 'cross-site' } }), 403], [enroll({ headers: { 'content-type': 'text/plain' } }), 403],
    [enroll({ headers: { 'content-encoding': 'gzip' } }), 403], [enroll({ suffix: '?budget=999' }), 403],
    [enroll({ headers: { authorization: 'Bearer ' + token() } }), 403], [enroll({ method: 'GET' }), 405],
    [enroll({ body: '{ }' }), 400], [enroll({ body: '{"x":1}' }), 400],
    [put(token(), token(), { headers: { origin: primaryOrigin } }), 403],
    [put(token(), token(), { headers: { authorization: 'Basic bad' } }), 403],
    [put(token(), token(), { url: recoveryOrigin + '/api/reserve/' + token() + '?x=1' }), 404],
    [put('A'.repeat(42) + 'B', token()), 404],
  ];
  for (const [request, status] of cases) assert.equal((await worker(p).fetch(request, { DB: db })).status, status);
  const missingOrigin = enroll(); missingOrigin.headers.delete('origin'); assert.equal((await worker(p).fetch(missingOrigin, { DB: db })).status, 403);
  assert.equal(touched, 0);
  const primary = worker(p, 'primary');
  for (const path of ['/api/enrollment/start', '/api/reserve/' + token(), '/api/retention/cleanup', '/api/primary/offline', '/rpc', '/control']) assert.equal((await primary.fetch(new Request(primaryOrigin + path), { DB: db })).status, 404);
  assert.equal((await primary.fetch(new Request(primaryOrigin + '/'), { WORK_RESERVE_PRIMARY_OFFLINE: 'true' })).status, 200);
  assert.equal(touched, 0);
});

test('canonical 64 KiB records only; malformed, oversized and stalled bodies never enter D1', async () => {
  const db = await database(), p = profile(), w = worker(p, 'recovery', { bodyTimeoutMs: 20 });
  const cap = (await (await w.fetch(enroll(), { DB: db })).json()).enrollmentToken, key = token(); let touched = 0;
  const tracked = { prepare(sql) { touched++; return db.prepare(sql); }, batch: statements => db.batch(statements) };
  for (const body of ['{"bytes":"AA","bytes":"AQ"}', '{"bytes":"AA","owner":"hidden"}', '{ "bytes": "AA" }', '{"bytes":"AB"}', '{"bytes":"AA=="}', '{"bytes":""}', '[]', new Uint8Array([255]), JSON.stringify({ bytes: base64url(new Uint8Array(65537)) })]) {
    assert.equal((await w.fetch(put(key, cap, { body }), { DB: tracked })).status, 400);
  }
  let cancelled = false;
  const stalled = new ReadableStream({ cancel() { cancelled = true; } });
  assert.equal((await w.fetch(put(key, cap, { body: stalled }), { DB: tracked })).status, 400); assert.equal(cancelled, true);
  assert.equal((await w.fetch(put(key, cap, { headers: { 'content-length': '87401' } }), { DB: tracked })).status, 400);
  assert.equal(touched, 0);
  const maximum = new Uint8Array(65536).fill(71); assert.equal((await w.fetch(put(key, cap, { bytes: maximum }), { DB: db })).status, 201);
  assert.deepEqual(await (await w.fetch(get(key), { DB: db })).json(), { bytes: base64url(maximum) });
});

test('admission throttle is bounded, ignores forwarded identity headers and never persists addresses', async () => {
  const db = await database(), p = profile(), w = worker(p);
  for (let i = 0; i < 3; i++) assert.equal((await w.fetch(enroll({ headers: { 'x-forwarded-for': '192.0.2.' + i } }), { DB: db })).status, 201);
  assert.equal((await w.fetch(enroll({ headers: { 'x-forwarded-for': '192.0.2.88' } }), { DB: db })).status, 429);
  assert.equal(JSON.stringify(await snapshot(db)).includes('192.0.2'), false);
});

test('failed transactions rollback; uncertain issuance and record writes are never retried', async () => {
  const db = await database(), p = profile(); let issues = 0;
  const lostIssue = { prepare: sql => db.prepare(sql), batch: async statements => { issues++; await db.batch(statements); throw Error('PRIVATE_PROVIDER_DETAIL'); } };
  const response = await worker(p).fetch(enroll(), { DB: lostIssue }); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'ENROLLMENT_ISSUE_UNKNOWN' }); assert.equal(issues, 1);
  assert.equal((await snapshot(db)).ss_capabilities.length, 1);
  const cap = token(), h = await enrollmentTicketHash(cap), key = token(); await store(p, db).issue(h);
  let writes = 0;
  const lostWrite = { prepare: sql => db.prepare(sql), batch: async statements => { writes++; await db.batch(statements); throw Error('PRIVATE_PROVIDER_DETAIL'); } };
  const requests = [], target = worker(p);
  const browser = (binding) => async (path, init = {}) => {
    const headers = new Headers(init.headers); if (init.method === 'PUT') headers.set('origin', recoveryOrigin);
    requests.push({ method: init.method ?? 'GET', authorization: headers.get('authorization') });
    return target.fetch(new Request(new URL(path, recoveryOrigin), { ...init, headers }), { DB: binding });
  };
  const client = createReserveHttpStore({ enrollmentToken: cap, fetcher: browser(lostWrite) });
  await assert.rejects(client.putIfAbsent(key, new Uint8Array([8])), /STORE_WRITE_UNKNOWN/);
  await assert.rejects(client.putIfAbsent(key, new Uint8Array([8])), /ENROLLMENT_DENIED/); assert.equal(writes, 1);
  assert.deepEqual(await createReserveHttpStore({ fetcher: browser(db) }).get(key), new Uint8Array([8]));
  assert.equal(requests.at(-1).authorization, null);
  const failedDb = await database(), failedProfile = profile();
  const broken = { prepare: sql => failedDb.prepare(sql), batch: statements => failedDb.batch([...statements, failedDb.prepare('INSERT INTO missing_table VALUES (1)')]) };
  await assert.rejects(store(failedProfile, broken).issue(hash())); assert.deepEqual(await snapshot(failedDb), { ss_release: [], ss_records: [], ss_capabilities: [] });
});

test('operation timeout reports unknown once even if the transaction commits afterward', async () => {
  const db = await database(), p = profile(); let commits = 0, finish;
  const delayed = { prepare: sql => db.prepare(sql), batch: async statements => { commits++; await new Promise(resolve => { finish = resolve; }); return db.batch(statements); } };
  const w = worker(p, 'recovery', { operationTimeoutMs: 10 });
  const response = await w.fetch(enroll(), { DB: delayed }); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'ENROLLMENT_ISSUE_UNKNOWN' });
  finish(); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(commits, 1); assert.equal((await snapshot(db)).ss_capabilities.length, 1);
});

test('retention uses a new maintenance secret, removes expired own state only and cannot erase live data', async () => {
  const db = await database(), p = profile(), s = store(p, db), h = hash(); await s.issue(h); await s.putIfAbsent(token(), new Uint8Array([1]), h);
  const secret = randomBytes(32).toString('hex'), authHash = createHash('sha256').update(secret).digest('hex');
  const cleanup = (authorization = 'Bearer ' + secret) => new Request(recoveryOrigin + '/api/retention/cleanup', { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: '{}' });
  const env = { DB: db, SELF_SERVICE_RETENTION_AUTH_HASH: authHash }, w = worker(p);
  assert.equal((await w.fetch(cleanup(), env)).status, 409); assert.equal((await snapshot(db)).ss_records.length, 1);
  assert.equal((await w.fetch(cleanup('Bearer ' + '0'.repeat(64)), env)).status, 403);
  assert.equal((await w.fetch(cleanup(), { DB: db, WORK_RETENTION_AUTH_HASH: authHash })).status, 403);
  const expired = { ...p, expiresAt: new Date(Date.now() - 1000).toISOString() };
  await db.prepare('UPDATE ss_release SET expires_ms=?').bind(Date.parse(expired.expiresAt)).run();
  await db.prepare('CREATE TABLE work_records(value TEXT)').run(); await db.prepare("INSERT INTO work_records VALUES ('old untouched')").run();
  const ew = worker(expired), result = await ew.fetch(cleanup(), env); assert.equal(result.status, 200);
  const value = await result.json(); assert.equal(value.activeRecordsDeleted, true); assert.equal(value.remaining, 0); assert.equal(value.remainingCapabilities, 0);
  assert.equal((await ew.fetch(cleanup(), env)).status, 200); assert.equal((await db.prepare('SELECT value FROM work_records').first()).value, 'old untouched');
  assert.equal((await ew.fetch(enroll(), env)).status, 410);
});

test('SDK encrypts and independently verifies fictional work, then recovers by locator with no enrollment auth', async () => {
  const db = await database(), p = profile(), w = worker(p), fixture = makeSdkFixture({ config: selfServiceConfig(p) }), requests = [];
  const issued = await (await w.fetch(enroll(), { DB: db })).json();
  const browser = async (path, init = {}) => {
    const headers = new Headers(init.headers); if (init.method === 'PUT') headers.set('origin', recoveryOrigin);
    requests.push({ method: init.method ?? 'GET', authorization: headers.get('authorization') });
    return w.fetch(new Request(new URL(path, recoveryOrigin), { ...init, headers }), { DB: db });
  };
  const work = { schema: WORK_SCHEMA, title: 'Fictional judge draft', client: 'Example client', brief: 'PRIVATE_FICTIONAL_BRIEF', deliverable: 'Unfinished example text', nextStep: 'Finish and export' }; let recovered;
  try {
    const preparing = createReserveHttpStore({ enrollmentToken: issued.enrollmentToken, fetcher: browser });
    const ready = await fixture.prepare({ work, store: preparing }, prepareWorkReserve); assert.equal(ready.independentlyVerified, true);
    const saved = await snapshot(db), encoded = JSON.stringify(saved);
    for (const hidden of [work.title, work.brief, issued.enrollmentToken, fixture.policy.expectedOwner, fixture.b.credentialId]) assert.equal(encoded.includes(hidden), false);
    fixture.closeOriginal(); preparing.clearEnrollmentCapability(); const requestCount = requests.length;
    recovered = await recoverWorkReserve({ config: selfServiceConfig(p), store: createReserveHttpStore({ fetcher: browser }), webAuthnClient: fixture.newRecoveryClient() });
    assert.deepEqual(recovered.work, work); assert.equal(recovered.owner, ready.owner); assert.equal(recovered.workDigest, ready.workDigest); assert.equal('account' in recovered, false);
    assert.ok(requests.slice(requestCount).every(r => r.method === 'GET' && r.authorization === null)); assert.deepEqual(await snapshot(db), saved);
  } finally { recovered?.close(); fixture.cleanup(); }
});

test('public config declares the fixed fictional demo contract, with no operator enrollment code', async () => {
  const db = await database(), p = profile(), response = await worker(p).fetch(new Request(recoveryOrigin + '/api/config'), { DB: db });
  assert.equal(response.status, 200); const config = await response.json();
  assert.deepEqual(config.limits, LIMITS); assert.equal(config.selfService, true); assert.equal(config.fictionalOnly, true); assert.equal(config.config.appId, 'continuity-judge-work-v1');
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  assert.equal((await worker(p).fetch(new Request(recoveryOrigin + '/api/enrollment/check'), { DB: db })).status, 404);
});
