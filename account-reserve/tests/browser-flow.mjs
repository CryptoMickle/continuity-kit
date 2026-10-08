import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverReserve } from '../sdk/index.mjs';
import { startReserveSetup, createReserveReceiver } from '../sdk/browser-flow.mjs';
import { memoryStore } from './sdk-fixture.mjs';

const config = Object.freeze({ appId: 'browser-flow-tests', originalRpId: 'primary.localhost', recoveryRpId: 'reserve.localhost', derivation: 'synthetic:v1' });
const user = { name: 'Synthetic example', displayName: 'Synthetic example' };
const userKey = () => { const privateKey = new Uint8Array(randomBytes(32)); return { privateKey, expectedOwner: privateKeyToAccount('0x' + Buffer.from(privateKey).toString('hex')).address.toLowerCase() }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('condition never reached'); }

// Synthetic transport only. Browser native WebAuthn and popup behavior are separate evidence.
function browserPair({ blocked = false, rewritePayload, delayed = false } = {}) {
  const transfers = [], packets = [], channels = [], deliveries = [];
  const deliver = action => delayed ? deliveries.push(action) : queueMicrotask(action);
  class Port {
    closed = false;
    onmessage = null;
    start() {}
    close() { this.closed = true; }
    postMessage(data, transfer = []) {
      const value = structuredClone(data, { transfer });
      if (value.kind === 'account') { transfers.push(value); rewritePayload?.(value); }
      packets.push(value);
      const target = this.target;
      deliver(() => { if (!target.closed) target.onmessage?.({ data: value }); });
    }
  }
  class Channel {
    constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.target = this.port2; this.port2.target = this.port1; channels.push(this); }
  }
  class FakeWindow {
    constructor(href) {
      this.location = new URL(href); this.closed = false; this.listeners = new Map(); this.MessageChannel = Channel;
      this.history = { replaceState: (_state, _title, url) => { this.location = new URL(url, this.location); } };
    }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(listener); }
    removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
    dispatch(name, event = {}) { for (const listener of [...this.listeners.get(name) ?? []]) listener(event); }
    count() { return [...this.listeners.values()].reduce((n, value) => n + value.size, 0); }
  }
  const a = new FakeWindow('http://primary.localhost:4573/'), b = new FakeWindow('http://reserve.localhost:4574/');
  const aRef = { get closed() { return a.closed; }, postMessage(data, origin, ports = []) { if (origin !== a.location.origin) return; deliver(() => a.dispatch('message', { data: structuredClone(data), origin: b.location.origin, source: bRef, ports })); } };
  const bRef = { get closed() { return b.closed; }, postMessage(data, origin, ports = []) { if (origin !== b.location.origin) return; deliver(() => b.dispatch('message', { data: structuredClone(data), origin: a.location.origin, source: aRef, ports })); } };
  b.opener = aRef;
  a.openCalls = [];
  a.open = (url, name) => { a.openCalls.push({ url, name }); if (blocked) return null; b.location = new URL(url); return bRef; };
  return { a, b, aRef, bRef, packets, transfers, channels, deliveries, flush() { for (const action of deliveries.splice(0)) action(); } };
}
function authenticator({ creationPrf = true } = {}) {
  const records = new Map(); let creates = 0, gets = 0;
  const client = {
    async createCredential(request) {
      creates++; assert.equal(request.rp.id, config.recoveryRpId);
      const id = randomBytes(24); const record = { id, outputs: new Map() }; records.set(id.toString('hex'), record);
      const salt = Buffer.from(request.prfSalt).toString('hex'); const output = new Uint8Array(randomBytes(32)); record.outputs.set(salt, output);
      return { credentialId: new Uint8Array(id), prfEnabled: true, ...(creationPrf ? { prfOutput: new Uint8Array(output) } : {}) };
    },
    async getCredential(request) {
      gets++; assert.equal(request.rpId, config.recoveryRpId);
      const record = request.allowCredential ? records.get(Buffer.from(request.allowCredential.credentialId).toString('hex')) : [...records.values()][0];
      assert.ok(record); const salt = Buffer.from(request.prfSalt).toString('hex');
      if (!record.outputs.has(salt)) record.outputs.set(salt, new Uint8Array(randomBytes(32)));
      return { credentialId: new Uint8Array(record.id), prfOutput: new Uint8Array(record.outputs.get(salt)) };
    },
  };
  return { client, get creates() { return creates; }, get gets() { return gets; } };
}
function setup(pair, key = userKey(), overrides = {}) {
  const sender = startReserveSetup({ config, recoveryUrl: 'http://reserve.localhost:4574/reserve?mode=synthetic', ...key, window: pair.a, ...overrides });
  const receiver = createReserveReceiver({ config, originalOrigin: 'http://primary.localhost:4573', window: pair.b });
  return { sender, receiver, key };
}

