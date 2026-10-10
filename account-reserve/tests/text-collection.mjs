import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createTextReserveCredential, selectTextReserveCredential, prepareTextReserve, recoverTextReserve, recoverTextReserves, TextReserveError } from '../sdk/text-reserve.mjs';

const code = expected => error => error?.code === expected;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const encode = value => new TextEncoder().encode(JSON.stringify(value, Object.keys(value).sort()));

// Synthetic PRF oracle only. These tests establish call count and protocol
// behavior, not a physical device's prompt count or user verification.
function fixture(t, count = 2) {
  const prefix = randomBytes(8).toString('hex'), key = randomBytes(32), id = new Uint8Array(randomBytes(24));
  const configs = Array.from({ length: count }, (_, index) => ({ appId: `collection-${prefix}-${index}`, recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example' }));
  const outputs = [], requests = [], handles = [], records = new Map(), counts = { creates: 0, gets: 0, reads: 0, writes: 0 };
  const output = salt => new Uint8Array(createHmac('sha256', key).update(salt).digest());
  const nativeResult = request => {
    const result = { credentialId: new Uint8Array(id), prfOutput: output(request.prfSalt) };
    outputs.push(result); return result;
  };
  const client = {
    createCredential(request) {
      counts.creates++; requests.push(request);
      assert.equal(request.residentKey, 'required'); assert.equal(request.userVerification, 'required');
      return Promise.resolve({ ...nativeResult(request), prfEnabled: true });
    },
    getCredential(request) {
      counts.gets++; requests.push(request); assert.equal(request.userVerification, 'required');
      return Promise.resolve(nativeResult(request));
    },
  };
  const store = {
    async get(locator) { counts.reads++; const bytes = records.get(locator); return bytes && new Uint8Array(bytes); },
    async putIfAbsent(locator, bytes) { counts.writes++; if (records.has(locator)) return false; records.set(locator, new Uint8Array(bytes)); return true; },
  };
  const texts = configs.map((_, index) => `\ufeffApp ${index}\r\nDifferent draft — Å, 界, 🦊.\n`);
  const prepared = new Map();
  async function prepare(index) {
    const config = configs[index];
    const handle = handles.length
      ? await selectTextReserveCredential({ config, webAuthnClient: client })
      : await createTextReserveCredential({ config, user: { name: 'Fictional', displayName: 'Synthetic collection' }, webAuthnClient: client });
    handles.push(handle);
    const ready = await prepareTextReserve({ config, recoveryCredential: handle, text: texts[index], store, webAuthnClient: client });
    prepared.set(index, ready); return ready;
  }
  t.after(() => { handles.forEach(handle => handle.close()); key.fill(0); });
  const recover = options => recoverTextReserves({ configs, store, webAuthnClient: client, ...options });
  return { configs, texts, id, outputs, requests, counts, records, client, store, prepared, prepare, recover, nativeResult };
}

for (const count of [1, 2, 8]) test(`${count} existing app namespaces reopen with one synchronous discoverable assertion`, async t => {
  const f = fixture(t, count);
  for (let index = 0; index < count; index++) await f.prepare(index);
  const before = { ...f.counts }, stages = [], recovering = f.recover({ onProgress: stage => stages.push(stage) });
  assert.equal(f.counts.gets, before.gets + 1, 'native adapter is invoked before caller regains the click stack');
  assert.equal(f.requests.at(-1).allowCredential, undefined);
  const results = await recovering;
  assert.ok(Object.isFrozen(results)); assert.equal(results.length, count);
  assert.deepEqual(stages, ['find-text', ...Array(count).fill('open-text')]);
  assert.equal(new Set(results.map(result => result.reserve.locator)).size, count);
  for (const [index, result] of results.entries()) {
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.reserve));
    assert.deepEqual(Object.keys(result).sort(), ['appId', 'reserve', 'status']);
    assert.deepEqual(Object.keys(result.reserve).sort(), ['locator', 'protocol', 'text', 'textDigest']);
    assert.equal(result.appId, f.configs[index].appId); assert.equal(result.status, 'recovered');
    assert.equal(result.reserve.text, f.texts[index]); assert.equal(result.reserve.locator, f.prepared.get(index).locator);
  }
  assert.deepEqual(f.counts, { ...before, gets: before.gets + 1, reads: before.reads + count });
  assert.ok(f.outputs.every(result => result.prfOutput.every(byte => byte === 0)));
  // Collection recovery has no session: a later operation asserts again and
  // the unchanged single-app API reads exactly the same immutable record.
  const single = await recoverTextReserve({ config: f.configs[0], store: f.store, webAuthnClient: f.client });
  assert.deepEqual(single, results[0].reserve); assert.equal(f.counts.gets, before.gets + 2);
});

test('invalid collection and app policies reject before any native or store access', async t => {
  const f = fixture(t);
  const accessorConfig = { ...f.configs[0] };
  Object.defineProperty(accessorConfig, 'appId', { enumerable: true, get() { throw Error('UNTRUSTED_GETTER'); } });
  const accessorList = [f.configs[0]];
  Object.defineProperty(accessorList, '0', { enumerable: true, get() { throw Error('UNTRUSTED_GETTER'); } });
  const extraList = [f.configs[0]]; extraList.selectedCredential = 'ignored?';
  const symbolList = [f.configs[0]]; symbolList[Symbol('hidden')] = true;
  for (const configs of [undefined, null, {}, [], Array(1), Array(9).fill(f.configs[0]), accessorList, extraList, symbolList,
    [f.configs[0], f.configs[0]], [f.configs[0], { ...f.configs[1], recoveryOrigin: 'https://other.example', recoveryRpId: 'other.example' }],
    [f.configs[0], { ...f.configs[1], recoveryOrigin: 'https://reserve.example:8443' }], [accessorConfig],
    [{ ...f.configs[0], appId: '' }], [{ ...f.configs[0], recoveryRpId: 'example' }], [{ ...f.configs[0], recoveryOrigin: 'https://reserve.example/' }]]) {
    await assert.rejects(f.recover({ configs }), error => ['CONFIG_COLLECTION_INVALID', 'CONFIG_INVALID'].includes(error?.code));
  }
  await assert.rejects(f.recover({ store: {} }), code('STORE_INVALID'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.recover({ signal: controller.signal }), code('OPERATION_CANCELLED'));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://reserve.example:8443' } });
  try { await assert.rejects(f.recover(), code('RECOVERY_ORIGIN_MISMATCH')); }
  finally { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; }
  assert.deepEqual(f.counts, { creates: 0, gets: 0, reads: 0, writes: 0 });
});

test('missing, unavailable and corrupt records are isolated without exposing failure metadata', async t => {
  const f = fixture(t, 5);
  for (const index of [0, 2, 3, 4]) await f.prepare(index);
  const corruptLocator = f.prepared.get(3).locator, outer = JSON.parse(new TextDecoder().decode(f.records.get(corruptLocator)));
  const ciphertext = Buffer.from(outer.ciphertext, 'base64url'); ciphertext[0] ^= 1; outer.ciphertext = ciphertext.toString('base64url');
  f.records.set(corruptLocator, encode(outer));
  const hidden = 'sensitive-provider-message-with-locator';
  const before = { ...f.counts };
  const results = await f.recover({ store: { get(locator) {
    if (locator === f.prepared.get(2).locator) throw new Error(hidden);
    if (locator === f.prepared.get(4).locator) throw new TextReserveError(hidden);
    return f.store.get(locator);
  } } });
  assert.deepEqual(results.map(result => result.status), ['recovered', 'missing', 'unavailable', 'rejected', 'rejected']);
  assert.equal(results[0].reserve.text, f.texts[0]);
  assert.deepEqual(results.slice(1).map(result => result.code), ['RESERVE_MISSING', 'STORE_UNAVAILABLE', 'MANIFEST_AUTH_FAILED', 'RECORD_INVALID']);
  for (const result of results.slice(1)) assert.deepEqual(Object.keys(result).sort(), ['appId', 'code', 'status']);
  assert.equal(JSON.stringify(results).includes(hidden), false);
  for (const index of [2, 3, 4]) assert.equal(JSON.stringify(results.slice(1)).includes(f.prepared.get(index).locator), false);
  assert.equal(f.counts.gets, before.gets + 1); assert.equal(f.counts.writes, before.writes);
});

test('app ciphertext substitution fails independently and never returns unauthenticated text', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const first = f.prepared.get(0).locator, second = f.prepared.get(1).locator, firstBytes = f.records.get(first);
  f.records.set(first, f.records.get(second)); f.records.set(second, firstBytes);
  const results = await f.recover();
  assert.deepEqual(results.map(result => [result.status, result.code]), [['rejected', 'MANIFEST_AUTH_FAILED'], ['rejected', 'MANIFEST_AUTH_FAILED']]);
  for (const text of f.texts) assert.equal(JSON.stringify(results).includes(text), false);
});

test('one valid but different selected credential yields missing apps and no creation fallback', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1); const before = { ...f.counts };
  const wrongId = randomBytes(24);
  const results = await f.recover({ webAuthnClient: { ...f.client, async getCredential(request) {
    const result = await f.client.getCredential(request); result.credentialId = wrongId; return result;
  } } });
  assert.ok(results.every(result => result.status === 'missing' && result.code === 'RESERVE_MISSING'));
  assert.equal(f.counts.gets, before.gets + 1); assert.equal(f.counts.creates, before.creates); assert.equal(f.counts.writes, before.writes);
});

