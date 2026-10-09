import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { recoverTextReserve } from '../sdk/text-reserve.mjs';
import { startTextReserveSetup, createTextReserveReceiver } from '../sdk/text-browser.mjs';
import { memoryStore } from './sdk-fixture.mjs';

const config = Object.freeze({ appId: 'text-browser-tests', recoveryOrigin: 'http://reserve.localhost:4574', recoveryRpId: 'reserve.localhost' });
const text = '# A real document\n\nPreserve ÆØÅ and Unicode 📝.\n';
const user = { name: 'Synthetic text example', displayName: 'Synthetic text example' };
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
      if (value.kind === 'text') { transfers.push(value); rewritePayload?.(value); }
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
function setup(pair, overrides = {}) {
  const sender = startTextReserveSetup({ config, originalOrigin: pair.a.location.origin, text, recoveryUrl: config.recoveryOrigin + '/reserve?mode=synthetic', window: pair.a, ...overrides });
  const receiver = createTextReserveReceiver({ config, originalOrigin: pair.a.location.origin, window: pair.b });
  return { sender, receiver };
}

test('text-only handoff independently reopens exact text and releases transport without account material', async () => {
  const pair = browserPair(), states = [], { sender, receiver } = setup(pair, { onState: state => states.push(state) });
  const auth = authenticator(), store = memoryStore();
  assert.equal(pair.a.openCalls.length, 1); assert.equal(auth.creates, 0); assert.equal(pair.b.location.hash, '');
  const [a, b] = await Promise.all([sender.completion, receiver.prepare({ store, user, webAuthnClient: auth.client })]);
  assert.deepEqual(a, b); assert.equal(a.text, text); assert.equal(a.independentlyVerified, true);
  assert.equal(store.calls.put, 1); assert.equal(auth.creates, 1); assert.equal(pair.transfers.length, 1);
  assert.deepEqual(Object.keys(pair.transfers[0]).sort(), ['config', 'expiresAt', 'kind', 'text']);
  assert.ok(states.every(value => Object.keys(value).every(key => ['state', 'code'].includes(key))));
  assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0); assert.ok(pair.channels.every(({ port1, port2 }) => port1.closed && port2.closed));
  const opened = await recoverTextReserve({ config, store, webAuthnClient: auth.client });
  assert.equal(opened.text, text); for (const field of ['owner', 'account', 'privateKey', 'openAccount', 'close']) assert.equal(field in opened, false);
  await assert.rejects(() => receiver.prepare({ store, user, webAuthnClient: auth.client }), { code: 'RESERVE_ALREADY_ATTEMPTED' });
});

test('missing creation PRF uses fallback and still independently verifies one immutable snapshot', async () => {
  const pair = browserPair(), { sender, receiver } = setup(pair), auth = authenticator({ creationPrf: false }), store = memoryStore();
  const [a, b] = await Promise.all([sender.completion, receiver.prepare({ store, user, webAuthnClient: auth.client })]);
  assert.deepEqual(a, b); assert.equal(a.text, text); assert.equal(auth.creates, 1); assert.equal(store.calls.put, 1);
});

