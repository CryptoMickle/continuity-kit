import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createHostedWorkClient, CHECK_ENROLLMENT_SCRIPT } from '../work-release/host-worker.mjs';
import { validateWorkReleaseProfile, workReserveConfig, WORK_APP_ID, WORK_DERIVATION } from '../work-release/profile.mjs';
import { READ_SCRIPT, WRITE_SCRIPT } from '../release/redis-store.mjs';
import { base64url, enrollmentTicketHash, releaseProfile } from '../release/profile.mjs';

const a = 'https://work-primary.example.invalid', b = 'https://work-reserve.example.invalid';
const endpoint = 'https://redis.example.invalid';
const token = 'synthetic-provider-secret-not-a-real-credential';
const profile = () => ({ version: 1, enabled: true, releaseId: 'b'.repeat(32), primaryOrigin: a, recoveryOrigin: b, expiresAt: new Date(Date.now() + 60000).toISOString() });
const assets = {
  '/index.html': { base64: Buffer.from('<html>Synthetic private work app</html>').toString('base64'), contentType: 'text/html; charset=utf-8' },
  '/assets/main.js': { base64: Buffer.from('/* static public app */').toString('base64'), contentType: 'text/javascript' },
};
const worker = (role, p = profile(), more = {}) => createHostedWorkClient({ profile: p, role, assets, redisOrigin: endpoint, ...more });
const bindings = grants => ({ RESERVE_REDIS_REST_URL: endpoint, RESERVE_REDIS_REST_TOKEN: token, RESERVE_ENROLLMENT_TICKET_HASHES: JSON.stringify(grants ?? []) });
const locator = () => base64url(randomBytes(32));
async function grant(bound = '*') { const token = locator(); return { token, configured: { hash: await enrollmentTicketHash(token), locator: bound } }; }
function reserveRequest(key, { token, method = 'GET', bytes = new Uint8Array([7, 8, 9]), origin = b, headers = {} } = {}) {
  return new Request(`${origin}/api/reserve/${key}`, { method, headers: { ...(method === 'PUT' ? { origin, 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(method === 'PUT' ? { body: JSON.stringify({ bytes: base64url(bytes) }) } : {}) });
}
function checkRequest(code, { method = 'POST', origin = b, headers = {}, body = '{}', suffix = '' } = {}) {
  return new Request(`${origin}/api/enrollment/check${suffix}`, { method, headers: { origin, 'content-type': 'application/json', ...(code ? { authorization: `Bearer ${code}` } : {}), ...headers }, ...(!['GET', 'HEAD'].includes(method) ? { body } : {}) });
}
// The HTTP boundary is real; the configured Redis REST origin is captured by a
// memory-only adapter. Production Lua identity is asserted, never sent online.
function provider(t) {
  const namespaces = new Map(), calls = [];
  let failure, forcedCheck;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, endpoint); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    const args = JSON.parse(init.body); calls.push(args);
    if (failure) throw new Error(failure);
    assert.equal(args[0], 'EVAL'); assert.equal(args[2], '1');
    const [_, script, , namespace, expiry, value, ticket, incoming] = args;
    assert.match(namespace, /^accountreserve:v1:[a-f0-9]{32}$/);
    let state = namespaces.get(namespace);
    let result;
    if (Date.now() >= Number(expiry)) result = ['expired'];
    else if (script === CHECK_ENROLLMENT_SCRIPT) result = [forcedCheck ?? (state && (state.tickets.has(value) || state.rows.size >= 16) ? 'denied' : 'ready')];
    else if (script === READ_SCRIPT) result = state?.rows.has(value) ? ['found', state.rows.get(value)] : ['missing'];
    else {
      assert.equal(script, WRITE_SCRIPT);
      if (!state) { state = { rows: new Map(), tickets: new Map() }; namespaces.set(namespace, state); }
      if (state.tickets.has(ticket)) result = [state.tickets.get(ticket) === value ? 'conflict' : 'consumed'];
      else if (state.rows.has(value)) result = ['conflict'];
      else if (state.rows.size >= 16) result = ['limit'];
      else { state.rows.set(value, incoming); state.tickets.set(ticket, value); result = ['created']; }
    }
    return new Response(JSON.stringify({ result }));
  });
  return { namespaces, calls, fail(value) { failure = value; }, checkResult(value) { forcedCheck = value; } };
}

