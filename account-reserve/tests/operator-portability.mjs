import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { canonical, hash, LIMITS, profile, TEXT_FORMAT } from '../operator/profile.mjs';
import { exportDatabase, importDatabase, initializeDatabase, openStore, validateTransfer } from '../operator/store.mjs';
import { readInvitation, startOperatorHost } from '../operator/host.mjs';
import { runOperatorPortabilityDrill } from '../scripts/operator-portability-drill.mjs';

const future = () => new Date(Date.now() + 86400000).toISOString();
const configuration = () => ({ version: 1, primaryOrigin: 'https://writing.example.org', recoveryOrigin: 'https://reserve.example.org', expiresAt: future(),
  apps: [{ id: 'textarea', label: 'Textarea', appId: 'continuity-textarea-v1' }, { id: 'markdown', label: 'Markdown Studio', appId: 'continuity-markdown-v1' }] });
const opaque = () => Buffer.from(canonical({ format: TEXT_FORMAT, nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(50).toString('base64url') }));
const key = () => randomBytes(32).toString('base64url');
const error = code => caught => caught?.code === code;
async function fixture(t) { const directory = await mkdtemp(join(tmpdir(), 'operator-test-')); t.after(() => rm(directory, { recursive: true, force: true })); return { directory, config: configuration(), database: join(directory, 'reserve.db') }; }

