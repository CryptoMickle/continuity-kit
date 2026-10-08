import assert from 'node:assert/strict';
import test from 'node:test';
import { checkReserveEnvironment } from '../sdk/preflight.mjs';
import { recoverReserve } from '../sdk/index.mjs';

const config = { appId: 'synthetic-preflight', originalRpId: 'primary.example.com', recoveryRpId: 'recovery.example.net', derivation: 'direct-prf-v1' };
const untouched = () => { throw new Error('Static preflight must never call an API'); };
function environment(origin = 'https://recovery.example.net') {
  return {
    origin, isSecureContext: true,
    crypto: { getRandomValues: untouched, subtle: Object.fromEntries(['digest', 'importKey', 'deriveBits', 'deriveKey', 'encrypt', 'decrypt'].map(name => [name, untouched])) },
    navigator: { credentials: { create: untouched, get: untouched } },
    PublicKeyCredential: untouched, fetch: untouched, AbortController: untouched,
    TextEncoder: untouched, TextDecoder: untouched,
  };
}
function options(changes = {}) { return { config, role: 'recovery', originalOrigin: 'https://primary.example.com', recoveryOrigin: 'https://recovery.example.net', environment: environment(), ...changes }; }
const check = (report, id) => report.checks.find(item => item.id === id);

test('valid static checks never call browser APIs or claim actual physical passkey support', () => {
  const report = checkReserveEnvironment(options());
  assert.equal(report.ok, true);
  assert.equal(report.physicalPasskey, 'unverified');
  assert.equal(check(report, 'physical-passkey').status, 'unverified');
  assert.equal(check(report, 'storage-durability').status, 'unverified');
  assert.equal(report.checks.filter(item => item.status === 'pass').length, 9);
  assert.equal(Object.isFrozen(report), true); assert.equal(Object.isFrozen(report.checks), true);
  assert.ok(report.checks.every(Object.isFrozen));
});

test('primary and recovery must each execute on their exact origin, including port', () => {
  assert.equal(checkReserveEnvironment(options({ role: 'primary', environment: environment('https://primary.example.com') })).ok, true);
  for (const current of ['https://primary.example.com', 'https://recovery.example.net:8443', 'https://evil.recovery.example.net']) {
    const report = checkReserveEnvironment(options({ environment: environment(current) }));
    assert.equal(report.ok, false); assert.equal(check(report, 'current-origin').status, 'fail');
  }
});

test('explicit localhost origin pair is allowed only in a browser-reported secure context', () => {
  const local = options({ config: { ...config, originalRpId: 'primary.localhost', recoveryRpId: 'recovery.localhost' }, originalOrigin: 'http://primary.localhost:4573', recoveryOrigin: 'http://recovery.localhost:4574', environment: environment('http://recovery.localhost:4574') });
  assert.equal(checkReserveEnvironment(local).ok, true);
  assert.equal(checkReserveEnvironment({ ...local, environment: { ...local.environment, isSecureContext: false } }).ok, false);
});

for (const origin of ['http://recovery.example.net', 'https://recovery.example.net/', 'https://recovery.example.net/path', 'https://recovery.example.net?x=1', 'https://recovery.example.net#x', 'https://user:secret@recovery.example.net', 'https://RECOVERY.example.net', 'data:text/plain,recovery', '//recovery.example.net']) test(`rejects noncanonical or insecure configured origin ${origin}`, () => {
  const report = checkReserveEnvironment(options({ recoveryOrigin: origin, environment: environment(origin) }));
  assert.equal(report.ok, false); assert.equal(check(report, 'origins').status, 'fail');
});

test('shared parent RP or reversed role binding fails before credential discovery', () => {
  for (const proposed of [{ ...config, recoveryRpId: 'example.net' }, { ...config, originalRpId: config.recoveryRpId, recoveryRpId: config.originalRpId }]) {
    const report = checkReserveEnvironment(options({ config: proposed }));
    assert.equal(report.ok, false); assert.equal(check(report, 'rp-origin-binding').status, 'fail');
  }
});

for (const [name, invalid] of [
  ['missing app ID', { ...config, appId: undefined }],
  ['empty app ID', { ...config, appId: '' }],
  ['extra owner', { ...config, expectedOwner: '0x' + '1'.repeat(40) }],
  ['extra locator', { ...config, locator: 'synthetic' }],
  ['uppercase RP', { ...config, originalRpId: 'Primary.example.com' }],
  ['shared RP', { ...config, originalRpId: config.recoveryRpId }],
  ['invalid derivation', { ...config, derivation: 'with spaces' }],
  ['oversized derivation', { ...config, derivation: 'a'.repeat(193) }],
  ['array config', []],
  ['null config', null],
]) test(`config parity: preflight and core reject ${name}`, async () => {
  const report = checkReserveEnvironment(options({ config: invalid }));
  assert.equal(report.ok, false); assert.equal(check(report, 'config').status, 'fail');
  await assert.rejects(recoverReserve({ config: invalid, webAuthnClient: { getCredential: untouched }, store: { get: untouched } }), error => error?.code === 'CONFIG_INVALID');
});

test('missing crypto, native WebAuthn or HTTP APIs are explicit failures', () => {
  for (const [changed, id] of [
    [{ crypto: undefined }, 'web-crypto'],
    [{ crypto: { getRandomValues: untouched, subtle: {} } }, 'web-crypto'],
    [{ PublicKeyCredential: undefined }, 'webauthn-api'],
    [{ navigator: { credentials: { get: untouched } } }, 'webauthn-api'],
    [{ fetch: undefined }, 'transport-apis'],
    [{ TextDecoder: undefined }, 'transport-apis'],
  ]) {
    const report = checkReserveEnvironment(options({ environment: { ...environment(), ...changed } }));
    assert.equal(report.ok, false); assert.equal(check(report, id).status, 'fail');
    assert.equal(report.physicalPasskey, 'unverified');
  }
});

test('missing input and unsupported role give a diagnostic report rather than probing', () => {
  assert.equal(checkReserveEnvironment().ok, false);
  const report = checkReserveEnvironment(options({ role: 'reserve' }));
  assert.equal(report.ok, false); assert.equal(check(report, 'role').status, 'fail');
});

test('default environment in Node does not mistake global WebCrypto/fetch for a working browser', () => {
  const { environment: _, ...native } = options();
  const report = checkReserveEnvironment(native);
  assert.equal(report.ok, false); assert.equal(check(report, 'current-origin').status, 'fail');
  assert.equal(report.physicalPasskey, 'unverified');
});