test('profile is exact, canonical, immutable and computes only fixed work configuration', () => {
  const p = profile(), accepted = validateWorkReleaseProfile(p);
  assert.deepEqual(accepted, p); assert.ok(Object.isFrozen(accepted));
  assert.deepEqual(validateWorkReleaseProfile(JSON.parse(JSON.stringify(accepted))), p);
  assert.deepEqual(workReserveConfig(accepted), { appId: WORK_APP_ID, originalRpId: new URL(a).hostname, recoveryRpId: new URL(b).hostname, derivation: WORK_DERIVATION });
  assert.ok(Object.isFrozen(workReserveConfig(p)));
  assert.equal(validateWorkReleaseProfile({ enabled: false }), undefined);
  for (const changed of [{ version: 2 }, { enabled: 1 }, { releaseId: 'A'.repeat(32) }, { releaseId: 'a'.repeat(31) }, { primaryOrigin: b }, { appId: 'overridden' }, { namespace: 'old:account' }, { config: {} }, { enrollmentToken: locator() }, { expiresAt: 'bad-date' }]) assert.throws(() => validateWorkReleaseProfile({ ...p, ...changed }));
  for (const origin of ['http://primary.example.invalid', a + '/', a + '/path', a + '?x=1', 'https://user:pass@primary.example.invalid', 'https://primary.example.invalid:443', 'https://primary.example.invalid:444', 'https://127.0.0.1', 'https://primary.localhost']) assert.throws(() => validateWorkReleaseProfile({ ...p, primaryOrigin: origin }));
});

test('disabled or missing configuration fails closed without storage or startup clock reads', async t => {
  let clockReads = 0, network = 0;
  t.mock.method(Date, 'now', () => { clockReads++; return 0; });
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('NO_NETWORK'); });
  for (const p of [undefined, { enabled: false }, { enabled: false, ignored: true }]) {
    for (const role of ['primary', 'recovery']) assert.equal((await createHostedWorkClient({ profile: p, role, assets, redisOrigin: endpoint }).fetch(new Request(role === 'primary' ? a : b))).status, 503);
  }
  assert.equal(clockReads, 0); assert.equal(network, 0);
  assert.throws(() => worker('admin'), /HOST_ROLE_INVALID/);
});

test('module import and enabled worker construction never read the deployment clock', async t => {
  const p = profile(), requestTime = Date.now(); let clock = 0, reads = 0;
  t.mock.method(Date, 'now', () => { reads++; return clock; });
  const imported = await import(`../work-release/host-worker.mjs?epoch=${randomBytes(4).toString('hex')}`);
  const wa = imported.createHostedWorkClient({ profile: p, role: 'primary', assets, redisOrigin: endpoint });
  const wb = imported.createHostedWorkClient({ profile: p, role: 'recovery', assets, redisOrigin: endpoint });
  assert.equal(reads, 0);
  clock = requestTime;
  for (const [w, origin] of [[wa, a], [wb, b]]) {
    const response = await w.fetch(new Request(origin + '/api/config'), bindings());
    assert.equal(response.status, 200); assert.equal((await response.json()).expiresAt, p.expiresAt);
  }
});

test('native configuration contains no provider token, enrollment hash, release key or synthetic controls', async t => {
  const memory = provider(t), p = profile(), capability = await grant(), env = bindings([capability.configured]);
  for (const [role, origin] of [['primary', a], ['recovery', b]]) {
    const response = await worker(role, p).fetch(new Request(origin + '/api/config'), env), text = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { hosted: true, synthetic: false, physicalEnabled: true, role, originalOrigin: a, recoveryOrigin: b, config: workReserveConfig(p), expiresAt: p.expiresAt });
    for (const secret of [token, capability.token, capability.configured.hash, p.releaseId, 'accountreserve:v1', 'rpcUrls', 'privateKey', 'enrollmentToken']) assert.equal(text.includes(secret), false);
  }
  assert.equal(memory.calls.length, 0, 'config checks bindings but never calls Redis');
});

