import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { TEXT_PROTOCOL, createTextReserveCredential, prepareTextReserve, recoverTextReserve, prepareTextReserveReplicas, recoverTextReserveFromReplicas, TextReserveError } from '../sdk/text-reserve.mjs';

const code = expected => error => error?.code === expected;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const encode = value => new TextEncoder().encode(JSON.stringify(sorted(value)));
const b64 = value => Buffer.from(value).toString('base64url');
const unb64 = value => new Uint8Array(Buffer.from(value, 'base64url'));
const digest = value => new Uint8Array(createHash('sha256').update(value).digest());
const sample = '\ufeffAn immutable fictional draft.\r\nÅ, 界 and 🦊.\n';
function memoryStore() {
  const records = new Map(), calls = { get: 0, put: 0 };
  return { records, calls,
    async get(locator) { calls.get++; const bytes = records.get(locator); return bytes && new Uint8Array(bytes); },
    async putIfAbsent(locator, bytes) { calls.put++; if (records.has(locator)) return false; records.set(locator, new Uint8Array(bytes)); return true; },
  };
}
function fixture(t, count = 2) {
  const config = { appId: 'replicas-' + randomBytes(8).toString('hex'), recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example' };
  const key = randomBytes(32), credentialId = new Uint8Array(randomBytes(24)), outputs = [], requests = [], handles = [];
  const counts = { create: 0, get: 0 }, stores = Array.from({ length: count }, memoryStore);
  const replicas = stores.map((store, index) => ({ id: ['alpha', 'beta', 'gamma'][index], store }));
  const output = salt => new Uint8Array(createHmac('sha256', key).update(salt).digest());
  const response = request => { const result = { credentialId: new Uint8Array(credentialId), prfOutput: output(request.prfSalt) }; outputs.push(result); return result; };
  const client = {
    createCredential(request) { counts.create++; requests.push(request); return Promise.resolve({ ...response(request), prfEnabled: true }); },
    getCredential(request) { counts.get++; requests.push(request); assert.equal(request.userVerification, 'required'); return Promise.resolve(response(request)); },
  };
  async function create() { const handle = await createTextReserveCredential({ config, user: { name: 'Fictional', displayName: 'Replica test' }, webAuthnClient: client }); handles.push(handle); return handle; }
  const prepare = (recoveryCredential, options) => prepareTextReserveReplicas({ config, recoveryCredential, text: sample, replicas, webAuthnClient: client, ...options });
  const recover = options => recoverTextReserveFromReplicas({ config, replicas, webAuthnClient: client, ...options });
  async function legacy() {
    const ready = await prepareTextReserve({ config, recoveryCredential: await create(), text: sample, store: stores[0], webAuthnClient: client });
    for (const store of stores.slice(1)) store.records.set(ready.locator, new Uint8Array(stores[0].records.get(ready.locator)));
    return ready;
  }
  async function rebox(bytes, text) {
    const material = await crypto.subtle.importKey('raw', output(digest(Buffer.from(`${TEXT_PROTOCOL}/prf`))), 'HKDF', false, ['deriveKey']);
    const salt = digest(encode({ format: `${TEXT_PROTOCOL}/hkdf`, config, credentialId: b64(credentialId) }));
    const manifestKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(`${TEXT_PROTOCOL}/manifest-aes-gcm`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const locator = [...stores[0].records.keys()][0], outer = JSON.parse(new TextDecoder().decode(bytes));
    const aad = encode({ format: `${TEXT_PROTOCOL}/index`, config, locator, credentialId: b64(credentialId) });
    let manifest = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(outer.nonce), additionalData: aad }, manifestKey, unb64(outer.ciphertext)));
    if (text !== undefined) {
      const value = JSON.parse(new TextDecoder().decode(manifest)), plain = new TextEncoder().encode(text), nonce = randomBytes(12);
      const textKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(`${TEXT_PROTOCOL}/text-aes-gcm`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      value.textDigest = Buffer.from(digest(plain)).toString('hex');
      const binding = { format: `${TEXT_PROTOCOL}/text`, config, locator, credentialId: b64(credentialId), textDigest: value.textDigest };
      value.textEnvelope = { nonce: b64(nonce), ciphertext: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encode(binding), tagLength: 128 }, textKey, plain)) };
      manifest.fill(0); manifest = encode(value); plain.fill(0);
    }
    const nonce = randomBytes(12), result = encode({ format: outer.format, nonce: b64(nonce), ciphertext: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, manifestKey, manifest)) });
    manifest.fill(0); return result;
  }
  t.after(() => { handles.forEach(handle => handle.close()); key.fill(0); });
  return { config, credentialId, counts, stores, replicas, outputs, requests, client, create, prepare, recover, legacy, rebox };
}
function diagnosticsAreSafe(error, secret) {
  assert.ok(error instanceof TextReserveError); assert.ok(Object.isFrozen(error.replicas));
  for (const diagnostic of error.replicas) {
    assert.ok(Object.isFrozen(diagnostic));
    assert.ok(Object.keys(diagnostic).every(key => ['id', 'stage', 'status', 'code'].includes(key)));
  }
  assert.equal(JSON.stringify(error).includes(secret), false); assert.equal(error.message.includes(secret), false);
  return true;
}

