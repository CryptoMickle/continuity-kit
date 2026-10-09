import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createTextReserveCredential, prepareTextReserve, recoverTextReserve, validateText, TEXT_PROTOCOL, MAX_TEXT_BYTES } from '../sdk/text-reserve.mjs';

const user = { name: 'Synthetic text reserve', displayName: 'Synthetic text reserve' };
const sample = '\ufeffA real text document.\r\nÅ, 界 and 🦊.\n\nKeep the final newline.\n';
const code = expected => error => error?.code === expected;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const encode = value => new TextEncoder().encode(JSON.stringify(sorted(value)));
const decode = bytes => JSON.parse(new TextDecoder().decode(bytes));
const b64 = value => Buffer.from(value).toString('base64url');
const unb64 = value => new Uint8Array(Buffer.from(value, 'base64url'));
const hash = value => createHash('sha256').update(value).digest('hex');
const prfSalt = () => new Uint8Array(createHash('sha256').update(`${TEXT_PROTOCOL}/prf`).digest());

function memoryStore() {
  const records = new Map(), calls = { get: 0, put: 0 };
  return {
    calls,
    async get(locator) { calls.get++; const value = records.get(locator); return value && new Uint8Array(value); },
    async putIfAbsent(locator, bytes) { calls.put++; if (records.has(locator)) return false; records.set(locator, new Uint8Array(bytes)); return true; },
    records() { return [...records].map(([locator, bytes]) => [locator, new Uint8Array(bytes)]); },
    replace(locator, bytes) { records.set(locator, new Uint8Array(bytes)); },
  };
}
// This deterministic HMAC oracle is a test adapter, not native WebAuthn proof.
function fixture(t, { fallback = false } = {}) {
  const config = Object.freeze({ appId: 'text-' + randomBytes(8).toString('hex'), recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example' });
  const prfKey = randomBytes(32), id = new Uint8Array(randomBytes(24));
  const outputs = [], requests = [], handles = [], counts = { creates: 0, gets: 0 };
  const output = salt => new Uint8Array(createHmac('sha256', prfKey).update(salt).digest());
  const client = {
    createCredential(request) {
      counts.creates++; requests.push({ kind: 'create', salt: new Uint8Array(request.prfSalt), request });
      assert.equal(request.userVerification, 'required'); assert.equal(request.residentKey, 'required');
      const result = { credentialId: new Uint8Array(id), prfEnabled: true, transports: ['internal'], ...(fallback ? {} : { prfOutput: output(request.prfSalt) }) };
      outputs.push(result); return Promise.resolve(result);
    },
    getCredential(request) {
      counts.gets++; requests.push({ kind: 'get', salt: new Uint8Array(request.prfSalt), request });
      assert.equal(request.userVerification, 'required');
      if (request.allowCredential) assert.deepEqual(request.allowCredential.credentialId, id);
      const result = { credentialId: new Uint8Array(id), prfOutput: output(request.prfSalt) };
      outputs.push(result); return Promise.resolve(result);
    },
  };
  const store = memoryStore();
  const create = async overrides => { const result = await createTextReserveCredential({ config, user, webAuthnClient: client, ...overrides }); handles.push(result); return result; };
  const prepare = (recoveryCredential, overrides) => prepareTextReserve({ config, recoveryCredential, text: sample, store, webAuthnClient: client, ...overrides });
  const recover = overrides => recoverTextReserve({ config, store, webAuthnClient: client, ...overrides });
  t.after(() => { for (const handle of handles) handle.close(); prfKey.fill(0); });
  return { config, id, output, outputs, requests, counts, client, store, create, prepare, recover };
}
async function keys(f, config = f.config, credentialId = b64(f.id)) {
  const raw = f.output(prfSalt());
  const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']); raw.fill(0);
  const salt = new Uint8Array(createHash('sha256').update(encode({ format: `${TEXT_PROTOCOL}/hkdf`, config, credentialId })).digest());
  const params = purpose => ({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(`${TEXT_PROTOCOL}/${purpose}`) });
  const lookup = await crypto.subtle.deriveBits(params('locator'), material, 256);
  const locator = b64(createHash('sha256').update(new Uint8Array(lookup)).digest());
  const derive = purpose => crypto.subtle.deriveKey(params(purpose), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { locator, manifest: await derive('manifest-aes-gcm'), text: await derive('text-aes-gcm') };
}
async function editRecord(f, mutate, { textBytes } = {}) {
  const [[locator, bytes]] = f.store.records(), record = decode(bytes), derived = await keys(f);
  const aad = encode({ format: `${TEXT_PROTOCOL}/index`, config: f.config, locator, credentialId: b64(f.id) });
  const manifest = decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.nonce), additionalData: aad }, derived.manifest, unb64(record.ciphertext)));
  await mutate(manifest);
  if (textBytes) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const binding = { format: `${TEXT_PROTOCOL}/text`, config: manifest.config, locator, credentialId: manifest.credentialId, textDigest: manifest.textDigest };
    manifest.textEnvelope = { nonce: b64(nonce), ciphertext: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encode(binding) }, derived.text, textBytes)) };
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  f.store.replace(locator, encode({ format: record.format, nonce: b64(nonce), ciphertext: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, derived.manifest, encode(manifest))) }));
}

