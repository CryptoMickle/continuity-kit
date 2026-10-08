import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMessage } from 'viem';
import { PROTOCOL } from '../sdk/index.mjs';
import { makeSdkFixture } from './sdk-fixture.mjs';

async function withFixture(run) { const f = makeSdkFixture(); try { await run(f); } finally { f.cleanup(); } }
const code = (expected) => (error) => error?.code === expected;
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}
const encode = (object) => new TextEncoder().encode(JSON.stringify(sorted(object)));
function mutate(bytes, change) { const value = JSON.parse(new TextDecoder().decode(bytes)); change(value); return encode(value); }
function flip(value) { const bytes = Buffer.from(value, 'base64url'); bytes[0] ^= 1; return bytes.toString('base64url'); }
async function verifyFresh(result, expectedOwner) {
  const message = `SYNTHETIC SDK DISCOVERY PROOF ${randomBytes(32).toString('hex')}`;
  const signature = await result.account.signMessage({ message });
  assert.equal(result.owner, expectedOwner);
  assert.equal(await verifyMessage({ address: expectedOwner, message, signature }), true);
  assert.equal(await verifyMessage({ address: expectedOwner, message: `${message}-different`, signature }), false);
}

test('ready requires independent discovery; recovery config carries no owner/locator/credential', async () => withFixture(async (f) => {
  const ready = await f.prepare();
  assert.equal(ready.status, 'ready'); assert.equal(ready.independentlyVerified, true);
  assert.equal(ready.owner, f.policy.expectedOwner); assert.equal(ready.protocol, PROTOCOL);
  assert.equal(f.store.calls.put, 1);
  assert.equal(f.store.calls.get, 3);
  assert.equal(f.stats().recoveryRequests, 4); // API invocations; not physical prompts.
  assert.equal(Object.hasOwn(f.config, 'expectedOwner'), false);
  assert.equal(Object.hasOwn(f.config, 'locator'), false);
  assert.equal(Object.hasOwn(f.config, 'credentialId'), false);
  assert.equal(f.stats().creates, 0);
}));

