import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPasskeyWithPrfOutput } from '@category-labs/mera';
import { createWebAuthnScope } from '../sdk/webauthn-scope.mjs';
import { makeSdkFixture } from './sdk-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const code = expected => error => error?.code === expected;
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const request = () => ({ rpId: 'reserve.localhost', challenge: new Uint8Array(32), prfSalt: new Uint8Array(32), userVerification: 'required' });
function output() { return { credentialId: new Uint8Array(24).fill(7), prfOutput: new Uint8Array(32).fill(23) }; }

test('abort rejects a never-settling client immediately; a late PRF buffer is erased', { timeout: 1000 }, async () => {
  const controller = new AbortController(), pending = deferred(); let calls = 0;
  const scope = createWebAuthnScope({ signal: controller.signal, webAuthnClient: {
    createCredential() { throw new Error('creation must not happen'); },
    getCredential() { calls++; return pending.promise; },
  } });
  assert.equal(calls, 0, 'constructing the scope must not request a passkey');
  const operation = scope.client.getCredential(request());
  const rejected = assert.rejects(operation, code('OPERATION_CANCELLED'));
  controller.abort(); await rejected;
  await assert.rejects(scope.client.getCredential(request()), code('OPERATION_CANCELLED'));
  assert.equal(calls, 1);
  const late = output(); pending.resolve(late); await tick();
  assert.ok(late.prfOutput.every(byte => byte === 0));
  scope.close();
});

test('one deadline bounds a stalled ceremony and close erases retained adapter output', { timeout: 1000 }, async () => {
  const retained = output(); let calls = 0, suppliedTimeout;
  const scope = createWebAuthnScope({ timeoutMs: 30, webAuthnClient: {
    createCredential() { throw new Error('unexpected create'); },
    getCredential(options) { calls++; suppliedTimeout = options.timeout; return calls === 1 ? Promise.resolve(retained) : new Promise(() => {}); },
  } });
  await scope.client.getCredential(request());
  await assert.rejects(scope.client.getCredential({ ...request(), timeout: 50000 }), code('OPERATION_TIMED_OUT'));
  assert.ok(suppliedTimeout <= 30 && suppliedTimeout > 0);
  assert.ok(retained.prfOutput.every(byte => byte === 0));
  scope.close();
});

test('successful Mera output is copied before scope cleanup erases the adapter buffer', async () => {
  const raw = { ...output(), prfEnabled: true };
  const scope = createWebAuthnScope({ webAuthnClient: {
    async createCredential() { return raw; },
    getCredential() { throw new Error('create-time PRF needs no fallback'); },
  } });
  const created = await createPasskeyWithPrfOutput({ rp: { id: 'reserve.localhost', name: 'Example' }, user: { name: 'example', displayName: 'example' }, webAuthnClient: scope.client });
  assert.notEqual(created.prfOutput, raw.prfOutput);
  assert.ok(created.prfOutput.every(byte => byte === 23));
  scope.close();
  assert.ok(raw.prfOutput.every(byte => byte === 0));
  assert.ok(created.prfOutput.every(byte => byte === 23), 'caller retains its Mera-owned copy until it explicitly wipes it');
  created.prfOutput.fill(0); created.prfSalt.fill(0);
});

test('default native adapter forwards AbortSignal and required WebAuthn controls', { timeout: 1000 }, async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator; });
  const pending = deferred(); let options;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
    get(value) { options = value; return pending.promise; },
  } } });
  const controller = new AbortController(), scope = createWebAuthnScope({ signal: controller.signal });
  const allowCredential = { credentialId: new Uint8Array([1, 2, 3]), transports: ['internal', 'hybrid'] };
  const operation = scope.client.getCredential({ ...request(), allowCredential });
  const rejected = assert.rejects(operation, code('OPERATION_CANCELLED'));
  assert.equal(options.signal, scope.signal);
  assert.equal(options.publicKey.rpId, 'reserve.localhost');
  assert.equal(options.publicKey.userVerification, 'required');
  assert.deepEqual(options.publicKey.allowCredentials, [{ type: 'public-key', id: allowCredential.credentialId, transports: allowCredential.transports }]);
  assert.equal(options.publicKey.extensions.prf.eval.first.length, 32);
  controller.abort(); await rejected; assert.equal(options.signal.aborted, true);
  const nativePrf = new Uint8Array(32).fill(29);
  pending.resolve({ type: 'public-key', rawId: new ArrayBuffer(24), getClientExtensionResults: () => ({ prf: { results: { first: nativePrf.buffer } } }) });
  await tick(); assert.ok(nativePrf.every(byte => byte === 0)); scope.close();
});