test('invalid origins, extra config, oversized text and blocked popup fail before a credential', () => {
  const pair = browserPair();
  const base = { config, originalOrigin: pair.a.location.origin, text, recoveryUrl: config.recoveryOrigin + '/', window: pair.a };
  for (const recoveryUrl of ['http://evil.example/', 'https://reserve.localhost.evil.example/', config.recoveryOrigin + '/#secret', 'http://name:password@reserve.localhost:4574/']) assert.throws(() => startTextReserveSetup({ ...base, recoveryUrl }));
  for (const originalOrigin of ['https://evil.example', config.recoveryOrigin, 'http://primary.localhost:4573/path']) assert.throws(() => startTextReserveSetup({ ...base, originalOrigin }));
  for (const timeoutMs of [0, 999, 300001, NaN]) assert.throws(() => startTextReserveSetup({ ...base, timeoutMs }), { code: 'TIMEOUT_INVALID' });
  assert.throws(() => startTextReserveSetup({ ...base, config: { ...config, owner: 'forbidden' } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => startTextReserveSetup({ ...base, text: 'x'.repeat(16385) }));
  assert.throws(() => startTextReserveSetup({ ...base, text: '\ud800' }));
  assert.equal(pair.a.openCalls.length, 0);
  assert.throws(() => startTextReserveSetup({ ...base, window: browserPair({ blocked: true }).a }), { code: 'POPUP_BLOCKED' });
});

test('fresh B has no enrollment authority without nonce and opener', async () => {
  const pair = browserPair(), auth = authenticator();
  const receiver = createTextReserveReceiver({ config, originalOrigin: pair.a.location.origin, window: pair.b });
  assert.equal(receiver.isEnrollment, false);
  await assert.rejects(() => receiver.prepare({ store: memoryStore(), user, webAuthnClient: auth.client }), { code: 'ENROLLMENT_UNAVAILABLE' });
  assert.equal(auth.creates, 0); receiver.dispose();
});

test('forged origin, source, nonce, version and additional fields cannot request text', async () => {
  const pair = browserPair(), { sender, receiver } = setup(pair);
  const nonce = new URL(pair.a.openCalls[0].url).hash.slice(13);
  const valid = { data: { version: 1, kind: 'receive', nonce }, origin: pair.b.location.origin, source: pair.bRef };
  for (const event of [{ ...valid, origin: 'https://evil.example' }, { ...valid, source: {} }, { ...valid, data: { ...valid.data, nonce: '0'.repeat(64) } }, { ...valid, data: { ...valid.data, version: 2 } }, { ...valid, data: { ...valid.data, extra: true } }]) pair.a.dispatch('message', event);
  assert.equal(pair.transfers.length, 0); sender.cancel(); await assert.rejects(sender.completion, { code: 'OPERATION_CANCELLED' }); receiver.dispose();
});

test('a mismatched transferred configuration cannot be stored', async () => {
  const pair = browserPair({ rewritePayload: value => { value.config.appId = 'other-app'; } }), { sender, receiver } = setup(pair), store = memoryStore();
  const results = await Promise.allSettled([sender.completion, receiver.prepare({ store, user, webAuthnClient: authenticator().client })]);
  assert.deepEqual(results.map(value => value.reason.code), ['HANDOFF_INVALID', 'HANDOFF_INVALID']); assert.equal(store.calls.put, 0);
});

test('altered text cannot produce readiness on A even if the independent B check passes', async () => {
  const pair = browserPair({ rewritePayload: value => { value.text = 'Altered during handoff'; } }), { sender, receiver } = setup(pair);
  const results = await Promise.allSettled([sender.completion, receiver.prepare({ store: memoryStore(), user, webAuthnClient: authenticator().client })]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.code, 'HANDOFF_INVALID');
  receiver.dispose();
});

test('cancel before text delivery closes listeners and never stores', async () => {
  const pair = browserPair({ delayed: true }), { sender, receiver } = setup(pair), auth = authenticator(), store = memoryStore();
  const pending = receiver.prepare({ store, user, webAuthnClient: auth.client }); await until(() => pair.deliveries.length);
  receiver.dispose(); sender.cancel();
  await Promise.all([assert.rejects(pending, { code: 'OPERATION_CANCELLED' }), assert.rejects(sender.completion, { code: 'OPERATION_CANCELLED' })]);
  pair.flush(); await tick(); pair.flush(); await tick();
  assert.equal(pair.transfers.length, 0); assert.equal(store.calls.put, 0); assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0);
});

test('unknown write keeps the existing-reserve path and never creates a replacement credential', async () => {
  const pair = browserPair(), { sender, receiver } = setup(pair), backing = memoryStore(), auth = authenticator();
  const store = { get: backing.get, async putIfAbsent(locator, bytes) { await backing.putIfAbsent(locator, bytes); throw Error('lost response'); } };
  const results = await Promise.allSettled([sender.completion, receiver.prepare({ store, user, webAuthnClient: auth.client })]);
  assert.ok(results.every(value => value.reason.code === 'STORE_WRITE_UNKNOWN' && value.reason.recordMayExist));
  assert.equal(backing.calls.put, 1); assert.equal(auth.creates, 1);
  await assert.rejects(() => receiver.prepare({ store, user, webAuthnClient: auth.client }), { code: 'RESERVE_ALREADY_ATTEMPTED' });
  assert.equal((await recoverTextReserve({ config, store: backing, webAuthnClient: auth.client })).text, text);
});

test('cancel during a pending write rejects promptly and cannot claim later readiness', async () => {
  const pair = browserPair(), states = [], { sender, receiver } = setup(pair, { onState: value => states.push(value) }), auth = authenticator(), backing = memoryStore();
  let release, started = false; const blocked = new Promise(resolve => { release = resolve; });
  const store = { get: backing.get, async putIfAbsent(locator, bytes) { started = true; await blocked; return backing.putIfAbsent(locator, bytes); } };
  const pending = receiver.prepare({ store, user, webAuthnClient: auth.client }); await until(() => started); sender.cancel();
  const results = await Promise.allSettled([sender.completion, pending]);
  assert.ok(results.every(value => value.reason.code === 'OPERATION_CANCELLED' && value.reason.recordMayExist));
  release(); await tick(); await tick(); assert.equal(backing.calls.put, 1); assert.equal(states.some(value => value.state === 'ready'), false);
});

test('native cancellation reaches navigator and late creation never transmits text', { timeout: 1500 }, async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; });
  let options, release; const pending = new Promise(resolve => { release = resolve; });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { create(value) { options = value; return pending; } } } });
  const pair = browserPair(), { sender, receiver } = setup(pair), store = memoryStore();
  t.after(() => { sender.cancel(); receiver.dispose(); });
  const preparing = receiver.prepare({ store, user }); assert.ok(options.signal instanceof AbortSignal); sender.cancel();
  await Promise.all([assert.rejects(preparing, { code: 'OPERATION_CANCELLED' }), assert.rejects(sender.completion, { code: 'OPERATION_CANCELLED' })]);
  assert.equal(options.signal.aborted, true);
  const bytes = new Uint8Array(32).fill(27);
  release({ type: 'public-key', rawId: new ArrayBuffer(24), response: { getTransports: () => ['internal'] }, getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: bytes.buffer } } }) });
  await tick(); await tick(); assert.ok(bytes.every(value => value === 0)); assert.equal(pair.transfers.length, 0); assert.equal(store.calls.put, 0);
});

