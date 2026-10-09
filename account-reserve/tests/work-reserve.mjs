import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { hexToBytes, sha256, toBytes, verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSecretVaultWithExistingPasskey, decryptSecretVaultWithPasskey } from '@category-labs/mera';
import { createWorkReserveCredential, prepareWorkReserve, recoverWorkReserve, validateWork, WORK_PROTOCOL, WORK_SCHEMA, MAX_WORK_BYTES } from '../sdk/work-reserve.mjs';
import { prepareReserve, recoverReserve, PROTOCOL } from '../sdk/index.mjs';
import { memoryStore } from './sdk-fixture.mjs';

const user = { name: 'Synthetic work reserve', displayName: 'Synthetic work reserve' };
const sample = Object.freeze({ schema: WORK_SCHEMA, title: 'Synthetic commission', client: 'Example customer', brief: 'Draft a simple accessible landing page.', deliverable: 'One responsive page and sources.', nextStep: 'Review contrast and deliver the draft.' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const encode = value => new TextEncoder().encode(JSON.stringify(sorted(value)));
const decode = bytes => JSON.parse(new TextDecoder().decode(bytes));
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const unb64 = text => new Uint8Array(Buffer.from(text, 'base64url'));
const digest = value => sha256(encode(value)).slice(2);

// RAM-only HMAC oracle. Counts measure API calls, never real device prompts.
function fixture(t, { fallback = false } = {}) {
  const config = Object.freeze({ appId: 'work-' + randomBytes(8).toString('hex'), originalRpId: 'original.localhost', recoveryRpId: 'work.localhost', derivation: 'synthetic-leaf:v1' });
  const rawKey = generatePrivateKey(), privateKey = hexToBytes(rawKey);
  const policy = { ...config, expectedOwner: privateKeyToAccount(rawKey).address.toLowerCase() };
  const prfKey = randomBytes(32), id = new Uint8Array(randomBytes(24));
  const outputs = [], requests = [], handles = [], contexts = [];
  const counts = { creates: 0, gets: 0 };
  const output = salt => new Uint8Array(createHmac('sha256', prfKey).update(salt).digest());
  const client = {
    createCredential(request) {
      counts.creates++; requests.push({ kind: 'create', salt: new Uint8Array(request.prfSalt), request });
      assert.equal(request.rp.id, config.recoveryRpId); assert.equal(request.userVerification, 'required'); assert.equal(request.residentKey, 'required');
      const result = { credentialId: new Uint8Array(id), prfEnabled: true, transports: ['internal'], ...(fallback ? {} : { prfOutput: output(request.prfSalt) }) };
      outputs.push(result); return Promise.resolve(result);
    },
    getCredential(request) {
      counts.gets++; requests.push({ kind: 'get', salt: new Uint8Array(request.prfSalt), request });
      assert.equal(request.rpId, config.recoveryRpId); assert.equal(request.userVerification, 'required');
      if (request.allowCredential) assert.deepEqual(request.allowCredential.credentialId, id);
      const result = { credentialId: new Uint8Array(id), prfOutput: output(request.prfSalt) };
      outputs.push(result); return Promise.resolve(result);
    },
  };
  const store = memoryStore();
  const create = async overrides => { const handle = await createWorkReserveCredential({ config, user, webAuthnClient: client, ...overrides }); handles.push(handle); return handle; };
  const prepare = (credential, overrides) => prepareWorkReserve({ privateKey, policy, recoveryCredential: credential, work: sample, webAuthnClient: client, store, ...overrides });
  const recover = async overrides => { const context = await recoverWorkReserve({ config, store, webAuthnClient: client, ...overrides }); contexts.push(context); return context; };
  t.after(() => { for (const context of contexts) context.close(); for (const handle of handles) handle.close(); privateKey.fill(0); prfKey.fill(0); });
  return { config, policy, privateKey, client, counts, requests, outputs, store, create, prepare, recover, output };
}
async function keys(f) {
  const salt = hexToBytes(sha256(toBytes(`${WORK_PROTOCOL}/bootstrap\0${f.config.appId}`)));
  const raw = f.output(salt);
  const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  raw.fill(0); salt.fill(0);
  const hkdfSalt = hexToBytes(sha256(toBytes(`${WORK_PROTOCOL}/hkdf`)));
  const derive = info => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: toBytes(`${WORK_PROTOCOL}/${info}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { manifest: await derive('manifest-aes-gcm'), work: await derive('work-aes-gcm') };
}
async function editRecord(f, mutate, { rewriteWork = false } = {}) {
  const [[locator, bytes]] = f.store.records(), record = decode(bytes), derived = await keys(f);
  const outerAAD = encode({ format: `${WORK_PROTOCOL}/index`, config: f.config, locator });
  const manifest = decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.nonce), additionalData: outerAAD }, derived.manifest, unb64(record.ciphertext)));
  const binding = m => ({ format: `${WORK_PROTOCOL}/work`, config: m.config, locator, owner: m.owner, credentialId: m.credentialId, workDigest: m.workDigest, vaultDigest: m.vaultDigest });
  let payload;
  if (rewriteWork) payload = decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(manifest.workEnvelope.nonce), additionalData: encode(binding(manifest)) }, derived.work, unb64(manifest.workEnvelope.ciphertext)));
  await mutate(manifest, payload);
  if (rewriteWork) {
    const currentBinding = binding(manifest);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    manifest.workEnvelope = { nonce: b64(nonce), ciphertext: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encode(currentBinding) }, derived.work, encode({ ...payload, ...currentBinding }))) };
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  f.store.replace(locator, encode({ format: record.format, nonce: b64(nonce), ciphertext: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: outerAAD }, derived.manifest, encode(manifest))) }));
}

for (const fallback of [false, true]) test(`immutable work setup verifies work and account; creation fallback=${fallback}`, async t => {
  const f = fixture(t, { fallback }), work = { ...sample }, stages = [];
  const handle = await f.create();
  assert.ok(Object.isFrozen(handle)); assert.deepEqual(Object.keys(handle).sort(), ['close', 'credentialId', 'transports']);
  const ready = await f.prepare(handle, { work, onProgress: stage => stages.push(stage) });
  assert.deepEqual(stages, ['protect-work', 'verify-work']);
  assert.equal(ready.protocol, WORK_PROTOCOL); assert.equal(ready.status, 'ready'); assert.equal(ready.independentlyVerified, true);
  assert.equal(ready.workDigest, digest(work)); assert.equal(ready.owner, f.policy.expectedOwner);
  assert.deepEqual(f.counts, { creates: 1, gets: fallback ? 4 : 3 });
  assert.deepEqual(f.store.calls, { get: 3, put: 1 });
  const [[locator, bytes]] = f.store.records();
  assert.equal(locator, ready.locator); assert.ok(bytes.length <= 65536);
  const record = decode(bytes); assert.deepEqual(Object.keys(record).sort(), ['ciphertext', 'format', 'nonce']);
  const storedText = new TextDecoder().decode(bytes);
  for (const forbidden of [work.brief, work.title, f.policy.expectedOwner, handle.credentialId]) assert.equal(storedText.includes(forbidden), false);
  work.title = 'Local changed copy';
  const fresh = await import(`../sdk/work-reserve.mjs?fresh=${randomBytes(6).toString('hex')}`);
  const before = f.counts.gets;
  const recovered = await fresh.recoverWorkReserve({ config: f.config, store: f.store, webAuthnClient: f.client });
  try {
    assert.equal(f.counts.gets - before, 1); assert.equal(recovered.owner, ready.owner); assert.deepEqual(recovered.work, sample);
    assert.ok(Object.isFrozen(recovered.work)); assert.ok(Object.isFrozen(recovered));
    assert.equal('account' in recovered, false); assert.equal('session' in recovered, false); assert.equal('privateKey' in recovered, false);
    assert.throws(() => { recovered.work.title = 'changed'; }, TypeError);
    const opened = await recovered.openAccount();
    assert.equal(f.counts.gets - before, 2); assert.equal(opened.owner, ready.owner);
    const message = 'Synthetic proof of account continuation';
    assert.equal(await verifyMessage({ address: ready.owner, message, signature: await opened.account.signMessage({ message }) }), true);
    await assert.rejects(recovered.openAccount(), code('ACCOUNT_ALREADY_OPEN'));
    recovered.close(); recovered.close();
    await assert.rejects(recovered.openAccount(), code('OPERATION_CANCELLED'));
    await assert.rejects(opened.account.signMessage({ message }));
  } finally { recovered.close(); }
  assert.ok(f.outputs.every(result => !result.prfOutput || result.prfOutput.every(byte => byte === 0)));
});

test('work read succeeds while vault PRF access is forbidden; unlock remains deliberate', async t => {
  const f = fixture(t), handle = await f.create(); await f.prepare(handle);
  const bootstrap = f.requests[0].salt; let denied = 0;
  const client = { ...f.client, getCredential(request) {
    if (!Buffer.from(request.prfSalt).equals(Buffer.from(bootstrap))) { denied++; throw new Error('ACCOUNT_VAULT_NOT_AUTHORIZED'); }
    return f.client.getCredential(request);
  } };
  const before = f.counts.gets, recovered = await f.recover({ webAuthnClient: client });
  assert.deepEqual(recovered.work, sample); assert.equal(denied, 0); assert.equal(f.counts.gets - before, 1);
  await assert.rejects(recovered.openAccount()); assert.equal(denied, 1);
  assert.deepEqual(recovered.work, sample);
});

test('work validation uses exact fields, plain values and UTF8 capacity before native/store activity', async t => {
  const f = fixture(t), handle = await f.create();
  const invalid = [{ ...sample, extra: '' }, { ...sample, schema: 'other' }, { ...sample, title: 'x'.repeat(257) }, { ...sample, client: 'x'.repeat(257) }, { ...sample, brief: {} }, { ...sample, brief: '界'.repeat(5500) }];
  const accessor = { ...sample }; Object.defineProperty(accessor, 'brief', { enumerable: true, get() { throw new Error('DO_NOT_INVOKE'); } }); invalid.push(accessor);
  for (const value of invalid) assert.throws(() => validateWork(value), /WORK_INVALID|WORK_TOO_LARGE/);
  const baseline = encode({ ...sample, brief: '' }).length;
  const edge = { ...sample, brief: 'x'.repeat(MAX_WORK_BYTES - baseline) };
  assert.equal(encode(validateWork(edge)).length, MAX_WORK_BYTES);
  assert.throws(() => validateWork({ ...edge, brief: edge.brief + 'x' }), code('WORK_TOO_LARGE'));
  const before = { ...f.counts };
  await assert.rejects(f.prepare(handle, { work: invalid[5] }), code('WORK_TOO_LARGE'));
  assert.deepEqual(f.counts, before); assert.deepEqual(f.store.calls, { get: 0, put: 0 });
  await assert.rejects(f.prepare(handle), code('RESERVE_CREDENTIAL_CONSUMED'));
  const f2 = fixture(t); await f2.prepare(await f2.create(), { work: edge }); assert.deepEqual((await f2.recover()).work, edge);
});

test('wrong leaf and wrong policy are rejected before storage or an additional assertion', async t => {
  for (const change of [f => ({ privateKey: hexToBytes(generatePrivateKey()) }), f => ({ policy: { ...f.policy, derivation: 'different' } })]) {
    const f = fixture(t), handle = await f.create(), before = { ...f.counts };
    await assert.rejects(f.prepare(handle, change(f)), /OWNER_MISMATCH|CREDENTIAL_MISMATCH/);
    assert.deepEqual(f.counts, before); assert.deepEqual(f.store.calls, { get: 0, put: 0 });
  }
});

test('new discovery and record namespace never silently recovers legacy account-only data', async t => {
  const f = fixture(t), handle = await f.create(), metadata = { credentialId: handle.credentialId, transports: [...handle.transports] };
  const legacy = await prepareReserve({ privateKey: f.privateKey, policy: f.policy, recoveryCredential: metadata, store: f.store, webAuthnClient: f.client });
  await assert.rejects(f.recover(), code('RESERVE_MISSING'));
  const ready = await f.prepare(handle);
  assert.notEqual(ready.locator, legacy.locator); assert.notEqual(WORK_PROTOCOL, PROTOCOL); assert.equal(f.store.records().length, 2);
  const old = await recoverReserve({ config: f.config, store: f.store, webAuthnClient: f.client });
  try { assert.equal(old.owner, ready.owner); } finally { old.close(); }
  const legacyBytes = await f.store.get(legacy.locator); f.store.replace(ready.locator, legacyBytes);
  await assert.rejects(f.recover(), code('RECORD_INVALID'));
});

test('wrong discovery credential or PRF cannot read work', async t => {
  const f = fixture(t); await f.prepare(await f.create());
  const client = { ...f.client, async getCredential(request) { const result = await f.client.getCredential(request); result.credentialId = new Uint8Array(randomBytes(24)); return result; } };
  await assert.rejects(f.recover({ webAuthnClient: client }), code('CREDENTIAL_MISMATCH'));
  const wrong = { ...f.client, async getCredential(request) { const result = await f.client.getCredential(request); result.prfOutput.fill(7); return result; } };
  await assert.rejects(f.recover({ webAuthnClient: wrong }), code('RESERVE_MISSING'));
});

for (const [name, mutate, expected] of [
  ['config', m => { m.config.derivation = 'other'; }, 'POLICY_MISMATCH'],
  ['credential', m => { m.credentialId = b64(randomBytes(24)); }, 'CREDENTIAL_MISMATCH'],
  ['vault digest', m => { m.vault.ciphertext = b64(randomBytes(80)); }, 'VAULT_MISMATCH'],
  ['work ciphertext', m => { m.workEnvelope.ciphertext = b64(randomBytes(80)); }, 'WORK_AUTH_FAILED'],
  ['owner binding', m => { m.owner = '0x' + 'a'.repeat(40); }, 'WORK_AUTH_FAILED'],
  ['work digest binding', m => { m.workDigest = 'a'.repeat(64); }, 'WORK_AUTH_FAILED'],
]) test(`authenticated manifest ${name} substitution is rejected`, async t => {
  const f = fixture(t); await f.prepare(await f.create());
  await editRecord(f, mutate); await assert.rejects(f.recover(), code(expected));
});

test('work plaintext must match its digest even with authentic nested encryption', async t => {
  const f = fixture(t); await f.prepare(await f.create());
  await editRecord(f, (m, payload) => { payload.work.brief = 'Tampered work'; }, { rewriteWork: true });
  await assert.rejects(f.recover(), code('WORK_DIGEST_MISMATCH'));
});

test('account header must bind the work snapshot before any signer is returned', async t => {
  const f = fixture(t); await f.prepare(await f.create());
  await editRecord(f, async m => {
    const secret = await decryptSecretVaultWithPasskey({ vault: m.vault, rpId: f.config.recoveryRpId, webAuthnClient: f.client });
    const headerLength = new DataView(secret.buffer, secret.byteOffset).getUint32(0, false);
    const header = decode(secret.subarray(4, 4 + headerLength)); header.workDigest = 'b'.repeat(64);
    const nextHeader = encode(header), next = new Uint8Array(4 + nextHeader.length + 32);
    new DataView(next.buffer).setUint32(0, nextHeader.length, false); next.set(nextHeader, 4); next.set(secret.subarray(4 + headerLength), 4 + nextHeader.length);
    try { m.vault = await createSecretVaultWithExistingPasskey({ secret: next, credential: m.vault.credential, rpId: f.config.recoveryRpId, webAuthnClient: f.client }); }
    finally { secret.fill(0); next.fill(0); }
    m.vaultDigest = digest(m.vault);
  }, { rewriteWork: true });
  const recovered = await f.recover(); assert.deepEqual(recovered.work, sample);
  await assert.rejects(recovered.openAccount(), code('PAYLOAD_MISMATCH'));
});

test('corrupt outer record and noncanonical or oversized input cannot produce a work read', async t => {
  const f = fixture(t); await f.prepare(await f.create());
  const [[locator, bytes]] = f.store.records(), record = decode(bytes);
  for (const bad of [encode({ ...record, ciphertext: b64(randomBytes(80)) }), new TextEncoder().encode(JSON.stringify(record) + '\n'), new Uint8Array(65537), encode({ ...record, ignored: true })]) {
    f.store.replace(locator, bad); await assert.rejects(f.recover());
  }
});

test('readback and independent account verification are mandatory for readiness', async t => {
  for (const failure of ['readback', 'independent-read', 'independent-account']) {
    const f = fixture(t), handle = await f.create(); let written = false, reads = 0, gets = 0;
    const store = { get: async locator => { const bytes = await f.store.get(locator); reads++; if (failure === 'readback' && written && bytes) bytes[bytes.length - 2] ^= 1; if (failure === 'independent-read' && reads === 3) return undefined; return bytes; }, putIfAbsent: async (...args) => { const result = await f.store.putIfAbsent(...args); written = true; return result; } };
    const client = { ...f.client, getCredential(request) { if (++gets === 3 && failure === 'independent-account') throw new Error('SYNTHETIC_ACCOUNT_UNAVAILABLE'); return f.client.getCredential(request); } };
    await assert.rejects(f.prepare(handle, { store, webAuthnClient: client }), error => error.recordMayExist === true);
    assert.equal(f.store.calls.put, 1); assert.deepEqual((await f.recover()).work, sample);
  }
});

test('immutable preparation has no retry/update, even after uncertain write outcome', async t => {
  const f = fixture(t), handle = await f.create();
  const store = { get: f.store.get, async putIfAbsent(...args) { await f.store.putIfAbsent(...args); throw new Error('SYNTHETIC_RESPONSE_LOST'); } };
  await assert.rejects(f.prepare(handle, { store }), error => error.code === 'STORE_WRITE_UNKNOWN' && error.recordMayExist === true);
  assert.equal(f.store.calls.put, 1);
  await assert.rejects(f.prepare({ credentialId: handle.credentialId }, { work: { ...sample, brief: 'changed' } }), code('RESERVE_ALREADY_ATTEMPTED'));
  const fresh = await import(`../sdk/work-reserve.mjs?immutable=${randomBytes(6).toString('hex')}`);
  await assert.rejects(fresh.prepareWorkReserve({ privateKey: f.privateKey, policy: f.policy, recoveryCredential: handle, work: sample, store: f.store, webAuthnClient: f.client }), code('RESERVE_EXISTS'));
  assert.equal(f.store.calls.put, 1); assert.deepEqual((await f.recover()).work, sample);
});

test('creation is synchronous, cancellable, and late native output is wiped', async t => {
  const f = fixture(t), pending = deferred(), controller = new AbortController(); let entered = false;
  const promise = f.create({ signal: controller.signal, webAuthnClient: { ...f.client, createCredential() { entered = true; return pending.promise; } } });
  assert.equal(entered, true); const rejected = assert.rejects(promise, code('OPERATION_CANCELLED')); controller.abort(); await rejected;
  const late = { credentialId: new Uint8Array(24).fill(3), prfEnabled: true, prfOutput: new Uint8Array(32).fill(17) };
  pending.resolve(late); await tick(); assert.ok(late.prfOutput.every(byte => byte === 0));
});

test('creation handle binding, expiration, cancellation and one-use survive all exits', async t => {
  for (const action of ['close', 'expire', 'abort', 'consumed']) {
    const f = fixture(t), controller = new AbortController(), handle = await f.create({ signal: controller.signal, timeoutMs: 1000 });
    if (action === 'close') handle.close(); if (action === 'abort') controller.abort();
    let clock;
    if (action === 'expire') { const future = Date.now() + 2000; clock = t.mock.method(Date, 'now', () => future); }
    if (action === 'consumed') await assert.rejects(f.prepare(handle, { work: {} }), code('WORK_INVALID'));
    const before = { ...f.counts }, io = { ...f.store.calls };
    try { await assert.rejects(f.prepare(handle), /RESERVE_CREDENTIAL_CLOSED|OPERATION_CANCELLED|RESERVE_CREDENTIAL_EXPIRED|RESERVE_CREDENTIAL_CONSUMED/); }
    finally { clock?.mock.restore(); }
    assert.deepEqual(f.counts, before); assert.deepEqual(f.store.calls, io);
  }
});

test('fallback wrong credential is rejected rather than binding unrelated PRF material', async t => {
  const f = fixture(t, { fallback: true });
  await assert.rejects(f.create({ webAuthnClient: { ...f.client, async getCredential(request) { const result = await f.client.getCredential(request); result.credentialId = new Uint8Array(randomBytes(24)); return result; } } }), error => error.code === 'CREDENTIAL_MISMATCH' || error.cause?.code === 'CREDENTIAL_MISMATCH');
  assert.equal(f.store.calls.put, 0); assert.ok(f.outputs.every(result => !result.prfOutput || result.prfOutput.every(byte => byte === 0)));
});

for (const action of ['close', 'abort']) test(`handle ${action} stops in-flight prepare before storage write`, async t => {
  const f = fixture(t), controller = new AbortController(), pending = deferred(), entered = deferred(), handle = await f.create({ signal: controller.signal });
  const operation = f.prepare(handle, { webAuthnClient: { ...f.client, getCredential() { entered.resolve(); return pending.promise; } } });
  const rejected = assert.rejects(operation, error => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === false);
  await entered.promise; if (action === 'close') handle.close(); else controller.abort(); await rejected;
  assert.equal(f.store.calls.put, 0);
  const late = { credentialId: new Uint8Array(24).fill(3), prfOutput: new Uint8Array(32).fill(17) }; pending.resolve(late); await tick(); assert.ok(late.prfOutput.every(byte => byte === 0));
});

test('closed read context cancels pending account unlock and wipes late PRF', async t => {
  const f = fixture(t); await f.prepare(await f.create());
  const pending = deferred(), entered = deferred(); let calls = 0;
  const recovered = await f.recover({ webAuthnClient: { ...f.client, getCredential(request) { if (++calls === 1) return f.client.getCredential(request); entered.resolve(); return pending.promise; } } });
  const operation = recovered.openAccount(), rejected = assert.rejects(operation, code('OPERATION_CANCELLED'));
  await entered.promise; recovered.close(); await rejected;
  const late = { credentialId: new Uint8Array(24).fill(3), prfOutput: new Uint8Array(32).fill(17) }; pending.resolve(late); await tick(); assert.ok(late.prfOutput.every(byte => byte === 0));
  const before = f.counts.gets; await assert.rejects(recovered.openAccount(), code('OPERATION_CANCELLED')); assert.equal(f.counts.gets, before);
});

test('read cancellation returns no work, and account context expires without a new assertion', async t => {
  const f = fixture(t); await f.prepare(await f.create());
  const controller = new AbortController(), pending = deferred(), entered = deferred();
  const reading = f.recover({ signal: controller.signal, store: { get() { entered.resolve(); return pending.promise; } } });
  const rejected = assert.rejects(reading, code('OPERATION_CANCELLED')); await entered.promise; controller.abort(); await rejected; pending.resolve(undefined);
  const recovered = await f.recover(), before = f.counts.gets, future = Date.now() + 300001;
  const clock = t.mock.method(Date, 'now', () => future);
  try { await assert.rejects(recovered.openAccount(), code('OPERATION_CANCELLED')); } finally { clock.mock.restore(); }
  assert.equal(f.counts.gets, before);
});

test('preparation captures the snapshot before yielding to caller mutations', async t => {
  const f = fixture(t), handle = await f.create(), work = { ...sample };
  const preparing = f.prepare(handle, { work });
  work.brief = 'Caller changed this while native operations were pending.';
  const ready = await preparing;
  assert.equal(ready.workDigest, digest(sample)); assert.deepEqual((await f.recover()).work, sample);
});

test('caller cancellation and bounded context expiration close an already opened signer', async t => {
  for (const action of ['read-signal', 'unlock-signal', 'expiry']) {
    const f = fixture(t); await f.prepare(await f.create());
    const readController = new AbortController(), unlockController = new AbortController();
    const recovered = await f.recover({ signal: readController.signal });
    const opened = await recovered.openAccount({ signal: unlockController.signal });
    let clock;
    if (action === 'read-signal') readController.abort();
    if (action === 'unlock-signal') unlockController.abort();
    if (action === 'expiry') {
      const future = Date.now() + 300001; clock = t.mock.method(Date, 'now', () => future);
      try { await assert.rejects(recovered.openAccount(), code('OPERATION_CANCELLED')); } finally { clock.mock.restore(); }
    }
    await assert.rejects(opened.account.signMessage({ message: 'Must remain closed' }));
    if (action === 'unlock-signal') {
      const later = await recovered.openAccount();
      assert.equal(later.owner, f.policy.expectedOwner); later.close();
    }
  }
});

test('account unlock rejects an adapter assertion for a different credential', async t => {
  const f = fixture(t); await f.prepare(await f.create()); let gets = 0;
  const recovered = await f.recover({ webAuthnClient: { ...f.client, async getCredential(request) {
    const result = await f.client.getCredential(request);
    if (++gets === 2) result.credentialId = new Uint8Array(randomBytes(24));
    return result;
  } } });
  assert.deepEqual(recovered.work, sample);
  await assert.rejects(recovered.openAccount(), error => error.code === 'CREDENTIAL_MISMATCH' || error.cause?.code === 'CREDENTIAL_MISMATCH');
  assert.equal(gets, 2); assert.ok(f.outputs.every(result => !result.prfOutput || result.prfOutput.every(byte => byte === 0)));
});