for (const fallback of [false, true]) test(`text roundtrips without account and with independent verification; creation fallback=${fallback}`, async t => {
  const f = fixture(t, { fallback }), stages = [], handle = await f.create();
  assert.ok(Object.isFrozen(handle)); assert.ok(Object.isFrozen(handle.transports));
  assert.deepEqual(Object.keys(handle).sort(), ['close', 'credentialId', 'transports']);
  const ready = await f.prepare(handle, { onProgress: stage => stages.push(stage) });
  assert.deepEqual(Object.keys(ready).sort(), ['independentlyVerified', 'locator', 'protocol', 'status', 'text', 'textDigest']);
  assert.deepEqual(stages, ['protect-text', 'verify-text']);
  assert.equal(ready.protocol, TEXT_PROTOCOL); assert.equal(ready.status, 'ready'); assert.equal(ready.independentlyVerified, true);
  assert.equal(ready.text, sample); assert.equal(ready.textDigest, hash(Buffer.from(sample))); assert.ok(Object.isFrozen(ready));
  assert.match(ready.locator, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(f.counts, { creates: 1, gets: fallback ? 2 : 1 });
  assert.deepEqual(f.store.calls, { get: 3, put: 1 });
  assert.deepEqual(f.requests[0].salt, prfSalt());
  const [[locator, bytes]] = f.store.records();
  assert.equal(locator, ready.locator); assert.ok(bytes.length <= 65536);
  assert.deepEqual(Object.keys(decode(bytes)).sort(), ['ciphertext', 'format', 'nonce']);
  assert.equal(new TextDecoder().decode(bytes).includes(sample), false);
  assert.equal(new TextDecoder().decode(bytes).includes(handle.credentialId), false);
  const fresh = await import(`../sdk/text-reserve.mjs?fresh=${randomBytes(6).toString('hex')}`);
  const recovered = await fresh.recoverTextReserve({ config: f.config, store: f.store, webAuthnClient: f.client });
  assert.deepEqual(recovered, { protocol: TEXT_PROTOCOL, locator, text: sample, textDigest: ready.textDigest });
  assert.deepEqual(Object.keys(recovered).sort(), ['locator', 'protocol', 'text', 'textDigest']);
  assert.ok(Object.isFrozen(recovered)); assert.throws(() => { recovered.text = 'changed'; }, TypeError);
  assert.equal(f.store.calls.put, 1);
  assert.ok(f.outputs.every(value => !value.prfOutput || value.prfOutput.every(byte => byte === 0)));
});

test('raw UTF-8 boundary, empty text, BOM and malformed surrogates are handled without normalization', async t => {
  for (const text of ['', '\ufeff\r\n\0🦊', 'x'.repeat(MAX_TEXT_BYTES), '🦊'.repeat(MAX_TEXT_BYTES / 4)]) {
    assert.equal(validateText(text), text);
    const f = fixture(t); await f.prepare(await f.create(), { text }); assert.equal((await f.recover()).text, text);
  }
  for (const value of [null, {}, ['x'], 1, '\ud800', '\udfff', 'x\ud800y']) assert.throws(() => validateText(value), code('TEXT_INVALID'));
  for (const value of ['x'.repeat(MAX_TEXT_BYTES + 1), '界'.repeat(5462), '🦊'.repeat(MAX_TEXT_BYTES / 4) + 'x']) assert.throws(() => validateText(value), code('TEXT_TOO_LARGE'));
});

test('config, user and text failures occur before native/store work and accessors are not invoked', async t => {
  const f = fixture(t);
  const configs = [null, [], { ...f.config, owner: 'forbidden' }, { ...f.config, appId: '' }, { ...f.config, recoveryOrigin: 'http://reserve.example' },
    { ...f.config, recoveryOrigin: 'https://reserve.example/' }, { ...f.config, recoveryOrigin: 'https://reserve.example/path' },
    { ...f.config, recoveryOrigin: 'https://user:password@reserve.example' }, { ...f.config, recoveryOrigin: 'https://reserve.example?x=1' },
    { ...f.config, recoveryOrigin: 'https://reserve.example#x' }, { ...f.config, recoveryRpId: 'example' }, { ...f.config, recoveryRpId: 'Reserve.example' }];
  const accessor = { ...f.config }; Object.defineProperty(accessor, 'appId', { get() { throw new Error('GETTER_RAN'); }, enumerable: true }); configs.push(accessor);
  const symbol = { ...f.config, [Symbol('hidden')]: 1 }; configs.push(symbol);
  for (const config of configs) await assert.rejects(f.create({ config }), code('CONFIG_INVALID'));
  for (const invalidUser of [{ name: '', displayName: 'x' }, { name: 'x', displayName: 'x', extra: true }]) await assert.rejects(f.create({ user: invalidUser }), code('USER_INVALID'));
  for (const timeoutMs of [0, -1, 300001, NaN]) await assert.rejects(f.create({ timeoutMs }), code('TIMEOUT_INVALID'));
  assert.deepEqual(f.counts, { creates: 0, gets: 0 });
  const handle = await f.create();
  await assert.rejects(f.prepare(handle, { text: '\ud800' }), code('TEXT_INVALID'));
  assert.deepEqual(f.store.calls, { get: 0, put: 0 });
  // Preflight rejection does not consume the valid handle.
  await f.prepare(handle);
});

test('loopback development origins are allowed and production HTTP is rejected', async t => {
  const f = fixture(t);
  for (const hostname of ['localhost', 'reserve.localhost', '127.0.0.1']) {
    const config = { ...f.config, recoveryOrigin: `http://${hostname}:8787`, recoveryRpId: hostname };
    const handle = await f.create({ config }); handle.close();
  }
  await assert.rejects(f.create({ config: { ...f.config, recoveryOrigin: 'http://localhost.evil.example', recoveryRpId: 'localhost.evil.example' } }), code('CONFIG_INVALID'));
});

test('browser exact origin is checked before a native ceremony, even for a same-RP port', async t => {
  const f = fixture(t), previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://reserve.example:8443' } });
  try {
    await assert.rejects(f.create(), code('RECOVERY_ORIGIN_MISMATCH'));
    await assert.rejects(f.recover(), code('RECOVERY_ORIGIN_MISMATCH'));
    assert.deepEqual(f.counts, { creates: 0, gets: 0 });
  } finally { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; }
});

test('create and discoverable recovery reach adapter synchronously in caller click stack', async t => {
  const f = fixture(t);
  const creating = f.create(); assert.equal(f.counts.creates, 1);
  const handle = await creating; await f.prepare(handle);
  const before = f.counts.gets, recovering = f.recover(); assert.equal(f.counts.gets, before + 1); await recovering;
  assert.equal(f.requests.at(-1).request.allowCredential, undefined);
  assert.ok(f.requests.every(request => request.salt.length === 32));
});

test('native default client forwards cancellation to navigator and wipes a late PRF result', async t => {
  const f = fixture(t), pending = deferred(), controller = new AbortController(), output = randomBytes(32);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let options;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { create(value) { options = value; return pending.promise; } } } });
  try {
    const creating = createTextReserveCredential({ config: f.config, user, signal: controller.signal });
    assert.ok(options); assert.equal(options.publicKey.authenticatorSelection.userVerification, 'required');
    assert.equal(options.publicKey.authenticatorSelection.residentKey, 'required');
    controller.abort(); await assert.rejects(creating, code('OPERATION_CANCELLED')); assert.equal(options.signal.aborted, true);
    pending.resolve({ type: 'public-key', rawId: new Uint8Array(f.id).buffer, response: { getTransports: () => ['internal'] }, getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: output } } }) });
    await tick(); assert.ok(output.every(byte => byte === 0));
  } finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator; }
});

