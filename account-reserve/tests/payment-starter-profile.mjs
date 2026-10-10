import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';

// The source template has its own package boundary, whose tarball dependency is
// installed only in generated consumers. Resolve its unchanged public imports
// through this repository's export map for these focused source tests. The
// separate installed starter suite verifies the actual dependency boundary.
const publicParent = new URL('../package.json', import.meta.url).href;
const hookSource = `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){return next(specifier,specifier.startsWith('@continuitykit/account-reserve')?{...context,parentURL:${JSON.stringify(publicParent)}}:context);}});`;
const hook = registerHooks({ resolve(specifier, context, next) { return next(specifier, specifier.startsWith('@continuitykit/account-reserve') ? { ...context, parentURL: publicParent } : context); } });
const { validatePaymentStarterProfile, serializePaymentStarterProfile, parsePaymentStarterProfile, checkPaymentStarterEnvironment } = await import('../payment-starter/profile.mjs');
const { runPaymentStarterDoctor } = await import('../payment-starter/doctor.mjs');
hook.deregister();

const example = JSON.parse(await readFile(new URL('../payment-starter/profile.example.json', import.meta.url), 'utf8'));
const profile = () => structuredClone(example);
const invalid = action => assert.throws(action, error => error.code === 'PAYMENT_STARTER_PROFILE_INVALID' && error.message === error.code && Object.keys(error).join(',') === 'code');
const digest = value => createHash('sha256').update(value).digest('hex');
const snapshot = origin => ({ origin, isSecureContext: true,
  crypto: { getRandomValues() { throw Error('unexpected crypto'); }, subtle: Object.fromEntries(['digest', 'importKey', 'deriveBits', 'deriveKey', 'encrypt', 'decrypt'].map(key => [key, () => { throw Error('unexpected crypto'); }])) },
  navigator: { credentials: { create() { throw Error('unexpected create'); }, get() { throw Error('unexpected get'); } } },
  PublicKeyCredential() {}, fetch() { throw Error('unexpected fetch'); }, AbortController, TextEncoder, TextDecoder });
async function temporary(t) { const path = await mkdtemp(join(tmpdir(), 'payment-profile-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('strict public profile round trips to immutable bigint claims without credential, storage or network I/O', t => {
  let fetches = 0, browserReads = 0;
  t.mock.method(globalThis, 'fetch', () => { fetches++; throw Error('unexpected fetch'); });
  for (const key of ['navigator', 'localStorage', 'PublicKeyCredential']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, get() { browserReads++; throw Error('unexpected browser access'); } });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  const input = profile();
  input.payment.claims = Array.from({ length: 8 }, (_, index) => ({ rightId: String(index * 2 + 1), amount: '10000000000000000', nonce: index + 3 }));
  const valid = validatePaymentStarterProfile(input);
  assert.equal(valid.payment.claims[7].rightId, 15n);
  for (const object of [valid, valid.reserve, valid.payment, valid.payment.claims, ...valid.payment.claims]) assert.ok(Object.isFrozen(object));
  assert.equal(validatePaymentStarterProfile(valid), valid);
  assert.deepEqual(serializePaymentStarterProfile(valid), input);
  assert.deepEqual(parsePaymentStarterProfile(JSON.stringify(input)), valid);
  input.reserve.appId = 'changed'; input.payment.claims[0].nonce = 40;
  assert.equal(valid.reserve.appId, example.reserve.appId); assert.equal(valid.payment.claims[0].nonce, 3);
  const serialized = serializePaymentStarterProfile(valid); serialized.payment.claims[0].nonce = 100;
  assert.equal(valid.payment.claims[0].nonce, 3); assert.equal(fetches, 0); assert.equal(browserReads, 0);
});

test('profile rejects noncanonical origins, shared RP hosts, store escapes and wrong schema', () => {
  const mutations = [
    value => { value.version = 2; }, value => { value.extra = 'secret'; }, value => { delete value.reserve; },
    value => { value.reserve.derivation += '\n'; }, value => { value.reserve.appId += '\n'; },
    value => { value.reserve.originalRpId = 'example.org'; }, value => { value.reserve.recoveryRpId = 'example.org'; },
    value => { value.originalOrigin = 'https://reserve.example.org:9443'; value.reserve.originalRpId = 'reserve.example.org'; },
    ...['https://Reserve.example.org', 'https://reserve.example.org:443', 'https://reserve.example.org/', 'https://reserve.example.org/?x',
      'https://reserve.example.org#x', 'https://secret:token@reserve.example.org', 'https://reserve.example.org.', 'http://reserve.example.org',
      'http://127.0.0.1:9090', 'http://[::1]:9090', 'file:///reserve'].map(origin => value => { value.recoveryOrigin = origin; }),
    ...['//other.example/api', 'https://other.example/api', '/api/../reserve', '/api/%2e%2e/reserve', '/api/reserve/', '/api/reserve?x', '/api/reserve#x', '/api/reserve\n', '/api\\reserve'].map(path => value => { value.storeBasePath = path; }),
  ];
  for (const mutation of mutations) { const value = profile(); mutation(value); invalid(() => validatePaymentStarterProfile(value)); }
  const local = profile(); local.originalOrigin = 'http://primary.localhost:6093'; local.recoveryOrigin = 'http://reserve.localhost:6094';
  local.reserve.originalRpId = 'primary.localhost'; local.reserve.recoveryRpId = 'reserve.localhost';
  assert.equal(validatePaymentStarterProfile(local).recoveryOrigin, local.recoveryOrigin);
});

