import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { verifyMessage } from 'viem';
import { createHostedWorkClient, CHECK_ENROLLMENT_SCRIPT } from '../work-release/host-worker.mjs';
import { workReserveConfig } from '../work-release/profile.mjs';
import { createReleaseStore } from '../release/redis-store.mjs';
import { createReserveHttpStore } from '../release/browser-store.mjs';
import { base64url, enrollmentTicketHash, releaseProfile } from '../release/profile.mjs';
import { prepareWorkReserve, WORK_SCHEMA } from '../sdk/work-reserve.mjs';
import { makeSdkFixture } from './sdk-fixture.mjs';

const run = promisify(execFile);
const a = 'https://work-primary.example.invalid', b = 'https://work-reserve.example.invalid';
const endpoint = 'https://redis.example.invalid', providerToken = 'synthetic-runtime-token-not-a-real-credential';
const assets = { '/index.html': { base64: Buffer.from('<html>Local integration fixture</html>').toString('base64'), contentType: 'text/html' } };
const locator = () => base64url(randomBytes(32));
const profile = () => ({ version: 1, enabled: true, releaseId: randomBytes(16).toString('hex'), primaryOrigin: a, recoveryOrigin: b, expiresAt: new Date(Date.now() + 60000).toISOString() });
const storeProfile = p => releaseProfile({ version: 1, enabled: true, releaseId: p.releaseId, recoveryOrigin: p.recoveryOrigin, expiresAt: p.expiresAt }, [p.recoveryOrigin]);
const namespace = p => `accountreserve:v1:${p.releaseId}`;
const worker = (role, p) => createHostedWorkClient({ role, profile: p, assets, redisOrigin: endpoint });
const envFor = grants => ({ RESERVE_REDIS_REST_URL: endpoint, RESERVE_REDIS_REST_TOKEN: providerToken, RESERVE_ENROLLMENT_TICKET_HASHES: JSON.stringify(grants.map(value => value.configured ?? value)) });
async function grant() { const token = locator(); return { token, configured: { hash: await enrollmentTicketHash(token), locator: '*' } }; }
const checkRequest = token => new Request(b + '/api/enrollment/check', { method: 'POST', headers: { origin: b, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
const putRequest = (key, token, bytes = new Uint8Array([1, 2, 3])) => new Request(b + '/api/reserve/' + key, { method: 'PUT', headers: { origin: b, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ bytes: base64url(bytes) }) });

// Disposable Unix socket, no TCP listener or cloud Redis. redis-cli only handles
// RESP serialization; redis-server evaluates the production scripts unchanged.
async function realRedis(binary) {
  // Preserve the existing verifier sandbox's narrow Unix-socket allowlist.
  const directory = await mkdtemp('/private/tmp/account-reserve-store-work-'), socket = join(directory, 'redis.sock');
  const child = spawn(binary, ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no', '--dir', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Disposable Redis startup timeout')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Disposable Redis exited ${code}: ${output}`)); });
      const receive = chunk => { output += chunk.toString(); if (output.toLowerCase().includes('ready to accept connections')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', receive); child.stderr.on('data', receive);
    });
  } catch (error) { child.kill('SIGTERM'); await stopped; await rm(directory, { recursive: true, force: true }); throw error; }
  const command = async args => {
    const { stdout } = await run(join(dirname(binary), 'redis-cli'), ['-s', socket, '--json', ...args.map(String)], { maxBuffer: 262144, timeout: 5000 });
    if (stdout.startsWith('error:')) throw new Error('DISPOSABLE_REDIS_COMMAND_FAILED');
    return JSON.parse(stdout);
  };
  return { command, async close() { child.kill('SIGTERM'); await stopped; await rm(directory, { recursive: true, force: true }); } };
}
async function snapshot(redis, key) {
  return { contents: await redis.command(['HGETALL', key]), expiresAt: await redis.command(['PEXPIRETIME', key]) };
}

const binary = process.env.ACCOUNT_RESERVE_REDIS_BIN;
test('real Redis hosted-work boundary and private-work recovery', { skip: !binary && 'Set ACCOUNT_RESERVE_REDIS_BIN to a local redis-server binary; no Redis binary is bundled.' }, async t => {
  const redis = await realRedis(binary); t.after(() => redis.close());
  const providerRequests = [];
  // Every apparent HTTPS call is intercepted. No fallback delegates to the
  // network; only the fixed synthetic provider is accepted by this adapter.
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, endpoint); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, `Bearer ${providerToken}`);
    const args = JSON.parse(init.body); providerRequests.push(args);
    const result = await redis.command(args);
    return new Response(JSON.stringify({ result }));
  });

  await t.test('checking an unused code creates no namespace, data, ticket or TTL', async () => {
    const p = profile(), g = await grant(), env = envFor([g]), wb = worker('recovery', p);
    const before = await redis.command(['DBSIZE']);
    for (let i = 0; i < 2; i++) {
      const response = await wb.fetch(checkRequest(g.token), env);
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ready: true, expiresAt: p.expiresAt });
      assert.equal(await redis.command(['EXISTS', namespace(p)]), 0);
      assert.equal(await redis.command(['PTTL', namespace(p)]), -2);
    }
    assert.equal(await redis.command(['DBSIZE']), before);
    assert.ok(providerRequests.slice(-2).every(args => args[1] === CHECK_ENROLLMENT_SCRIPT));
  });

  await t.test('ready and consumed checks preserve existing hash bytes and absolute expiry', async () => {
    const p = profile(), used = await grant(), unused = await grant(), env = envFor([used, unused]), wb = worker('recovery', p), key = locator();
    assert.equal((await wb.fetch(putRequest(key, used.token), env)).status, 201);
    const before = await snapshot(redis, namespace(p));
    assert.equal(before.expiresAt, Date.parse(p.expiresAt));
    assert.equal((await wb.fetch(checkRequest(unused.token), env)).status, 200);
    assert.deepEqual(await snapshot(redis, namespace(p)), before);
    const denied = await wb.fetch(checkRequest(used.token), env);
    assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'ENROLLMENT_DENIED' });
    assert.deepEqual(await snapshot(redis, namespace(p)), before);
    assert.equal(await redis.command(['HLEN', namespace(p)]), 4);
    // The unused code still authorizes exactly one final atomic write.
    assert.equal((await wb.fetch(putRequest(locator(), unused.token), env)).status, 201);
    assert.equal((await wb.fetch(checkRequest(unused.token), env)).status, 403);
  });

  await t.test('real 16-record quota denies a valid unused code without consuming it or changing TTL', async () => {
    const p = profile(), store = createReleaseStore({ profile: storeProfile(p), command: redis.command });
    const values = await Promise.all(Array.from({ length: 16 }, async () => store.putIfAbsent(locator(), new Uint8Array([5]), (await grant()).configured.hash)));
    assert.ok(values.every(value => value === 'created'));
    const unused = await grant(), env = envFor([unused]), wb = worker('recovery', p), before = await snapshot(redis, namespace(p));
    const response = await wb.fetch(checkRequest(unused.token), env);
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'ENROLLMENT_DENIED' });
    assert.equal(await redis.command(['HLEN', namespace(p)]), 34);
    assert.equal(await redis.command(['HEXISTS', namespace(p), 'ticket:' + unused.configured.hash]), 0);
    assert.deepEqual(await snapshot(redis, namespace(p)), before);
    assert.equal((await wb.fetch(putRequest(locator(), unused.token), env)).status, 429);
    assert.deepEqual(await snapshot(redis, namespace(p)), before);
  });

  await t.test('Redis TIME enforces expiry even when application time would permit a check', async () => {
    const p = profile(), g = await grant(), key = namespace(p), store = createReleaseStore({ profile: storeProfile(p), command: redis.command });
    assert.equal(await store.putIfAbsent(locator(), new Uint8Array([6]), (await grant()).configured.hash), 'created');
    const before = await snapshot(redis, key), expiredAt = String(Date.now() - 1000);
    // The key stays live; an expired authorization must be rejected before any
    // metadata read could turn a stale caller clock into a ready response.
    assert.deepEqual(await redis.command(['EVAL', CHECK_ENROLLMENT_SCRIPT, '1', key, expiredAt, g.configured.hash]), ['expired']);
    assert.deepEqual(await snapshot(redis, key), before);
    const absent = `accountreserve:v1:${randomBytes(16).toString('hex')}`;
    assert.deepEqual(await redis.command(['EVAL', CHECK_ENROLLMENT_SCRIPT, '1', absent, expiredAt, g.configured.hash]), ['expired']);
    assert.equal(await redis.command(['EXISTS', absent]), 0);
  });

  await t.test('malformed namespace metadata is rejected without repairing or mutating it', async () => {
    const p = profile(), g = await grant(), env = envFor([g]), key = namespace(p), wb = worker('recovery', p);
    await redis.command(['HSET', key, '__schema', 'wrong-schema', '__expires', String(Date.parse(p.expiresAt)), 'data:' + locator(), 'AQ', 'ticket:' + 'a'.repeat(64), locator()]);
    await redis.command(['PEXPIREAT', key, String(Date.parse(p.expiresAt))]);
    const before = await snapshot(redis, key);
    const response = await wb.fetch(checkRequest(g.token), env);
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'STORE_UNAVAILABLE' });
    assert.deepEqual(await snapshot(redis, key), before);
  });

  await t.test('SDK encryption survives original-session loss and A outage through a fresh B Worker and Redis', async () => {
    const p = profile(), config = workReserveConfig(p), fixture = makeSdkFixture({ config }), g = await grant();
    const env = envFor([g]), wb = worker('recovery', p), wa = worker('primary', p), browserRequests = [];
    const browser = (target, runtime) => async (path, init = {}) => {
      assert.match(path, /^\/api\/reserve\/[A-Za-z0-9_-]{43}$/);
      const headers = new Headers(init.headers);
      if (init.method === 'PUT') headers.set('origin', b);
      headers.set('sec-fetch-site', 'same-origin');
      browserRequests.push({ method: init.method ?? 'GET', authorization: headers.get('authorization'), path });
      return target.fetch(new Request(new URL(path, b), { ...init, headers }), runtime);
    };
    const work = Object.freeze({ schema: WORK_SCHEMA, title: 'Synthetic real-Redis commission', client: 'Example client', brief: 'SYNTHETIC_WORK_REAL_REDIS_TEST: keep this private draft.', deliverable: 'One small illustrated page.', nextStep: 'Review the draft and export a local copy.' });
    let recovered;
    try {
      assert.equal((await wb.fetch(checkRequest(g.token), env)).status, 200);
      const preparingStore = createReserveHttpStore({ enrollmentToken: g.token, fetcher: browser(wb, env) });
      const ready = await fixture.prepare({ work, store: preparingStore }, prepareWorkReserve);
      assert.equal(ready.independentlyVerified, true); assert.equal(ready.owner, fixture.policy.expectedOwner);
      assert.equal(browserRequests.filter(request => request.method === 'PUT').length, 1);
      const stored = await snapshot(redis, namespace(p)), storedText = JSON.stringify(stored.contents);
      for (const privateValue of [work.title, work.brief, work.client, fixture.policy.expectedOwner, fixture.b.credentialId, g.token]) assert.equal(storedText.includes(privateValue), false);
      fixture.closeOriginal(); preparingStore.clearEnrollmentCapability();
      const offline = { ...env, WORK_RESERVE_PRIMARY_OFFLINE: 'true' };
      assert.equal((await wa.fetch(new Request(a + '/'), offline)).status, 503);
      assert.equal((await wa.fetch(new Request(a + '/api/config'), offline)).status, 503);
      const freshB = worker('recovery', p), freshEnv = { ...envFor([]), WORK_RESERVE_PRIMARY_OFFLINE: 'true' };
      const publicConfig = await (await freshB.fetch(new Request(b + '/api/config'), freshEnv)).json();
      assert.equal(publicConfig.synthetic, false); assert.deepEqual(publicConfig.config, config);
      assert.equal('owner' in publicConfig, false); assert.equal('locator' in publicConfig, false);
      const freshSdk = await import(`../sdk/work-reserve.mjs?real-redis-fresh=${randomBytes(6).toString('hex')}`);
      const start = fixture.stats(), requestsBefore = browserRequests.length;
      recovered = await freshSdk.recoverWorkReserve({ config: publicConfig.config, store: createReserveHttpStore({ fetcher: browser(freshB, freshEnv) }), webAuthnClient: fixture.newRecoveryClient() });
      assert.deepEqual(recovered.work, work); assert.equal(recovered.owner, ready.owner); assert.equal(recovered.workDigest, ready.workDigest);
      assert.equal('account' in recovered, false); assert.equal('session' in recovered, false);
      assert.equal(fixture.stats().recoveryRequests - start.recoveryRequests, 1, 'work reading requests discovery only');
      assert.ok(browserRequests.slice(requestsBefore).every(request => request.method === 'GET' && request.authorization === null));
      assert.deepEqual(await snapshot(redis, namespace(p)), stored, 'read recovery cannot alter ciphertext or expiry');
      const opened = await recovered.openAccount();
      assert.equal(fixture.stats().recoveryRequests - start.recoveryRequests, 2, 'only explicit unlock asks for the account vault');
      const message = 'Local synthetic work-account continuity check';
      assert.equal(await verifyMessage({ address: ready.owner, message, signature: await opened.account.signMessage({ message }) }), true);
      recovered.close(); await assert.rejects(opened.account.signMessage({ message }));
      assert.deepEqual(await snapshot(redis, namespace(p)), stored);
    } finally { recovered?.close(); fixture.cleanup(); }
  });
});