test('native denial or malformed PRF rejects the entire collection before reads', async t => {
  const f = fixture(t); let assertions = 0;
  for (const response of [undefined, new Uint8Array(31)]) {
    const client = { ...f.client, getCredential() { assertions++; return Promise.resolve({ credentialId: f.id, ...(response ? { prfOutput: response } : {}) }); } };
    await assert.rejects(f.recover({ webAuthnClient: client }));
  }
  await assert.rejects(f.recover({ webAuthnClient: { ...f.client, getCredential() { assertions++; throw Object.assign(new Error('Denied'), { name: 'NotAllowedError' }); } } }));
  assert.equal(assertions, 3); assert.deepEqual(f.counts, { creates: 0, gets: 0, reads: 0, writes: 0 });
});

test('PRF outputs owned by the adapter and Mera are erased before the first store read', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const original = crypto.subtle.importKey, importedRaw = [];
  crypto.subtle.importKey = function(format, bytes, algorithm, ...args) {
    if (format === 'raw' && algorithm === 'HKDF') importedRaw.push(bytes);
    return original.call(this, format, bytes, algorithm, ...args);
  };
  try {
    const results = await f.recover({ store: { get(locator) {
      assert.equal(importedRaw.length, 2);
      assert.ok(importedRaw.every(bytes => bytes.every(byte => byte === 0)));
      assert.ok(f.outputs.every(result => result.prfOutput.every(byte => byte === 0)));
      return f.store.get(locator);
    } } });
    assert.ok(results.every(result => result.status === 'recovered'));
  } finally { crypto.subtle.importKey = original; }
});

