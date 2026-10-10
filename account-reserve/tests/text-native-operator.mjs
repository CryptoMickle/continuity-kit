import test from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, chmod, symlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { issueNativeGrants, runtimeProfile } from '../text-native/operator.mjs';
import { startNativeHost } from '../text-native/native-host.mjs';
import { parseNativeGrants } from '../text-native/profile.mjs';
import { initializeDatabase } from '../text-native/operator-runtime/store.mjs';
import { startOperatorHost } from '../text-native/operator-runtime/host.mjs';
import { startReplicaGateway } from '../text-native/operator-runtime/replica-gateway.mjs';

const record = () => Buffer.from(JSON.stringify({ ciphertext: randomBytes(48).toString('base64url'), format: 'account-continuity/text-reserve-v1/index', nonce: randomBytes(12).toString('base64url') }));
function call(port, origin, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false, signal: AbortSignal.timeout(5000),
      headers: { host: new URL(origin).host, origin, ...headers } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.once('error', reject);
      response.once('end', () => done({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    }); req.once('error', reject); req.end(body);
  });
}
function counts(database) { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare('SELECT issued FROM operator_meta WHERE id=1').get().issued; } finally { db.close(); } }
async function fixture(t, ids = ['alpha', 'beta']) {
  const directory = await mkdtemp(join(tmpdir(), 'native-operator-test-')), hosts = [];
  const profile = { version: 1, appId: 'native-text-test', primaryOrigin: 'https://native-primary.example', recoveryOrigin: 'https://native-reserve.example', recoveryRpId: 'native-reserve.example',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), replicas: ids.map(id => ({ id, basePath: '/api/replicas/' + id + '/reserve' })) };
  t.after(async () => { await Promise.all(hosts.map(host => host.close())); await rm(directory, { recursive: true, force: true }); });
  const entries = [], databases = [];
  for (const id of ids) {
    const invitation = randomBytes(32).toString('hex'), invitationFile = join(directory, id + '.invitation');
    await writeFile(invitationFile, invitation, { mode: 0o600 });
    const database = join(directory, id + '.sqlite'); databases.push(database); initializeDatabase(database, runtimeProfile(profile));
    const host = await startOperatorHost({ configuration: runtimeProfile(profile), database, invitationFile }); hosts.push(host);
    entries.push({ id, invitation, port: host.port });
  }
  const invitationsFile = join(directory, 'invitations.json'); await writeFile(invitationsFile, JSON.stringify({ replicas: entries }), { mode: 0o600 });
  const output = join(directory, 'grants.json');
  async function assets(role, changed = profile) {
    const root = join(directory, role + '-' + randomBytes(4).toString('hex')); await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'continuity-config.json'), JSON.stringify({ profile: changed, role }));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Native</title><script type="module" src="/assets/main-12345678.js"></script>');
    await writeFile(join(root, 'assets/main-12345678.js'), 'export const native=true;');
    await writeFile(join(root, 'private.json'), 'NEVER_SERVE_THIS'); return root;
  }
  return { directory, profile, entries, databases, invitationsFile, output, assets, hosts };
}