test('deliberate setup independently verifies same existing account, owns copies and cleans transport', async () => {
  const pair = browserPair(), states = [], key = userKey(), before = new Uint8Array(key.privateKey);
  const sender = startReserveSetup({ config, recoveryUrl: 'http://reserve.localhost:4574/reserve?mode=synthetic', ...key, window: pair.a, onState: state => states.push(state) });
  assert.equal(pair.a.openCalls.length, 1); // synchronous, retains user activation
  const receiver = createReserveReceiver({ config, originalOrigin: 'http://primary.localhost:4573', window: pair.b, onState: state => states.push(state) });
  const auth = authenticator(), store = memoryStore();
  assert.equal(receiver.isEnrollment, true); assert.equal(pair.b.location.hash, ''); assert.equal(pair.b.location.search, '?mode=synthetic'); assert.equal(auth.creates, 0);
  const [onB, onA] = await Promise.all([receiver.prepare({ store, user, webAuthnClient: auth.client }), sender.completion]);
  assert.equal(onA.independentlyVerified, true); assert.deepEqual(onA, onB); assert.equal(onA.owner, key.expectedOwner);
  assert.equal(auth.creates, 1); assert.equal(auth.gets, 3);
  assert.deepEqual(key.privateKey, before); assert.equal(pair.transfers.length, 1); assert.ok(pair.transfers[0].privateKey.every(value => value === 0));
  assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0); assert.ok(pair.channels.every(({ port1, port2 }) => port1.closed && port2.closed));
  assert.ok(states.every(state => Object.keys(state).every(key => key === 'state' || key === 'code')));
  pair.a.closed = true; const beforeRecovery = auth.gets;
  const recovered = await recoverReserve({ config, store, webAuthnClient: auth.client });
  assert.equal(auth.gets - beforeRecovery, 2);
  try { assert.equal(recovered.owner, key.expectedOwner); } finally { recovered.close(); key.privateKey.fill(0); }
  await assert.rejects(() => receiver.prepare({ store, user, webAuthnClient: auth.client }), { code: 'RESERVE_ALREADY_ATTEMPTED' });
});

test('creation without a PRF result uses one fallback assertion and still independently recovers', async () => {
  const pair = browserPair(), { sender, receiver, key } = setup(pair);
  const auth = authenticator({ creationPrf: false }), store = memoryStore();
  try {
    const [onB, onA] = await Promise.all([receiver.prepare({ store, user, webAuthnClient: auth.client }), sender.completion]);
    assert.equal(onB.independentlyVerified, true); assert.deepEqual(onA, onB);
    assert.equal(auth.creates, 1); assert.equal(auth.gets, 4); assert.equal(store.calls.put, 1);
    pair.a.closed = true;
    const beforeRecovery = auth.gets;
    const recovered = await recoverReserve({ config, store, webAuthnClient: auth.client });
    try { assert.equal(recovered.owner, key.expectedOwner); assert.equal(auth.gets - beforeRecovery, 2); }
    finally { recovered.close(); }
  } finally { sender.cancel(); receiver.dispose(); key.privateKey.fill(0); }
});

test('cancellation after credential creation but before account delivery cannot prepare a reserve', async () => {
  const pair = browserPair({ delayed: true }), { sender, receiver, key } = setup(pair);
  const auth = authenticator(), store = memoryStore();
  const preparing = receiver.prepare({ store, user, webAuthnClient: auth.client });
  // Hold the authentic handoff after the new credential has been derived.
  await until(() => pair.deliveries.length > 0);
  assert.equal(auth.creates, 1); assert.equal(auth.gets, 0);
  receiver.dispose(); sender.cancel();
  await Promise.all([assert.rejects(preparing, { code: 'OPERATION_CANCELLED' }), assert.rejects(sender.completion, { code: 'OPERATION_CANCELLED' })]);
  pair.flush(); await tick(); pair.flush(); await tick();
  assert.equal(pair.transfers.length, 0); assert.equal(store.calls.put, 0); assert.equal(auth.gets, 0);
  assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0); key.privateKey.fill(0);
});

