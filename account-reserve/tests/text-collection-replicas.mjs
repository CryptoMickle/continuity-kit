import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { TEXT_PROTOCOL, createTextReserveCredential, selectTextReserveCredential, prepareTextReserve, recoverTextReserve, recoverTextReservesFromReplicas, TextReserveError } from '../sdk/text-reserve.mjs';

const code = expected => error => error?.code === expected;
const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
const encode = value => new TextEncoder().encode(JSON.stringify(sort(value)));
const digest = value => new Uint8Array(createHash('sha256').update(value).digest());
const b64 = value => Buffer.from(value).toString('base64url');
const unb64 = value => new Uint8Array(Buffer.from(value, 'base64url'));

// This test oracle verifies one assertion and actual SDK cryptography. It is
// not a device and makes no claim about native confirmation count.
function fixture(t, count = 2, replicaCount = 2) {
  const prefix = randomBytes(8).toString('hex'), key = randomBytes(32), credentialId = new Uint8Array(randomBytes(24));
  const counts = { creates: 0, assertions: 0, reads: 0, writes: 0 }, outputs = [], requests = [], handles = [], prepared = new Map();
  const prf = salt => new Uint8Array(createHmac('sha256', key).update(salt).digest());
  const response = request => { const value = { credentialId: new Uint8Array(credentialId), prfOutput: prf(request.prfSalt) }; outputs.push(value); return value; };
  const client = {
    createCredential(request) { counts.creates++; requests.push(request); return Promise.resolve({ ...response(request), prfEnabled: true }); },
    getCredential(request) { counts.assertions++; requests.push(request); assert.equal(request.userVerification, 'required'); return Promise.resolve(response(request)); },
  };
  const stores = Array.from({ length: replicaCount }, () => {
    const records = new Map();
    return { records, async get(locator) { counts.reads++; const bytes = records.get(locator); return bytes && new Uint8Array(bytes); },
      async putIfAbsent(locator, bytes) { counts.writes++; if (records.has(locator)) return false; records.set(locator, new Uint8Array(bytes)); return true; } };
  });
  const configs = Array.from({ length: count }, (_, index) => ({ appId: `replica-collection-${prefix}-${index}`, recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example' }));
  const apps = configs.map(config => ({ config, replicas: stores.map((store, index) => ({ id: ['alpha', 'beta', 'gamma'][index], store })) }));
  const texts = configs.map((_, index) => `\ufeffFictional app ${index}.\r\nSeparate draft — Å, 界 and 🦊.\n`);
  async function prepare(index) {
    const config = configs[index], recoveryCredential = handles.length
      ? await selectTextReserveCredential({ config, webAuthnClient: client })
      : await createTextReserveCredential({ config, user: { name: 'Fictional', displayName: 'Synthetic collection test' }, webAuthnClient: client });
    handles.push(recoveryCredential);
    // Legacy single-store records deliberately prove protocol compatibility.
    const ready = await prepareTextReserve({ config, recoveryCredential, text: texts[index], store: stores[0], webAuthnClient: client });
    for (const store of stores.slice(1)) store.records.set(ready.locator, new Uint8Array(stores[0].records.get(ready.locator)));
    prepared.set(index, ready); return ready;
  }
  async function rebox(index) {
    const config = configs[index], locator = prepared.get(index).locator, bytes = stores[0].records.get(locator);
    const raw = prf(digest(Buffer.from(`${TEXT_PROTOCOL}/prf`)));
    const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']); raw.fill(0);
    const salt = digest(encode({ format: `${TEXT_PROTOCOL}/hkdf`, config, credentialId: b64(credentialId) }));
    const manifestKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(`${TEXT_PROTOCOL}/manifest-aes-gcm`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const outer = JSON.parse(new TextDecoder().decode(bytes)), aad = encode({ format: `${TEXT_PROTOCOL}/index`, config, locator, credentialId: b64(credentialId) });
    const manifest = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(outer.nonce), additionalData: aad }, manifestKey, unb64(outer.ciphertext)));
    try { const nonce = randomBytes(12); return encode({ format: outer.format, nonce: b64(nonce), ciphertext: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, manifestKey, manifest)) }); }
    finally { manifest.fill(0); }
  }
  t.after(() => { handles.forEach(handle => handle.close()); key.fill(0); });
  return { apps, configs, stores, texts, client, counts, outputs, requests, credentialId, prepared, prepare, rebox,
    recover: options => recoverTextReservesFromReplicas({ apps, webAuthnClient: client, ...options }) };
}
function safeResults(results) {
  assert.ok(Object.isFrozen(results));
  for (const result of results) {
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.replicas));
    assert.deepEqual(Object.keys(result).sort(), result.status === 'recovered' ? ['appId', 'replicas', 'reserve', 'status'] : ['appId', 'code', 'replicas', 'status']);
    for (const replica of result.replicas) {
      assert.ok(Object.isFrozen(replica)); assert.equal(replica.stage, 'verify');
      assert.ok(Object.keys(replica).every(key => ['id', 'stage', 'status', 'code'].includes(key)));
      assert.ok(['verified', 'missing', 'unavailable', 'rejected'].includes(replica.status));
    }
    if (result.status === 'recovered') { assert.ok(Object.isFrozen(result.reserve)); assert.deepEqual(Object.keys(result.reserve).sort(), ['locator', 'protocol', 'text', 'textDigest']); }
  }
}

