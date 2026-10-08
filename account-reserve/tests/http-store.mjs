import assert from 'node:assert/strict';
import test from 'node:test';
import { createReserveHttpStore } from '../sdk/http-store.mjs';

// All tokens/locators are disposable synthetic values; no network is called.
const locator = Buffer.alloc(32, 1).toString('base64url');
const token = Buffer.alloc(32, 2).toString('base64url');
const bytes = Uint8Array.from([1, 2, 3, 254, 255]);
const code = value => error => error?.code === value;
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('GET uses the configured same-origin endpoint with no enrollment capability or browser credentials', async () => {
  const calls = [];
  const store = createReserveHttpStore({ enrollmentToken: token, basePath: '/custom/reserve-v1', fetcher: async (url, init) => {
    calls.push({ url, init }); return reply({ bytes: Buffer.from(bytes).toString('base64url') });
  } });
  assert.deepEqual(await store.get(locator), bytes);
  assert.equal(calls[0].url, `/custom/reserve-v1/${locator}`);
  const init = calls[0].init;
  assert.equal(init.method, 'GET'); assert.equal(init.mode, 'same-origin');
  assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
  assert.equal(init.redirect, 'error'); assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.headers, undefined); assert.equal(init.body, undefined);
  assert.equal(init.signal.aborted, true);
  assert.equal(Object.isFrozen(store), true);
});

test('GET missing and expired are distinct; no implicit write or retry occurs', async () => {
  const calls = [];
  const store = createReserveHttpStore({ fetcher: async (_url, init) => { calls.push(init.method); return new Response('', { status: calls.length === 1 ? 404 : 410 }); } });
  assert.equal(await store.get(locator), undefined);
  await assert.rejects(store.get(locator), code('STORE_EXPIRED'));
  await assert.rejects(store.putIfAbsent(locator, bytes), code('ENROLLMENT_DENIED'));
  assert.deepEqual(calls, ['GET', 'GET']);
});

test('GET returns detached copies, including at the maximum permitted record size', async () => {
  const original = Buffer.alloc(65536, 7);
  const fetcher = async () => reply({ bytes: original.toString('base64url') });
  const store = createReserveHttpStore({ fetcher });
  const first = await store.get(locator); first.fill(8);
  assert.deepEqual(await store.get(locator), new Uint8Array(original));
  assert.equal(original[0], 7);
});

for (const [label, body] of [
  ['empty', '{"bytes":""}'],
  ['noncanonical base64', '{"bytes":"AB"}'],
  ['padded base64', '{"bytes":"AQ=="}'],
  ['extra field', '{"bytes":"AQ","url":"https://attacker.invalid"}'],
  ['duplicate field', '{"bytes":"AQ","bytes":"Ag"}'],
  ['escaped field', '{"b\\u0079tes":"AQ"}'],
  ['array', '["AQ"]'],
  ['malformed JSON', '{"bytes":'],
  ['oversized decoded record', JSON.stringify({ bytes: Buffer.alloc(65537).toString('base64url') })],
  ['invalid UTF8', Uint8Array.from([0xff, 0xfe])],
  ['non-JSON whitespace', '\u00a0{"bytes":"AQ"}'],
  ['UTF8 byte-order mark', Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"bytes":"AQ"}')])],
]) test(`GET rejects ${label} before returning bytes`, async () => {
  const store = createReserveHttpStore({ fetcher: async () => new Response(body) });
  await assert.rejects(store.get(locator), code('STORE_UNAVAILABLE'));
});

test('GET stream and declared length are bounded before JSON parsing', async () => {
  let consumed = 0; let cancelled = 0;
  const stream = new ReadableStream({ pull(controller) { consumed++; controller.enqueue(new Uint8Array(90000)); }, cancel() { cancelled++; } });
  const streamed = createReserveHttpStore({ fetcher: async () => new Response(stream) });
  await assert.rejects(streamed.get(locator), code('STORE_UNAVAILABLE'));
  assert.ok(consumed <= 2); assert.equal(cancelled, 1);
  const declared = createReserveHttpStore({ fetcher: async () => new Response('{"bytes":"AQ"}', { headers: { 'content-length': '1000000' } }) });
  await assert.rejects(declared.get(locator), code('STORE_UNAVAILABLE'));
});

test('GET times out a response stream that never finishes and cancels its reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"bytes":"')); }, cancel() { cancelled = true; } });
  const store = createReserveHttpStore({ timeoutMs: 20, fetcher: async () => new Response(stream) });
  await assert.rejects(store.get(locator), code('STORE_UNAVAILABLE'));
  assert.equal(cancelled, true);
});

