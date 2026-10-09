import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkClientEnvironment, validateWorkEnrollmentToken } from '../work/client-config.mjs';
import { configuration } from '../work/config.mjs';

const now = Date.parse('2026-10-08T12:00:00.000Z');
const token = Buffer.alloc(32, 7).toString('base64url');
function hosted(role = 'recovery') {
  return { hosted: true, synthetic: false, physicalEnabled: true, role, originalOrigin: 'https://work-primary.example.com', recoveryOrigin: 'https://work-reserve.example.com', config: { appId: 'continuity-private-work-v1', originalRpId: 'work-primary.example.com', recoveryRpId: 'work-reserve.example.com', derivation: 'demo-existing-eoa:v1' }, expiresAt: '2026-11-10T00:00:00.000Z' };
}
function check(env, href = (env.role === 'primary' ? env.originalOrigin : env.recoveryOrigin) + '/') { return validateWorkClientEnvironment(env, href, now); }

test('local synthetic origins and hosted native origins are distinct accepted modes', () => {
  for (const role of ['primary', 'recovery']) {
    const local = { ...configuration(5073, 5074), role, synthetic: true, ...(role === 'recovery' ? { enrollmentToken: token } : {}) };
    assert.deepEqual(check(local), { hosted: false, primary: role === 'primary', expiresAtMs: undefined });
    const native = hosted(role);
    assert.deepEqual(check(native), { hosted: true, primary: role === 'primary', expiresAtMs: Date.parse(native.expiresAt) });
    assert.throws(() => validateWorkClientEnvironment(local, (role === 'primary' ? local.originalOrigin : local.recoveryOrigin) + '/', now, true));
    assert.equal(validateWorkClientEnvironment(native, (role === 'primary' ? native.originalOrigin : native.recoveryOrigin) + '/', now, true).hosted, true);
  }
});

test('mixed flags, exposed hosted tokens, wrong origins, RP swaps and foreign namespaces reject', () => {
  const mutations = [
    e => { e.synthetic = true; }, e => { e.hosted = false; }, e => { delete e.physicalEnabled; },
    e => { e.enrollmentToken = token; }, e => { e.role = 'other'; },
    e => { e.config.originalRpId = e.config.recoveryRpId; },
    e => { e.config.appId = 'private-work-example-v1'; }, e => { e.config.derivation = 'unexpected'; },
    e => { e.originalOrigin = 'http://work-primary.example.com'; },
    e => { e.recoveryOrigin += '/nested'; }, e => { e.config.extra = 'untrusted'; },
    e => { e.recoveryOrigin = e.originalOrigin; e.config.recoveryRpId = e.config.originalRpId; },
  ];
  for (const mutate of mutations) { const env = hosted(); mutate(env); assert.throws(() => check(env)); }
  assert.throws(() => check(hosted(), 'https://work-primary.example.com/'));
  assert.throws(() => check(hosted(), 'https://unrelated.example.com/'));
  assert.throws(() => check(hosted(), 'https://user:password@work-reserve.example.com/'));
  const local = { ...configuration(), role: 'recovery', synthetic: true, physicalEnabled: true };
  assert.throws(() => check(local));
  delete local.physicalEnabled; local.originalOrigin = 'http://different.localhost:5073'; local.config = { ...local.config, originalRpId: 'different.localhost' };
  assert.throws(() => check(local));
});

test('hosted expiry is canonical, future and bounded to 45 days', () => {
  for (const expiresAt of ['invalid', '2026-11-10T00:00:00Z', now + 1000, new Date(now).toISOString(), new Date(now - 1).toISOString(), new Date(now + 45 * 86400000 + 1).toISOString()]) {
    const env = hosted(); env.expiresAt = expiresAt; assert.throws(() => check(env));
  }
  const env = hosted(); env.expiresAt = new Date(now + 45 * 86400000).toISOString(); assert.equal(check(env).hosted, true);
});

test('enrollment accepts only one canonical 32-byte code; never whitespace, URL or aliases', () => {
  assert.equal(validateWorkEnrollmentToken(token), token);
  for (const value of [undefined, '', token + '=', token + '\n', ' ' + token, token.slice(1), 'https://example.com/' + token, token.slice(0, -1) + 'B', '*'.repeat(43)]) {
    assert.throws(() => validateWorkEnrollmentToken(value), { code: 'ENROLLMENT_CODE_INVALID' });
  }
});