for (const [count, replicaCount] of [[1, 2], [2, 3], [8, 3]]) test(`${count} apps and ${replicaCount} shared stores use one synchronous discoverable assertion`, async t => {
  const f = fixture(t, count, replicaCount); for (let index = 0; index < count; index++) await f.prepare(index);
  const before = { ...f.counts }, stages = [], pending = f.recover({ onProgress: value => stages.push(value) });
  assert.equal(f.counts.assertions, before.assertions + 1); assert.equal(f.requests.at(-1).allowCredential, undefined);
  const results = await pending; safeResults(results);
  assert.equal(new Set(results.map(item => item.reserve.locator)).size, count);
  assert.deepEqual(results.map(item => item.appId), f.configs.map(item => item.appId));
  assert.deepEqual(results.map(item => item.reserve.text), f.texts);
  assert.deepEqual(stages, ['find-text', ...Array(count * replicaCount).fill('open-text')]);
  assert.ok(results.every(item => item.replicas.every(replica => replica.status === 'verified')));
  assert.deepEqual(f.counts, { ...before, assertions: before.assertions + 1, reads: before.reads + count * replicaCount });
  assert.ok(f.outputs.every(item => item.prfOutput.every(byte => byte === 0)));
  const single = await recoverTextReserve({ config: f.configs[0], store: f.stores[0], webAuthnClient: f.client });
  assert.deepEqual(single, results[0].reserve);
});

test('all app and replica policies are validated before native discovery or any store call', async t => {
  const f = fixture(t), malformed = [undefined, null, {}, [], Array(1), Array(9).fill(f.apps[0]), [f.apps[0], f.apps[0]]];
  const copy = () => f.apps.map(app => ({ config: { ...app.config }, replicas: app.replicas.map(replica => ({ ...replica })) }));
  for (const mutate of [
    apps => { apps[1].config.recoveryOrigin = 'https://other.example'; apps[1].config.recoveryRpId = 'other.example'; },
    apps => { apps[1].config.recoveryOrigin += ':8443'; }, apps => { apps[1].config.recoveryRpId = 'example'; },
    apps => { apps[1].config.appId = ''; }, apps => { apps[1].extra = true; }, apps => { apps.extra = true; },
    apps => { apps[1].replicas = []; }, apps => { apps[1].replicas.pop(); }, apps => { apps[1].replicas.push(...apps[1].replicas); },
    apps => { apps[1].replicas[1].id = 'alpha'; }, apps => { apps[1].replicas[1].store = apps[1].replicas[0].store; },
    apps => { apps[1].replicas[0].id = 'Invalid'; }, apps => { apps[1].replicas[0].url = 'https://untrusted.example'; },
    apps => { apps[1].replicas[0].store = {}; },
  ]) { const apps = copy(); mutate(apps); malformed.push(apps); }
  for (const apps of malformed) await assert.rejects(f.recover({ apps }), error => ['CONFIG_COLLECTION_INVALID', 'CONFIG_INVALID', 'REPLICAS_INVALID', 'STORE_INVALID'].includes(error.code));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://reserve.example:8443' } });
  try { await assert.rejects(f.recover(), code('RECOVERY_ORIGIN_MISMATCH')); }
  finally { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; }
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.recover({ signal: controller.signal }), code('OPERATION_CANCELLED'));
  assert.deepEqual(f.counts, { creates: 0, assertions: 0, reads: 0, writes: 0 });
});