test('fresh module discovers only encrypted persisted index after original session ended', async () => withFixture(async (f) => {
  await f.prepare(); f.closeOriginal();
  await assert.rejects(() => f.originalAccount.signMessage({ message: 'SYNTHETIC CLOSED A' }), code('SESSION_ENDED'));
  const temp = await mkdtemp(join(tmpdir(), 'reserve-encrypted-records-'));
  try {
    // Only encrypted server records cross this filesystem boundary, not owner or key.
    const records = f.store.records();
    for (const [locator, bytes] of records) {
      const text = new TextDecoder().decode(bytes);
      assert.equal(text.includes(f.policy.expectedOwner), false);
      assert.equal(text.includes(f.config.appId), false);
      await writeFile(join(temp, locator), bytes, { mode: 0o600 });
    }
    const store = { async get(locator) { try { return new Uint8Array(await readFile(join(temp, locator))); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } } };
    const fresh = await import(`../sdk/index.mjs?fresh=${randomBytes(8).toString('hex')}`);
    const calls = f.stats();
    const recovered = await fresh.recoverReserve({ config: { ...f.config }, webAuthnClient: f.newRecoveryClient(), store });
    try {
      await verifyFresh(recovered, f.policy.expectedOwner);
      assert.deepEqual(recovered.policy, f.policy);
      assert.equal(f.stats().originalRequests, calls.originalRequests);
      assert.equal(f.stats().recoveryRequests - calls.recoveryRequests, 2);
    } finally { recovered.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
}));

test('missing reserve is distinct from unavailable store and never creates a new account', async () => withFixture(async (f) => {
  await assert.rejects(() => f.recover(), code('RESERVE_MISSING'));
  await assert.rejects(() => f.recover({ store: { async get() { throw new Error('synthetic offline'); } } }), code('STORE_UNAVAILABLE'));
  assert.equal(f.stats().creates, 0); assert.equal(f.store.calls.put, 0);
}));

test('original owner is checked before any credential call or store write', async () => withFixture(async (f) => {
  await assert.rejects(() => f.prepare({ policy: { ...f.policy, expectedOwner: '0x' + '1'.repeat(40) } }), code('OWNER_MISMATCH'));
  assert.equal(f.stats().recoveryRequests, 0); assert.equal(f.store.calls.put, 0);
}));

test('fresh recovery rejects fixture-supplied expectedOwner in config', async () => withFixture(async (f) => {
  await assert.rejects(() => f.recover({ config: { ...f.config, expectedOwner: f.policy.expectedOwner } }), code('CONFIG_INVALID'));
  assert.equal(f.stats().recoveryRequests, 0);
}));

test('same credential cannot be rebound in same module or fresh module against existing record', async () => withFixture(async (f) => {
  await f.prepare();
  await assert.rejects(() => f.prepare(), code('RESERVE_ALREADY_ATTEMPTED'));
  const fresh = await import(`../sdk/index.mjs?duplicate=${randomBytes(8).toString('hex')}`);
  await assert.rejects(() => f.prepare({}, fresh.prepareReserve), code('RESERVE_EXISTS'));
  assert.equal(f.store.calls.put, 1);
}));

for (const field of ['ciphertext', 'nonce']) {
  test(`tampered ${field} fails manifest authentication before vault assertion`, async () => withFixture(async (f) => {
    const ready = await f.prepare();
    const [[, bytes]] = f.store.records();
    f.store.replace(ready.locator, mutate(bytes, (record) => { record[field] = flip(record[field]); }));
    const before = f.stats().recoveryRequests;
    await assert.rejects(() => f.recover(), code('MANIFEST_AUTH_FAILED'));
    assert.equal(f.stats().recoveryRequests - before, 1);
  }));
}

test('record from another B credential cannot substitute account ownership', async () => {
  const first = makeSdkFixture(); const second = makeSdkFixture();
  try {
    const a = await first.prepare(); await second.prepare();
    const [[, bytes]] = second.store.records(); first.store.replace(a.locator, bytes);
    await assert.rejects(() => first.recover(), code('MANIFEST_AUTH_FAILED'));
  } finally { first.cleanup(); second.cleanup(); }
});

for (const [name, value] of [['derivation', 'other-leaf:v2'], ['originalRpId', 'other.example.localhost']]) {
  test(`authenticated manifest rejects changed trusted ${name}`, async () => withFixture(async (f) => {
    await f.prepare();
    await assert.rejects(() => f.recover({ config: { ...f.config, [name]: value } }), code('POLICY_MISMATCH'));
  }));
}

test('wrong app namespace and wrong B credential cannot discover a reserve', async () => withFixture(async (f) => {
  await f.prepare();
  await assert.rejects(() => f.recover({ config: { ...f.config, appId: 'different-app' } }), code('RESERVE_MISSING'));
  f.loseB();
  await assert.rejects(() => f.recover(), code('RESERVE_MISSING'));
  assert.equal(f.stats().creates, 0);
}));

test('wrong client RP cannot assert the configured recovery credential', async () => withFixture(async (f) => {
  await f.prepare();
  await assert.rejects(() => f.recover({ webAuthnClient: f.wrongRpClient() }), code('PASSKEY_OPERATION_FAILED'));
}));

for (const [name, transform] of [
  ['storage-selected-rp', (bytes) => mutate(bytes, (record) => { record.recoveryRpId = 'attacker.localhost'; })],
  ['storage-selected-code', (bytes) => mutate(bytes, (record) => { record.url = 'https://attacker.invalid/code'; })],
  ['noncanonical-json', (bytes) => new TextEncoder().encode(' ' + new TextDecoder().decode(bytes))],
  ['oversized-record', () => new Uint8Array(65537)],
]) {
  test(`${name} is rejected before vault unlock`, async () => withFixture(async (f) => {
    const ready = await f.prepare(); const [[, bytes]] = f.store.records();
    f.store.replace(ready.locator, transform(bytes));
    const before = f.stats().recoveryRequests;
    await assert.rejects(() => f.recover(), code('RECORD_INVALID'));
    assert.equal(f.stats().recoveryRequests - before, 1);
  }));
}

test('conditional create refusal does not report ready', async () => withFixture(async (f) => {
  await assert.rejects(() => f.prepare({ store: { async get() { return undefined; }, async putIfAbsent() { return false; } } }), code('RESERVE_EXISTS'));
}));

test('write-response loss remains unknown; later independent recovery can succeed', async () => withFixture(async (f) => {
  const store = {
    get: (locator) => f.store.get(locator),
    async putIfAbsent(locator, bytes) { await f.store.putIfAbsent(locator, bytes); throw new Error('synthetic lost response'); },
  };
  await assert.rejects(() => f.prepare({ store }), (error) => error.code === 'STORE_WRITE_UNKNOWN' && error.recordMayExist === true);
  const recovered = await f.recover(); await verifyFresh(recovered, f.policy.expectedOwner); recovered.close();
}));

test('readback mismatch cannot report readiness', async () => withFixture(async (f) => {
  let count = 0;
  const store = {
    async get(locator) { count++; return count === 2 ? new Uint8Array([1, 2, 3]) : f.store.get(locator); },
    putIfAbsent: (locator, bytes) => f.store.putIfAbsent(locator, bytes),
  };
  await assert.rejects(() => f.prepare({ store }), (error) => error.code === 'READBACK_FAILED' && error.recordMayExist === true);
}));

test('successful readback is insufficient when independent discovery cannot read the record', async () => withFixture(async (f) => {
  let count = 0;
  const store = {
    async get(locator) { count++; return count === 3 ? undefined : f.store.get(locator); },
    putIfAbsent: (locator, bytes) => f.store.putIfAbsent(locator, bytes),
  };
  await assert.rejects(() => f.prepare({ store }), (error) => error.code === 'RESERVE_MISSING' && error.recordMayExist === true);
  assert.equal(count, 3);
}));

test('abort after a completed store write cannot become ready', async () => withFixture(async (f) => {
  const controller = new AbortController();
  const store = {
    get: (locator) => f.store.get(locator),
    async putIfAbsent(locator, bytes) { const result = await f.store.putIfAbsent(locator, bytes); controller.abort(); return result; },
  };
  await assert.rejects(() => f.prepare({ store, signal: controller.signal }), (error) => error.code === 'OPERATION_CANCELLED' && error.recordMayExist === true);
}));

test('abort during a credential operation prevents a returned signer', async () => withFixture(async (f) => {
  await f.prepare();
  const controller = new AbortController();
  const client = {
    createCredential: f.webAuthnClient.createCredential,
    async getCredential(request) { const result = await f.webAuthnClient.getCredential(request); controller.abort(); return result; },
  };
  await assert.rejects(() => f.recover({ webAuthnClient: client, signal: controller.signal }), code('OPERATION_CANCELLED'));
}));

test('closed recovered Mera signer refuses further signatures', async () => withFixture(async (f) => {
  await f.prepare(); const result = await f.recover(); result.close();
  await assert.rejects(() => result.account.signMessage({ message: 'SYNTHETIC CLOSED B' }), code('SESSION_ENDED'));
}));