test('role, exact URL origin and method guards block unapproved paths', async t => {
  const memory = provider(t), p = profile();
  for (const [role, origin] of [['primary', a], ['recovery', b]]) {
    const w = worker(role, p);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) assert.equal((await w.fetch(new Request(origin + '/api/config', { method }), bindings())).status, 405);
    assert.equal((await w.fetch(new Request((role === 'primary' ? b : a) + '/api/config'), bindings())).status, 421);
    assert.equal((await w.fetch(new Request('https://wrong.example.invalid/'), bindings())).status, 421);
    for (const path of ['/api/synthetic/credential', '/api/prepare-right', '/api/configuration', '/rpc', '/rpc/test', '/control', '/control/primary', '/api/admin/tickets']) {
      assert.equal((await w.fetch(new Request(origin + path), bindings())).status, 404);
      assert.equal((await w.fetch(new Request(origin + path, { method: 'POST' }), bindings())).status, 405);
    }
  }
  const primary = worker('primary', p);
  assert.equal((await primary.fetch(reserveRequest(locator(), { origin: a }), bindings())).status, 404);
  assert.equal((await primary.fetch(checkRequest(locator(), { origin: a }), bindings())).status, 405);
  assert.equal(memory.calls.length, 0);
});

test('runtime primary outage blocks all A responses while B remains independent', async t => {
  const memory = provider(t), p = profile(), env = { ...bindings(), WORK_RESERVE_PRIMARY_OFFLINE: 'true' }, wa = worker('primary', p), wb = worker('recovery', p);
  for (const path of ['/', '/assets/main.js', '/api/config', '/api/enrollment/check', '/api/reserve/' + locator(), '/missing']) assert.equal((await wa.fetch(new Request(a + path), env)).status, 503);
  for (const path of ['/', '/assets/main.js', '/api/config']) assert.equal((await wb.fetch(new Request(b + path), env)).status, 200);
  assert.equal((await wb.fetch(reserveRequest(locator()), env)).status, 404);
  assert.equal(memory.calls.length, 1);
  env.WORK_RESERVE_PRIMARY_OFFLINE = 'false'; assert.equal((await wa.fetch(new Request(a), env)).status, 200);
  env.ACCOUNT_RESERVE_PRIMARY_OFFLINE = 'true'; assert.equal((await wa.fetch(new Request(a), env)).status, 200, 'old product flag cannot control the work site');
});

test('all responses use self-only CSP and asset embedding rejects unknown or inherited paths', async t => {
  provider(t); const w = worker('recovery');
  for (const path of ['/', '/api/config', '/unknown', '/api/reserve/' + locator()]) {
    const response = await w.fetch(new Request(b + path), bindings());
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes("connect-src 'self'")); assert.ok(csp.includes("script-src 'self'")); assert.ok(csp.includes("frame-ancestors 'none'"));
    for (const forbidden of ['https:', 'http:', 'data:', 'unsafe-inline', 'unsafe-eval', '*']) assert.equal(csp.includes(forbidden), false);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.has('access-control-allow-origin'), false);
  }
  const home = await w.fetch(new Request(b), bindings()); assert.equal(await home.text(), '<html>Synthetic private work app</html>');
  const inherited = Object.create({ '/inherited.html': assets['/index.html'] });
  assert.equal((await worker('primary', profile(), { assets: inherited }).fetch(new Request(a + '/inherited.html'))).status, 404);
  for (const path of ['/.env', '/server.mjs', '/assets/no.js']) assert.equal((await w.fetch(new Request(b + path), bindings())).status, 404);
});