test('accessor policies and store methods cannot run before validation', async t => {
  const f = fixture(t); let calls = 0;
  const getter = { enumerable: true, get() { calls++; throw Error('PRIVATE_GETTER_DATA'); } };
  for (const mutate of [apps => Object.defineProperty(apps, '0', getter), apps => Object.defineProperty(apps[0], 'config', getter),
    apps => Object.defineProperty(apps[0], 'replicas', getter), apps => Object.defineProperty(apps[0].config, 'appId', getter),
    apps => Object.defineProperty(apps[0].replicas, '0', getter), apps => Object.defineProperty(apps[0].replicas[0], 'store', getter),
    apps => { apps[0].replicas[0].store = Object.defineProperty({}, 'get', getter); },
  ]) {
    const apps = f.apps.map(app => ({ config: { ...app.config }, replicas: app.replicas.map(replica => ({ ...replica })) })); mutate(apps);
    await assert.rejects(f.recover({ apps }));
  }
  assert.equal(calls, 0); assert.deepEqual(f.counts, { creates: 0, assertions: 0, reads: 0, writes: 0 });
});

test('missing, unavailable, rejected and recovered apps remain independent with sanitized diagnostics', async t => {
  const f = fixture(t, 5); for (const index of [0, 2, 3, 4]) await f.prepare(index);
  const unavailable = f.prepared.get(2).locator, bad = f.prepared.get(3).locator, survivor = f.prepared.get(4).locator;
  for (const store of f.stores) store.records.set(bad, new TextEncoder().encode('private malformed record'));
  f.stores[0].records.set(survivor, new TextEncoder().encode('bad'));
  const secret = 'provider-private-message';
  const apps = f.apps.map(app => ({ ...app, replicas: app.replicas.map(({ id, store }) => ({ id, store: { get(locator) {
    if (locator === unavailable) throw new Error(secret); return store.get(locator);
  } } })) }));
  const before = { ...f.counts }, results = await f.recover({ apps }); safeResults(results);
  assert.deepEqual(results.map(item => [item.status, item.code]), [['recovered', undefined], ['missing', 'RESERVE_MISSING'], ['unavailable', 'REPLICA_RECOVERY_FAILED'], ['rejected', 'REPLICA_RECOVERY_FAILED'], ['recovered', undefined]]);
  assert.deepEqual(results[4].replicas.map(item => item.status), ['rejected', 'verified']); assert.equal(results[4].reserve.text, f.texts[4]);
  const failed = JSON.stringify(results.filter(item => item.status !== 'recovered')); assert.equal(failed.includes(secret), false);
  for (const index of [2, 3]) { assert.equal(failed.includes(f.prepared.get(index).locator), false); assert.equal(failed.includes(f.texts[index]), false); }
  assert.equal(f.counts.assertions, before.assertions + 1); assert.equal(f.counts.writes, before.writes);
});

test('different authenticated bytes with equal plaintext reject only the conflicting app', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const locator = f.prepared.get(0).locator, alternate = await f.rebox(0); assert.notDeepEqual(alternate, f.stores[0].records.get(locator));
  f.stores[1].records.set(locator, alternate);
  assert.equal((await recoverTextReserve({ config: f.configs[0], store: f.stores[1], webAuthnClient: f.client })).text, f.texts[0]);
  const results = await f.recover(); safeResults(results);
  assert.deepEqual([results[0].status, results[0].code], ['rejected', 'REPLICA_CONFLICT']);
  assert.ok(results[0].replicas.every(item => item.status === 'verified')); assert.equal(Object.hasOwn(results[0], 'reserve'), false);
  assert.equal(results[1].status, 'recovered'); assert.equal(results[1].reserve.text, f.texts[1]);
});