test('PUT snapshots input and consumes capability before a concurrent second attempt', async () => {
  const calls = []; let complete;
  const store = createReserveHttpStore({ enrollmentToken: token, fetcher: async (url, init) => {
    calls.push({ url, init }); return new Promise(resolve => { complete = resolve; });
  } });
  const input = new Uint8Array(bytes);
  const first = store.putIfAbsent(locator, input);
  input.fill(0);
  await assert.rejects(store.putIfAbsent(locator, bytes), code('ENROLLMENT_DENIED'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/reserve/${locator}`);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.body, JSON.stringify({ bytes: Buffer.from(bytes).toString('base64url') }));
  complete(reply({ created: true }, 201));
  assert.equal(await first, true);
  await assert.rejects(store.putIfAbsent(locator, bytes), code('ENROLLMENT_DENIED'));
});

test('a conflict returns false and consumes enrollment capability permanently for this instance', async () => {
  let calls = 0;
  const store = createReserveHttpStore({ enrollmentToken: token, fetcher: async () => { calls++; return new Response('', { status: 409 }); } });
  assert.equal(await store.putIfAbsent(locator, bytes), false);
  await assert.rejects(store.putIfAbsent(locator, bytes), code('ENROLLMENT_DENIED'));
  assert.equal(calls, 1);
});

for (const [label, fetcher] of [
  ['lost response', async () => { throw new Error('SYNTHETIC RESPONSE LOSS'); }],
  ['unexpected status', async () => reply({ created: true }, 200)],
  ['malformed success', async () => reply({ created: 'true' }, 201)],
  ['duplicate success property', async () => new Response('{"created":true,"created":true}', { status: 201 })],
  ['oversized success', async () => new Response(' '.repeat(129), { status: 201 })],
  ['redirected response', async () => ({ status: 201, redirected: true })],
]) test(`PUT ${label} is unknown and cannot be retried`, async () => {
  let calls = 0;
  const store = createReserveHttpStore({ enrollmentToken: token, fetcher: (...args) => { calls++; return fetcher(...args); } });
  await assert.rejects(store.putIfAbsent(locator, bytes), code('STORE_WRITE_UNKNOWN'));
  await assert.rejects(store.putIfAbsent(locator, bytes), code('ENROLLMENT_DENIED'));
  assert.equal(calls, 1);
});

test('PUT timeout aborts transport, reports unknown and never retries even if server persisted', async () => {
  let requests = 0; let signal; let persisted;
  const store = createReserveHttpStore({ enrollmentToken: token, timeoutMs: 20, fetcher: async (_url, init) => {
    requests++; signal = init.signal; persisted = init.body; return new Promise(() => {});
  } });
  await assert.rejects(store.putIfAbsent(locator, bytes), code('STORE_WRITE_UNKNOWN'));
  await assert.rejects(store.putIfAbsent(locator, bytes), code('ENROLLMENT_DENIED'));
  assert.equal(requests, 1); assert.equal(signal.aborted, true); assert.ok(persisted);
});

test('explicit capability clear leaves GET available and prevents PUT', async () => {
  let calls = 0;
  const store = createReserveHttpStore({ enrollmentToken: token, fetcher: async () => { calls++; return new Response('', { status: 404 }); } });
  store.clearEnrollmentCapability();
  await assert.rejects(store.putIfAbsent(locator, bytes), code('ENROLLMENT_DENIED'));
  assert.equal(await store.get(locator), undefined);
  assert.equal(calls, 1);
});

test('invalid inputs cannot consume a capability or reach the transport', async () => {
  let calls = 0;
  const store = createReserveHttpStore({ enrollmentToken: token, fetcher: async () => { calls++; return reply({ created: true }, 201); } });
  for (const bad of ['', '../record', locator + '=', 'A'.repeat(42) + 'B']) await assert.rejects(store.get(bad), code('LOCATOR_INVALID'));
  for (const bad of [null, [], new Uint8Array(0), new Uint8Array(65537)]) await assert.rejects(store.putIfAbsent(locator, bad), code('RECORD_INVALID'));
  assert.equal(calls, 0);
  assert.equal(await store.putIfAbsent(locator, bytes), true);
});

test('construction rejects cross-origin or ambiguous paths and invalid timeout/token without fetching', () => {
  let calls = 0; const fetcher = async () => { calls++; };
  for (const basePath of ['https://attacker.invalid/api', '//attacker.invalid/api', '/api/../reserve', '/api/%2e%2e/reserve', '/api\\reserve', '/api/reserve/', '/api/reserve?x=1', '/api/reserve#x', 'api/reserve', '/']) assert.throws(() => createReserveHttpStore({ basePath, fetcher }), code('STORE_CONFIG_INVALID'));
  for (const timeoutMs of [0, -1, NaN, Infinity, 10001, 1.5]) assert.throws(() => createReserveHttpStore({ timeoutMs, fetcher }), code('STORE_CONFIG_INVALID'));
  assert.throws(() => createReserveHttpStore({ enrollmentToken: 'bad', fetcher }), code('ENROLLMENT_DENIED'));
  assert.equal(calls, 0);
});
