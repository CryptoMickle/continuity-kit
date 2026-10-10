import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { recoverTextReserveFromReplicas } from '../sdk/text-reserve.mjs';
import { startTextReserveReplicaSetup, createTextReserveReplicaReceiver } from '../sdk/text-browser.mjs';

const config = Object.freeze({ appId: 'text-browser-tests', recoveryOrigin: 'http://reserve.localhost:4574', recoveryRpId: 'reserve.localhost' });
const text = '# A real document\n\nPreserve ÆØÅ and Unicode 📝.\n';
const user = { name: 'Synthetic text example', displayName: 'Synthetic text example' };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('condition never reached'); }

// Synthetic transport only. Browser native WebAuthn and popup behavior are separate evidence.
function browserPair({ blocked = false, rewritePayload, rewritePacket, delayed = false } = {}) {
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
      rewritePacket?.(value); packets.push(value);
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
  const records = new Map(), outputs = []; let creates = 0, gets = 0;
  const client = {
    async createCredential(request) {
      creates++; assert.equal(request.rp.id, config.recoveryRpId);
      const id = randomBytes(24); const record = { id, outputs: new Map() }; records.set(id.toString('hex'), record);
      const salt = Buffer.from(request.prfSalt).toString('hex'); const output = new Uint8Array(randomBytes(32)); record.outputs.set(salt, output);
      const result = { credentialId: new Uint8Array(id), prfEnabled: true, ...(creationPrf ? { prfOutput: new Uint8Array(output) } : {}) }; outputs.push(result); return result;
    },
    async getCredential(request) {
      gets++; assert.equal(request.rpId, config.recoveryRpId);
      const record = request.allowCredential ? records.get(Buffer.from(request.allowCredential.credentialId).toString('hex')) : [...records.values()][0];
      assert.ok(record); const salt = Buffer.from(request.prfSalt).toString('hex');
      if (!record.outputs.has(salt)) record.outputs.set(salt, new Uint8Array(randomBytes(32)));
      const result = { credentialId: new Uint8Array(record.id), prfOutput: new Uint8Array(record.outputs.get(salt)) }; outputs.push(result); return result;
    },
  };
  return { client, outputs, get creates() { return creates; }, get gets() { return gets; } };
}
const replicaIds = Object.freeze(['alpha', 'beta']);
function memoryStore() {
  const records = new Map(), calls = { get: 0, put: 0 };
  return { records, calls, async get(key) { calls.get++; const value = records.get(key); return value && new Uint8Array(value); },
    async putIfAbsent(key, value) { calls.put++; if (records.has(key)) return false; records.set(key, new Uint8Array(value)); return true; } };
}
function targets(ids = replicaIds) { return ids.map(id => ({ id, store: memoryStore() })); }
function setup(pair, senderOptions = {}, receiverOptions = {}) {
  const sender = startTextReserveReplicaSetup({ config, replicaIds, originalOrigin: pair.a.location.origin, text,
    recoveryUrl: config.recoveryOrigin + '/reserve?mode=synthetic', window: pair.a, ...senderOptions });
  const receiver = createTextReserveReplicaReceiver({ config, replicaIds, originalOrigin: pair.a.location.origin, window: pair.b, ...receiverOptions });
  return { sender, receiver };
}
function cleaned(pair) { assert.equal(pair.a.count(), 0); assert.equal(pair.b.count(), 0); assert.ok(pair.channels.every(({ port1, port2 }) => port1.closed && port2.closed)); }
function safeFailure(error, expectedIds = replicaIds) {
  assert.deepEqual(error.replicas.map(item => item.id), expectedIds);
  assert.ok(Object.isFrozen(error.replicas));
  for (const item of error.replicas) { assert.ok(Object.isFrozen(item)); assert.ok(Object.keys(item).every(key => ['id', 'stage', 'status', 'code'].includes(key))); }
  assert.equal(JSON.stringify(error).includes(text), false);
}