test('native issuer creates distinct private bound grants and native hosts forward only reserve operations', async t => {
  const f = await fixture(t, ['alpha', 'beta', 'gamma']);
  const summary = await issueNativeGrants({ profile: f.profile, invitationsFile: f.invitationsFile, output: f.output });
  assert.deepEqual(Object.keys(summary).sort(), ['bundleWritten', 'expiresAt', 'replicas']); assert.equal(summary.bundleWritten, true); assert.equal(summary.replicas, 3);
  const bundle = parseNativeGrants(await readFile(f.output, 'utf8'), f.profile);
  assert.equal((await stat(f.output)).mode & 0o777, 0o600); assert.equal(new Set(bundle.replicas.map(item => item.enrollmentToken)).size, 3);
  assert.deepEqual(f.databases.map(counts), [1, 1, 1]); assert.ok(bundle.replicas.every(item => Date.parse(item.expiresAt) <= Date.now() + 300000));
  assert.doesNotMatch(JSON.stringify(summary), /enrollmentToken|invitation/);
  const gateway = await startReplicaGateway({ configuration: { recoveryOrigin: f.profile.recoveryOrigin, replicas: f.entries.map(({ id, port }) => ({ id, port })) } }); f.hosts.push(gateway);
  const a = await startNativeHost({ profile: f.profile, role: 'primary', assets: await f.assets('primary') }); f.hosts.push(a);
  const b = await startNativeHost({ profile: f.profile, role: 'recovery', assets: await f.assets('recovery'), gatewayPort: gateway.port }); f.hosts.push(b);
  const page = await call(b.port, f.profile.recoveryOrigin, '/'); assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /script-src 'self'/); assert.equal(page.headers['cache-control'], 'no-store');
  const config = await call(b.port, f.profile.recoveryOrigin, '/continuity-config.json'); assert.equal(config.status, 200); assert.deepEqual(JSON.parse(config.text), { profile: f.profile, role: 'recovery' });
  assert.equal((await call(b.port, f.profile.recoveryOrigin, '/assets/main-12345678.js')).status, 200);
  for (const path of ['/private.json', '/operator.mjs', '/assets/main.js', '/api/config', '/api/synthetic', '/api/enrollment/start', '/api/replica-enrollment', '/api/replica-control', '/api/status', '/api/primary']) {
    assert.equal((await call(b.port, f.profile.recoveryOrigin, path)).status, 404, path);
  }
  for (const path of ['/api/synthetic', '/api/replica-control', '/api/enrollment/start']) assert.equal((await call(b.port, f.profile.recoveryOrigin, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  const key = randomBytes(32).toString('base64url'), bytes = record(), path = '/api/replicas/alpha/reserve/' + key;
  const authorization = 'Bearer ' + bundle.replicas[0].enrollmentToken;
  assert.equal((await call(a.port, f.profile.primaryOrigin, path)).status, 404);
  assert.equal((await call(b.port, f.profile.recoveryOrigin, path)).status, 404);
  assert.equal((await call(b.port, f.profile.recoveryOrigin, path, { method: 'PUT', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify({ bytes: bytes.toString('base64url') }) })).status, 201);
  const saved = await call(b.port, f.profile.recoveryOrigin, path); assert.equal(saved.status, 200); assert.deepEqual(Buffer.from(JSON.parse(saved.text).bytes, 'base64url'), bytes);
  assert.equal((await call(b.port, f.profile.recoveryOrigin, path, { method: 'PUT', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify({ bytes: bytes.toString('base64url') }) })).status, 403);
  assert.equal((await call(b.port, f.profile.recoveryOrigin, '/api/replicas/beta/reserve/' + key, { method: 'PUT', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify({ bytes: bytes.toString('base64url') }) })).status, 403, 'capabilities are store-specific');
  const before = await readFile(f.output);
  await assert.rejects(issueNativeGrants({ profile: f.profile, invitationsFile: f.invitationsFile, output: f.output }), error => error.code === 'OUTPUT_EXISTS' && error.issuedMayExist === false);
  assert.deepEqual(await readFile(f.output), before); assert.deepEqual(f.databases.map(counts), [1, 1, 1]);
});

test('issuer validates private paths, profile bindings and invitations before consuming quota', async t => {
  const f = await fixture(t);
  await chmod(f.invitationsFile, 0o644);
  await assert.rejects(issueNativeGrants({ profile: f.profile, invitationsFile: f.invitationsFile, output: f.output }), { code: 'INVITATIONS_INVALID' });
  await chmod(f.invitationsFile, 0o600);
  const alias = join(f.directory, 'alias.json'); await symlink(f.invitationsFile, alias);
  await assert.rejects(issueNativeGrants({ profile: f.profile, invitationsFile: alias, output: f.output }), { code: 'INVITATIONS_INVALID' });
  const publicDir = join(f.directory, 'public'); await mkdir(publicDir, { mode: 0o755 }); await chmod(publicDir, 0o755);
  await assert.rejects(issueNativeGrants({ profile: f.profile, invitationsFile: f.invitationsFile, output: join(publicDir, 'grants.json') }), { code: 'OUTPUT_NOT_PRIVATE' });
  await assert.rejects(issueNativeGrants({ profile: f.profile, invitationsFile: f.invitationsFile, output: join(f.directory, 'continuity-config.json') }), { code: 'OUTPUT_INVALID' });
  const existing = join(f.directory, 'existing.json'); await symlink(join(f.directory, 'missing-target'), existing);
  await assert.rejects(issueNativeGrants({ profile: f.profile, invitationsFile: f.invitationsFile, output: existing }), { code: 'OUTPUT_EXISTS' });
  await assert.rejects(issueNativeGrants({ profile: { ...f.profile, appId: 'different-app' }, invitationsFile: f.invitationsFile, output: f.output }), error => error.code === 'OPERATOR_PROFILE_MISMATCH' && error.issuedMayExist === false);
  await assert.rejects(issueNativeGrants({ profile: { ...f.profile, expiresAt: new Date(Date.now() - 1000).toISOString() }, invitationsFile: f.invitationsFile, output: f.output }), { code: 'NATIVE_PROFILE_EXPIRED' });
  const reversed = join(f.directory, 'reversed.json'); await writeFile(reversed, JSON.stringify({ replicas: [...f.entries].reverse() }), { mode: 0o600 });
  await assert.rejects(issueNativeGrants({ profile: f.profile, invitationsFile: reversed, output: f.output }), { code: 'INVITATIONS_INVALID' });
  assert.deepEqual(f.databases.map(counts), [0, 0]); await assert.rejects(access(f.output));
});

test('partial admission is reported conservatively and never retried or published as a complete bundle', async t => {
  const f = await fixture(t), wrong = f.entries.map(item => ({ ...item })); wrong[1].invitation = randomBytes(32).toString('hex');
  await writeFile(f.invitationsFile, JSON.stringify({ replicas: wrong }), { mode: 0o600 });
  await assert.rejects(issueNativeGrants({ profile: f.profile, invitationsFile: f.invitationsFile, output: f.output }), error => {
    assert.equal(error.code, 'GRANT_ISSUANCE_UNCONFIRMED'); assert.equal(error.issuedMayExist, true);
    for (const item of wrong) assert.equal(String(error).includes(item.invitation), false); return true;
  });
  assert.deepEqual(f.databases.map(counts), [1, 0]); await assert.rejects(access(f.output));
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.native-grants-')), false);
});

test('native host rejects mismatched builds, foreign origins, oversized bodies and unexpected routes', async t => {
  const f = await fixture(t);
  const changed = { ...f.profile, appId: 'other-app' };
  await assert.rejects(startNativeHost({ profile: f.profile, role: 'primary', assets: await f.assets('primary', changed) }), { code: 'BUILD_PROFILE_MISMATCH' });
  const gateway = await startReplicaGateway({ configuration: { recoveryOrigin: f.profile.recoveryOrigin, replicas: f.entries.map(({ id, port }) => ({ id, port })) } }); f.hosts.push(gateway);
  const b = await startNativeHost({ profile: f.profile, role: 'recovery', assets: await f.assets('recovery'), gatewayPort: gateway.port }); f.hosts.push(b);
  const path = '/api/replicas/alpha/reserve/' + randomBytes(32).toString('base64url');
  assert.equal((await call(b.port, f.profile.recoveryOrigin, '/', { headers: { host: 'wrong.example' } })).status, 421);
  for (const origin of [f.profile.primaryOrigin, 'https://evil.example', 'null']) assert.equal((await call(b.port, f.profile.recoveryOrigin, path, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await call(b.port, f.profile.recoveryOrigin, path, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + randomBytes(32).toString('base64url'), 'content-length': '87441' } })).status, 400);
  assert.equal((await call(b.port, f.profile.recoveryOrigin, path, { method: 'DELETE' })).status, 405);
  for (const route of ['/x/../continuity-config.json', '/%2e%2e/private.json', '/continuity-config.json?target=other', '//api/config']) assert.equal((await call(b.port, f.profile.recoveryOrigin, route)).status, 400);
  assert.equal((await call(b.port, f.profile.recoveryOrigin, '/api/replicas/arbitrary/reserve/' + randomBytes(32).toString('base64url'))).status, 404);
  await b.close(); await b.close();
});

test('issuer refuses redirects before admission and no upstream body or bearer enters the error', async t => {
  const f = await fixture(t), trap = createServer((req, res) => { res.writeHead(302, { 'content-type': 'application/json', location: 'https://never-follow.example' }); res.end(JSON.stringify({ secret: f.entries[0].invitation })); });
  await new Promise(done => trap.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => trap.close(done)));
  const entries = f.entries.map((item, index) => index === 0 ? { ...item, port: trap.address().port } : item);
  await writeFile(f.invitationsFile, JSON.stringify({ replicas: entries }), { mode: 0o600 });
  await assert.rejects(issueNativeGrants({ profile: f.profile, invitationsFile: f.invitationsFile, output: f.output }), error => error.code === 'UPSTREAM_RESPONSE_INVALID' && error.issuedMayExist === false && !String(error).includes(entries[0].invitation));
  assert.deepEqual(f.databases.map(counts), [0, 0]);
});