for (const count of [2, 3]) test(`${count} replicas prepare one identical v1 record and independently authenticate every copy`, async t => {
  const f = fixture(t, count), stages = [], ready = await f.prepare(await f.create(), { onProgress: stage => stages.push(stage) });
  assert.deepEqual(stages, ['protect-text', 'verify-text']); assert.equal(ready.status, 'ready'); assert.equal(ready.text, sample);
  assert.equal(ready.independentlyVerified, true); assert.ok(Object.isFrozen(ready)); assert.ok(Object.isFrozen(ready.replicas));
  assert.deepEqual(ready.replicas, f.replicas.map(({ id }) => ({ id, stage: 'verify', status: 'verified' })));
  assert.deepEqual(f.counts, { create: 1, get: 1 });
  for (const store of f.stores) { assert.deepEqual(store.calls, { get: 3, put: 1 }); assert.deepEqual(store.records.get(ready.locator), f.stores[0].records.get(ready.locator)); }
  const before = f.counts.get, recovering = f.recover(); assert.equal(f.counts.get, before + 1); assert.equal(f.requests.at(-1).allowCredential, undefined);
  const recovered = await recovering; assert.equal(recovered.reserve.text, sample); assert.equal(recovered.reserve.locator, ready.locator);
  assert.ok(Object.isFrozen(recovered)); assert.ok(Object.isFrozen(recovered.reserve));
  const single = await recoverTextReserve({ config: f.config, store: f.stores[0], webAuthnClient: f.client }); assert.deepEqual(single, recovered.reserve);
  assert.ok(f.outputs.every(value => value.prfOutput.every(byte => byte === 0))); assert.ok(f.stores.every(store => store.calls.put === 1));
});

test('unchanged legacy single-store records work with replica recovery and no new enrollment', async t => {
  const f = fixture(t), ready = await f.legacy(), before = { ...f.counts };
  const result = await f.recover(); assert.equal(result.reserve.text, ready.text);
  assert.deepEqual(result.replicas.map(item => item.status), ['verified', 'verified']);
  assert.equal(f.counts.create, before.create); assert.equal(f.counts.get, before.get + 1);
  assert.deepEqual(f.stores.map(store => store.calls.put), [1, 0]);
});

test('tampered or malformed copies cannot suppress a valid sibling', async t => {
  const f = fixture(t, 3), ready = await f.legacy();
  const outer = JSON.parse(new TextDecoder().decode(f.stores[0].records.get(ready.locator))), corrupt = unb64(outer.ciphertext); corrupt[0] ^= 1; outer.ciphertext = b64(corrupt);
  f.stores[0].records.set(ready.locator, encode(outer)); f.stores[1].records.set(ready.locator, new Uint8Array(65537));
  const result = await f.recover(); assert.equal(result.reserve.text, sample);
  assert.deepEqual(result.replicas.map(item => [item.status, item.code]), [['rejected', 'MANIFEST_AUTH_FAILED'], ['rejected', 'RECORD_INVALID'], ['verified', undefined]]);
});