test('missing, malformed, mismatched or changed runtime bindings fail closed without leaks', async t => {
  const memory = provider(t), w = worker('recovery'), key = locator();
  for (const env of [{}, null, { ...bindings(), RESERVE_REDIS_REST_URL: 'https://wrong.example.invalid' }, { ...bindings(), RESERVE_REDIS_REST_TOKEN: '' }, { ...bindings(), RESERVE_ENROLLMENT_TICKET_HASHES: '{bad json' }, { ...bindings(), RESERVE_ENROLLMENT_TICKET_HASHES: '[{"hash":"bad","locator":"*"}]' }]) {
    for (const path of ['/api/config', '/api/reserve/' + key]) {
      const response = await w.fetch(new Request(b + path), env), text = await response.text();
      assert.equal(response.status, 503); assert.equal(text.includes(token), false); assert.equal(text.includes('wrong.example'), false);
    }
  }
  const env = bindings(); assert.equal((await w.fetch(new Request(b + '/api/config'), env)).status, 200);
  env.RESERVE_REDIS_REST_TOKEN = ''; assert.equal((await w.fetch(new Request(b + '/api/config'), env)).status, 503, 'cached bindings must not keep a removed token usable');
  assert.equal(memory.calls.length, 0);
});

test('request-time validation preserves the exact 45-day window and accepts expired profiles only for 410', async t => {
  const p = profile(), now = Date.now(); t.mock.method(Date, 'now', () => now);
  const edge = { ...p, expiresAt: new Date(now + 45 * 86400000).toISOString() };
  assert.deepEqual(validateWorkReleaseProfile(edge), edge);
  for (const changed of [{ expiresAt: new Date(now + 45 * 86400000 + 1).toISOString() }, { expiresAt: '2026-10-08' }, { primaryOrigin: 'http://primary.example.invalid' }, { newField: true }]) assert.equal((await worker('primary', { ...p, ...changed }).fetch(new Request(a))).status, 503);
  assert.equal((await worker('primary', edge).fetch(new Request(a + '/api/config'))).status, 200);
  const expired = { ...p, expiresAt: new Date(now - 1).toISOString() };
  assert.throws(() => validateWorkReleaseProfile(expired), /WORK_RELEASE_EXPIRED/);
  assert.deepEqual(validateWorkReleaseProfile(expired, { allowExpired: true }), expired);
  for (const [role, origin] of [['primary', a], ['recovery', b]]) assert.equal((await worker(role, expired).fetch(new Request(origin))).status, 410);
});

test('expiry blocks new and cached handler requests before Redis access', async t => {
  const p = profile(); let now = Date.parse(p.expiresAt) - 1; t.mock.method(Date, 'now', () => now);
  const memory = provider(t), wa = worker('primary', p), wb = worker('recovery', p), env = bindings();
  assert.equal((await wb.fetch(new Request(b + '/api/config'), env)).status, 200);
  now++;
  for (const [w, origin] of [[wa, a], [wb, b], [worker('primary', p), a], [worker('recovery', p), b]]) {
    for (const path of ['/', '/api/config', '/api/reserve/' + locator(), '/api/enrollment/check']) assert.equal((await w.fetch(new Request(origin + path), env)).status, 410);
  }
  assert.equal(memory.calls.length, 0);
});

test('ciphertext writes use the unchanged handler and a new isolated Redis namespace', async t => {
  const memory = provider(t), p = profile(), w = worker('recovery', p), capability = await grant(), env = bindings([capability.configured]), key = locator();
  assert.equal((await w.fetch(reserveRequest(key, { method: 'PUT', token: capability.token }), env)).status, 201);
  assert.equal((await w.fetch(reserveRequest(key, { method: 'PUT', token: capability.token, bytes: new Uint8Array([1]) }), env)).status, 409);
  const recovered = await w.fetch(reserveRequest(key), env); assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), { bytes: base64url(new Uint8Array([7, 8, 9])) });
  assert.equal(memory.calls[0][1], WRITE_SCRIPT); assert.equal(memory.calls.at(-1)[1], READ_SCRIPT);
  assert.ok(memory.calls.every(args => args[3] === `accountreserve:v1:${p.releaseId}`));
  const previous = releaseProfile({ version: 1, enabled: true, releaseId: 'a'.repeat(32), recoveryOrigin: b, expiresAt: p.expiresAt }, [b]);
  assert.notEqual(memory.calls[0][3], previous.namespace); assert.equal(memory.namespaces.has(previous.namespace), false);
  const other = worker('recovery', { ...p, releaseId: 'c'.repeat(32) }); assert.equal((await other.fetch(reserveRequest(key), env)).status, 404);
});

