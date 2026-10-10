import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { validateText } from '../sdk/text-reserve.mjs';
import { validateNativeEnvironment, nativeConfig, parseNativeGrants } from '../text-native/profile.mjs';

const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url)), { JSDOM } = require('jsdom');
const html = await readFile(new URL('../text-native/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../text-native/main.mjs', import.meta.url), 'utf8');
const main = source.replace(/^import .*;\n/gm, '');
const adapterSource = (await readFile(new URL('../text-native/adapter.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ');
const adapter = new Function('validateText', adapterSource + '\nreturn {captureText,restoreText,exportText,textareaAdapter};')(validateText);
const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const sample = '\ufeffRecovered — ÆØÅ 📝\r\nA correction worth keeping.\r\n';
const fail = code => Object.assign(new Error(code), { code });

async function fixture(t, { role = 'recovery', enrollment = false, secure = true, delayedConfig = false, count = 2, profileLifetime = 3600000, storeDelay = 0 } = {}) {
  let now = Date.now(), nextTimer = 0; const timers = new Map();
  const ids = ['alpha','beta','gamma'].slice(0,count);
  const profile = { version: 1, appId: 'native-ui-v1', primaryOrigin: 'https://writer.example.test', recoveryOrigin: 'https://reserve.example.test', recoveryRpId: 'reserve.example.test', expiresAt: new Date(now + profileLifetime).toISOString(), replicas: ids.map(id => ({ id, basePath: '/api/replicas/' + id + '/reserve' })) };
  const origin = role === 'primary' ? profile.primaryOrigin : profile.recoveryOrigin;
  const dom = new JSDOM(html, { url: origin + '/', runScripts: 'outside-only' }), { window } = dom;
  const prepared = deferred(), recovered = deferred(), sent = deferred(), body = deferred(), blobs = [];
  const calls = { native: 0, probes: 0, storage: 0, fetch: [], stores: [], cleared: 0, prepare: [], recover: [], start: [], dispose: 0, cancel: 0 };
  const $ = id => window.document.getElementById(id);
  window.AbortController = AbortController; window.AbortSignal = AbortSignal;
  window.Date = class extends Date { static now() { return now; } };
  Object.defineProperty(window, 'isSecureContext', { value: secure });
  Object.defineProperty(window, 'crypto', { value: webcrypto });
  window.PublicKeyCredential = class { static isUserVerifyingPlatformAuthenticatorAvailable() { calls.probes++; throw new Error('PROBE_FORBIDDEN'); } };
  Object.defineProperty(window.navigator, 'credentials', { value: { get() { calls.native++; throw new Error('REAL_NATIVE_FORBIDDEN_IN_TEST'); }, create() { calls.native++; throw new Error('REAL_NATIVE_FORBIDDEN_IN_TEST'); } } });
  window.Storage.prototype.setItem = () => { calls.storage++; throw new Error('PERSISTENCE_FORBIDDEN'); };
  window.Blob = Blob; window.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:test-export'; }; window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { assert.equal(this.download.startsWith('continuity-draft.'), true); };
  window.setTimeout = (fn, milliseconds) => { const id = ++nextTimer; timers.set(id, { fn, at: now + milliseconds }); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.fetch = async (path, options) => { calls.fetch.push({ path, options }); assert.equal(path, '/continuity-config.json'); return { ok: true, text: () => delayedConfig ? body.promise : Promise.resolve(JSON.stringify({ profile, role })) }; };
  window.__deps = { ...adapter,
    validateNativeEnvironment: (value, href) => validateNativeEnvironment(JSON.parse(JSON.stringify(value)), href, { now }), nativeConfig,
    parseNativeGrants: (text, value) => parseNativeGrants(text, value, { now }),
    startTextReserveReplicaSetup(options) { calls.start.push(options); assert.equal(Object.hasOwn(options, 'webAuthnClient'), false); return { completion: sent.promise, cancel() { calls.cancel++; } }; },
    createTextReserveReplicaReceiver(options) {
      assert.deepEqual(Array.from(options.replicaIds), ids);
      return { isEnrollment: enrollment, dispose() { calls.dispose++; }, prepare(options) { calls.prepare.push(options); assert.equal(Object.hasOwn(options, 'webAuthnClient'), false); return prepared.promise; } };
    },
    createReserveHttpStore(options) { now += storeDelay; calls.stores.push(options); return { clearEnrollmentCapability() { calls.cleared++; } }; },
    recoverTextReserveFromReplicas(options) { calls.recover.push(options); assert.equal(Object.hasOwn(options, 'webAuthnClient'), false); return recovered.promise; },
  };
  const boot = window.eval('(async () => { const { ' + Object.keys(window.__deps).join(',') + ' } = window.__deps;\n' + main + '\n})()');
  if (!delayedConfig) await boot; else await tick();
  t.after(() => { window.dispatchEvent(new window.Event('pagehide')); window.close(); });
  const diagnostics = (statuses = ids.map(() => 'verified')) => ids.map((id,index) => ({ id, stage: 'verify', status: statuses[index] }));
  const grant = (lifetime = 60000) => ({ format: 'continuitykit/native-replica-grants/v1', appId: profile.appId, recoveryOrigin: profile.recoveryOrigin,
    replicas: ids.map((id,index) => ({ id, enrollmentToken: Buffer.alloc(32,index + 1).toString('base64url'), expiresAt: new Date(Math.min(now + lifetime, Date.parse(profile.expiresAt))).toISOString() })) });
  return { window, $, profile, ids, calls, prepared, recovered, sent, body, boot, blobs, diagnostics, grant,
    check(value = grant()) { $('upload-permission').value = typeof value === 'string' ? value : JSON.stringify(value); $('check-permission').click(); },
    advance(milliseconds) { now += milliseconds; for (let rounds = 0; rounds < 10; rounds++) { const due = [...timers].filter(([,value]) => value.at <= now); if (!due.length) break; for (const [id,value] of due) { timers.delete(id); value.fn(); } } },
    ready(statuses) { return { text: sample, replicas: diagnostics(statuses) }; },
    result(statuses) { return { reserve: { text: sample }, replicas: diagnostics(statuses) }; },
  };
}

test('native entrypoint omits simulation clients, and page load never starts credential or grant activity', async t => {
  assert.doesNotMatch(source, /webAuthnClient\s*:|syntheticClient|\/api\/synthetic|localStorage|sessionStorage/);
  for (const role of ['primary','recovery']) {
    const f = await fixture(t, { role });
    assert.equal(f.calls.native, 0); assert.equal(f.calls.probes, 0); assert.equal(f.calls.storage, 0);
    assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.recover.length, 0); assert.equal(f.calls.stores.length, 0);
    assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.fetch[0].options.credentials, 'omit');
    assert.equal(f.$('permission-panel').hidden, true);
    assert.equal(f.$('draft-panel').hidden, role === 'recovery', 'fresh B offers recovery without an empty editor; A keeps its draft');
  }
});

test('unsupported browsers expose no enabled native action and perform no capability probe', async t => {
  const f = await fixture(t, { secure: false });
  assert.equal(f.$('recover').disabled, true); f.$('recover').dispatchEvent(new f.window.Event('click'));
  assert.equal(f.calls.recover.length, 0); assert.equal(f.calls.probes, 0); assert.equal(f.calls.native, 0);
});

test('checking scoped permission clears the input without prompting, storing or contacting a service', async t => {
  const f = await fixture(t, { enrollment: true, count: 3 }); f.check();
  assert.equal(f.$('upload-permission').value, ''); assert.equal(f.$('passkey-options').hidden, false);
  assert.equal(f.$('prepare-new').disabled, false); assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.stores.length, 0); assert.equal(f.calls.fetch.length, 1);
  assert.match(f.$('permission-status').textContent, /operator still checks/);
});