test('configuration array and store method are captured before asynchronous mutation', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const configs = f.configs.map(config => ({ ...config })), store = { get: f.store.get };
  const result = await f.recover({ configs, store, onProgress(stage) {
    if (stage === 'find-text') {
      configs[0].appId = 'attacker-app'; configs[1].recoveryOrigin = 'https://other.example'; configs.length = 0;
      store.get = () => { throw Error('MUTATED_STORE'); };
    }
  } });
  assert.deepEqual(result.map(value => value.appId), f.configs.map(config => config.appId));
  assert.deepEqual(result.map(value => value.reserve.text), f.texts);
});

test('cancellation rejects all results, forwards native abort and clears a late adapter response', async t => {
  const f = fixture(t), pending = deferred(), controller = new AbortController(), late = randomBytes(32);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let nativeOptions, creates = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
    get(options) { nativeOptions = options; return pending.promise; }, create() { creates++; throw Error('UNEXPECTED_CREATE'); },
  } } });
  try {
    const recovering = recoverTextReserves({ configs: f.configs, store: f.store, signal: controller.signal });
    assert.ok(nativeOptions); assert.equal(nativeOptions.publicKey.allowCredentials, undefined);
    controller.abort(); await assert.rejects(recovering, code('OPERATION_CANCELLED')); assert.equal(nativeOptions.signal.aborted, true);
    pending.resolve({ type: 'public-key', rawId: new Uint8Array(f.id).buffer, getClientExtensionResults: () => ({ prf: { results: { first: late } } }) });
    await tick(); assert.ok(late.every(byte => byte === 0)); assert.equal(creates, 0); assert.equal(f.counts.reads, 0);
  } finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator; }
});