test('creation fallback rejects an unallowlisted credential and never writes', async t => {
  const f = fixture(t, { fallback: true });
  const client = { ...f.client, async getCredential(request) { const result = await f.client.getCredential(request); result.credentialId = randomBytes(24); return result; } };
  await assert.rejects(f.create({ webAuthnClient: client }));
  assert.deepEqual(f.store.calls, { get: 0, put: 0 });
  assert.ok(f.outputs.every(value => !value.prfOutput || value.prfOutput.every(byte => byte === 0)));
});

test('metadata copies, mismatched configuration, closed and consumed handles cannot enroll', async t => {
  const f = fixture(t), handle = await f.create();
  await assert.rejects(f.prepare({ ...handle }), code('RESERVE_CREDENTIAL_INVALID'));
  await assert.rejects(f.prepare(handle, { config: { ...f.config, appId: 'other' } }), code('CREDENTIAL_MISMATCH'));
  assert.deepEqual(f.store.calls, { get: 0, put: 0 });
  await f.prepare(handle); await assert.rejects(f.prepare(handle), code('RESERVE_CREDENTIAL_CONSUMED'));
  const closed = await f.create(); closed.close(); closed.close();
  await assert.rejects(f.prepare(closed), code('RESERVE_CREDENTIAL_CLOSED'));
});

