import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { validateNativeProfile, nativeConfig, validateNativeEnvironment, parseNativeGrants } from '../text-native/profile.mjs';

const now = Date.parse('2090-10-10T12:00:00.000Z');
const iso = offset => new Date(now + offset).toISOString();
const profile = () => ({ version: 1, appId: 'native-profile-tests', primaryOrigin: 'https://primary.example', recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example', expiresAt: iso(3600000), replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] });
const grants = (bound = profile()) => ({ format: 'continuitykit/native-replica-grants/v1', appId: bound.appId, recoveryOrigin: bound.recoveryOrigin, replicas: bound.replicas.map(({ id }) => ({ id, enrollmentToken: randomBytes(32).toString('base64url'), expiresAt: iso(300000) })) });
const parse = (value, bound = profile(), at = now) => parseNativeGrants(JSON.stringify(value), bound, { now: at });
function safeReject(action, code) {
  assert.throws(action, error => {
    assert.equal(error.code, code); assert.equal(error.message, code);
    assert.deepEqual(Object.keys(error), ['code']); return true;
  });
}

test('profile and grant copies are deeply frozen and preserve ordered public routes', () => {
  for (const count of [2, 3]) {
    const input = profile(); if (count === 3) input.replicas.push({ id: 'gamma', basePath: '/api/replicas/gamma/reserve' });
    const valid = validateNativeProfile(input, { now }), bundle = grants(input), copied = parse(bundle, valid);
    assert.deepEqual(valid, input); assert.deepEqual(copied, bundle);
    assert.ok(Object.isFrozen(valid) && Object.isFrozen(valid.replicas) && valid.replicas.every(Object.isFrozen));
    assert.ok(Object.isFrozen(copied) && Object.isFrozen(copied.replicas) && copied.replicas.every(Object.isFrozen));
    input.appId = 'changed'; input.replicas.reverse(); bundle.replicas[0].enrollmentToken = 'changed';
    assert.equal(valid.appId, 'native-profile-tests'); assert.equal(valid.replicas[0].id, 'alpha'); assert.notEqual(copied.replicas[0].enrollmentToken, 'changed');
    assert.deepEqual(nativeConfig(valid), { appId: valid.appId, recoveryOrigin: valid.recoveryOrigin, recoveryRpId: valid.recoveryRpId });
    assert.ok(Object.isFrozen(nativeConfig(valid)));
  }
});

test('exact profile schemas reject extra fields, wrong types and noncanonical origins', () => {
  const mutations = [
    value => { value.version = 2; }, value => { value.appId = '_invalid'; }, value => { value.appId = 'x'.repeat(97); },
    value => { value.extra = 'forbidden'; }, value => { delete value.expiresAt; },
    value => { value.primaryOrigin = value.recoveryOrigin; }, value => { value.primaryOrigin = 'https://reserve.example:8443'; },
    value => { value.recoveryRpId = 'example'; }, value => { value.recoveryRpId = 'Reserve.example'; },
    ...['https://reserve.example/', 'https://reserve.example:443', 'https://Reserve.example', 'https://reserve.example/path',
      'https://reserve.example?x', 'https://reserve.example#x', 'http://reserve.example', 'file:///reserve.example',
      'https://user:secret@reserve.example', 'https://reserve.example.', 'https://☃.example'].map(origin => value => { value.recoveryOrigin = origin; }),
  ];
  for (const mutate of mutations) { const input = profile(); mutate(input); safeReject(() => validateNativeProfile(input, { now }), 'NATIVE_PROFILE_INVALID'); }
});

test('local native testing allows only exact localhost forms on distinct RP hosts', () => {
  for (const recoveryOrigin of ['http://localhost:6074', 'http://reserve.localhost:6074', 'http://127.0.0.1:6074']) {
    const input = { ...profile(), primaryOrigin: 'http://primary.localhost:6073', recoveryOrigin, recoveryRpId: new URL(recoveryOrigin).hostname };
    assert.deepEqual(validateNativeProfile(input, { now }), input);
  }
  for (const [primaryOrigin, recoveryOrigin] of [
    ['http://localhost:6073', 'http://localhost:6074'], ['http://primary.localhost:6073', 'http://127.1:6074'],
    ['http://primary.localhost:6073', 'http://localhost.:6074'], ['http://primary.localhost:6073', 'http://[::1]:6074'],
  ]) safeReject(() => validateNativeProfile({ ...profile(), primaryOrigin, recoveryOrigin, recoveryRpId: new URL(recoveryOrigin).hostname }, { now }), 'NATIVE_PROFILE_INVALID');
});

test('replicas must be 2–3 unique ordered IDs with exact fixed namespace routes', () => {
  const malformed = [[], [profile().replicas[0]], [...profile().replicas, ...profile().replicas], [profile().replicas[0], profile().replicas[0]],
    [{ id: 'Alpha', basePath: '/api/replicas/Alpha/reserve' }, profile().replicas[1]],
    [{ id: 'a'.repeat(33), basePath: '/api/replicas/' + 'a'.repeat(33) + '/reserve' }, profile().replicas[1]]];
  for (const basePath of ['/api/replicas/beta/reserve', '/api/replicas/alpha/reserve/', '/api/replicas/alpha/reserve?x', '/api/replicas/%61lpha/reserve', 'https://store.example/api/reserve']) malformed.push([{ id: 'alpha', basePath }, profile().replicas[1]]);
  for (const replicas of malformed) safeReject(() => validateNativeProfile({ ...profile(), replicas }, { now }), 'NATIVE_PROFILE_INVALID');
  const reversed = profile(); reversed.replicas.reverse(); assert.equal(validateNativeProfile(reversed, { now }).replicas[0].id, 'beta');
});

test('canonical expiry rejects aliases, malformed dates and expired profiles', () => {
  for (const expiresAt of [iso(0), iso(-1)]) safeReject(() => validateNativeProfile({ ...profile(), expiresAt }, { now }), 'NATIVE_PROFILE_EXPIRED');
  for (const expiresAt of ['2090-10-10T13:00:00Z', '2090-10-10T13:00:00.000+00:00', '2090-02-30T13:00:00.000Z', 'tomorrow', 123]) safeReject(() => validateNativeProfile({ ...profile(), expiresAt }, { now }), 'NATIVE_PROFILE_INVALID');
  for (const at of [NaN, Infinity, -1, 0.5, 'now', undefined]) safeReject(() => validateNativeProfile(profile(), { now: at }), 'NATIVE_TIME_INVALID');
});

test('descriptors, sparse arrays and hostile proxies are rejected without evaluating accessors', () => {
  let reads = 0;
  const getter = { enumerable: true, get() { reads++; throw Error('private credential contents'); } };
  const inputs = [];
  for (const field of Object.keys(profile())) { const input = profile(); Object.defineProperty(input, field, getter); inputs.push(input); }
  const nested = profile(); Object.defineProperty(nested.replicas[0], 'id', getter); inputs.push(nested);
  const arrayGetter = profile(); Object.defineProperty(arrayGetter.replicas, '0', getter); inputs.push(arrayGetter);
  const sparse = profile(); delete sparse.replicas[0]; inputs.push(sparse);
  const symbol = profile(); symbol[Symbol('extra')] = 'hidden'; inputs.push(symbol);
  const hidden = profile(); Object.defineProperty(hidden, 'private', { value: 'hidden' }); inputs.push(hidden);
  const inherited = Object.create(profile()); inputs.push(inherited);
  inputs.push(new Proxy(profile(), { getPrototypeOf() { throw Error('private credential contents'); } }));
  for (const input of inputs) safeReject(() => validateNativeProfile(input, { now }), 'NATIVE_PROFILE_INVALID');
  const options = {}; Object.defineProperty(options, 'now', getter);
  safeReject(() => validateNativeProfile(profile(), options), 'NATIVE_TIME_INVALID');
  const environment = { profile: profile() }; Object.defineProperty(environment, 'role', getter);
  safeReject(() => validateNativeEnvironment(environment, 'https://reserve.example', { now }), 'NATIVE_ENVIRONMENT_INVALID');
  assert.equal(reads, 0);
});

test('environment requires exact role/origin before any native page action', () => {
  for (const role of ['primary', 'recovery']) {
    const bound = profile(), origin = role === 'primary' ? bound.primaryOrigin : bound.recoveryOrigin;
    for (const suffix of ['', '/', '/app?mode=native#nonce']) {
      const environment = validateNativeEnvironment({ profile: bound, role }, origin + suffix, { now });
      assert.equal(environment.role, role); assert.ok(Object.isFrozen(environment) && Object.isFrozen(environment.profile));
    }
  }
  for (const href of ['https://primary.example', 'https://reserve.example.evil', 'https://reserve.example:8443', 'http://reserve.example',
    'https://user:secret@reserve.example', 'https://Reserve.example/', 'https://reserve.example:443/', 'https://reserve.example\\app']) {
    safeReject(() => validateNativeEnvironment({ profile: profile(), role: 'recovery' }, href, { now }), 'NATIVE_ORIGIN_MISMATCH');
  }
  safeReject(() => validateNativeEnvironment({ profile: profile(), role: 'reserve' }, 'https://reserve.example', { now }), 'NATIVE_ENVIRONMENT_INVALID');
  safeReject(() => validateNativeEnvironment({ profile: profile(), role: 'recovery', extra: true }, 'https://reserve.example', { now }), 'NATIVE_ENVIRONMENT_INVALID');
});

test('grants bind exact app, origin, replica count and ordered IDs', () => {
  const mutations = [value => { value.appId = 'other-app'; }, value => { value.recoveryOrigin = 'https://other.example'; },
    value => { value.recoveryOrigin += '/'; }, value => value.replicas.reverse(), value => { value.replicas[0].id = 'gamma'; },
    value => { value.replicas.push({ ...value.replicas[0], id: 'gamma', enrollmentToken: randomBytes(32).toString('base64url') }); }];
  for (const mutate of mutations) { const bundle = grants(); mutate(bundle); safeReject(() => parse(bundle), 'NATIVE_GRANTS_CONTEXT_MISMATCH'); }
  for (const mutate of [value => { value.extra = true; }, value => { value.replicas[0].extra = true; }, value => { value.format = 'other'; }, value => value.replicas.pop()]) {
    const bundle = grants(); mutate(bundle); safeReject(() => parse(bundle), 'NATIVE_GRANTS_INVALID');
  }
});

test('32-byte tokens must be unique canonical base64url, including zero padding bits', () => {
  const base = grants(), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const token = base.replicas[0].enrollmentToken, alias = token.slice(0, 42) + alphabet[alphabet.indexOf(token[42]) + 1];
  assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(token, 'base64url'), 'alias decodes to identical bytes');
  for (const invalid of [alias, token + '=', token + 'A', token.slice(1), 'not a token', 'A'.repeat(42) + '+', 4, null, {}]) {
    const bundle = grants(); bundle.replicas[0].enrollmentToken = invalid; safeReject(() => parse(bundle), 'NATIVE_GRANTS_INVALID');
  }
  const duplicate = grants(); duplicate.replicas[1].enrollmentToken = duplicate.replicas[0].enrollmentToken;
  safeReject(() => parse(duplicate), 'NATIVE_GRANTS_INVALID');
});

test('grants expire strictly and never outlive five minutes or the profile', () => {
  for (const offset of [0, -1]) { const bundle = grants(); bundle.replicas[0].expiresAt = iso(offset); safeReject(() => parse(bundle), 'NATIVE_GRANTS_EXPIRED'); }
  const overlong = grants(); overlong.replicas[0].expiresAt = iso(300001); safeReject(() => parse(overlong), 'NATIVE_GRANTS_INVALID');
  const shortProfile = { ...profile(), expiresAt: iso(60000) }; safeReject(() => parse(grants(shortProfile), shortProfile), 'NATIVE_GRANTS_INVALID');
  const equal = grants(shortProfile); equal.replicas.forEach(item => { item.expiresAt = shortProfile.expiresAt; }); assert.deepEqual(parse(equal, shortProfile), equal);
  const alias = grants(); alias.replicas[0].expiresAt = '2090-10-10T12:05:00.000+00:00'; safeReject(() => parse(alias), 'NATIVE_GRANTS_INVALID');
  const expiredProfile = { ...profile(), expiresAt: iso(0) }; safeReject(() => parse(grants(expiredProfile), expiredProfile), 'NATIVE_PROFILE_EXPIRED');
});

test('bounded JSON rejects duplicate keys and escaped aliases without secret-bearing errors', () => {
  const bundle = grants(), valid = JSON.stringify(bundle), token = bundle.replicas[0].enrollmentToken;
  const malformed = ['{', 'null', '[]', valid + ' trailing', ' '.repeat(8193) + valid,
    valid.replace('"appId":', '"appId":"hidden","appId":'),
    valid.replace('"appId":', '"\\u0061ppId":"hidden","appId":'),
    valid.replace('"enrollmentToken":', '"enrollmentToken":"secret","enrollmentToken":'),
    valid.replace('"replicas":', '"__proto__":{},"replicas":')];
  for (const input of malformed) {
    assert.throws(() => parseNativeGrants(input, profile(), { now }), error => {
      assert.equal(error.code, 'NATIVE_GRANTS_INVALID'); assert.equal(error.message, error.code);
      assert.equal(JSON.stringify(error).includes(token), false); assert.equal(JSON.stringify(error).includes('hidden'), false); return true;
    });
  }
  const pretty = JSON.stringify(bundle, null, 2); assert.deepEqual(parseNativeGrants(pretty, profile(), { now }), bundle);
  const escaped = valid.replace('"appId":', '"\\u0061ppId":'); assert.deepEqual(parseNativeGrants(escaped, profile(), { now }), bundle);
});