test('two and three intended copies independently verify before A becomes ready', async () => {
  for (const ids of [replicaIds, ['alpha', 'beta', 'gamma']]) {
    const pair = browserPair(), auth = authenticator(), replicas = targets(ids), states = [];
    const { sender, receiver } = setup(pair, { replicaIds: ids, onState: value => states.push(value) }, { replicaIds: ids });
    assert.equal(auth.creates, 0); assert.equal(pair.b.location.hash, '');
    const pending = receiver.prepare({ replicas, user, webAuthnClient: auth.client });
    assert.equal(auth.creates, 1, 'first native call stays in the click stack');
    const [a, b] = await Promise.all([sender.completion, pending]);
    assert.deepEqual(a, b); assert.equal(a.text, text);
    assert.deepEqual(a.replicas, ids.map(id => ({ id, stage: 'verify', status: 'verified' })));
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.replicas) && a.replicas.every(Object.isFrozen));
    assert.equal(auth.gets, 1, 'one independent discovery verifies every copy');
    assert.ok(auth.outputs.every(item => !item.prfOutput || item.prfOutput.every(byte => byte === 0)));
    assert.ok(replicas.every(item => item.store.calls.put === 1 && item.store.calls.get === 3));
    const copies = replicas.map(item => [...item.store.records.values()][0]);
    assert.ok(copies.every(bytes => Buffer.from(bytes).equals(Buffer.from(copies[0]))));
    assert.deepEqual(Object.keys(pair.transfers[0]).sort(), ['config', 'expiresAt', 'kind', 'replicaIds', 'text']);
    assert.deepEqual(pair.transfers[0].replicaIds, ids);
    assert.equal(states.at(-1).state, 'ready'); cleaned(pair);
  }
});

test('invalid IDs reject before popup or credential activity', () => {
  const pair = browserPair(), base = { config, replicaIds, originalOrigin: pair.a.location.origin, text, recoveryUrl: config.recoveryOrigin, window: pair.a };
  const sparse = new Array(2), accessor = ['alpha', 'beta'];
  Object.defineProperty(accessor, '0', { get() { throw Error('must not evaluate'); } });
  const extra = ['alpha', 'beta']; extra.secret = 'unexpected';
  for (const ids of [null, [], ['alpha'], ['alpha', 'alpha'], ['alpha', 'Beta'], ['alpha', 'beta', 'gamma', 'delta'], sparse, accessor, extra]) {
    assert.throws(() => startTextReserveReplicaSetup({ ...base, replicaIds: ids }), { code: 'REPLICAS_INVALID' });
    assert.throws(() => createTextReserveReplicaReceiver({ config, replicaIds: ids, originalOrigin: pair.a.location.origin, window: pair.b }), { code: 'REPLICAS_INVALID' });
  }
  assert.equal(pair.a.openCalls.length, 0);
});

test('invalid stores, duplicate targets and local ID reordering fail before a prompt', async t => {
  const pair = browserPair(), { sender, receiver } = setup(pair), auth = authenticator(), replicas = targets();
  t.after(() => { sender.cancel(); receiver.dispose(); });
  for (const options of [
    { replicas, store: memoryStore() }, { replicas: [{ id: 'alpha', store: replicas[0].store }, { id: 'beta', store: replicas[0].store }] },
    { replicas: [replicas[1], replicas[0]] }, { replicas: [{ id: 'alpha', store: { get() {} } }, replicas[1]] },
    { replicas: [{ ...replicas[0], secret: 'no' }, replicas[1]] }, { replicas: [replicas[0], , replicas[1]] },
  ]) await assert.rejects(receiver.prepare({ ...options, user, webAuthnClient: auth.client }));
  assert.equal(auth.creates, 0); assert.equal(auth.gets, 0); assert.equal(pair.transfers.length, 0);
  await Promise.all([sender.completion, receiver.prepare({ replicas, user, webAuthnClient: auth.client })]);
  cleaned(pair);
});

test('A and B disagreeing or reordered IDs reject before credential creation', async () => {
  for (const ids of [['beta', 'alpha'], ['alpha', 'gamma']]) {
    const pair = browserPair(), { sender, receiver } = setup(pair, {}, { replicaIds: ids }), auth = authenticator();
    const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas: targets(ids), user, webAuthnClient: auth.client })]);
    assert.equal(results[0].reason.code, 'HANDOFF_INVALID'); assert.equal(results[1].reason.code, 'REPLICA_IDS_MISMATCH');
    assert.equal(results[0].reason.recordMayExist, false); assert.equal(results[1].reason.recordMayExist, false);
    assert.equal(auth.creates, 0); assert.equal(auth.gets, 0); assert.equal(pair.transfers.length, 0); cleaned(pair);
  }
});

