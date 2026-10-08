import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createReserveHandler } from '../release/handler.mjs';
import { createRedisRestCommand } from '../release/redis-rest.mjs';
import { createReleaseStore } from '../release/redis-store.mjs';
import { createReserveHttpStore } from '../release/browser-store.mjs';
import { base64url, enrollmentTicketHash, releaseProfile } from '../release/profile.mjs';

const origin = 'https://account-reserve.example.invalid';
const endpoint = 'https://redis.example.invalid';
const providerToken = 'synthetic-provider-token-for-local-tests';
const run = promisify(execFile);
const locator = () => base64url(randomBytes(32));
const record = () => new TextEncoder().encode('SYNTHETIC ENCRYPTED-RECORD BYTES; no keys or user content');
function profile() { return { version: 1, enabled: true, releaseId: randomBytes(16).toString('hex'), recoveryOrigin: origin, expiresAt: new Date(Date.now() + 60000).toISOString() }; }
async function grant(bound = '*') { const token = locator(); return { token, configured: { hash: await enrollmentTicketHash(token), locator: bound } }; }
function request(key, { token, method = 'PUT', bytes = record(), url, headers = {}, body } = {}) {
  return new Request(url ?? `${origin}/api/reserve/${key}`, { method, headers: { ...(method === 'PUT' ? { origin, 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(method === 'PUT' ? { body: body ?? JSON.stringify({ bytes: base64url(bytes) }) } : {}) });
}
function handler(p, g, command, options) { return createReserveHandler({ profile: p, allowedOrigins: [origin], enrollmentTickets: g.map(x => x.configured ?? x), command }, options); }

test('empty and disabled release configurations perform no storage work', async () => {
  let called = 0;
  const empty = createReserveHandler({ command: async () => { called++; } });
  assert.equal((await empty(request(locator(), { method: 'GET' }))).status, 503);
  const disabled = createReserveHandler({ profile: { enabled: false }, command: async () => { called++; } });
  assert.equal((await disabled(request(locator()))).status, 503);
  assert.equal(called, 0);
});

test('release and Redis endpoint origins require independent exact HTTPS allowlists', () => {
  for (const recoveryOrigin of ['http://reserve.example.invalid', `${origin}/`, `${origin}/path`, `${origin}?x=1`, 'https://user:pass@reserve.example.invalid', 'https://reserve.example.invalid:444', 'https://127.0.0.1', 'https://reserve.localhost']) {
    assert.throws(() => releaseProfile({ ...profile(), recoveryOrigin }, [recoveryOrigin]), /RELEASE_CONFIG_INVALID/);
  }
  assert.throws(() => releaseProfile(profile(), ['https://another.example.invalid']), /RELEASE_CONFIG_INVALID/);
  assert.throws(() => releaseProfile({ ...profile(), namespace: 'old:continuity' }, [origin]), /RELEASE_CONFIG_INVALID/);
  assert.throws(() => releaseProfile({ ...profile(), expiresAt: new Date(Date.now() + 46 * 86400000).toISOString() }, [origin]), /RELEASE_CONFIG_INVALID/);
  assert.throws(() => createRedisRestCommand({ url: endpoint, token: providerToken }), /REDIS_CONFIG_INVALID/);
  assert.throws(() => createRedisRestCommand({ url: endpoint, token: providerToken, allowedOrigins: ['https://other.example.invalid'] }), /REDIS_CONFIG_INVALID/);
});

test('invalid origin, cross-site use, missing/wrong ticket and malformed records never reach Redis', async () => {
  const g = await grant(), key = locator(); let commands = 0;
  const h = handler(profile(), [g], async () => { commands++; throw new Error('must not run'); });
  for (const r of [
    request(key), request(key, { token: locator() }),
    request(key, { token: g.token, headers: { origin: 'https://attacker.example.invalid' } }),
    request(key, { token: g.token, headers: { 'sec-fetch-site': 'cross-site' } }),
    request(key, { token: g.token, headers: { origin: '' } }),
  ]) assert.equal((await h(r)).status, 403);
  assert.equal((await h(request(key, { method: 'GET', url: `https://other.example.invalid/api/reserve/${key}` }))).status, 421);
  assert.equal((await h(request(key, { method: 'GET', headers: { origin: 'https://attacker.example.invalid' } }))).status, 403);
  for (const body of ['{"bytes":"AA","bytes":"AQ"}', '{"bytes":"AA","owner":"evil"}', JSON.stringify({ bytes: base64url(new Uint8Array(65537)) }), '{"bytes":"AB"}']) {
    assert.equal((await h(request(key, { token: g.token, body }))).status, 400);
  }
  assert.equal((await h(request(key, { token: g.token, url: `${origin}/api/reserve/${key}?token=not-allowed` }))).status, 404);
  assert.equal((await h(request(key, { token: g.token, headers: { 'content-length': '90001' } }))).status, 400);
  assert.equal(commands, 0);
});

test('locator-bound ticket cannot write another record; expiration precedes provider work', async () => {
  const key = locator(), g = await grant(key); let calls = 0;
  const p = profile();
  const h = handler(p, [g], async () => { calls++; return ['created']; });
  assert.equal((await h(request(locator(), { token: g.token }))).status, 403);
  const expired = handler(p, [g], async () => { calls++; }, { now: () => Date.parse(p.expiresAt) });
  assert.equal((await expired(request(key, { token: g.token }))).status, 410);
  assert.equal((await expired(request(key, { method: 'GET' }))).status, 410);
  assert.equal(calls, 0);
});

test('missing ciphertext differs from storage failure and no provider errors leak', async () => {
  const g = await grant(), key = locator(), p = profile();
  const absent = handler(p, [g], async () => ['missing']);
  assert.equal((await absent(request(key, { method: 'GET' }))).status, 404);
  const unavailable = handler(p, [g], async () => { throw new Error('synthetic-provider-secret-or-record'); });
  const read = await unavailable(request(key, { method: 'GET' }));
  assert.equal(read.status, 503); assert.deepEqual(await read.json(), { error: 'STORE_UNAVAILABLE' });
  const write = await unavailable(request(key, { token: g.token }));
  assert.equal(write.status, 503); assert.deepEqual(await write.json(), { error: 'STORE_WRITE_UNKNOWN' });
});

test('read-only release needs no enrollment ticket and rejects all new writes', async () => {
  let commands = 0;
  const h = handler(profile(), [], async () => { commands++; return ['found', base64url(record())]; });
  const read = await h(request(locator(), { method: 'GET' }));
  assert.equal(read.status, 200); assert.equal(read.headers.has('access-control-allow-origin'), false);
  assert.equal((await h(request(locator(), { token: locator() }))).status, 403);
  assert.equal(commands, 1);
});

test('a stalled request body is bounded and never reaches the command client', async () => {
  const g = await grant(), key = locator(); let commands = 0, cancelled = false;
  const h = handler(profile(), [g], async () => { commands++; }, { bodyTimeoutMs: 10 });
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const r = new Request(`${origin}/api/reserve/${key}`, { method: 'PUT', headers: { origin, 'content-type': 'application/json', authorization: `Bearer ${g.token}` }, body, duplex: 'half' });
  assert.equal((await h(r)).status, 400); assert.equal(commands, 0); assert.equal(cancelled, true);
});

test('REST transport bounds redirects, response shape/size, timeout, and does not retry', async () => {
  for (const makeResponse of [
    () => new Response('', { status: 302, headers: { location: 'https://attacker.example.invalid' } }),
    () => new Response(JSON.stringify({ error: providerToken })),
    () => new Response(JSON.stringify({ result: null, extra: true })),
    () => new Response('x'.repeat(131073)),
  ]) {
    let calls = 0;
    const command = createRedisRestCommand({ url: endpoint, token: providerToken, allowedOrigins: [endpoint] }, { fetcher: async (_url, init) => { calls++; assert.equal(init.redirect, 'manual'); return makeResponse(); } });
    await assert.rejects(() => command(['PING']), /^Error: REDIS_UNAVAILABLE$/);
    await assert.rejects(() => command(['PING']), /^Error: REDIS_UNAVAILABLE$/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const timed = createRedisRestCommand({ url: endpoint, token: providerToken, allowedOrigins: [endpoint] }, { timeoutMs: 10, fetcher: async () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(() => timed(['PING']), /REDIS_UNAVAILABLE/); assert.equal(calls, 1);
});

test('browser adapter spends its capability once and never attaches it to recovery reads', async () => {
  const g = await grant(), key = locator(); const calls = [];
  const store = createReserveHttpStore({ enrollmentToken: g.token, fetcher: async (path, init) => { calls.push({ path, init }); if (init.method === 'PUT') throw new Error('lost response'); return new Response(JSON.stringify({ bytes: base64url(record()) })); } });
  await assert.rejects(() => store.putIfAbsent(key, record()), /STORE_WRITE_UNKNOWN/);
  await assert.rejects(() => store.putIfAbsent(key, record()), /ENROLLMENT_DENIED/);
  assert.deepEqual(await store.get(key), record());
  assert.equal(calls.length, 2); assert.equal(calls[0].init.headers.authorization, `Bearer ${g.token}`);
  assert.equal(calls[1].init.headers, undefined); assert.equal(calls.some(x => x.path.includes(g.token)), false);
});

// Actual Redis over a disposable Unix socket, no TCP or cloud database. redis-cli
// only serializes RESP; all production Lua is evaluated by redis-server itself.
async function realRedis(binary) {
  const directory = await mkdtemp('/private/tmp/account-reserve-store-');
  const socket = join(directory, 'redis.sock');
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

test('real Redis Lua: HTTP ciphertext lifecycle, concurrency, tickets, quota, expiry and namespace isolation', { skip: !process.env.ACCOUNT_RESERVE_REDIS_BIN && 'Set ACCOUNT_RESERVE_REDIS_BIN to redis-server; no Redis binary is bundled.' }, async t => {
  const redis = await realRedis(process.env.ACCOUNT_RESERVE_REDIS_BIN); t.after(() => redis.close());
  // Exercise the real REST transport through a local in-memory HTTP adapter.
  // No fetch escapes: only the configured fake provider URL is accepted.
  let providerCalls = 0, dropNextWrite = false, transportClock = Date.now();
  // Advance only the transport cooldown clock; Redis expiry uses actual TIME.
  const command = createRedisRestCommand({ url: endpoint, token: providerToken, allowedOrigins: [endpoint] }, { now: () => transportClock += 3000, fetcher: async (url, init) => {
    assert.equal(url, endpoint); assert.equal(init.headers.authorization, `Bearer ${providerToken}`); providerCalls++;
    const args = JSON.parse(init.body); const result = await redis.command(args);
    if (dropNextWrite && args.length === 8) { dropNextWrite = false; throw new Error('synthetic response loss after Redis accepted write'); }
    return new Response(JSON.stringify({ result }));
  } });

  await t.test('concurrent same-ticket writes create exactly one record and prevent overwrite', async () => {
    const p = profile(), g = await grant(), key = locator(); const h = handler(p, [g], command);
    const results = await Promise.all(Array.from({ length: 8 }, () => h(request(key, { token: g.token }))));
    assert.equal(results.filter(r => r.status === 201).length, 1); assert.equal(results.filter(r => r.status === 409).length, 7);
    const changed = await h(request(key, { token: g.token, bytes: new Uint8Array([5]) })); assert.equal(changed.status, 409);
    const fetched = await h(request(key, { method: 'GET' })); assert.equal(fetched.status, 200); assert.deepEqual(await fetched.json(), { bytes: base64url(record()) });
    assert.equal((await h(request(locator(), { token: g.token }))).status, 403);
    assert.equal(await redis.command(['HLEN', `accountreserve:v1:${p.releaseId}`]), 4);
  });

  await t.test('second capability cannot overwrite; losing PUT response preserves recoverable ciphertext', async () => {
    const p = profile(), a = await grant(), b = await grant(), key = locator(); const h = handler(p, [a, b], command);
    dropNextWrite = true;
    const response = await h(request(key, { token: a.token })); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'STORE_WRITE_UNKNOWN');
    assert.equal((await h(request(key, { token: b.token, bytes: new Uint8Array([0]) }))).status, 409);
    // A fresh B handler has neither enrollment token nor A service state for GET.
    const freshB = handler(p, [], command);
    const recovered = await freshB(request(key, { method: 'GET' })); assert.equal(recovered.status, 200); assert.equal((await recovered.json()).bytes, base64url(record()));
  });

  await t.test('concurrent quota is at most 16 records even after operator rotates ticket hashes', async () => {
    const p = profile(); const store = createReleaseStore({ profile: releaseProfile(p, [origin]), command });
    const attempts = await Promise.all(Array.from({ length: 20 }, async () => store.putIfAbsent(locator(), record(), (await grant()).configured.hash)));
    assert.equal(attempts.filter(x => x === 'created').length, 16); assert.equal(attempts.filter(x => x === 'limit').length, 4);
    assert.equal(await redis.command(['HLEN', `accountreserve:v1:${p.releaseId}`]), 34);
    const extra = await grant(); assert.equal((await handler(p, [extra], command)(request(locator(), { token: extra.token }))).status, 429);
  });

  await t.test('64 KiB record succeeds, 64 KiB plus one fails, and release namespace stays isolated', async () => {
    const p = profile(), g = await grant(), key = locator(); const h = handler(p, [g], command);
    assert.equal((await h(request(key, { token: g.token, bytes: new Uint8Array(65536) }))).status, 201);
    const read = await h(request(key, { method: 'GET' })); assert.equal((await read.json()).bytes.length, 87382);
    const other = handler(profile(), [g], command); assert.equal((await other(request(key, { method: 'GET' }))).status, 404);
    assert.equal((await other(request(key, { token: g.token, bytes: new Uint8Array(65537) }))).status, 400);
  });

  await t.test('Redis enforces absolute expiry even if the handler clock is stale', async () => {
    const p = { ...profile(), expiresAt: new Date(Date.now() - 1000).toISOString() }, g = await grant();
    const h = handler(p, [g], command, { now: () => Date.parse(p.expiresAt) - 10000 });
    assert.equal((await h(request(locator(), { token: g.token }))).status, 410);
    assert.equal((await h(request(locator(), { method: 'GET' }))).status, 410);
    assert.equal(await redis.command(['EXISTS', `accountreserve:v1:${p.releaseId}`]), 0);
  });
});
