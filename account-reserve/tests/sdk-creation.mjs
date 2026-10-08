import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { hexToBytes, verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createReserveCredential, prepareReserve, recoverReserve, PROTOCOL } from '../sdk/index.mjs';
import { memoryStore } from './sdk-fixture.mjs';

const user = { name: 'Synthetic reserve', displayName: 'Synthetic reserve' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const code = expected => error => error?.code === expected;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Test-only PRF oracle with one discoverable credential. It tests ceremony
// dependencies and buffer ownership, not physical device prompt counts.
function fixture(t, { fallback = false, wrongFallbackCredential = false } = {}) {
  const config = Object.freeze({ appId: 'creation-' + randomBytes(8).toString('hex'), originalRpId: 'original.localhost', recoveryRpId: 'reserve.localhost', derivation: 'synthetic-leaf:v1' });
  const key = generatePrivateKey(), privateKey = hexToBytes(key);
  const policy = { ...config, expectedOwner: privateKeyToAccount(key).address.toLowerCase() };
  const prfKey = randomBytes(32), id = new Uint8Array(randomBytes(24));
  const outputs = [], requests = [], handles = [];
  const counts = { creates: 0, gets: 0 };
  const output = salt => new Uint8Array(createHmac('sha256', prfKey).update(salt).digest());
  const client = {
    createCredential(request) {
      counts.creates++; requests.push({ kind: 'create', salt: new Uint8Array(request.prfSalt), request });
      assert.equal(request.rp.id, config.recoveryRpId); assert.equal(request.userVerification, 'required');
      assert.equal(request.residentKey, 'required');
      const result = { credentialId: new Uint8Array(id), prfEnabled: true, transports: ['internal'], ...(fallback ? {} : { prfOutput: output(request.prfSalt) }) };
      outputs.push(result); return Promise.resolve(result);
    },
    getCredential(request) {
      counts.gets++; requests.push({ kind: 'get', salt: new Uint8Array(request.prfSalt), request });
      assert.equal(request.rpId, config.recoveryRpId); assert.equal(request.userVerification, 'required');
      if (request.allowCredential) assert.deepEqual(request.allowCredential.credentialId, id);
      const result = { credentialId: new Uint8Array(wrongFallbackCredential ? randomBytes(24) : id), prfOutput: output(request.prfSalt) };
      outputs.push(result); return Promise.resolve(result);
    },
  };
  const store = memoryStore();
  const create = async overrides => {
    const handle = await createReserveCredential({ config, user, webAuthnClient: client, ...overrides }); handles.push(handle); return handle;
  };
  const prepare = (credential, overrides) => prepareReserve({ privateKey, policy, recoveryCredential: credential, webAuthnClient: client, store, ...overrides });
  t.after(() => { for (const handle of handles) handle.close(); privateKey.fill(0); prfKey.fill(0); });
  return { config, policy, privateKey, client, counts, requests, outputs, store, create, prepare };
}

for (const fallback of [false, true]) test(`creation reuse preserves the protocol and independent check, fallback=${fallback}`, async t => {
  const f = fixture(t, { fallback });
  const handle = await f.create();
  assert.equal(Object.isFrozen(handle), true); assert.equal(Object.isFrozen(handle.transports), true);
  assert.deepEqual(Object.keys(handle).sort(), ['close', 'credentialId', 'transports']);
  assert.equal('prfOutput' in handle, false); assert.equal('locator' in handle, false); assert.equal('manifestKey' in handle, false);
  assert.ok(f.outputs.every(result => !result.prfOutput || result.prfOutput.every(byte => byte === 0)), 'raw adapter PRF outputs are erased before helper returns');
  const oldSalt = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${PROTOCOL}/bootstrap\0${f.config.appId}`)));
  assert.deepEqual(f.requests[0].salt, oldSalt, 'synchronous salt matches previous WebCrypto formula including NUL');
  const ready = await f.prepare(handle);
  assert.equal(ready.owner, f.policy.expectedOwner); assert.equal(ready.independentlyVerified, true);
  assert.deepEqual(f.counts, { creates: 1, gets: fallback ? 4 : 3 });
  assert.equal(f.store.calls.put, 1); assert.equal(f.store.calls.get, 3);
  const [[locator, bytes]] = f.store.records();
  const record = JSON.parse(new TextDecoder().decode(bytes));
  assert.deepEqual(Object.keys(record).sort(), ['ciphertext', 'format', 'nonce']);
  assert.equal(record.format, `${PROTOCOL}/index`);
  assert.equal(new TextDecoder().decode(bytes).includes(f.policy.expectedOwner), false);
  const before = { ...f.counts };
  const fresh = await import(`../sdk/index.mjs?creation-proof=${randomBytes(8).toString('hex')}`);
  const recovered = await fresh.recoverReserve({ config: f.config, store: f.store, webAuthnClient: f.client });
  try {
    assert.equal(recovered.owner, f.policy.expectedOwner); assert.equal(recovered.locator, locator);
    const message = 'Synthetic independent challenge';
    assert.equal(await verifyMessage({ address: f.policy.expectedOwner, message, signature: await recovered.account.signMessage({ message }) }), true);
    assert.equal(f.counts.gets - before.gets, 2); assert.equal(f.counts.creates, before.creates);
  } finally { recovered.close(); }
});

test('creation reaches native create synchronously before yielding', async t => {
  const f = fixture(t), pending = deferred(); let entered = false;
  const controller = new AbortController();
  const promise = createReserveCredential({ config: f.config, user, signal: controller.signal, webAuthnClient: {
    ...f.client, createCredential() { entered = true; return pending.promise; },
  } });
  assert.equal(entered, true);
  const rejected = assert.rejects(promise, code('OPERATION_CANCELLED'));
  controller.abort(); await rejected;
  const late = { credentialId: new Uint8Array(24).fill(9), prfEnabled: true, prfOutput: new Uint8Array(32).fill(23) };
  pending.resolve(late); await tick();
  assert.ok(late.prfOutput.every(byte => byte === 0));
});

test('incorrect fallback credential is rejected and its output wiped', async t => {
  const f = fixture(t, { fallback: true, wrongFallbackCredential: true });
  await assert.rejects(f.create(), error => error.code === 'CREDENTIAL_MISMATCH' || error.cause?.code === 'CREDENTIAL_MISMATCH');
  assert.deepEqual(f.counts, { creates: 1, gets: 1 }); assert.equal(f.store.calls.put, 0);
  assert.ok(f.outputs.every(result => !result.prfOutput || result.prfOutput.every(byte => byte === 0)));
});

test('invalid creation inputs and pre-aborted signals never request a credential', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  for (const changed of [{ config: { ...f.config, recoveryRpId: f.config.originalRpId } }, { user: { name: '', displayName: 'x' } }, { timeoutMs: 300001 }, { timeoutMs: 0 }, { signal: controller.signal }, { webAuthnClient: {} }]) {
    await assert.rejects(f.create(changed));
  }
  assert.deepEqual(f.counts, { creates: 0, gets: 0 }); assert.equal(f.store.calls.get, 0);
});

test('ordinary copied metadata follows normal discovery while exact issued handle is one-use', async t => {
  const f = fixture(t), handle = await f.create();
  await f.prepare({ credentialId: handle.credentialId, transports: [...handle.transports] });
  assert.deepEqual(f.counts, { creates: 1, gets: 4 });
  handle.close();
  const before = { ...f.counts }, io = { ...f.store.calls };
  await assert.rejects(f.prepare(handle), code('RESERVE_CREDENTIAL_CLOSED'));
  assert.deepEqual(f.counts, before); assert.deepEqual(f.store.calls, io);
});

test('successful one-use handle cannot be reused, modified or made reusable by closing', async t => {
  const f = fixture(t), handle = await f.create();
  assert.throws(() => { handle.credentialId = 'tampered'; }, TypeError);
  assert.throws(() => { handle.transports.push('hybrid'); }, TypeError);
  await f.prepare(handle);
  const before = { ...f.counts }, io = { ...f.store.calls };
  await assert.rejects(f.prepare(handle), code('RESERVE_CREDENTIAL_CONSUMED'));
  handle.close(); await assert.rejects(f.prepare(handle), code('RESERVE_CREDENTIAL_CONSUMED'));
  assert.deepEqual(f.counts, before); assert.deepEqual(f.store.calls, io);
});

test('config mismatch and early preparation failure consume and release the handle without fallback', async t => {
  for (const change of [f => ({ policy: { ...f.policy, derivation: 'different:v1' } }), f => ({ policy: { ...f.policy, appId: 'different-app' } }), () => ({ privateKey: new Uint8Array(1) })]) {
    const f = fixture(t), handle = await f.create(), before = { ...f.counts };
    await assert.rejects(f.prepare(handle, change(f)), /CREDENTIAL_MISMATCH|KEY_INVALID/);
    await assert.rejects(f.prepare(handle), code('RESERVE_CREDENTIAL_CONSUMED'));
    assert.deepEqual(f.counts, before); assert.equal(f.store.calls.get, 0); assert.equal(f.store.calls.put, 0);
  }
});

test('closed, aborted and expired ready handles reject before native or storage calls', async t => {
  for (const kind of ['close', 'abort', 'expire']) {
    const f = fixture(t), controller = new AbortController();
    const handle = await f.create({ signal: controller.signal, timeoutMs: 1000 });
    const before = { ...f.counts };
    if (kind === 'close') handle.close();
    if (kind === 'abort') controller.abort();
    let clock;
    if (kind === 'expire') { const future = Date.now() + 2000; clock = t.mock.method(Date, 'now', () => future); }
    try { await assert.rejects(f.prepare(handle), /RESERVE_CREDENTIAL_CLOSED|OPERATION_CANCELLED|RESERVE_CREDENTIAL_EXPIRED/); }
    finally { clock?.mock.restore(); }
    assert.deepEqual(f.counts, before); assert.equal(f.store.calls.get, 0); assert.equal(f.store.calls.put, 0);
  }
});

for (const kind of ['abort', 'close']) test(`creation handle ${kind} cancels ongoing preparation even without a new caller signal`, async t => {
  const f = fixture(t), controller = new AbortController(), started = deferred(), pending = deferred();
  const handle = await f.create({ signal: controller.signal });
  const operation = f.prepare(handle, { webAuthnClient: { ...f.client, getCredential() { started.resolve(); return pending.promise; } } });
  const rejected = assert.rejects(operation, error => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === false);
  await started.promise;
  if (kind === 'abort') controller.abort(); else handle.close();
  await rejected;
  assert.equal(f.store.calls.put, 0);
  const late = { credentialId: new Uint8Array(24).fill(3), prfOutput: new Uint8Array(32).fill(17) };
  pending.resolve(late); await tick(); assert.ok(late.prfOutput.every(byte => byte === 0));
  await assert.rejects(f.prepare(handle), code('RESERVE_CREDENTIAL_CONSUMED'));
});

test('readback tampering still blocks readiness after optimized creation', async t => {
  const f = fixture(t), handle = await f.create(); let written = false;
  const store = {
    get: async locator => { const bytes = await f.store.get(locator); if (written && bytes) bytes[bytes.length - 2] ^= 1; return bytes; },
    putIfAbsent: async (...args) => { const result = await f.store.putIfAbsent(...args); written = true; return result; },
  };
  await assert.rejects(f.prepare(handle, { store }), error => error.code === 'READBACK_FAILED' && error.recordMayExist === true);
  assert.equal(f.store.calls.put, 1); assert.equal(f.counts.gets, 1);
  const recovered = await recoverReserve({ config: f.config, webAuthnClient: f.client, store: f.store });
  assert.equal(recovered.owner, f.policy.expectedOwner); recovered.close();
});

test('failure of the independent public recovery still blocks readiness', async t => {
  const f = fixture(t), handle = await f.create(); let calls = 0;
  const client = { ...f.client, getCredential(request) { if (++calls === 2) throw new Error('SYNTHETIC_INDEPENDENT_DISCOVERY_FAILED'); return f.client.getCredential(request); } };
  await assert.rejects(f.prepare(handle, { webAuthnClient: client }), error => error.recordMayExist === true);
  assert.equal(f.store.calls.put, 1); assert.equal(calls, 2);
});