test('altered payload IDs or config cannot write to any replica', async () => {
  for (const rewritePayload of [value => value.replicaIds.reverse(), value => { value.replicaIds = ['alpha', 'gamma']; }, value => { value.config.appId = 'different'; }]) {
    const pair = browserPair({ rewritePayload }), { sender, receiver } = setup(pair), auth = authenticator(), replicas = targets();
    const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas, user, webAuthnClient: auth.client })]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'HANDOFF_INVALID'));
    assert.ok(replicas.every(item => item.store.calls.put === 0)); cleaned(pair);
  }
});

test('A rejects partial, reordered, invalid and provider-enriched readiness diagnostics', async () => {
  const mutations = [
    result => { delete result.replicas; }, result => { result.replicas.pop(); },
    result => { result.replicas.reverse(); }, result => { result.replicas[0].status = 'written'; },
    result => { result.replicas[0].stage = 'readback'; }, result => { result.replicas[0].id = 'other'; },
    result => { result.replicas[0].locator = 'secret'; }, result => { result.replicas[0].code = 'PRIVATE_PASSWORD'; },
    result => { result.replicas[0].code = 'STORE_UNAVAILABLE'; },
  ];
  for (const mutate of mutations) {
    const states = [], pair = browserPair({ rewritePacket: value => { if (value.kind === 'prepared') mutate(value.result); } });
    const { sender, receiver } = setup(pair, { onState: value => states.push(value) });
    const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas: targets(), user, webAuthnClient: authenticator().client })]);
    assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.code, 'HANDOFF_INVALID'); assert.equal(results[0].reason.recordMayExist, true);
    assert.equal(results[1].status, 'fulfilled'); assert.equal(states.some(item => item.state === 'ready'), false); cleaned(pair);
  }
});

test('preflight rejection reports sanitized diagnostics and no possible write on both pages', async () => {
  const pair = browserPair(), { sender, receiver } = setup(pair), auth = authenticator(), replicas = targets();
  replicas[1].store.get = async () => { throw Object.assign(Error('private provider body'), { secret: text, code: 'PRIVATE_PASSWORD' }); };
  const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas, user, webAuthnClient: auth.client })]);
  for (const result of results) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'REPLICA_PREPARATION_FAILED'); assert.equal(result.reason.recordMayExist, false);
    safeFailure(result.reason); assert.equal(JSON.stringify(result.reason).includes('private'), false);
    assert.deepEqual(result.reason.replicas, [{ id: 'alpha', stage: 'preflight', status: 'missing' }, { id: 'beta', stage: 'preflight', status: 'unavailable', code: 'STORE_UNAVAILABLE' }]);
  }
  assert.ok(replicas.every(item => item.store.calls.put === 0)); assert.equal(auth.creates, 1); assert.equal(auth.gets, 0); cleaned(pair);
});

test('lost write response stays unknown with one PUT per store and no replacement key', async () => {
  const pair = browserPair(), { sender, receiver } = setup(pair), auth = authenticator(), replicas = targets();
  const put = replicas[1].store.putIfAbsent;
  replicas[1].store.putIfAbsent = async (locator, bytes) => { await put(locator, bytes); throw Error('private response body'); };
  const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas, user, webAuthnClient: auth.client })]);
  for (const result of results) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'REPLICA_PREPARATION_FAILED'); assert.equal(result.reason.recordMayExist, true); safeFailure(result.reason);
    assert.deepEqual(result.reason.replicas, [{ id: 'alpha', stage: 'write', status: 'written' }, { id: 'beta', stage: 'write', status: 'unknown', code: 'STORE_WRITE_UNKNOWN' }]);
  }
  await assert.rejects(receiver.prepare({ replicas, user, webAuthnClient: auth.client }), { code: 'RESERVE_ALREADY_ATTEMPTED' });
  const recovered = await recoverTextReserveFromReplicas({ config, replicas, webAuthnClient: auth.client });
  assert.equal(recovered.reserve.text, text); assert.equal(auth.creates, 1); assert.ok(replicas.every(item => item.store.calls.put === 1)); cleaned(pair);
});