test('invalid, foreign and expired permission cannot reach a native request', async t => {
  const f = await fixture(t, { enrollment: true });
  for (const grant of ['invalid json', { ...f.grant(), appId: 'other-app' }, f.grant(-1)]) {
    f.check(grant); assert.equal(f.$('upload-permission').value, ''); assert.equal(f.$('prepare-new').disabled, true);
    f.$('prepare-new').dispatchEvent(new f.window.Event('click')); assert.equal(f.calls.prepare.length, 0);
  }
});

test('new-key preparation is click-bound, uses the native default and opens only when all three copies verify', async t => {
  const f = await fixture(t, { enrollment: true, count: 3 }); f.check(); f.$('prepare-new').click();
  assert.equal(f.calls.prepare.length, 1, 'SDK invoked synchronously before the click handler returns');
  const options = f.calls.prepare[0]; assert.equal(options.credentialMode, undefined); assert.equal(typeof options.user.name, 'string'); assert.equal(options.webAuthnClient, undefined);
  assert.deepEqual(f.calls.stores.map(value => value.basePath), f.profile.replicas.map(value => value.basePath)); assert.equal(f.$('draft').value, '');
  f.prepared.resolve(f.ready()); await tick();
  assert.match(f.$('draft').value, /correction worth keeping/); assert.equal(f.calls.cleared, 3); assert.equal(f.$('permission-panel').hidden, true);
  assert.equal(f.$('copy-list').querySelectorAll('[data-state=verified]').length, 3); assert.equal(f.calls.native, 0);
});