test('payment validation uses the installed SDK bounds plus canonical JSON claim strings', () => {
  const mutations = [value => { value.payment.chainId = 31337; }, value => { value.payment.chainId = 1; },
    value => { value.payment.owner = value.payment.issuer; }, value => { value.payment.owner = '0x' + '0'.repeat(40); },
    value => { value.payment.expectedRuntimeCodeHash += '\n'; }, value => { value.payment.expectedRuntimeCodeHash = '0x' + '0'.repeat(64); },
    value => { value.payment.claims = []; }, value => { value.payment.claims = Array(9).fill(value.payment.claims[0]); },
    value => { value.payment.claims.push({ ...value.payment.claims[0], nonce: 1 }); },
    value => { value.payment.claims.push({ rightId: '2', amount: '1', nonce: 5 }); },
    value => { value.payment.claims[0].amount = '1000000000000000001'; }, value => { value.payment.claims[0].nonce = 0.5; },
    value => { value.payment.claims[0].nonce = -1; }, value => { value.payment.claims[0].nonce = '0'; },
    ...['0', '01', '-1', '+1', '1.0', '1e3', ' 1', '1\n', String(2n ** 256n), 1, 1n].map(rightId => value => { value.payment.claims[0].rightId = rightId; }),
    ...['2090-01-01T00:00:00Z', '2090-02-30T00:00:00.000Z', 'never', 0].map(expiresAt => value => { value.payment.expiresAt = expiresAt; }),
  ];
  for (const mutation of mutations) { const value = profile(); mutation(value); invalid(() => validatePaymentStarterProfile(value)); }
  const expired = profile(); expired.payment.expiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal(validatePaymentStarterProfile(expired).payment.expiresAt, expired.payment.expiresAt);
});

test('profile never evaluates nested accessors and rejects sparse, hidden or inherited policy', () => {
  let reads = 0;
  const accessor = { enumerable: true, get() { reads++; throw Error('private secret'); } };
  const inputs = [];
  for (const key of Object.keys(profile())) { const value = profile(); Object.defineProperty(value, key, accessor); inputs.push(value); }
  for (const section of ['reserve', 'payment']) for (const key of Object.keys(profile()[section])) { const value = profile(); Object.defineProperty(value[section], key, accessor); inputs.push(value); }
  const item = profile(); Object.defineProperty(item.payment.claims, '0', accessor); inputs.push(item);
  const claim = profile(); Object.defineProperty(claim.payment.claims[0], 'amount', accessor); inputs.push(claim);
  const sparse = profile(); delete sparse.payment.claims[0]; inputs.push(sparse);
  const hidden = profile(); Object.defineProperty(hidden, 'secret', { value: 'never echo' }); inputs.push(hidden);
  const symbol = profile(); symbol[Symbol('extra')] = true; inputs.push(symbol);
  inputs.push(Object.create(profile()), new Proxy({}, { getPrototypeOf() { throw Error('never echo'); } }));
  for (const input of inputs) invalid(() => validatePaymentStarterProfile(input));
  assert.equal(reads, 0);
});

test('bounded JSON parser rejects duplicate keys, escaped aliases, BOM and secret extras', () => {
  const text = JSON.stringify(profile());
  for (const bad of [text.replace('"version":1', '"version":1,"version":1'), text.replace('"owner":', '"own\\u0065r":"0x' + '2'.repeat(40) + '","owner":'),
    text.replace('"nonce":0', '"nonce":0,"nonce":0'), '\ufeff' + text, text + ' '.repeat(16384), text.replace('"version":1', '"version":1,"privateKey":"secret"')]) invalid(() => parsePaymentStarterProfile(bad));
});

test('actual browser globals and explicit test snapshots must match B before authentication is possible', () => {
  const value = validatePaymentStarterProfile(profile());
  const good = checkPaymentStarterEnvironment(value, snapshot(value.recoveryOrigin));
  assert.equal(good.ok, true); assert.equal(good.physicalPasskey, 'unverified');
  for (const origin of [value.originalOrigin, value.recoveryOrigin + ':8443', 'https://reserve.example.org.attacker', undefined]) {
    const result = checkPaymentStarterEnvironment(value, snapshot(origin));
    assert.equal(result.ok, false); assert.equal(result.checks.find(item => item.id === 'current-origin').status, 'fail');
  }
  const originals = new Map(), env = snapshot(value.originalOrigin);
  try {
    for (const [key, replacement] of Object.entries({ ...env, location: { origin: env.origin } })) {
      if (key === 'origin') continue;
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value: replacement, configurable: true });
    }
    assert.equal(checkPaymentStarterEnvironment(value).ok, false);
    globalThis.location.origin = value.recoveryOrigin;
    assert.equal(checkPaymentStarterEnvironment(value).ok, true);
  } finally { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
});