test('ciphertext endpoint preserves same-origin, ticket and 64KiB limits', async t => {
  const memory = provider(t), w = worker('recovery'), capability = await grant(), env = bindings([capability.configured]), key = locator();
  for (const request of [reserveRequest(key, { method: 'PUT' }), reserveRequest(key, { method: 'PUT', token: capability.token, headers: { origin: a } }), reserveRequest(key, { method: 'PUT', token: capability.token, headers: { 'sec-fetch-site': 'cross-site' } })]) assert.equal((await w.fetch(request, env)).status, 403);
  assert.equal((await w.fetch(reserveRequest(key, { method: 'PUT', token: capability.token, bytes: new Uint8Array(65537) }), env)).status, 400);
  assert.equal(memory.calls.length, 0);
  assert.equal((await w.fetch(reserveRequest(key, { method: 'PUT', token: capability.token, bytes: new Uint8Array(65536) }), env)).status, 201);
  assert.equal((await (await w.fetch(reserveRequest(key), env)).json()).bytes.length, 87382);
});

test('enrollment check is readonly and returns no capability, hash, locator or namespace', async t => {
  const memory = provider(t), p = profile(), capability = await grant(), env = bindings([capability.configured]), w = worker('recovery', p);
  for (const body of ['{}', '', undefined]) {
    const response = await w.fetch(checkRequest(capability.token, { body }), env);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ready: true, expiresAt: p.expiresAt });
  }
  assert.equal(memory.namespaces.size, 0, 'read check must not create a Redis record');
  assert.equal(memory.calls.length, 3);
  assert.ok(memory.calls.every(args => args[1] === CHECK_ENROLLMENT_SCRIPT && args.length === 6));
  const redisCommands = [...CHECK_ENROLLMENT_SCRIPT.matchAll(/redis\.call\('([^']+)'/g)].map(match => match[1]);
  assert.ok(redisCommands.every(command => ['TIME', 'TYPE', 'HLEN', 'HGET', 'HKEYS', 'HSTRLEN', 'HEXISTS'].includes(command)));
  const key = locator(); assert.equal((await w.fetch(reserveRequest(key, { method: 'PUT', token: capability.token }), env)).status, 201, 'check does not consume code');
  const used = await w.fetch(checkRequest(capability.token), env); assert.equal(used.status, 403); assert.deepEqual(await used.json(), { error: 'ENROLLMENT_DENIED' });
});

test('malformed, cross-origin, unknown or locator-bound enrollment checks uniformly deny without Redis', async t => {
  const memory = provider(t), capability = await grant(), bound = await grant(locator()), env = bindings([capability.configured, bound.configured]), w = worker('recovery');
  for (const request of [checkRequest(undefined), checkRequest(locator()), checkRequest(bound.token), checkRequest(capability.token, { headers: { origin: a } }), checkRequest(capability.token, { headers: { 'sec-fetch-site': 'cross-site' } }), checkRequest(capability.token, { headers: { 'content-type': 'text/plain' } }), checkRequest(capability.token, { headers: { 'content-encoding': 'gzip' } }), checkRequest(capability.token, { body: '{ }' }), checkRequest(capability.token, { body: '[]' }), checkRequest(capability.token, { body: '{"owner":"hidden"}' }), checkRequest(capability.token, { suffix: '?token=forbidden' }), checkRequest(capability.token, { headers: { 'content-length': '999999' } })]) {
    const response = await w.fetch(request, env); assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'ENROLLMENT_DENIED' });
  }
  assert.equal((await w.fetch(checkRequest(capability.token, { method: 'GET' }), env)).status, 405);
  assert.equal(memory.calls.length, 0);
});