test('cancelling an in-flight read returns no partial plaintext and ignores late storage success', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const pending = deferred(), started = deferred(), controller = new AbortController(), slow = f.prepared.get(1).locator;
  let opened = 0;
  const recovering = f.recover({ signal: controller.signal, store: { get(locator) {
    if (locator === slow) { started.resolve(); return pending.promise; }
    return f.store.get(locator);
  } }, onProgress(stage) { if (stage === 'open-text') opened++; } });
  await started.promise; controller.abort(); await assert.rejects(recovering, code('OPERATION_CANCELLED'));
  const openedAtCancellation = opened;
  pending.resolve(new Uint8Array(f.records.get(slow))); await tick();
  assert.equal(opened, openedAtCancellation); assert.ok(f.outputs.every(result => result.prfOutput.every(byte => byte === 0)));
});

test('read timeout is app-specific and late success does not replace the frozen unavailable result', async t => {
  const f = fixture(t); await f.prepare(0); await f.prepare(1);
  const slow = f.prepared.get(1).locator, pending = deferred(), originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => originalTimer(callback, ms === 10000 ? 30 : ms, ...args);
  try {
    const results = await f.recover({ store: { get(locator) { return locator === slow ? pending.promise : f.store.get(locator); } } });
    assert.equal(results[0].status, 'recovered'); assert.deepEqual(results[1], { appId: f.configs[1].appId, status: 'unavailable', code: 'STORE_UNAVAILABLE' });
    pending.resolve(new Uint8Array(f.records.get(slow))); await tick(); assert.equal(results[1].status, 'unavailable');
  } finally { globalThis.setTimeout = originalTimer; pending.resolve(undefined); }
});

test('whole-operation timeout and observer cancellation never become per-app failures', async t => {
  const f = fixture(t), originalTimer = globalThis.setTimeout, pending = deferred();
  globalThis.setTimeout = (callback, ms, ...args) => originalTimer(callback, ms === 300000 ? 10 : ms, ...args);
  try {
    await assert.rejects(f.recover({ webAuthnClient: { ...f.client, getCredential: () => pending.promise } }), code('OPERATION_TIMED_OUT'));
  } finally { globalThis.setTimeout = originalTimer; pending.resolve({ credentialId: f.id, prfOutput: randomBytes(32) }); }
  const controller = new AbortController();
  await assert.rejects(f.recover({ signal: controller.signal, onProgress() { controller.abort(); } }), code('OPERATION_CANCELLED'));
  assert.equal(f.counts.reads, 0);
  const result = await f.recover({ onProgress() { throw Error('OBSERVER_THROW'); } });
  assert.ok(result.every(value => value.status === 'missing'));
});