test('expired creation handles fail without requesting another passkey', async t => {
  const f = fixture(t), handle = await f.create({ timeoutMs: 1000 }), original = Date.now;
  Date.now = () => original() + 2000;
  try { await assert.rejects(f.prepare(handle), code('RESERVE_CREDENTIAL_EXPIRED')); }
  finally { Date.now = original; }
  assert.deepEqual(f.counts, { creates: 1, gets: 0 }); assert.deepEqual(f.store.calls, { get: 0, put: 0 });
});

test('configuration and bound store methods are captured before asynchronous mutation', async t => {
  const f = fixture(t), config = { ...f.config }, store = { ...f.store }, handle = await f.create({ config });
  const ready = await f.prepare(handle, { config, store, onProgress(stage) { if (stage === 'protect-text') { config.appId = 'mutated'; store.get = () => { throw new Error('MUTATED_STORE'); }; } } });
  assert.equal(ready.text, sample); assert.equal((await f.recover()).text, sample);
});

test('protocol, config and credential domains cannot share locators or keys', async t => {
  const f = fixture(t); const ready = await f.prepare(await f.create());
  const original = await keys(f); assert.equal(original.locator, ready.locator);
  for (const config of [{ ...f.config, appId: 'other' }, { ...f.config, recoveryOrigin: 'https://reserve.example:8443' }, { ...f.config, recoveryOrigin: 'https://other.example', recoveryRpId: 'other.example' }]) {
    assert.notEqual((await keys(f, config)).locator, ready.locator);
    await assert.rejects(f.recover({ config }), code('RESERVE_MISSING'));
  }
  const otherId = randomBytes(24);
  const wrongCredential = { ...f.client, async getCredential(request) { const result = await f.client.getCredential(request); result.credentialId = otherId; return result; } };
  await assert.rejects(f.recover({ webAuthnClient: wrongCredential }), code('RESERVE_MISSING'));
  const wrongPrf = { ...f.client, async getCredential(request) { const result = await f.client.getCredential(request); result.prfOutput.fill(7); return result; } };
  await assert.rejects(f.recover({ webAuthnClient: wrongPrf }), code('RESERVE_MISSING'));
  const nonce = randomBytes(12), encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, original.manifest, Buffer.from('key separation'));
  await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, original.text, encrypted));
  assert.equal(original.manifest.extractable, false); assert.equal(original.text.extractable, false);
});

for (const [name, mutate, expected] of [
  ['legacy format', r => { r.format = 'account-continuity/work-reserve-v1/index'; }, 'RECORD_INVALID'],
  ['extra field', r => { r.account = {}; }, 'RECORD_INVALID'],
  ['ciphertext', r => { r.ciphertext = b64(randomBytes(32)); }, 'MANIFEST_AUTH_FAILED'],
  ['nonce', r => { r.nonce = b64(randomBytes(12)); }, 'MANIFEST_AUTH_FAILED'],
]) test(`unauthenticated outer ${name} substitution fails`, async t => {
  const f = fixture(t); await f.prepare(await f.create()); const [[locator, bytes]] = f.store.records(), record = decode(bytes); mutate(record); f.store.replace(locator, encode(record));
  await assert.rejects(f.recover(), code(expected));
});