test('timeout plus a valid survivor is bounded and does not retry a read or write', async t => {
  const f = fixture(t), ready = await f.legacy(), pending = deferred(), originalTimer = globalThis.setTimeout; let calls = 0;
  globalThis.setTimeout = (callback, ms, ...args) => originalTimer(callback, ms === 10000 ? 25 : ms, ...args);
  try {
    const replicas = [{ id: 'alpha', store: { get() { calls++; return pending.promise; } } }, f.replicas[1]];
    const result = await f.recover({ replicas }); assert.equal(result.reserve.text, sample);
    assert.deepEqual(result.replicas.map(item => item.status), ['unavailable', 'verified']); assert.equal(calls, 1);
    pending.resolve(f.stores[0].records.get(ready.locator)); await tick(); assert.equal(result.replicas[0].status, 'unavailable'); assert.equal(calls, 1);
  } finally { globalThis.setTimeout = originalTimer; pending.resolve(undefined); }
});

test('all missing and all rejected results fail with safe diagnostics and no plaintext', async t => {
  const missing = fixture(t);
  await assert.rejects(missing.recover(), error => error.code === 'RESERVE_MISSING' && error.replicas.every(item => item.status === 'missing') && diagnosticsAreSafe(error, sample));
  const bad = fixture(t); const ready = await bad.legacy();
  for (const store of bad.stores) store.records.set(ready.locator, new TextEncoder().encode('not-json'));
  await assert.rejects(bad.recover(), error => error.code === 'REPLICA_RECOVERY_FAILED' && error.replicas.every(item => item.status === 'rejected') && diagnosticsAreSafe(error, sample));
});

for (const text of [undefined, 'A different authenticated document.']) test(`authenticated ciphertext divergence fails closed; equal plaintext=${text === undefined}`, async t => {
  const f = fixture(t), ready = await f.legacy(), original = f.stores[0].records.get(ready.locator);
  f.stores[1].records.set(ready.locator, await f.rebox(original, text));
  await assert.rejects(f.recover(), error => error.code === 'REPLICA_CONFLICT' && error.replicas.every(item => item.status === 'verified') && diagnosticsAreSafe(error, sample));
});

test('replica list and policies are validated before a native request or handle consumption', async t => {
  const f = fixture(t), sameStore = f.replicas[0].store;
  const getter = { id: 'alpha' }; Object.defineProperty(getter, 'store', { enumerable: true, get() { throw Error('GETTER_RAN'); } });
  const arrayGetter = [f.replicas[0], f.replicas[1]]; Object.defineProperty(arrayGetter, '1', { enumerable: true, get() { throw Error('GETTER_RAN'); } });
  for (const replicas of [null, [], [f.replicas[0]], Array(2), [...f.replicas, ...f.replicas], arrayGetter,
    [getter, f.replicas[1]], [{ ...f.replicas[0], url: 'https://untrusted.example' }, f.replicas[1]],
    [f.replicas[0], { id: 'alpha', store: memoryStore() }], [f.replicas[0], { id: 'beta', store: sameStore }],
    [{ id: '../alpha', store: memoryStore() }, f.replicas[1]], [{ id: 'A', store: memoryStore() }, f.replicas[1]]]) {
    await assert.rejects(f.recover({ replicas }), code('REPLICAS_INVALID'));
  }
  await assert.rejects(f.recover({ replicas: [{ id: 'alpha', store: {} }, f.replicas[1]] }), code('STORE_INVALID'));
  await assert.rejects(f.recover({ config: { ...f.config, recoveryRpId: 'example' } }), code('CONFIG_INVALID'));
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.recover({ signal: controller.signal }), code('OPERATION_CANCELLED'));
  assert.deepEqual(f.counts, { create: 0, get: 0 }); assert.ok(f.stores.every(store => store.calls.get === 0));
  const handle = await f.create();
  await assert.rejects(f.prepare(handle, { replicas: [f.replicas[0]] }), code('REPLICAS_INVALID'));
  const ready = await f.prepare(handle); assert.equal(ready.status, 'ready');
});

test('any existing or unavailable preflight store prevents every write', async t => {
  for (const unavailable of [false, true]) {
    const f = fixture(t), handle = await f.create(), secret = 'private-provider-locator';
    const store = { ...f.stores[1], async get() { if (unavailable) throw new Error(secret); return Uint8Array.of(1); } };
    await assert.rejects(f.prepare(handle, { replicas: [f.replicas[0], { id: 'beta', store }] }), error => error.code === 'REPLICA_PREPARATION_FAILED' && error.recordMayExist === false && diagnosticsAreSafe(error, secret));
    assert.deepEqual(f.stores.map(value => value.calls.put), [0, 0]); assert.equal(f.counts.get, 0);
  }
});