test('native creation preserves discoverability and PRF fallback is cancellable without another creation', { timeout: 1000 }, async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator; });
  const asserted = deferred(), started = deferred(); let creates = 0, creation, assertion;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
    async create(options) {
      creates++; creation = options;
      return { type: 'public-key', rawId: new ArrayBuffer(24), response: { getTransports: () => ['internal'] }, getClientExtensionResults: () => ({ prf: { enabled: true } }) };
    },
    get(options) { assertion = options; started.resolve(); return asserted.promise; },
  } } });
  const controller = new AbortController(), scope = createWebAuthnScope({ signal: controller.signal });
  const operation = createPasskeyWithPrfOutput({ rp: { id: 'reserve.localhost', name: 'Synthetic native adapter test' }, user: { name: 'example', displayName: 'example' }, webAuthnClient: scope.client });
  const rejected = assert.rejects(operation, code('PASSKEY_OPERATION_FAILED'));
  await started.promise;
  assert.deepEqual(creation.publicKey.authenticatorSelection, { residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
  assert.deepEqual(creation.publicKey.pubKeyCredParams, [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }]);
  assert.equal(assertion.publicKey.allowCredentials.length, 1);
  controller.abort(); await rejected; assert.equal(creates, 1);
  assert.equal(creation.signal.aborted, true); assert.equal(assertion.signal.aborted, true); scope.close();
});

test('SDK preparation aborts during a stalled vault assertion and wipes owned key buffers', { timeout: 1500 }, async t => {
  const privateKey = new Uint8Array(32).fill(33), f = makeSdkFixture({ privateKey });
  t.after(() => { f.cleanup(); privateKey.fill(0); });
  const controller = new AbortController(), started = deferred(), pending = deferred();
  let calls = 0; const wipedKeys = new Set();
  const originalFill = Uint8Array.prototype.fill;
  t.mock.method(Uint8Array.prototype, 'fill', function(value, ...rest) {
    if (value === 0 && this.length === 32 && this.every(byte => byte === 33)) wipedKeys.add(this);
    return originalFill.call(this, value, ...rest);
  });
  const operation = f.prepare({ privateKey, signal: controller.signal, webAuthnClient: {
    createCredential: f.webAuthnClient.createCredential,
    async getCredential(options) { calls++; if (calls === 2) { started.resolve(); return pending.promise; } return f.webAuthnClient.getCredential(options); },
  } });
  const rejected = assert.rejects(operation, error => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === false);
  await started.promise; const beforeAbort = wipedKeys.size;
  controller.abort(); await rejected;
  assert.ok(wipedKeys.size > beforeAbort, 'SDK-owned leaf key is wiped when cancellation settles, before the native prompt resolves');
  assert.ok([...wipedKeys].every(bytes => bytes.every(byte => byte === 0)));
  assert.ok(privateKey.every(byte => byte === 33), 'the caller still owns its input key');
  assert.equal(f.store.calls.put, 0);
  const late = output(); pending.resolve(late); await tick();
  assert.ok(late.prfOutput.every(byte => byte === 0)); assert.equal(calls, 2);
});

test('SDK abort after storage preserves the record but cannot report ready; fresh recovery works', { timeout: 1500 }, async t => {
  const f = makeSdkFixture(); t.after(() => f.cleanup());
  const controller = new AbortController(), started = deferred(); let calls = 0;
  const operation = f.prepare({ signal: controller.signal, webAuthnClient: {
    createCredential: f.webAuthnClient.createCredential,
    async getCredential(options) { calls++; if (calls === 3) { started.resolve(); return new Promise(() => {}); } return f.webAuthnClient.getCredential(options); },
  } });
  const rejected = assert.rejects(operation, error => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === true);
  await started.promise; controller.abort(); await rejected;
  assert.equal(f.store.calls.put, 1); assert.equal(f.store.records().length, 1);
  const recovered = await f.recover(); assert.equal(recovered.owner, f.policy.expectedOwner); recovered.close();
});

test('SDK recovery aborts a never-settling discovery without creating or returning a signer', { timeout: 1500 }, async t => {
  const f = makeSdkFixture(); t.after(() => f.cleanup()); await f.prepare();
  const controller = new AbortController(), started = deferred(), pending = deferred();
  const operation = f.recover({ signal: controller.signal, webAuthnClient: {
    createCredential() { throw new Error('recovery must not create'); },
    getCredential() { started.resolve(); return pending.promise; },
  } });
  const rejected = assert.rejects(operation, code('OPERATION_CANCELLED'));
  await started.promise; controller.abort(); await rejected;
  const late = output(); pending.resolve(late); await tick();
  assert.ok(late.prfOutput.every(byte => byte === 0));
});

test('cancellation also bounds stalled storage after a successful discovery', { timeout: 1500 }, async t => {
  const f = makeSdkFixture(); t.after(() => f.cleanup());
  const controller = new AbortController(), started = deferred();
  const operation = f.prepare({ signal: controller.signal, store: {
    get() { started.resolve(); return new Promise(() => {}); },
    putIfAbsent() { assert.fail('cancelled operation must not write'); },
  } });
  const rejected = assert.rejects(operation, error => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === false);
  await started.promise; controller.abort(); await rejected;
});