test('invalid origins, policy, expiry and blocked popup fail before credentials or transfer', () => {
  const pair = browserPair(), key = userKey();
  const base = { config, recoveryUrl: 'http://reserve.localhost:4574/', ...key, window: pair.a };
  for (const recoveryUrl of ['http://evil.example/', 'https://reserve.localhost.evil.example/', 'https://name:password@reserve.localhost/', 'http://reserve.localhost/#secret']) assert.throws(() => startReserveSetup({ ...base, recoveryUrl }), { code: 'ORIGIN_INVALID' });
  for (const timeoutMs of [0, 999, 300001, NaN]) assert.throws(() => startReserveSetup({ ...base, timeoutMs }), { code: 'TIMEOUT_INVALID' });
  assert.throws(() => startReserveSetup({ ...base, config: { ...config, expectedOwner: key.expectedOwner } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => startReserveSetup({ ...base, privateKey: new Uint8Array(32) }), { code: 'KEY_INVALID' });
  assert.throws(() => startReserveSetup({ ...base, expectedOwner: '0x' + '00'.repeat(20) }), { code: 'OWNER_MISMATCH' });
  assert.equal(pair.a.openCalls.length, 0);
  const blocked = browserPair({ blocked: true });
  assert.throws(() => startReserveSetup({ ...base, window: blocked.a }), { code: 'POPUP_BLOCKED' });
  assert.ok(key.privateKey.some(value => value !== 0)); key.privateKey.fill(0);
});

test('fresh reserve cannot enroll without an authentic setup context', async () => {
  const pair = browserPair(), auth = authenticator();
  const receiver = createReserveReceiver({ config, originalOrigin: 'http://primary.localhost:4573', window: pair.b });
  assert.equal(receiver.isEnrollment, false);
  await assert.rejects(() => receiver.prepare({ store: memoryStore(), user, webAuthnClient: auth.client }), { code: 'ENROLLMENT_UNAVAILABLE' });
  assert.equal(auth.creates, 0); receiver.dispose(); assert.equal(pair.b.count(), 0);
});

test('forged origin, source, nonce and extra message fields cannot request a key transfer', async () => {
  const pair = browserPair(), { sender, receiver, key } = setup(pair);
  const nonce = new URL(pair.a.openCalls[0].url).hash.slice(8);
  const valid = { data: { version: 1, kind: 'receive', nonce }, origin: pair.b.location.origin, source: pair.bRef };
  for (const event of [{ ...valid, origin: 'https://evil.example' }, { ...valid, source: {} }, { ...valid, data: { ...valid.data, nonce: '0'.repeat(64) } }, { ...valid, data: { ...valid.data, extra: true } }]) pair.a.dispatch('message', event);
  assert.equal(pair.transfers.length, 0); sender.cancel();
  await assert.rejects(sender.completion, { code: 'OPERATION_CANCELLED' }); await tick(); receiver.dispose(); key.privateKey.fill(0);
});

test('mismatched transferred policy is rejected and wiped without storing or reporting ready', async () => {
  const pair = browserPair({ rewritePayload: payload => { payload.config.appId = 'other-app'; } }), states = [];
  const { sender, receiver, key } = setup(pair, userKey(), { onState: state => states.push(state) });
  const store = memoryStore(), auth = authenticator();
  const result = await Promise.allSettled([receiver.prepare({ store, user, webAuthnClient: auth.client }), sender.completion]);
  assert.deepEqual(result.map(result => result.reason.code), ['HANDOFF_INVALID', 'HANDOFF_INVALID']);
  assert.equal(store.calls.put, 0); assert.ok(pair.transfers[0].privateKey.every(value => value === 0)); assert.equal(states.some(state => state.state === 'ready'), false);
  assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0); key.privateKey.fill(0);
});

test('unknown store write never reports ready or silently creates a replacement credential', async () => {
  const pair = browserPair(), { sender, receiver, key } = setup(pair), auth = authenticator(), backing = memoryStore();
  const store = { get: backing.get, async putIfAbsent(locator, bytes) { await backing.putIfAbsent(locator, bytes); throw new Error('uncertain'); } };
  const results = await Promise.allSettled([receiver.prepare({ store, user, webAuthnClient: auth.client }), sender.completion]);
  assert.deepEqual(results.map(result => result.reason.code), ['STORE_WRITE_UNKNOWN', 'STORE_WRITE_UNKNOWN']);
  assert.ok(results.every(result => result.reason.recordMayExist === true)); assert.equal(backing.calls.put, 1);
  await assert.rejects(() => receiver.prepare({ store, user, webAuthnClient: auth.client }), { code: 'RESERVE_ALREADY_ATTEMPTED' }); assert.equal(auth.creates, 1);
  const recovered = await recoverReserve({ config, store: backing, webAuthnClient: auth.client }); try { assert.equal(recovered.owner, key.expectedOwner); } finally { recovered.close(); key.privateKey.fill(0); }
});

test('cancellation during native-style pending creation rejects promptly and never transfers after late completion', async () => {
  const pair = browserPair(), { sender, receiver, key } = setup(pair), auth = authenticator(), store = memoryStore();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const webAuthnClient = { ...auth.client, async createCredential(request) { await pending; return auth.client.createCredential(request); } };
  const preparing = receiver.prepare({ store, user, webAuthnClient }); sender.cancel();
  await Promise.all([assert.rejects(preparing, { code: 'OPERATION_CANCELLED' }), assert.rejects(sender.completion, { code: 'OPERATION_CANCELLED' })]);
  release(); await tick(); await tick(); assert.equal(pair.transfers.length, 0); assert.equal(store.calls.put, 0); assert.equal(pair.b.count(), 0); key.privateKey.fill(0);
});

test('starter cancellation reaches the real navigator boundary before a creation response arrives', { timeout: 1500 }, async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; });
  let nativeOptions, release;
  const pending = new Promise(resolve => { release = resolve; });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
    create(options) { nativeOptions = options; return pending; },
  } } });
  const pair = browserPair(), { sender, receiver, key } = setup(pair), store = memoryStore();
  t.after(() => { sender.cancel(); receiver.dispose(); key.privateKey.fill(0); });
  const preparing = receiver.prepare({ store, user });
  assert.ok(nativeOptions.signal instanceof AbortSignal);
  assert.equal(nativeOptions.signal.aborted, false);
  sender.cancel();
  await Promise.all([assert.rejects(preparing, { code: 'OPERATION_CANCELLED' }), assert.rejects(sender.completion, { code: 'OPERATION_CANCELLED' })]);
  assert.equal(nativeOptions.signal.aborted, true);
  const latePrf = new Uint8Array(32).fill(59);
  release({ type: 'public-key', rawId: new ArrayBuffer(24), response: { getTransports: () => ['internal'] }, getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: latePrf.buffer } } }) });
  await tick(); await tick();
  assert.ok(latePrf.every(byte => byte === 0)); assert.equal(pair.transfers.length, 0); assert.equal(store.calls.put, 0);
});