test('timeout and closed popup reject and release listeners without text delivery', async () => {
  for (const mode of ['timeout', 'popup']) {
    const pair = browserPair(), { sender, receiver } = setup(pair, { timeoutMs: 1000 }); if (mode === 'popup') pair.b.closed = true;
    await assert.rejects(sender.completion, { code: mode === 'popup' ? 'SETUP_WINDOW_CLOSED' : 'SETUP_EXPIRED' });
    await tick(); receiver.dispose(); assert.equal(pair.transfers.length, 0); assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0);
  }
});

test('observer failures cannot interrupt independent completion or transport cleanup', async () => {
  const pair = browserPair(), { sender, receiver } = setup(pair, { onState() { throw Error('UI observer'); } });
  await Promise.all([sender.completion, receiver.prepare({ store: memoryStore(), user, webAuthnClient: authenticator().client })]);
  assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0);
});

test('B ignores forged channels and cancellations until its exact opener authenticates the channel', async t => {
  const pair = browserPair({ delayed: true }), { sender, receiver } = setup(pair), auth = authenticator(), store = memoryStore();
  t.after(() => { sender.cancel(); receiver.dispose(); });
  const pending = receiver.prepare({ store, user, webAuthnClient: auth.client });
  await until(() => pair.deliveries.length > 0);
  const nonce = new URL(pair.a.openCalls[0].url).hash.slice(13);
  let touched = 0;
  const port = { start() { touched++; }, close() { touched++; }, postMessage() { touched++; } };
  const valid = { data: { version: 1, kind: 'channel', nonce }, origin: pair.a.location.origin, source: pair.aRef, ports: [port] };
  for (const event of [
    { ...valid, origin: 'https://evil.example' }, { ...valid, source: {} },
    { ...valid, data: { ...valid.data, nonce: '0'.repeat(64) } },
    { ...valid, data: { ...valid.data, extra: true } },
    { ...valid, ports: [] }, { ...valid, ports: [port, port] },
    { ...valid, origin: 'https://evil.example', data: { version: 1, kind: 'cancel', nonce } },
    { ...valid, source: {}, data: { version: 1, kind: 'cancel', nonce } },
  ]) pair.b.dispatch('message', event);
  assert.equal(touched, 0); assert.equal(store.calls.put, 0);
  let settled = false;
  const completion = Promise.all([sender.completion, pending]).finally(() => { settled = true; });
  for (let i = 0; i < 200 && !settled; i++) { pair.flush(); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal(settled, true, 'authentic channel completes after forged events are ignored');
  const [a, b] = await completion;
  assert.deepEqual(a, b); assert.equal(a.text, text); assert.equal(store.calls.put, 1);
});

test('browser handoff preserves empty text, initial BOM, CRLF and supplementary Unicode exactly', async () => {
  for (const value of ['', '\ufeff# Kept\r\n\r\nUnicode 📝\r\n']) {
    const pair = browserPair(), { sender, receiver } = setup(pair, { text: value }), auth = authenticator(), store = memoryStore();
    const [a, b] = await Promise.all([sender.completion, receiver.prepare({ store, user, webAuthnClient: auth.client })]);
    assert.equal(a.text, value); assert.equal(b.text, value);
    assert.equal((await recoverTextReserve({ config, store, webAuthnClient: auth.client })).text, value);
  }
});