test('preflight observes live quota and final atomic write still handles races', async t => {
  const memory = provider(t), p = profile(), capability = await grant(), env = bindings([capability.configured]), w = worker('recovery', p);
  assert.equal((await w.fetch(checkRequest(capability.token), env)).status, 200);
  memory.namespaces.set(`accountreserve:v1:${p.releaseId}`, { rows: new Map(Array.from({ length: 16 }, (_, i) => ['synthetic-' + i, 'AA'])), tickets: new Map() });
  const full = await w.fetch(checkRequest(capability.token), env); assert.equal(full.status, 403); assert.deepEqual(await full.json(), { error: 'ENROLLMENT_DENIED' });
  assert.equal((await w.fetch(reserveRequest(locator(), { method: 'PUT', token: capability.token }), env)).status, 429);
});

test('runtime grant removal invalidates cached preflight capability', async t => {
  const memory = provider(t), capability = await grant(), env = bindings([capability.configured]), w = worker('recovery');
  assert.equal((await w.fetch(checkRequest(capability.token), env)).status, 200);
  env.RESERVE_ENROLLMENT_TICKET_HASHES = '[]';
  assert.equal((await w.fetch(checkRequest(capability.token), env)).status, 403); assert.equal(memory.calls.length, 1);
});

test('Redis errors, unexpected preflight result and Redis-time expiry are sanitized without retry', async t => {
  const memory = provider(t), capability = await grant(), env = bindings([capability.configured]);
  memory.checkResult('unexpected-provider-response');
  const unknown = await worker('recovery').fetch(checkRequest(capability.token), env); assert.equal(unknown.status, 503); assert.deepEqual(await unknown.json(), { error: 'STORE_UNAVAILABLE' });
  memory.checkResult('expired');
  assert.equal((await worker('recovery').fetch(checkRequest(capability.token), env)).status, 410);
  memory.fail('DO_NOT_LEAK_SYNTHETIC_PROVIDER_DETAIL');
  const before = memory.calls.length, w = worker('recovery');
  const response = await w.fetch(checkRequest(capability.token), env); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'STORE_UNAVAILABLE' });
  assert.equal(memory.calls.length - before, 1);
  assert.equal((await w.fetch(checkRequest(capability.token), env)).status, 503); assert.equal(memory.calls.length - before, 1, 'transport cooldown does not retry a failed command');
});

test('preflight body is bounded even when its stream never finishes', async t => {
  const memory = provider(t), capability = await grant(), env = bindings([capability.configured]), w = worker('recovery');
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const request = new Request(b + '/api/enrollment/check', { method: 'POST', headers: { origin: b, 'content-type': 'application/json', authorization: `Bearer ${capability.token}` }, body, duplex: 'half' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const checking = w.fetch(request, env);
  t.mock.timers.tick(5000);
  const response = await checking;
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'ENROLLMENT_DENIED' });
  assert.equal(cancelled, true); assert.equal(memory.calls.length, 0);
});

test('provider result arriving after release expiry cannot return ready', async t => {
  const p = profile(), capability = await grant(), env = bindings([capability.configured]);
  let now = Date.parse(p.expiresAt) - 1;
  t.mock.method(Date, 'now', () => now);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests++; assert.equal(url, endpoint); assert.equal(JSON.parse(init.body)[1], CHECK_ENROLLMENT_SCRIPT);
    now = Date.parse(p.expiresAt);
    return new Response(JSON.stringify({ result: ['ready'] }));
  });
  const response = await worker('recovery', p).fetch(checkRequest(capability.token), env);
  assert.equal(requests, 1); assert.equal(response.status, 410); assert.deepEqual(await response.json(), { error: 'DEMONSTRATION_ENDED' });
});