test('existing-key preparation never falls back to creation or retries after an unknown write', async t => {
  const f = await fixture(t, { enrollment: true }); f.check(); f.$('prepare-existing').click();
  assert.equal(f.calls.prepare[0].credentialMode, 'existing'); assert.equal(f.calls.prepare[0].user, undefined);
  f.prepared.reject(Object.assign(new Error('provider payload must remain private'), { code: 'REPLICA_PREPARATION_FAILED', recordMayExist: true, replicas: f.diagnostics(['verified','unknown']) })); await tick();
  assert.equal(f.calls.cleared, 2); assert.equal(f.$('draft').value, ''); assert.equal(f.$('recover').hidden, false);
  assert.match(f.$('copy-list').textContent, /outcome unknown/); assert.doesNotMatch(f.$('status').textContent, /provider payload/);
  f.$('prepare-new').dispatchEvent(new f.window.Event('click')); f.$('prepare-existing').dispatchEvent(new f.window.Event('click')); assert.equal(f.calls.prepare.length, 1);
});

test('permission expiry is checked again at the click boundary, including after store construction', async t => {
  const f = await fixture(t, { enrollment: true }); f.check(f.grant(500)); f.advance(501);
  f.$('prepare-new').dispatchEvent(new f.window.Event('click')); assert.equal(f.calls.prepare.length, 0); assert.equal(f.$('passkey-options').hidden, true);
  const race = await fixture(t, { enrollment: true, storeDelay: 300 }); race.check(race.grant(500)); race.$('prepare-new').click();
  assert.equal(race.calls.prepare.length, 0); assert.equal(race.calls.cleared, 2); assert.match(race.$('status').textContent, /UPLOAD_PERMISSION_EXPIRED/);
});

test('expiry cancels an active native operation and a late result cannot open plaintext', async t => {
  const f = await fixture(t, { enrollment: true }); f.check(f.grant(500)); f.$('prepare-new').click();
  f.advance(501); assert.equal(f.calls.prepare[0].signal.aborted, true); f.prepared.resolve(f.ready()); await tick();
  assert.equal(f.$('draft').value, ''); assert.equal(f.$('export-txt').hidden, true);
  const recovery = await fixture(t, { profileLifetime: 500 }); recovery.$('recover').click(); recovery.advance(501);
  assert.equal(recovery.calls.recover[0].signal.aborted, true); recovery.recovered.resolve(recovery.result()); await tick();
  assert.equal(recovery.$('draft').value, ''); assert.equal(recovery.$('recover').disabled, true);
});