test('cross-app ciphertext substitution is authenticated independently and cannot disclose another app', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const a = f.prepared.get(0).locator, b = f.prepared.get(1).locator;
  for (const store of f.stores) { const bytes = store.records.get(a); store.records.set(a, store.records.get(b)); store.records.set(b, bytes); }
  const results = await f.recover(); assert.ok(results.every(item => item.status === 'rejected'));
  assert.ok(results.every(item => item.replicas.every(replica => replica.code === 'MANIFEST_AUTH_FAILED')));
  for (const text of f.texts) assert.equal(JSON.stringify(results).includes(text), false);
});

test('one wrong valid credential yields missing apps without creating credentials or writing', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1); const before = { ...f.counts };
  const results = await f.recover({ webAuthnClient: { ...f.client, async getCredential(request) { const value = await f.client.getCredential(request); value.credentialId = randomBytes(24); return value; } } });
  assert.ok(results.every(item => item.status === 'missing' && item.code === 'RESERVE_MISSING'));
  assert.equal(f.counts.assertions, before.assertions + 1); assert.equal(f.counts.creates, before.creates); assert.equal(f.counts.writes, before.writes);
});

test('all raw PRF buffers are erased before any app or replica I/O', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const original = crypto.subtle.importKey, imported = [];
  crypto.subtle.importKey = function(format, bytes, algorithm, ...args) { if (format === 'raw' && algorithm === 'HKDF') imported.push(bytes); return original.call(this, format, bytes, algorithm, ...args); };
  try {
    const apps = f.apps.map(app => ({ ...app, replicas: app.replicas.map(({ id, store }) => ({ id, store: { get(locator) {
      assert.equal(imported.length, 2); assert.ok(imported.every(bytes => bytes.every(byte => byte === 0))); assert.ok(f.outputs.every(value => value.prfOutput.every(byte => byte === 0)));
      return store.get(locator);
    } } })) }));
    assert.ok((await f.recover({ apps })).every(item => item.status === 'recovered'));
  } finally { crypto.subtle.importKey = original; }
});

test('app policy, ordered replicas and bound methods survive observer mutation', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const apps = f.apps.map(app => ({ config: { ...app.config }, replicas: app.replicas.map(({ id, store }) => ({ id, store: { get: store.get } })) }));
  const results = await f.recover({ apps, onProgress(stage) {
    if (stage === 'find-text') { for (const app of apps) { app.config.appId = 'mutated'; for (const replica of app.replicas) { replica.id = 'mutated'; replica.store.get = () => { throw Error('MUTATED'); }; } app.replicas.reverse(); } apps.length = 0; }
  } });
  assert.deepEqual(results.map(item => item.appId), f.configs.map(item => item.appId)); assert.deepEqual(results.map(item => item.reserve.text), f.texts);
  assert.ok(results.every(item => item.replicas.map(replica => replica.id).join(',') === 'alpha,beta'));
});

test('native denial or malformed PRF fails the whole collection without provider details or reads', async t => {
  const f = fixture(t);
  for (const getCredential of [() => { throw Object.assign(new Error('private-native-message'), { name: 'NotAllowedError' }); },
    () => Promise.resolve({ credentialId: f.credentialId }), () => Promise.resolve({ credentialId: f.credentialId, prfOutput: new Uint8Array(31) })]) {
    await assert.rejects(f.recover({ webAuthnClient: { ...f.client, getCredential } }), error => {
      assert.equal(error.code, 'CREDENTIAL_UNAVAILABLE'); assert.equal(error.message, 'CREDENTIAL_UNAVAILABLE'); assert.equal(JSON.stringify(error).includes('private-native-message'), false); return true;
    });
  }
  assert.equal(f.counts.reads, 0); assert.equal(f.counts.creates, 0);
});

test('cancellation erases late native PRF output and never returns partial results', async t => {
  const f = fixture(t), pending = deferred(), controller = new AbortController(), late = randomBytes(32);
  const recovering = f.recover({ signal: controller.signal, webAuthnClient: { ...f.client, getCredential: () => pending.promise } });
  controller.abort(); await assert.rejects(recovering, code('OPERATION_CANCELLED'));
  pending.resolve({ credentialId: f.credentialId, prfOutput: late }); await tick(); assert.ok(late.every(byte => byte === 0)); assert.equal(f.counts.reads, 0);
});

