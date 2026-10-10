import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { configuration, validateEnvironment } from '../text-starter/config.mjs';
import { validateText } from '../sdk/text-reserve.mjs';

const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url)), { JSDOM } = require('jsdom');
const html = await readFile(new URL('../text-starter/index.html', import.meta.url), 'utf8');
const main = (await readFile(new URL('../text-starter/main.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const adapterSource = (await readFile(new URL('../text-starter/adapter.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ');
const adapter = new Function('validateText', adapterSource + '\nreturn {captureText,restoreText,exportText,textareaAdapter};')(validateText);
const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const replicas = [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }];
const diagnostic = (id, status) => ({ id, stage: 'verify', status });
const result = (alpha = 'verified', beta = 'verified') => ({ reserve: { text: '\uFEFFRecovered — ÆØÅ\r\nOriginal draft.\r\n' }, replicas: [diagnostic('alpha', alpha), diagnostic('beta', beta)] });

async function fixture(t, { enrollment = false, delayedAdmission = false, admissionStatus = 200, role = 'recovery' } = {}) {
  const settings = configuration(6073, 6074), origin = role === 'recovery' ? settings.recoveryOrigin : settings.originalOrigin;
  const environment = { ...settings, synthetic: true, role, replicaMode: true, replicas };
  const dom = new JSDOM(html, { url: origin + '/', runScripts: 'outside-only' }), { window } = dom;
  const pending = [], preparation = deferred(), admission = deferred(), sender = deferred(), blobs = [];
  const calls = { native: 0, storage: 0, admission: 0, prepare: [], recover: [], stores: [], clears: 0, disposes: 0, controls: [], originalSetup: 0, replicaSetup: [] };
  let states = [{ id: 'alpha', running: true, corrupted: false }, { id: 'beta', running: true, corrupted: false }];
  const synthetic = {}, $ = id => window.document.getElementById(id);
  window.AbortController = AbortController; window.AbortSignal = AbortSignal;
  window.Blob = Blob; window.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:local-test'; }; window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  Object.defineProperty(window.navigator, 'credentials', { value: { get() { calls.native++; throw new Error('NATIVE_FORBIDDEN'); }, create() { calls.native++; throw new Error('NATIVE_FORBIDDEN'); } } });
  window.Storage.prototype.setItem = () => { calls.storage++; throw new Error('STORAGE_FORBIDDEN'); };
  const grant = () => ({ replicas: [{ id: 'alpha', enrollmentToken: 'a'.repeat(43) }, { id: 'beta', enrollmentToken: 'b'.repeat(43) }] });
  window.fetch = async (path, options = {}) => {
    if (path === '/api/config') return { ok: true, json: async () => environment };
    if (path === '/api/status') return { ok: true, json: async () => ({ synthetic: true, primaryOnline: true, replicas: structuredClone(states) }) };
    if (path === '/api/replica-enrollment') { calls.admission++; assert.equal(options.method, 'POST'); assert.equal(options.body, '{}'); return { ok: admissionStatus === 200, json: () => delayedAdmission ? admission.promise : Promise.resolve(grant()) }; }
    if (path === '/api/replica-control') {
      const value = JSON.parse(options.body); calls.controls.push(value); const state = states.find(item => item.id === value.id);
      if (value.action === 'stop') state.running = false;
      else if (value.action === 'start') state.running = true;
      else { assert.equal(state.running, false); assert.equal(state.corrupted, false); state.corrupted = true; }
      return { ok: true, json: async () => ({ synthetic: true, primaryOnline: true, replicas: states }) };
    }
    throw new Error('UNEXPECTED_FETCH:' + path);
  };
  window.__deps = { ...adapter, validateEnvironment, syntheticClient: () => synthetic,
    startTextReserveSetup() { calls.originalSetup++; throw new Error('LEGACY_SETUP_USED'); },
    createTextReserveReceiver() { throw new Error('LEGACY_RECEIVER_USED'); }, recoverTextReserve() { throw new Error('LEGACY_RECOVERY_USED'); },
    startTextReserveReplicaSetup(options) { calls.replicaSetup.push(options); return { completion: sender.promise, cancel() {} }; },
    createTextReserveReplicaReceiver(options) { assert.deepEqual(Array.from(options.replicaIds), ['alpha','beta']); return { isEnrollment: enrollment, dispose() { calls.disposes++; }, prepare(options) { calls.prepare.push(options); assert.equal(options.webAuthnClient, synthetic); return preparation.promise; } }; },
    createReserveHttpStore(options) { calls.stores.push(options); return { clearEnrollmentCapability() { calls.clears++; } }; },
    recoverTextReserveFromReplicas(options) { assert.equal(options.webAuthnClient, synthetic); calls.recover.push(options); const value = deferred(); pending.push(value); return value.promise; },
  };
  await window.eval('(async () => { const { ' + Object.keys(window.__deps).join(',') + ' } = window.__deps;\n' + main + '\n})()');
  t.after(() => { window.dispatchEvent(new window.Event('pagehide')); window.close(); });
  return { $, window, calls, pending, preparation, admission, sender, blobs, grant, environment };
}

test('replica environment requires two fixed, distinct, same-origin store routes and no initial capability', () => {
  const base = { ...configuration(), role: 'recovery', synthetic: true, replicaMode: true, replicas };
  assert.doesNotThrow(() => validateEnvironment(base, base.recoveryOrigin));
  for (const mutation of [
    { enrollmentToken: 'x'.repeat(43) }, { replicas: [replicas[0], replicas[0]] }, { replicaMode: 'true' },
    { replicas: [replicas[0], { ...replicas[1], basePath: 'https://other.invalid/api' }] },
    { replicas: [...replicas].reverse() }, { replicaMode: false },
  ]) assert.throws(() => validateEnvironment({ ...base, ...mutation }, base.recoveryOrigin), /ENVIRONMENT_INVALID/);
});

test('replica A uses the dedicated SDK handoff and requires explicit replica identities', async t => {
  const f = await fixture(t, { role: 'primary' });
  f.$('draft').value = 'A fictional draft.'; f.$('prepare').click();
  assert.equal(f.calls.originalSetup, 0); assert.equal(f.calls.replicaSetup.length, 1);
  assert.deepEqual(Array.from(f.calls.replicaSetup[0].replicaIds), ['alpha','beta']); assert.equal(f.calls.replicaSetup[0].text, 'A fictional draft.');
  f.sender.resolve({}); await tick(); assert.match(f.$('status').textContent, /ready in B/);
});

test('replica preparation checks distinct grants and opens text only after both copies verify', async t => {
  const f = await fixture(t, { enrollment: true });
  assert.equal(f.$('toggle-alpha').disabled, true); assert.equal(f.calls.admission, 0);
  f.$('receive').click(); await tick(); assert.equal(f.calls.admission, 1); assert.equal(f.calls.prepare.length, 1);
  assert.deepEqual(f.calls.stores.map(value => value.enrollmentToken), ['a'.repeat(43), 'b'.repeat(43)]);
  assert.deepEqual(f.calls.stores.map(value => value.basePath), replicas.map(value => value.basePath));
  assert.equal(f.calls.prepare[0].store, undefined); assert.equal(f.$('draft').value, '');
  f.preparation.resolve({ text: 'Both stored copies.', replicas: result().replicas }); await tick();
  assert.equal(f.$('draft').value, 'Both stored copies.'); assert.match(f.$('copy-alpha').textContent, /Verified/); assert.match(f.$('copy-beta').textContent, /Verified/);
  assert.equal(f.calls.clears, 2); assert.equal(f.calls.disposes, 1); assert.equal(f.$('toggle-alpha').disabled, true);
  assert.equal(f.calls.native, 0); assert.equal(f.calls.storage, 0);
});

test('failed admission never starts a credential ceremony or retries and leaves deliberate recovery available', async t => {
  const f = await fixture(t, { enrollment: true, admissionStatus: 503 });
  f.$('receive').click(); await tick(); assert.equal(f.calls.admission, 1); assert.equal(f.calls.prepare.length, 0);
  assert.equal(f.$('receive').hidden, true); assert.equal(f.$('recover').hidden, false); assert.equal(f.calls.disposes, 1);
  f.$('receive').dispatchEvent(new f.window.Event('click')); await tick(); assert.equal(f.calls.admission, 1); assert.equal(f.$('draft').value, '');
});

test('partial preparation exposes copy outcomes without claiming readiness or displaying plaintext', async t => {
  const f = await fixture(t, { enrollment: true }); f.$('receive').click(); await tick();
  f.preparation.reject(Object.assign(new Error('provider detail must remain private'), { code: 'REPLICA_PREPARATION_FAILED', recordMayExist: true, replicas: result('verified','unknown').replicas })); await tick();
  assert.equal(f.$('draft').value, ''); assert.equal(f.$('recover').hidden, false); assert.equal(f.$('receive').hidden, true);
  assert.match(f.$('copy-beta').textContent, /outcome unknown/); assert.doesNotMatch(f.$('status').textContent, /provider detail/); assert.equal(f.calls.clears, 2);
});

test('a verified surviving copy opens while offline status alone never proves recovery', async t => {
  const f = await fixture(t); assert.equal(f.$('copy-alpha').textContent, 'Not checked'); assert.match(f.$('process-alpha').textContent, /running/);
  f.$('recover').click(); assert.equal(f.calls.recover.length, 1); assert.ok(f.calls.stores.every(value => value.enrollmentToken === undefined));
  f.pending[0].resolve(result('unavailable','verified')); await tick();
  assert.match(f.$('draft').value, /Original draft/); assert.match(f.$('copy-alpha').textContent, /Unavailable/); assert.match(f.$('copy-beta').textContent, /Verified/);
  assert.match(f.$('copy-summary').textContent, /Redundancy is reduced/);
  assert.equal(f.$('toggle-beta').disabled, true); assert.equal(f.$('offline').disabled, true); assert.equal(f.$('recover').hidden, true);
  f.$('draft').value = 'Unexported local correction.';
  f.$('toggle-alpha').dispatchEvent(new f.window.Event('click')); assert.equal(f.calls.controls.length, 0); assert.equal(f.$('draft').value, 'Unexported local correction.');
  f.$('clear').click(); f.$('toggle-alpha').click(); await tick();
  assert.deepEqual(f.calls.controls, [{ id: 'alpha', action: 'stop' }]); assert.equal(f.$('copy-beta').textContent, 'Not checked'); assert.match(f.$('copy-summary').textContent, /new verification/);
  assert.equal(f.$('corrupt-alpha').disabled, false); f.$('corrupt-alpha').click(); await tick();
  assert.deepEqual(f.calls.controls.at(-1), { id: 'alpha', action: 'corrupt' }); assert.equal(f.$('corrupt-alpha').disabled, true); assert.match(f.$('process-alpha').textContent, /corrupted/);
});

test('all invalid copies and conflicting authenticated records return no plaintext', async t => {
  for (const code of ['REPLICA_RECOVERY_FAILED','REPLICA_CONFLICT']) {
    const f = await fixture(t); f.$('recover').click();
    f.pending[0].reject(Object.assign(new Error('never expose provider body or text'), { code, text: 'Untrusted plaintext', replicas: result(code === 'REPLICA_CONFLICT' ? 'verified' : 'rejected', code === 'REPLICA_CONFLICT' ? 'verified' : 'unavailable').replicas })); await tick();
    assert.equal(f.$('draft').value, ''); assert.equal(f.$('export-txt').hidden, true); assert.equal(f.$('recover').hidden, false);
    assert.doesNotMatch(f.$('status').textContent, /provider|Untrusted/);
    if (code === 'REPLICA_CONFLICT') assert.match(f.$('status').textContent, /copies disagree/);
    else assert.match(f.$('copy-alpha').textContent, /Rejected/);
  }
});

test('late admission, prepare and recovery cannot resurrect text or capability after navigation', async t => {
  const admission = await fixture(t, { enrollment: true, delayedAdmission: true }); admission.$('receive').click(); await tick();
  admission.window.dispatchEvent(new admission.window.Event('pagehide')); admission.admission.resolve(admission.grant()); await tick();
  assert.equal(admission.calls.prepare.length, 0); assert.equal(admission.calls.stores.length, 0); assert.equal(admission.$('draft').value, '');
  const preparing = await fixture(t, { enrollment: true }); preparing.$('receive').click(); await tick(); preparing.window.dispatchEvent(new preparing.window.Event('pagehide'));
  assert.equal(preparing.calls.prepare[0].signal.aborted, true); preparing.preparation.resolve({ text: 'Late plaintext', replicas: result().replicas }); await tick();
  assert.equal(preparing.$('draft').value, ''); assert.equal(preparing.calls.clears, 2); assert.match(preparing.$('status').textContent, /closed/);
  const recovering = await fixture(t); recovering.$('recover').click(); recovering.window.dispatchEvent(new recovering.window.Event('pagehide'));
  recovering.pending[0].resolve(result()); await tick(); assert.equal(recovering.$('draft').value, ''); assert.match(recovering.$('status').textContent, /closed/);
  assert.equal(recovering.$('copy-alpha').textContent, 'Not checked'); assert.equal(recovering.calls.native, 0); assert.equal(recovering.calls.storage, 0);
});