test('one surviving copy cannot make preparation ready if independent peer verification fails', async () => {
  const pair = browserPair(), { sender, receiver } = setup(pair), auth = authenticator(), replicas = targets();
  const get = replicas[1].store.get; let calls = 0;
  replicas[1].store.get = async locator => { const value = await get(locator); return ++calls === 3 ? new Uint8Array([7, 8, 9]) : value; };
  const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas, user, webAuthnClient: auth.client })]);
  for (const result of results) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'INDEPENDENT_CHECK_FAILED'); assert.equal(result.reason.recordMayExist, true);
    assert.deepEqual(result.reason.replicas, [{ id: 'alpha', stage: 'verify', status: 'verified' }, { id: 'beta', stage: 'verify', status: 'rejected', code: 'RECORD_INVALID' }]);
  }
  assert.equal(auth.gets, 1); cleaned(pair);
});

test('copied IDs and bound store methods survive caller mutation during the native prompt', async () => {
  const pair = browserPair(), ids = ['alpha', 'beta'], replicas = targets(), auth = authenticator();
  const originalStores = replicas.map(item => item.store), originals = originalStores.map(store => ({ get: store.get, put: store.putIfAbsent }));
  const { sender, receiver } = setup(pair, { replicaIds: ids }, { replicaIds: ids });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const client = { ...auth.client, async createCredential(request) { const value = await auth.client.createCredential(request); await gate; return value; } };
  const pending = receiver.prepare({ replicas, user, webAuthnClient: client });
  ids.reverse(); replicas[0].id = 'wrong'; replicas.reverse();
  for (const store of originalStores) { store.get = () => { throw Error('mutated'); }; store.putIfAbsent = () => { throw Error('mutated'); }; }
  release(); const [a, b] = await Promise.all([sender.completion, pending]);
  assert.deepEqual(a, b); assert.deepEqual(a.replicas.map(item => item.id), replicaIds);
  assert.ok(originalStores.every(store => store.calls.put === 1));
  originalStores.forEach((store, i) => { store.get = originals[i].get; store.putIfAbsent = originals[i].put; }); cleaned(pair);
});

test('A/B pagehide and external abort cancel native work; late PRF output is wiped', async () => {
  for (const mode of ['a-pagehide', 'b-pagehide', 'signal']) {
    const pair = browserPair(), { sender, receiver } = setup(pair), auth = authenticator(), replicas = targets(), controller = new AbortController();
    let release, output; const gate = new Promise(resolve => { release = resolve; });
    const client = { ...auth.client, async createCredential(request) { output = await auth.client.createCredential(request); await gate; return output; } };
    const pending = receiver.prepare({ replicas, user, webAuthnClient: client, signal: controller.signal });
    await until(() => output);
    if (mode === 'signal') controller.abort(); else pair[mode[0]].dispatch('pagehide');
    const results = await Promise.allSettled([sender.completion, pending]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'OPERATION_CANCELLED' && result.reason.recordMayExist === false));
    release(); await tick(); await tick(); assert.ok(output.prfOutput.every(byte => byte === 0));
    assert.ok(replicas.every(item => item.store.calls.put === 0)); assert.equal(pair.transfers.length, 0); cleaned(pair);
  }
});

test('cancel during a pending write remains conservative and ignores all late readiness', async () => {
  const states = [], pair = browserPair(), { sender, receiver } = setup(pair, { onState: value => states.push(value) }), auth = authenticator(), replicas = targets();
  let release, started = false; const gate = new Promise(resolve => { release = resolve; }), put = replicas[1].store.putIfAbsent;
  replicas[1].store.putIfAbsent = async (locator, bytes) => { started = true; await gate; return put(locator, bytes); };
  const pending = receiver.prepare({ replicas, user, webAuthnClient: auth.client }); await until(() => started); sender.cancel();
  const results = await Promise.allSettled([sender.completion, pending]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'OPERATION_CANCELLED' && result.reason.recordMayExist));
  results.forEach(result => safeFailure(result.reason));
  release(); await tick(); await tick(); assert.ok(replicas.every(item => item.store.calls.put === 1));
  assert.equal(states.some(item => item.state === 'ready'), false); assert.equal(auth.gets, 0); cleaned(pair);
});