test('lost write response reports possible partial commit without retry and leaves survivor recovery available', async t => {
  const f = fixture(t), handle = await f.create(), secret = 'provider-message-with-sensitive-data';
  const replica = { id: 'beta', store: { get: f.stores[1].get, async putIfAbsent(locator, bytes) { await f.stores[1].putIfAbsent(locator, bytes); throw new Error(secret); } } };
  await assert.rejects(f.prepare(handle, { replicas: [f.replicas[0], replica] }), error => error.code === 'REPLICA_PREPARATION_FAILED' && error.recordMayExist === true
    && error.replicas[1].status === 'unknown' && diagnosticsAreSafe(error, secret));
  assert.deepEqual(f.stores.map(store => store.calls), [{ get: 1, put: 1 }, { get: 1, put: 1 }]);
  await assert.rejects(f.prepare(handle), code('RESERVE_CREDENTIAL_CONSUMED'));
  const result = await f.recover(); assert.equal(result.reserve.text, sample); assert.ok(f.stores.every(store => store.calls.put === 1));
});

test('a failed write does not stop explicit sibling attempts and readiness is never degraded success', async t => {
  const f = fixture(t, 3), handle = await f.create(); let attempts = 0;
  const replicas = [f.replicas[0], { id: 'beta', store: { get: f.stores[1].get, putIfAbsent() { attempts++; throw Error('DOWN'); } } }, f.replicas[2]];
  await assert.rejects(f.prepare(handle, { replicas }), error => error.code === 'REPLICA_PREPARATION_FAILED' && error.recordMayExist === true);
  assert.equal(attempts, 1); assert.deepEqual(f.stores.map(store => store.calls.put), [1, 0, 1]);
  const result = await f.recover(); assert.deepEqual(result.replicas.map(item => item.status), ['verified', 'missing', 'verified']);
});

test('byte readback is required at every replica before the independent native assertion', async t => {
  const f = fixture(t), handle = await f.create(); let reads = 0;
  const store = { ...f.stores[1], async get(locator) { const bytes = await f.stores[1].get(locator); if (++reads === 2) bytes[bytes.length - 1] ^= 1; return bytes; } };
  await assert.rejects(f.prepare(handle, { replicas: [f.replicas[0], { id: 'beta', store }] }), error => error.code === 'REPLICA_PREPARATION_FAILED' && error.recordMayExist === true
    && error.replicas[1].stage === 'readback' && error.replicas[1].code === 'READBACK_FAILED');
  assert.equal(f.counts.get, 0); assert.deepEqual(f.stores.map(value => value.calls.put), [1, 1]);
});

test('independent verification must authenticate every replica, even if a valid survivor exists', async t => {
  const f = fixture(t), handle = await f.create(); let reads = 0;
  const store = { ...f.stores[1], async get(locator) { const bytes = await f.stores[1].get(locator); if (++reads === 3) return undefined; return bytes; } };
  await assert.rejects(f.prepare(handle, { replicas: [f.replicas[0], { id: 'beta', store }] }), error => error.code === 'INDEPENDENT_CHECK_FAILED' && error.recordMayExist === true
    && error.replicas[0].status === 'verified' && error.replicas[1].status === 'missing');
  assert.equal(f.counts.get, 1); assert.deepEqual(f.stores.map(value => value.calls.get), [3, 3]);
});

test('independent verification compares ciphertext with the exact prepared record, not merely plaintext', async t => {
  const f = fixture(t), handle = await f.create(); let changed;
  const replicas = f.stores.map((storage, index) => ({ id: f.replicas[index].id, store: {
    putIfAbsent: storage.putIfAbsent,
    async get(locator) {
      const bytes = await storage.get(locator);
      if (storage.calls.get === 3) { changed ??= f.rebox(bytes); return new Uint8Array(await changed); }
      return bytes;
    },
  } }));
  await assert.rejects(f.prepare(handle, { replicas }), error => error.code === 'INDEPENDENT_CHECK_FAILED' && error.recordMayExist === true && diagnosticsAreSafe(error, sample));
});