for (const [name, mutate, expected] of [
  ['configuration', m => { m.config.appId = 'other'; }, 'POLICY_MISMATCH'],
  ['credential', m => { m.credentialId = b64(randomBytes(24)); }, 'CREDENTIAL_MISMATCH'],
  ['manifest format', m => { m.format = 'other'; }, 'MANIFEST_INVALID'],
  ['extra vault', m => { m.vault = {}; }, 'MANIFEST_INVALID'],
  ['digest encoding', m => { m.textDigest = 'not-a-hash'; }, 'TEXT_DIGEST_INVALID'],
  ['digest binding', m => { m.textDigest = 'a'.repeat(64); }, 'TEXT_AUTH_FAILED'],
  ['text ciphertext', m => { m.textEnvelope.ciphertext = b64(randomBytes(32)); }, 'TEXT_AUTH_FAILED'],
]) test(`authenticated manifest ${name} substitution fails`, async t => {
  const f = fixture(t); await f.prepare(await f.create()); await editRecord(f, mutate); await assert.rejects(f.recover(), code(expected));
});

test('authenticated text must match digest, strict UTF-8 and capacity', async t => {
  for (const [textBytes, expected] of [[Buffer.from('modified plaintext'), 'TEXT_DIGEST_MISMATCH'], [Uint8Array.of(0xff, 0xfe), 'TEXT_INVALID'], [Buffer.alloc(MAX_TEXT_BYTES + 1, 65), 'TEXT_AUTH_FAILED']]) {
    const f = fixture(t); await f.prepare(await f.create()); await editRecord(f, () => {}, { textBytes }); await assert.rejects(f.recover(), code(expected));
  }
});

test('oversized, duplicate-key and noncanonical records fail before plaintext is returned', async t => {
  for (const change of [() => Buffer.alloc(65537, 32), bytes => Buffer.concat([Buffer.from(' '), bytes]), bytes => Buffer.from(new TextDecoder().decode(bytes).replace('{', '{"format":"discarded",'))]) {
    const f = fixture(t); await f.prepare(await f.create()); const [[locator, bytes]] = f.store.records(); f.store.replace(locator, change(bytes));
    await assert.rejects(f.recover(), code('RECORD_INVALID'));
  }
});

test('concurrent attempts for the same credential dispatch at most one write', async t => {
  const f = fixture(t), first = await f.create(), second = await f.create();
  const results = await Promise.allSettled([f.prepare(first), f.prepare(second)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'RESERVE_ALREADY_ATTEMPTED');
  assert.equal(f.store.calls.put, 1);
});

test('an existing record is never overwritten, even from a fresh module instance', async t => {
  const f = fixture(t); await f.prepare(await f.create()); const before = f.store.records()[0][1];
  const fresh = await import(`../sdk/text-reserve.mjs?existing=${randomBytes(6).toString('hex')}`);
  const credential = await fresh.createTextReserveCredential({ config: f.config, user, webAuthnClient: f.client });
  await assert.rejects(fresh.prepareTextReserve({ config: f.config, recoveryCredential: credential, text: 'replacement', store: f.store, webAuthnClient: f.client }), code('RESERVE_EXISTS'));
  assert.deepEqual(f.store.records()[0][1], before); assert.equal(f.store.calls.put, 1);
});

test('unknown write outcome is never retried and a committed record remains recoverable', async t => {
  const f = fixture(t), handle = await f.create();
  const store = { get: f.store.get, async putIfAbsent(locator, bytes) { await f.store.putIfAbsent(locator, bytes); throw new Error('RESPONSE_LOST'); } };
  await assert.rejects(f.prepare(handle, { store }), error => error.code === 'STORE_WRITE_UNKNOWN' && error.recordMayExist === true);
  await assert.rejects(f.prepare(handle, { store }), code('RESERVE_CREDENTIAL_CONSUMED'));
  assert.equal(f.store.calls.put, 1); assert.equal((await f.recover()).text, sample);
});

test('write timeout remains unknown after a late acknowledgement; no retry or verification follows', async t => {
  const f = fixture(t), handle = await f.create(), pending = deferred(), originalTimer = globalThis.setTimeout;
  let ioTimers = 0;
  // Accelerate only the second 10-second IO timer (the write). Native and
  // handle deadlines remain real; do not wait ten wall-clock seconds in CI.
  globalThis.setTimeout = (callback, ms, ...args) => originalTimer(callback, ms === 10000 && ++ioTimers === 2 ? 1 : ms, ...args);
  try {
    const store = { get: f.store.get, async putIfAbsent(locator, bytes) { await f.store.putIfAbsent(locator, bytes); await pending.promise; return true; } };
    await assert.rejects(f.prepare(handle, { store }), error => error.code === 'STORE_WRITE_UNKNOWN' && error.recordMayExist === true);
    pending.resolve(); await tick();
    assert.deepEqual(f.store.calls, { get: 1, put: 1 }); assert.equal(f.counts.gets, 0);
  } finally { globalThis.setTimeout = originalTimer; pending.resolve(); }
  assert.equal((await f.recover()).text, sample);
});

test('unexpected write return values fail closed and byte readback substitution prevents readiness', async t => {
  for (const result of [undefined, null, 1, 'true']) {
    const f = fixture(t);
    await assert.rejects(f.prepare(await f.create(), { store: { get: f.store.get, putIfAbsent: async () => result } }), error => error.code === 'STORE_WRITE_UNKNOWN' && error.recordMayExist);
  }
  const f = fixture(t); let reads = 0;
  const store = { ...f.store, async get(locator) { const bytes = await f.store.get(locator); if (++reads === 2) bytes[bytes.length - 1] ^= 1; return bytes; } };
  await assert.rejects(f.prepare(await f.create(), { store }), error => error.code === 'READBACK_FAILED' && error.recordMayExist);
  assert.equal(f.counts.gets, 0); assert.equal(f.store.calls.put, 1);
});

test('independent verification really reasserts and rereads instead of trusting creation keys', async t => {
  const f = fixture(t), handle = await f.create();
  const client = { ...f.client, getCredential() { throw new Error('SECOND_ASSERTION_DENIED'); } };
  await assert.rejects(f.prepare(handle, { webAuthnClient: client }), error => error.recordMayExist === true);
  assert.equal(f.store.calls.put, 1); assert.equal((await f.recover()).text, sample);
});

test('pre-abort and progress abort prevent store writes; observers cannot replace outcomes', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.create({ signal: controller.signal }), code('OPERATION_CANCELLED'));
  assert.equal(f.counts.creates, 0);
  const handle = await f.create(), during = new AbortController();
  await assert.rejects(f.prepare(handle, { signal: during.signal, onProgress() { during.abort(); } }), error => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === false);
  assert.deepEqual(f.store.calls, { get: 0, put: 0 });
  const other = fixture(t);
  const ready = await other.prepare(await other.create(), { onProgress() { throw new Error('OBSERVER'); } }); assert.equal(ready.status, 'ready');
  const recovered = await other.recover({ onProgress() { return Promise.reject(new Error('OBSERVER')); } }); assert.equal(recovered.text, sample);
});