test('fresh B recovery is read-only, preserves unedited UTF-8 exports and protects open edits', async t => {
  const f = await fixture(t); f.$('recover').click(); assert.equal(f.calls.recover.length, 1);
  assert.equal(f.$('draft-panel').hidden, true, 'no draft appears while authentication is pending');
  assert.ok(f.calls.stores.every(value => !Object.hasOwn(value, 'enrollmentToken'))); assert.equal(f.calls.recover[0].webAuthnClient, undefined);
  f.recovered.resolve(f.result(['rejected','verified'])); await tick();
  assert.equal(f.$('draft-panel').hidden, false, 'authenticated text opens the editor');
  assert.match(f.$('copy-summary').textContent, /1 of 2/); assert.equal(f.$('recover').hidden, true);
  f.$('export-txt').click(); assert.deepEqual(Buffer.from(await f.blobs[0].arrayBuffer()), Buffer.from(sample));
  f.$('draft').value = 'Local unsaved correction.'; f.$('recover').dispatchEvent(new f.window.Event('click'));
  assert.equal(f.calls.recover.length, 1); assert.equal(f.$('draft').value, 'Local unsaved correction.');
  f.$('close-copy').click(); assert.equal(f.$('draft').value, ''); assert.equal(f.$('recover').hidden, false); assert.equal(f.$('draft-panel').hidden, true);
});

test('all-invalid, conflicting or incompletely prepared copies never expose a draft', async t => {
  for (const code of ['REPLICA_RECOVERY_FAILED','REPLICA_CONFLICT']) {
    const f = await fixture(t); f.$('recover').click(); f.recovered.reject(Object.assign(new Error('private provider details'), { code, replicas: f.diagnostics(['rejected','unavailable']) })); await tick();
    assert.equal(f.$('draft').value, ''); assert.equal(f.$('export-txt').hidden, true); assert.doesNotMatch(f.$('status').textContent, /provider details/);
    assert.equal(f.$('draft-panel').hidden, true, 'failed verification leaves the closed editor hidden');
    if (code === 'REPLICA_CONFLICT') assert.match(f.$('status').textContent, /copies disagree/);
  }
  const partial = await fixture(t, { enrollment: true }); partial.check(); partial.$('prepare-new').click(); partial.prepared.resolve(partial.ready(['verified','unavailable'])); await tick();
  assert.equal(partial.$('draft').value, ''); assert.equal(partial.$('recover').hidden, false);
});

test('late configuration, preparation and recovery are cleared after navigation', async t => {
  const loading = await fixture(t, { delayedConfig: true, role: 'primary' }); loading.window.dispatchEvent(new loading.window.Event('pagehide'));
  loading.body.resolve(JSON.stringify({ profile: loading.profile, role: 'primary' })); await loading.boot;
  assert.equal(loading.$('draft').value, ''); assert.match(loading.$('status').textContent, /view is closed/);
  const preparing = await fixture(t, { enrollment: true }); preparing.check(); preparing.$('prepare-new').click(); preparing.window.dispatchEvent(new preparing.window.Event('pagehide'));
  assert.equal(preparing.calls.prepare[0].signal.aborted, true); preparing.prepared.resolve(preparing.ready()); await tick();
  assert.equal(preparing.$('draft').value, ''); assert.equal(preparing.calls.cleared, 2);
  const recovering = await fixture(t); recovering.$('recover').click(); recovering.window.dispatchEvent(new recovering.window.Event('pagehide')); recovering.recovered.resolve(recovering.result()); await tick();
  assert.equal(recovering.$('draft').value, ''); assert.match(recovering.$('status').textContent, /view is closed/); assert.equal(recovering.calls.native, 0); assert.equal(recovering.calls.storage, 0);
});

test('A starts the public replica handoff directly from its deliberate click without a credential override', async t => {
  const f = await fixture(t, { role: 'primary' }); f.$('draft').value = 'A fictional source draft.'; f.$('start-setup').click();
  assert.equal(f.calls.start.length, 1); assert.equal(f.calls.start[0].text, 'A fictional source draft.'); assert.equal(f.calls.start[0].webAuthnClient, undefined);
  f.sent.resolve(f.ready()); await tick(); assert.match(f.$('status').textContent, /snapshot is ready/);
});