test('replicas and bound methods are snapshotted before asynchronous observer mutation', async t => {
  const f = fixture(t), ready = await f.legacy(), config = { ...f.config }, replicas = f.replicas.map(item => ({ id: item.id, store: { get: item.store.get } }));
  const result = await f.recover({ config, replicas, onProgress(stage) {
    if (stage === 'find-text') { config.appId = 'other'; replicas[0].id = 'mutated'; replicas[0].store.get = () => { throw Error('MUTATED'); }; replicas.length = 0; }
  } });
  assert.equal(result.reserve.locator, ready.locator); assert.deepEqual(result.replicas.map(item => item.id), ['alpha', 'beta']);
});

test('wrong valid credential cannot recover stored copies and never causes a new credential', async t => {
  const f = fixture(t); await f.legacy(); const before = { ...f.counts };
  await assert.rejects(f.recover({ webAuthnClient: { ...f.client, async getCredential(request) { const result = await f.client.getCredential(request); result.credentialId = randomBytes(24); return result; } } }), code('RESERVE_MISSING'));
  assert.equal(f.counts.create, before.create); assert.equal(f.counts.get, before.get + 1);
});

test('cancelling native discovery erases a late PRF response and performs no replica reads', async t => {
  const f = fixture(t), pending = deferred(), controller = new AbortController(), output = randomBytes(32);
  const recovering = f.recover({ signal: controller.signal, webAuthnClient: { ...f.client, getCredential: () => pending.promise } });
  controller.abort(); await assert.rejects(recovering, code('OPERATION_CANCELLED'));
  pending.resolve({ credentialId: f.credentialId, prfOutput: output }); await tick();
  assert.ok(output.every(byte => byte === 0)); assert.ok(f.stores.every(store => store.calls.get === 0));
});

test('cancelling a replica read rejects the whole call even when another copy is valid', async t => {
  const f = fixture(t), ready = await f.legacy(), pending = deferred(), started = deferred(), controller = new AbortController();
  const recovering = f.recover({ signal: controller.signal, replicas: [f.replicas[0], { id: 'beta', store: { get() { started.resolve(); return pending.promise; } } }] });
  await started.promise; controller.abort(); await assert.rejects(recovering, error => error.code === 'OPERATION_CANCELLED' && diagnosticsAreSafe(error, sample));
  pending.resolve(f.stores[1].records.get(ready.locator)); await tick(); assert.ok(f.outputs.every(value => value.prfOutput.every(byte => byte === 0)));
});

test('aborting after writes dispatch reports possible commit and never verifies or retries late acknowledgements', async t => {
  const f = fixture(t), handle = await f.create(), pending = deferred(), started = deferred(), controller = new AbortController(); let completed = 0;
  const replicas = f.replicas.map(({ id, store }) => ({ id, store: {
    get: store.get,
    async putIfAbsent(locator, bytes) { await store.putIfAbsent(locator, bytes); if (++completed === f.replicas.length) started.resolve(); await pending.promise; return true; },
  } }));
  const preparing = f.prepare(handle, { replicas, signal: controller.signal }); await started.promise; controller.abort();
  await assert.rejects(preparing, error => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === true && diagnosticsAreSafe(error, sample));
  pending.resolve(); await tick(); assert.equal(f.counts.get, 0); assert.ok(f.stores.every(store => store.calls.get === 1 && store.calls.put === 1));
  const recovered = await f.recover(); assert.equal(recovered.reserve.text, sample);
});

test('raw PRF is cleared before replica reads and observers cannot alter authenticated outcomes', async t => {
  const f = fixture(t), ready = await f.legacy(), original = crypto.subtle.importKey, imported = [];
  crypto.subtle.importKey = function(format, bytes, algorithm, ...args) {
    if (format === 'raw' && algorithm === 'HKDF') imported.push(bytes);
    return original.call(this, format, bytes, algorithm, ...args);
  };
  try {
    const replicas = f.replicas.map(({ id, store }) => ({ id, store: { get(locator) {
      assert.equal(imported.length, 1); assert.ok(imported.every(bytes => bytes.every(byte => byte === 0)));
      assert.ok(f.outputs.every(value => value.prfOutput.every(byte => byte === 0))); return store.get(locator);
    } } }));
    const result = await f.recover({ replicas, onProgress() { throw Error('OBSERVER'); } }); assert.equal(result.reserve.locator, ready.locator);
  } finally { crypto.subtle.importKey = original; }
});