test('doctor demands declared B, preserves historical profiles and never claims browser, chain or credential proof', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected network'); });
  const value = profile();
  for (const origin of [undefined, value.originalOrigin, value.recoveryOrigin + '/']) {
    const report = await runPaymentStarterDoctor({ profile: value, origin });
    assert.equal(report.ok, false); assert.equal(report.checks.find(check => check.id === 'declared-origin').ok, false);
  }
  const report = await runPaymentStarterDoctor({ profile: value, origin: value.recoveryOrigin });
  assert.equal(report.ok, true); assert.equal(report.readOnly, true); assert.equal(report.declaredOriginOnly, true);
  for (const key of ['browserEnvironmentVerified', 'physicalPasskeyVerified', 'liveStorageChecked', 'rpcChecked', 'deployed', 'buildChecked']) assert.equal(report[key], false);
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.checks));
  value.payment.expiresAt = '2000-01-01T00:00:00.000Z';
  const expired = await runPaymentStarterDoctor({ profile: value, origin: value.recoveryOrigin });
  assert.equal(expired.ok, false); assert.equal(expired.checks.find(check => check.id === 'signing-window').code, 'PAYMENT_STARTER_PROFILE_EXPIRED');
  assert.match(expired.checks.find(check => check.id === 'signing-window').action, /Historical receipt/);
});

test('doctor binds every local asset and profile without modifying files or following artifact symlinks', async t => {
  const directory = await temporary(t), out = join(directory, 'dist'); await mkdir(join(out, 'assets'), { recursive: true });
  const value = profile(), html = '<script type="module" src="/assets/main.js"></script>', js = 'export const ready = true;';
  const report = { version: 1, mode: 'existing-account-payment', profileSha256: digest(JSON.stringify(value)),
    assetFiles: ['index.html', 'assets/main.js'], assetSha256: { 'index.html': digest(html), 'assets/main.js': digest(js) }, physicalPasskeyVerified: false, deployed: false };
  const files = { 'payment-config.json': JSON.stringify(value), 'build-report.json': JSON.stringify(report), 'index.html': html, 'assets/main.js': js };
  for (const [name, contents] of Object.entries(files)) await writeFile(join(out, name), contents);
  const before = await Promise.all(Object.keys(files).map(async name => ({ name, bytes: await readFile(join(out, name)), stat: await lstat(join(out, name)) })));
  assert.equal((await runPaymentStarterDoctor({ profile: value, origin: value.recoveryOrigin, out })).ok, true);
  for (const { name, bytes, stat } of before) { assert.deepEqual(await readFile(join(out, name)), bytes); assert.equal((await lstat(join(out, name))).mtimeMs, stat.mtimeMs); }
  await writeFile(join(out, 'assets/main.js'), 'tampered');
  assert.equal((await runPaymentStarterDoctor({ profile: value, origin: value.recoveryOrigin, out })).checks.at(-1).code, 'PAYMENT_STARTER_BUILD_INVALID');
  await writeFile(join(out, 'assets/main.js'), js); await writeFile(join(out, 'private-grants.json'), '{}');
  assert.equal((await runPaymentStarterDoctor({ profile: value, origin: value.recoveryOrigin, out })).ok, false);
  await rm(join(out, 'private-grants.json')); await rm(join(out, 'assets/main.js')); await writeFile(join(directory, 'outside.js'), js); await symlink(join(directory, 'outside.js'), join(out, 'assets/main.js'));
  assert.equal((await runPaymentStarterDoctor({ profile: value, origin: value.recoveryOrigin, out })).ok, false);
});

test('doctor CLI accepts only explicit bounded local inputs and emits no raw path or secret errors', async t => {
  const directory = await temporary(t), path = join(directory, 'secret-profile.json'), cli = fileURLToPath(new URL('../payment-starter/doctor.mjs', import.meta.url));
  await writeFile(path, JSON.stringify(profile()));
  const run = args => spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(hookSource), cli, ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  const good = run(['--profile', path, '--origin', example.recoveryOrigin]);
  assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).ok, true);
  for (const args of [['--profile', path], ['--profile', path, '--origin', example.recoveryOrigin, '--origin', example.recoveryOrigin], ['--profile', path, '--origin', example.recoveryOrigin, '--rpc', 'https://private.example']]) {
    const result = run(args); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'PAYMENT_STARTER_DOCTOR_INPUT_INVALID'); assert.ok(!result.stderr.includes(path));
  }
  await writeFile(path, '{"privateKey":"DO_NOT_ECHO_THIS_SECRET"}');
  const invalidFile = run(['--profile', path, '--origin', example.recoveryOrigin]);
  assert.equal(invalidFile.status, 1); assert.ok(!invalidFile.stderr.includes('DO_NOT_ECHO_THIS_SECRET'));
  await rm(path); await symlink(join(directory, 'missing-secret'), path);
  assert.equal(run(['--profile', path, '--origin', example.recoveryOrigin]).status, 1);
});