test('existing credential denial is sanitized and cannot fall back to creating another key', async () => {
  const pair = browserPair(), { sender, receiver } = setup(pair), replicas = targets(); let gets = 0, creates = 0;
  const client = { createCredential() { creates++; throw Error('unexpected'); }, getCredential() { gets++; throw Object.assign(Error(text), { code: 'PRIVATE_PASSWORD', replicas: [{ text }], recordMayExist: true }); } };
  const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas, credentialMode: 'existing', webAuthnClient: client })]);
  assert.equal(gets, 1); assert.equal(creates, 0); assert.equal(pair.transfers.length, 0);
  for (const result of results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'PASSKEY_OPERATION_FAILED'); safeFailure(result.reason); assert.equal(result.reason.message, 'PASSKEY_OPERATION_FAILED'); }
  await assert.rejects(receiver.prepare({ replicas, credentialMode: 'existing', webAuthnClient: client }), { code: 'RESERVE_ALREADY_ATTEMPTED' }); cleaned(pair);
});

test('different app policies are rejected on B before a credential prompt', async () => {
  const pair = browserPair(), { sender, receiver } = setup(pair, {}, { config: { ...config, appId: 'different-app' } }), auth = authenticator();
  const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas: targets(), user, webAuthnClient: auth.client })]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'HANDOFF_INVALID' && result.reason.recordMayExist === false));
  assert.equal(auth.creates, 0); assert.equal(auth.gets, 0); assert.equal(pair.transfers.length, 0); cleaned(pair);
});

test('invalid failure diagnostics cannot downgrade an uncertain transferred setup', async () => {
  for (const change of [
    value => value.replicas.pop(), value => value.replicas.reverse(), value => { value.replicas[0].text = text; },
    value => { value.replicas[0].code = 'PRIVATE_PASSWORD'; }, value => { value.recordMayExist = 'false'; },
    value => { value.code = 'PRIVATE_PASSWORD'; },
  ]) {
    const pair = browserPair({ rewritePacket: value => { if (value.kind === 'failed') change(value); } });
    const { sender, receiver } = setup(pair), replicas = targets(); replicas[1].store.get = async () => { throw Error('unavailable'); };
    const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas, user, webAuthnClient: authenticator().client })]);
    assert.equal(results[0].reason.code, 'HANDOFF_INVALID'); assert.equal(results[0].reason.recordMayExist, true); safeFailure(results[0].reason);
    assert.equal(results[1].reason.code, 'REPLICA_PREPARATION_FAILED'); assert.equal(results[1].reason.recordMayExist, false); cleaned(pair);
  }
});

test('canceling the independent verification prompt cannot publish readiness from late success', async () => {
  const pair = browserPair(), states = [], { sender, receiver } = setup(pair, { onState: value => states.push(value) }), replicas = targets(), auth = authenticator();
  let release, output; const gate = new Promise(resolve => { release = resolve; });
  const client = { ...auth.client, async getCredential(request) { output = await auth.client.getCredential(request); await gate; return output; } };
  const pending = receiver.prepare({ replicas, user, webAuthnClient: client }); await until(() => output);
  pair.b.dispatch('pagehide');
  const results = await Promise.allSettled([sender.completion, pending]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'OPERATION_CANCELLED' && result.reason.recordMayExist));
  release(); await tick(); await tick(); assert.ok(output.prfOutput.every(byte => byte === 0));
  assert.equal(states.some(item => item.state === 'ready'), false); assert.ok(replicas.every(item => item.store.calls.put === 1 && item.store.calls.get === 2)); cleaned(pair);
});

test('a false flag cannot downgrade diagnostics that already report a possible write', async () => {
  for (const stage of ['write', 'readback', 'verify']) {
    const pair = browserPair({ rewritePacket: value => {
      if (value.kind === 'failed') { value.recordMayExist = false; value.replicas.forEach(item => { item.stage = stage; }); }
    } });
    const { sender, receiver } = setup(pair), replicas = targets();
    const put = replicas[1].store.putIfAbsent;
    replicas[1].store.putIfAbsent = async (locator, bytes) => { await put(locator, bytes); throw Error('lost reply'); };
    const results = await Promise.allSettled([sender.completion, receiver.prepare({ replicas, user, webAuthnClient: authenticator().client })]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'REPLICA_PREPARATION_FAILED' && result.reason.recordMayExist === true));
    assert.ok(results[0].reason.replicas.every(item => item.stage === stage));
    assert.ok(replicas.every(item => item.store.calls.put === 1)); cleaned(pair);
  }
});