test('cancelling a dispatched write reports possible commit and discards late success', async t => {
  const f = fixture(t), handle = await f.create(), pending = deferred(), started = deferred(), controller = new AbortController();
  const store = { get: f.store.get, async putIfAbsent(locator, bytes) { await f.store.putIfAbsent(locator, bytes); started.resolve(); await pending.promise; return true; } };
  const preparing = f.prepare(handle, { store, signal: controller.signal }); await started.promise;
  controller.abort(); await assert.rejects(preparing, error => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === true);
  pending.resolve(); await tick(); assert.equal(f.counts.gets, 0); assert.equal(f.store.calls.put, 1);
  assert.equal((await f.recover()).text, sample);
});

test('closing a handle cancels pending preparation before write', async t => {
  const f = fixture(t), handle = await f.create(), pending = deferred(), started = deferred();
  const preparing = f.prepare(handle, { store: { ...f.store, get() { started.resolve(); return pending.promise; } } });
  await started.promise; handle.close();
  await assert.rejects(preparing, error => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === false);
  pending.resolve(undefined); await tick(); assert.equal(f.store.calls.put, 0);
});

test('cancelled recovery wipes a late uncooperative adapter output and performs no read', async t => {
  const f = fixture(t), pending = deferred(), controller = new AbortController(), output = randomBytes(32);
  const recovering = f.recover({ signal: controller.signal, webAuthnClient: { ...f.client, getCredential: () => pending.promise } });
  controller.abort(); await assert.rejects(recovering, code('OPERATION_CANCELLED'));
  pending.resolve({ credentialId: f.id, prfOutput: output }); await tick();
  assert.ok(output.every(byte => byte === 0)); assert.deepEqual(f.store.calls, { get: 0, put: 0 });
});

test('text module dependency and API surfaces contain no signing/vault or legacy reserve implementation', async () => {
  const source = await readFile(new URL('../sdk/text-reserve.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ createPasskeyWithPrfOutput, getPasskeyPrfOutput \} from '@category-labs\/mera'/);
  assert.doesNotMatch(source, /from ['"]viem|createSecretVault|decryptSecretVault|SigningSession|toViemAccount|privateKey|expectedOwner|openAccount|work-reserve\.mjs|index\.mjs/);
});