test('profile pins exact HTTPS origins and distinct app key domains', () => {
  const value = configuration(); assert.ok(Object.isFrozen(profile(value))); assert.equal(profile(value).apps.length, 2);
  for (const patch of [{ recoveryOrigin: 'https://reserve.example.org/path' }, { recoveryOrigin: 'http://reserve.example.org' },
    { primaryOrigin: value.recoveryOrigin }, { apps: [value.apps[0], { ...value.apps[1], appId: value.apps[0].appId }] }, { unexpected: true }]) {
    assert.throws(() => profile({ ...value, ...patch }), error('PROFILE_INVALID'));
  }
});
test('durable immutable store consumes capabilities and rejects binding changes', async t => {
  const f = await fixture(t); initializeDatabase(f.database, f.config); let store = openStore(f.database, f.config);
  const token = hash(key()), record = opaque(), loc = key(); store.issue(token);
  assert.equal(store.putIfAbsent(loc, record, token), true); assert.deepEqual(store.get(loc), record);
  assert.throws(() => store.putIfAbsent(key(), opaque(), token), error('ENROLLMENT_DENIED'));
  const conflict = hash(key()); store.issue(conflict); assert.equal(store.putIfAbsent(loc, opaque(), conflict), false);
  assert.throws(() => store.putIfAbsent(key(), opaque(), conflict), error('ENROLLMENT_DENIED'));
  store.close(); store = openStore(f.database, f.config); assert.deepEqual(store.get(loc), record); assert.deepEqual(store.counts(), { records: 1, issued: 2 }); store.close();
  assert.throws(() => openStore(f.database, { ...f.config, recoveryOrigin: 'https://other.example.org' }), error('DATABASE_BINDING_INVALID'));
  assert.throws(() => initializeDatabase(f.database, f.config), caught => caught.code === 'EEXIST');
});
test('live admissions reserve capacity; expiration does not reset lifetime quota', async t => {
  const f = await fixture(t); initializeDatabase(f.database, f.config); let time = Date.now(); const store = openStore(f.database, f.config, { now: () => time }); t.after(() => store.close());
  const first = hash(key()); store.issue(first);
  for (let i = 1; i < LIMITS.maxRecords; i++) store.issue(hash(key()));
  assert.throws(() => store.issue(hash(key())), error('ENROLLMENT_LIMIT'));
  time += LIMITS.capabilityTtlMs + 1;
  assert.throws(() => store.putIfAbsent(key(), opaque(), first), error('ENROLLMENT_DENIED'));
  for (let block = 1; block < 4; block++) { for (let i = 0; i < LIMITS.maxRecords; i++) store.issue(hash(key())); time += LIMITS.capabilityTtlMs + 1; }
  assert.equal(store.counts().issued, LIMITS.maxIssuedCapabilities); assert.throws(() => store.issue(hash(key())), error('ENROLLMENT_LIMIT'));
});
test('transfer retains only opaque records and binding; import is no-clobber and invalidates pending grants', async t => {
  const f = await fixture(t); initializeDatabase(f.database, f.config); const source = openStore(f.database, f.config);
  const used = hash(key()), pending = hash(key()), loc = key(), record = opaque(); source.issue(used); source.putIfAbsent(loc, record, used); source.issue(pending); source.close();
  const file = join(f.directory, 'transfer.json'); exportDatabase(f.database, f.config, file); const bytes = await readFile(file);
  assert.throws(() => exportDatabase(f.database, f.config, file), caught => caught.code === 'EEXIST');
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(bytes.toString().includes(pending), false); assert.equal(bytes.toString().includes(used), false);
  const dest = join(f.directory, 'next.db'); importDatabase(file, f.config, dest); const next = openStore(dest, f.config);
  assert.deepEqual(next.get(loc), record); assert.deepEqual(next.counts(), { records: 1, issued: 2 });
  assert.throws(() => next.putIfAbsent(key(), opaque(), pending), error('ENROLLMENT_DENIED')); next.close();
  const before = hash(await readFile(dest)); assert.throws(() => importDatabase(file, f.config, dest), error('DESTINATION_EXISTS')); assert.equal(hash(await readFile(dest)), before);
  const corrupt = Buffer.from(bytes); corrupt[25] ^= 1; assert.throws(() => validateTransfer(corrupt, f.config));
  assert.throws(() => validateTransfer(bytes, { ...f.config, expiresAt: new Date(Date.parse(f.config.expiresAt) + 1).toISOString() }), error('TRANSFER_INVALID'));
  const bad = JSON.parse(bytes); bad.payload.records[0].bytes = Buffer.from('plain draft').toString('base64url'); bad.sha256 = hash(canonical(bad.payload));
  const badFile = join(f.directory, 'bad.json'), badTarget = join(f.directory, 'bad.db'); await writeFile(badFile, canonical(bad));
  assert.throws(() => importDatabase(badFile, f.config, badTarget), error('RECORD_INVALID')); await assert.rejects(access(badTarget));
});
test('host requires private invitation, exact origin and single-use admission before encrypted writes', async t => {
  const f = await fixture(t); initializeDatabase(f.database, f.config); const invitation = randomBytes(32).toString('hex'), invitationFile = join(f.directory, 'invitation');
  await writeFile(invitationFile, invitation, { mode: 0o600 }); assert.equal(readInvitation(invitationFile), invitation);
  const assets = join(f.directory, 'public'); await mkdir(join(assets, 'apps'), { recursive: true });
  await writeFile(join(assets, 'apps/index.html'), '<!doctype html><title>Operator browser entry</title>');
  const running = await startOperatorHost({ configuration: f.config, database: f.database, invitationFile, assets }); t.after(() => running.close());
  const url = 'http://127.0.0.1:' + running.port;
  const headers = { host: 'reserve.example.org', origin: f.config.recoveryOrigin, 'content-type': 'application/json' };
  const call = (path, options = {}) => new Promise((done, reject) => {
    const req = httpRequest(url + path, { method: options.method ?? 'GET', headers: { ...headers, ...options.headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done(new Response(Buffer.concat(chunks), { status: res.statusCode })));
    }); req.on('error', reject); req.end(options.body);
  });
  assert.equal((await fetch(url + '/api/apps-config')).status, 421);
  const config = await (await call('/api/apps-config')).json(); assert.equal(config.enrollmentRequiresInvitation, true); assert.equal(JSON.stringify(config).includes(invitation), false);
  for (const path of ['/apps/', '/apps/textarea/', '/apps/markdown/']) { const page = await call(path); assert.equal(page.status, 200); assert.match(await page.text(), /Operator browser entry/); }
  assert.equal((await call('/invitation')).status, 404); assert.equal((await call('/apps/unlisted/')).status, 404);
  const denied = await call('/api/enrollment/start', { method: 'POST', body: '{}' }); assert.equal(denied.status, 403);
  const cross = await call('/api/enrollment/start', { method: 'POST', headers: { authorization: 'Bearer ' + invitation, origin: 'https://evil.example.org' }, body: '{}' }); assert.equal(cross.status, 403);
  const issued = await call('/api/enrollment/start', { method: 'POST', headers: { authorization: 'Bearer ' + invitation }, body: '{}' }); assert.equal(issued.status, 201);
  const { enrollmentToken } = await issued.json(), loc = key(), record = opaque();
  const write = { method: 'PUT', headers: { authorization: 'Bearer ' + enrollmentToken }, body: JSON.stringify({ bytes: record.toString('base64url') }) };
  assert.equal((await call('/api/reserve/' + loc, write)).status, 201);
  assert.equal((await call('/api/reserve/' + key(), write)).status, 403);
  assert.equal((await (await call('/api/reserve/' + loc)).json()).bytes, record.toString('base64url'));
  assert.equal((await call('/api/retention/cleanup', { method: 'POST', body: '{}' })).status, 405);
});
test('installed public SDK recovers both apps after original host/store removal', { timeout: 180000 }, async t => {
  const f = await fixture(t), assets = join(f.directory, 'assets'); await mkdir(join(assets, 'apps'), { recursive: true });
  await writeFile(join(assets, 'apps/index.html'), '<!doctype html><title>HTTP test fixture</title>');
  // This suite tests host/package behavior; the public drill uses the real build.
  const report = await runOperatorPortabilityDrill({ assets });
  assert.equal(report.status, 'PASSED'); assert.equal(report.recovered.exactTexts, 2); assert.equal(report.prepared.creates, 1);
  assert.equal(report.changedCiphertextRejected, true); assert.equal(report.originalStoreRemoved, true);
});