test('cancellation while immutable write is pending prevents late readiness but preserves existing reserve path', async () => {
  const pair = browserPair(), states = [], { sender, receiver, key } = setup(pair, userKey(), { onState: state => states.push(state) });
  const auth = authenticator(), backing = memoryStore(); let releaseWrite, started = false;
  const blocked = new Promise(resolve => { releaseWrite = resolve; });
  const store = { get: backing.get, async putIfAbsent(locator, bytes) { started = true; await blocked; return backing.putIfAbsent(locator, bytes); } };
  const preparing = receiver.prepare({ store, user, webAuthnClient: auth.client }); await until(() => started); sender.cancel();
  const results = await Promise.allSettled([preparing, sender.completion]); assert.ok(results.every(result => result.reason.code === 'OPERATION_CANCELLED' && result.reason.recordMayExist));
  assert.ok(pair.transfers[0].privateKey.every(value => value === 0)); // before the network write resolves
  releaseWrite(); await tick(); await tick(); assert.equal(states.some(state => state.state === 'ready'), false); assert.equal(backing.calls.put, 1);
  assert.ok(pair.transfers[0].privateKey.every(value => value === 0)); assert.equal(pair.b.count(), 0); key.privateKey.fill(0);
});

test('receiver-owned payload is wiped immediately if a passkey assertion outlives cancellation', async () => {
  const pair = browserPair(), { sender, receiver, key } = setup(pair), auth = authenticator(), store = memoryStore();
  let releaseAssertion, started = false;
  const blocked = new Promise(resolve => { releaseAssertion = resolve; });
  const webAuthnClient = { ...auth.client, async getCredential(request) { started = true; await blocked; return auth.client.getCredential(request); } };
  const preparing = receiver.prepare({ store, user, webAuthnClient });
  await until(() => started); sender.cancel();
  await Promise.all([assert.rejects(preparing, { code: 'OPERATION_CANCELLED' }), assert.rejects(sender.completion, { code: 'OPERATION_CANCELLED' })]);
  assert.ok(pair.transfers[0].privateKey.every(value => value === 0)); assert.ok(key.privateKey.some(value => value !== 0));
  releaseAssertion(); await tick(); await tick(); assert.equal(store.calls.put, 0); key.privateKey.fill(0);
});

test('timeout and popup close release listeners without transferring a key', async () => {
  for (const mode of ['timeout', 'popup']) {
    const pair = browserPair(), { sender, receiver, key } = setup(pair, userKey(), { timeoutMs: 1000 });
    if (mode === 'popup') pair.b.closed = true;
    await assert.rejects(sender.completion, { code: mode === 'popup' ? 'SETUP_WINDOW_CLOSED' : 'SETUP_EXPIRED' });
    await tick(); receiver.dispose(); assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0); assert.equal(pair.transfers.length, 0); key.privateKey.fill(0);
  }
});

test('observer exceptions cannot prevent confirmation or cleanup', async () => {
  const pair = browserPair(), { sender, receiver, key } = setup(pair, userKey(), { onState() { throw new Error('UI failure'); } });
  await Promise.all([receiver.prepare({ store: memoryStore(), user, webAuthnClient: authenticator().client }), sender.completion]);
  assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0); key.privateKey.fill(0);
});