test('aborting after an app reaches open-text suppresses every result and ignores late storage bytes', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const pending = deferred(), started = deferred(), firstOpened = deferred(), controller = new AbortController(), slow = f.prepared.get(1).locator; let opened = 0;
  const apps = f.apps.map(app => ({ ...app, replicas: app.replicas.map(({ id, store }) => ({ id, store: { get(locator) { if (locator === slow) { started.resolve(); return pending.promise; } return store.get(locator); } } })) }));
  const recovering = f.recover({ apps, signal: controller.signal, onProgress(stage) { if (stage === 'open-text') { opened++; firstOpened.resolve(); } } });
  await started.promise; await firstOpened.promise; await tick(); assert.ok(opened > 0);
  controller.abort(); await assert.rejects(recovering, code('OPERATION_CANCELLED')); const atAbort = opened;
  pending.resolve(new Uint8Array(f.stores[0].records.get(slow))); await tick(); assert.equal(opened, atAbort); assert.ok(f.outputs.every(item => item.prfOutput.every(byte => byte === 0)));
});

test('a throwing provider error accessor cannot return pending diagnostics before a sibling read settles', async t => {
  const f = fixture(t); await f.prepare(1);
  const pending = deferred(), started = deferred(), secret = 'untrusted-private-provider-data'; let settled = false;
  const providerError = new TextReserveError(secret); Object.defineProperty(providerError, 'code', { get() { throw Error(secret); } });
  const apps = [{ ...f.apps[0], replicas: [{ id: 'alpha', store: { get() { throw providerError; } } }, { id: 'beta', store: { get() { started.resolve(); return pending.promise; } } }] }, f.apps[1]];
  const recovering = f.recover({ apps }); recovering.then(() => { settled = true; }, () => { settled = true; });
  await started.promise; await tick(); assert.equal(settled, false, 'the complete replica set must settle before returning');
  pending.resolve(undefined); const results = await recovering; safeResults(results);
  assert.deepEqual(results[0], { appId: f.configs[0].appId, status: 'unavailable', code: 'REPLICA_RECOVERY_FAILED', replicas: [
    { id: 'alpha', stage: 'verify', status: 'unavailable', code: 'STORE_UNAVAILABLE' }, { id: 'beta', stage: 'verify', status: 'missing', code: 'RESERVE_MISSING' },
  ] });
  assert.equal(results[1].status, 'recovered'); assert.equal(results[1].reserve.text, f.texts[1]); assert.equal(JSON.stringify(results).includes(secret), false);
});

test('per-replica timeout preserves survivors and frozen unavailable diagnostics after late completion', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1); const pending = deferred(), original = globalThis.setTimeout; let reads = 0;
  globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === 10000 ? 25 : ms, ...args);
  try {
    const apps = f.apps.map(app => ({ ...app, replicas: [{ id: 'alpha', store: { get() { reads++; return pending.promise; } } }, app.replicas[1]] }));
    const before = { ...f.counts }, results = await f.recover({ apps }); safeResults(results);
    assert.ok(results.every(item => item.status === 'recovered' && item.replicas[0].status === 'unavailable' && item.replicas[1].status === 'verified'));
    assert.equal(reads, 2); assert.equal(f.counts.writes, before.writes); pending.resolve(new Uint8Array(f.stores[0].records.get(f.prepared.get(0).locator))); await tick();
    assert.ok(results.every(item => item.replicas[0].status === 'unavailable'));
  } finally { globalThis.setTimeout = original; pending.resolve(undefined); }
});

test('whole-operation timeout and observer cancellation remain global failures', async t => {
  const f = fixture(t), pending = deferred(), original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === 300000 ? 15 : ms, ...args);
  try { await assert.rejects(f.recover({ webAuthnClient: { ...f.client, getCredential: () => pending.promise } }), code('OPERATION_TIMED_OUT')); }
  finally { globalThis.setTimeout = original; pending.resolve({ credentialId: f.credentialId, prfOutput: randomBytes(32) }); }
  const controller = new AbortController(); await assert.rejects(f.recover({ signal: controller.signal, onProgress() { controller.abort(); } }), code('OPERATION_CANCELLED'));
  assert.equal(f.counts.reads, 0); const results = await f.recover({ onProgress() { throw Error('OBSERVER_THROW'); } }); assert.ok(results.every(item => item.status === 'missing'));
});
