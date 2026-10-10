import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { collectionConfiguration, validateCollectionEnvironment } from '../text-starter/collection-config.mjs';
import { prismBackdrop, prismSculpture } from '../starter/prism-art.mjs';
import { TEXT_PROTOCOL, validateText } from '../sdk/text-reserve.mjs';

const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const html = await readFile(new URL('../text-starter/collection-index.html', import.meta.url), 'utf8');
// The checked-in template is intentionally not installed. Inject its real
// adapter and validators; the separate package test imports the installed UI.
const adapterSource = (await readFile(new URL('../text-starter/adapter.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ');
const adapter = new Function('validateText', adapterSource + '\nreturn {captureText,restoreText,exportText,textareaAdapter};')(validateText);
const source = (await readFile(new URL('../text-starter/collection-main.mjs', import.meta.url), 'utf8')).split('// A Node consumer')[0].replace(/^import .*;\n/gm, '').replace('export function mountCollection', 'function mountCollection');
const mountCollection = new Function('TEXT_PROTOCOL', 'validateText', 'validateCollectionEnvironment', 'prismBackdrop', 'prismSculpture', ...Object.keys(adapter), source + '\nreturn mountCollection;')(TEXT_PROTOCOL, validateText, validateCollectionEnvironment, prismBackdrop, prismSculpture, ...Object.values(adapter));
const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const texts = ['\ufeffText draft — ÆØÅ 🦊\r\nPrivate line.\r\n', '# Markdown\n\n<img src=x onerror="throw 1">\n<script>window.bad=true</script>'];
const diagnostic = (id, status, code) => ({ id, stage: 'verify', status, ...(code ? { code } : {}) });
function results(environment, statuses = ['recovered', 'recovered']) {
  return environment.apps.map(({ config }, index) => statuses[index] === 'recovered'
    ? { appId: config.appId, status: 'recovered', reserve: { protocol: TEXT_PROTOCOL, locator: Buffer.alloc(32, index + 1).toString('base64url'), text: texts[index], textDigest: createHash('sha256').update(texts[index]).digest('hex') }, replicas: ['alpha', 'beta'].map(id => diagnostic(id, 'verified')) }
    : { appId: config.appId, status: statuses[index], code: statuses[index] === 'missing' ? 'RESERVE_MISSING' : 'REPLICA_RECOVERY_FAILED', replicas: ['alpha', 'beta'].map(id => diagnostic(id, statuses[index], { missing: 'RESERVE_MISSING', unavailable: 'STORE_UNAVAILABLE', rejected: 'RECORD_INVALID' }[statuses[index]])) });
}

async function fixture(t, { role = 'recovery', enrollment = false, lifetime = 3600000, delayedStatus = false, delayedAdmission = false, url = '', mutation } = {}) {
  let time = Date.now(), sequence = 0;
  const settings = collectionConfiguration(6173, 6174), environment = { ...settings, role, synthetic: true, collectionMode: true, expiresAt: new Date(time + lifetime).toISOString() };
  const dom = new JSDOM(html, { url: (role === 'primary' ? settings.originalOrigin : settings.recoveryOrigin) + '/' + url, runScripts: 'outside-only' });
  const { window } = dom, timers = new Map(), blobs = [], revoked = [], pending = [], prepared = deferred(), statusResponse = deferred(), admissionResponse = deferred();
  let statusCalls = 0, failControl = false;
  const calls = { recover: [], stores: [], fetch: [], prepare: [], setup: [], dispose: 0, native: 0, persistence: 0, admission: 0, clears: 0 };
  const $ = id => window.document.getElementById(id), client = {};
  window.AbortController = AbortController; window.AbortSignal = AbortSignal; window.Blob = Blob;
  window.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:collection-' + blobs.length; };
  window.URL.revokeObjectURL = url => revoked.push(url);
  window.HTMLAnchorElement.prototype.click = () => {};
  window.setTimeout = (fn, milliseconds) => { const id = ++sequence; timers.set(id, { fn, due: time + milliseconds }); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.Storage.prototype.setItem = () => { calls.persistence++; throw Error('PERSISTENCE_FORBIDDEN'); };
  Object.defineProperty(window.navigator, 'credentials', { value: { create() { calls.native++; throw Error('NATIVE_FORBIDDEN'); }, get() { calls.native++; throw Error('NATIVE_FORBIDDEN'); } } });
  const currentStatus = () => ({ synthetic: true, primaryOnline: true, replicas: ['alpha', 'beta'].map(id => ({ id, running: true, corruptedApps: [] })) });
  const fetcher = async (path, options = {}) => {
    calls.fetch.push({ path, options });
    if (path === '/api/status') { statusCalls++; const first = statusCalls === 1; return { ok: true, json: () => delayedStatus && first ? statusResponse.promise : Promise.resolve(currentStatus()) }; }
    if (path === '/api/replica-enrollment') { calls.admission++; const { appId } = JSON.parse(options.body); return { ok: true, json: () => delayedAdmission ? admissionResponse.promise : Promise.resolve({ appId, replicas: ['alpha', 'beta'].map((id, index) => ({ id, enrollmentToken: Buffer.alloc(32, index + 1).toString('base64url') })) }) }; }
    if (path === '/api/primary' || path === '/api/replica-control') return { ok: !failControl, json: async () => currentStatus() };
    throw Error('UNEXPECTED_FETCH');
  };
  const options = { environment: mutation ? mutation(structuredClone(environment)) : environment, fetcher, webAuthnClient: client, now: () => time,
    recover(value) { calls.recover.push(value); const item = deferred(); pending.push(item); return item.promise; },
    makeStore(value) { calls.stores.push(value); return { get() { throw Error('FAKE_RECOVERY_OWNS_READS'); }, clearEnrollmentCapability() { calls.clears++; } }; },
    startSetup(value) { calls.setup.push(value); return { completion: Promise.resolve({}), cancel() {} }; },
    makeReceiver() { return { isEnrollment: enrollment, prepare(value) { calls.prepare.push(value); return prepared.promise; }, dispose() { calls.dispose++; } }; },
  };
  let instance; try { instance = mountCollection(window.document, window, options); } catch (error) { window.close(); throw error; }
  if (!delayedStatus) await instance.ready;
  t.after(() => { instance.dispose(); window.close(); });
  return { $, window, calls, environment, pending, prepared, blobs, revoked, client, instance, statusResponse, admissionResponse, currentStatus,
    failNextControl() { failControl = true; },
    results: statuses => results(environment, statuses),
    advance(milliseconds) { time += milliseconds; for (let round = 0; round < 20; round++) { const due = [...timers].filter(([, value]) => value.due <= time); if (!due.length) break; for (const [id, value] of due) { timers.delete(id); value.fn(); } } },
  };
}

test('loading a collection creates no credentials, writes, recovery requests or stored plaintext', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.recover.length, 0); assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.admission, 0); assert.equal(f.calls.stores.length, 0);
  assert.equal(f.calls.native, 0); assert.equal(f.calls.persistence, 0);
  for (const id of ['textarea', 'markdown']) { assert.equal(f.$('draft-' + id).value, ''); assert.equal(f.$('export-' + id + '-txt').hidden, true); }
});

test('one deliberate click synchronously opens the bounded collection using shared read-only adapters', async t => {
  const f = await fixture(t); f.$('recover').click(); f.$('recover').dispatchEvent(new f.window.Event('click'));
  assert.equal(f.calls.recover.length, 1); assert.equal(f.calls.recover[0].webAuthnClient, f.client);
  assert.deepEqual(f.calls.recover[0].apps.map(item => item.config.appId), f.environment.apps.map(item => item.config.appId));
  assert.ok([2, 4].includes(f.calls.stores.length)); assert.ok(f.calls.stores.every(item => item.enrollmentToken === undefined));
  for (const app of f.calls.recover[0].apps) assert.deepEqual(app.replicas.map(item => item.id), ['alpha', 'beta']);
  f.pending[0].resolve(f.results()); await tick();
  assert.equal(f.$('draft-textarea').value, texts[0].replaceAll('\r\n', '\n')); assert.equal(f.$('draft-markdown').value, texts[1]);
  assert.equal(f.$('recover').hidden, true); assert.equal(f.calls.native, 0); assert.equal(f.calls.persistence, 0);
});

test('literal HTML stays text and both TXT and JSON exports preserve original bytes until the user edits', async t => {
  const f = await fixture(t); f.$('recover').click(); f.pending[0].resolve(f.results()); await tick();
  assert.equal(f.window.bad, undefined); assert.equal(f.$('card-markdown').querySelector('img,script'), null);
  for (const [index, id] of ['textarea', 'markdown'].entries()) {
    f.$('export-' + id + '-txt').click(); assert.deepEqual(Buffer.from(await f.blobs.at(-1).arrayBuffer()), Buffer.from(texts[index]));
    f.$('export-' + id + '-json').click(); assert.deepEqual(JSON.parse(await f.blobs.at(-1).text()), { format: 'continuity-text-export/v1', text: texts[index] });
  }
  f.$('draft-textarea').value = 'A local correction.\n'; f.$('draft-textarea').dispatchEvent(new f.window.Event('input'));
  f.$('export-textarea-txt').click(); assert.equal(await f.blobs.at(-1).text(), 'A local correction.\n');
  assert.equal(f.calls.recover.length, 1); assert.equal(f.calls.admission, 0);
});

test('missing, unavailable and rejected apps expose no editor or export while their healthy sibling remains usable', async t => {
  for (const status of ['missing', 'unavailable', 'rejected']) {
    const f = await fixture(t); f.$('recover').click(); const value = f.results([status, 'recovered']); f.pending[0].resolve(value); await tick();
    assert.equal(f.$('draft-textarea').value, ''); assert.equal(f.$('export-textarea-txt').hidden, true); assert.equal(f.$('export-textarea-json').hidden, true);
    assert.equal(f.$('draft-markdown').value, texts[1]); assert.equal(f.$('export-markdown-txt').hidden, false);
    f.$('export-textarea-txt').dispatchEvent(new f.window.Event('click')); assert.equal(f.blobs.length, 0);
    f.$('export-markdown-txt').click(); assert.equal(await f.blobs[0].text(), texts[1]);
  }
});

test('authenticated conflict rejects only that app and a surviving verified copy can open another app', async t => {
  const f = await fixture(t), value = f.results(['rejected', 'recovered']);
  value[0].code = 'REPLICA_CONFLICT'; value[0].replicas = ['alpha', 'beta'].map(id => diagnostic(id, 'verified'));
  value[1].replicas[0] = diagnostic('alpha', 'unavailable', 'STORE_UNAVAILABLE');
  f.$('recover').click(); f.pending[0].resolve(value); await tick();
  assert.equal(f.$('draft-textarea').value, ''); assert.match(f.$('state-textarea').textContent, /disagree|conflict/i);
  assert.equal(f.$('draft-markdown').value, texts[1]); assert.match(f.$('copy-markdown-beta').textContent, /verified/i); assert.match(f.$('copy-markdown-alpha').textContent, /unavailable/i);
});

test('malformed, reordered or contradictory SDK results fail closed before displaying any app', async t => {
  const mutations = [value => value.reverse(), value => { value[1].appId = value[0].appId; }, value => { value[1].appId = 'unknown'; }, value => { value.pop(); },
    value => { value[1].replicas.reverse(); }, value => { value[1].replicas[1].id = 'alpha'; }, value => { value[1].replicas[0].stage = 'write'; },
    value => { value[1].replicas[0].status = 'pending'; }, value => { value[1].replicas = value[1].replicas.map(({ id }) => diagnostic(id, 'missing')); },
    value => { value[1].status = 'missing'; value[1].code = 'RESERVE_MISSING'; }, value => { value[1].reserve.text = '\ud800'; }, value => { value[1].extra = 'PRIVATE_DETAILS'; }];
  for (const mutate of mutations) {
    const f = await fixture(t), value = f.results(); mutate(value); f.$('recover').click(); f.pending[0].resolve(value); await tick();
    for (const id of ['textarea', 'markdown']) { assert.equal(f.$('draft-' + id).value, ''); assert.equal(f.$('export-' + id + '-txt').hidden, true); }
    assert.doesNotMatch(f.$('status').textContent, /PRIVATE_DETAILS|Private line/);
  }
});

test('provider failure text and accessors are never rendered as errors or plaintext', async t => {
  const f = await fixture(t); f.$('recover').click(); f.pending[0].reject(Object.assign(Error('PRIVATE_PROVIDER_BODY'), { code: 'PRIVATE_PROVIDER_CODE', text: texts[0] })); await tick();
  assert.doesNotMatch(f.window.document.body.textContent, /PRIVATE_PROVIDER_BODY|PRIVATE_PROVIDER_CODE|Private line/);
  f.$('recover').click(); let reads = 0; const value = f.results(); Object.defineProperty(value[1], 'reserve', { enumerable: true, get() { reads++; throw Error('PRIVATE_GETTER'); } });
  f.pending[1].resolve(value); await tick(); assert.equal(reads, 0); assert.equal(f.$('draft-textarea').value, ''); assert.equal(f.$('draft-markdown').value, '');
});

test('cancel rejects late results and a subsequent operation cannot be overwritten by the cancelled request', async t => {
  const f = await fixture(t); f.$('recover').click(); const firstSignal = f.calls.recover[0].signal; f.$('cancel').click(); assert.equal(firstSignal.aborted, true);
  f.$('recover').click(); assert.equal(f.calls.recover.length, 2); const current = f.results(); current[0].reserve.text = 'Current operation.';
  f.pending[1].resolve(current); await tick(); f.pending[0].resolve(f.results()); await tick(); assert.equal(f.$('draft-textarea').value, 'Current operation.');
});

test('closing clears all adapters, diagnostics and object URLs without automatically reopening', async t => {
  const f = await fixture(t); f.$('recover').click(); f.pending[0].resolve(f.results()); await tick();
  f.$('export-textarea-txt').click(); f.$('export-markdown-json').click(); assert.equal(f.blobs.length, 2);
  f.$('clear').click(); for (const id of ['textarea', 'markdown']) { assert.equal(f.$('draft-' + id).value, ''); assert.equal(f.$('export-' + id + '-txt').hidden, true); }
  assert.equal(new Set(f.revoked).size, 2); assert.equal(f.calls.recover.length, 1);
  f.$('export-textarea-txt').dispatchEvent(new f.window.Event('click')); assert.equal(f.blobs.length, 2);
  f.$('recover').click(); f.pending[1].resolve(f.results(['missing', 'missing'])); await tick(); assert.equal(f.$('draft-textarea').value, ''); assert.equal(f.$('draft-markdown').value, '');
});

test('pagehide aborts the operation and late results or process status cannot resurrect the page', async t => {
  const f = await fixture(t, { delayedStatus: true }); f.$('recover').click(); f.window.dispatchEvent(new f.window.Event('pagehide'));
  assert.equal(f.calls.recover[0].signal.aborted, true); f.pending[0].resolve(f.results()); f.statusResponse.resolve({ synthetic: true, primaryOnline: true, replicas: ['alpha', 'beta'].map(id => ({ id, running: true, corruptedApps: [] })) });
  await f.instance.ready; await tick(); assert.equal(f.$('draft-textarea').value, ''); assert.equal(f.$('draft-markdown').value, ''); assert.equal(f.$('recover').disabled, true);
  f.$('recover').dispatchEvent(new f.window.Event('click')); assert.equal(f.calls.recover.length, 1);
});

test('expiry clears opened drafts and URLs and prevents later actions, including suspended-tab clicks', async t => {
  const f = await fixture(t, { lifetime: 2000 }); f.$('recover').click(); f.pending[0].resolve(f.results()); await tick(); f.$('export-textarea-txt').click();
  f.advance(2001); assert.equal(f.$('draft-textarea').value, ''); assert.equal(f.$('draft-markdown').value, ''); assert.equal(f.$('recover').disabled, true); assert.equal(f.revoked.length, 1);
  f.$('recover').dispatchEvent(new f.window.Event('click')); f.$('export-textarea-txt').dispatchEvent(new f.window.Event('click')); assert.equal(f.calls.recover.length, 1); assert.equal(f.blobs.length, 1);
});

test('A captures the selected editor and passes exact replica identity to the dedicated handoff', async t => {
  const f = await fixture(t, { role: 'primary' });
  for (const [index, id] of ['textarea', 'markdown'].entries()) {
    f.$('draft-' + id).value = 'Example ' + id; f.$('prepare-' + id).click(); await tick();
    assert.equal(f.calls.setup[index].config.appId, f.environment.apps[index].config.appId); assert.equal(f.calls.setup[index].text, 'Example ' + id); assert.deepEqual(f.calls.setup[index].replicaIds, ['alpha', 'beta']);
  }
  assert.equal(f.calls.recover.length, 0); assert.equal(f.calls.native, 0);
});

test('B preparation explicitly selects the existing credential and cannot claim readiness for partial copies', async t => {
  const f = await fixture(t, { enrollment: true, url: '?app=markdown' }); f.$('receive-existing').click(); await tick();
  assert.equal(f.calls.admission, 1); assert.equal(f.calls.prepare.length, 1); assert.equal(f.calls.prepare[0].credentialMode, 'existing');
  assert.equal(f.calls.prepare[0].webAuthnClient, f.client); assert.equal(f.calls.prepare[0].replicas.length, 2);
  f.prepared.reject(Object.assign(Error('PRIVATE_STORE_BODY'), { code: 'REPLICA_PREPARATION_FAILED', recordMayExist: true, replicas: [diagnostic('alpha', 'verified'), { id: 'beta', stage: 'write', status: 'unknown', code: 'STORE_UNAVAILABLE' }] })); await tick();
  assert.equal(f.$('draft-markdown').value, ''); assert.doesNotMatch(f.$('status').textContent, /PRIVATE_STORE_BODY/);
  f.$('receive-existing').dispatchEvent(new f.window.Event('click')); assert.equal(f.calls.admission, 1); assert.ok(f.calls.clears >= 2);
});

test('opened drafts prevent recovery and fault controls even when disabled buttons are dispatched manually', async t => {
  const f = await fixture(t); f.$('recover').click(); f.pending[0].resolve(f.results()); await tick(); const before = f.calls.fetch.length;
  f.$('draft-textarea').value = 'Do not lose this local edit.';
  for (const id of ['recover', 'offline', 'toggle-alpha', 'corrupt-alpha', 'refresh-status']) f.$(id).dispatchEvent(new f.window.Event('click'));
  await tick(); assert.equal(f.calls.fetch.length, before); assert.equal(f.calls.recover.length, 1); assert.equal(f.$('draft-textarea').value, 'Do not lose this local edit.');
});

test('older process status cannot overwrite a later refresh or re-enable controls after an unknown mutation', async t => {
  const f = await fixture(t, { delayedStatus: true }); f.$('refresh-status').click(); await tick(); assert.match(f.$('availability').textContent, /available/);
  f.failNextControl(); f.$('offline').click(); await tick(); assert.equal(f.$('offline').disabled, true); assert.equal(f.$('toggle-alpha').disabled, true);
  f.statusResponse.resolve(f.currentStatus()); await f.instance.ready; await tick();
  assert.equal(f.$('offline').disabled, true); assert.equal(f.$('toggle-alpha').disabled, true); assert.match(f.$('status').textContent, /unknown/i);
});

test('a stale initial status failure cannot erase a newer successful process check', async t => {
  const f = await fixture(t, { delayedStatus: true }); f.$('refresh-status').click(); await tick(); const current = f.$('status').textContent;
  assert.equal(f.$('offline').disabled, false); f.statusResponse.reject(Error('PRIVATE_STALE_FAILURE')); await f.instance.ready; await tick();
  assert.equal(f.$('offline').disabled, false); assert.equal(f.$('status').textContent, current); assert.doesNotMatch(f.window.document.body.textContent, /PRIVATE_STALE_FAILURE/);
});

test('navigation during admission or preparation clears capabilities and rejects late completion', async t => {
  const waiting = await fixture(t, { enrollment: true, delayedAdmission: true, url: '?app=textarea' }); waiting.$('receive-existing').click(); await tick();
  waiting.window.dispatchEvent(new waiting.window.Event('pagehide'));
  waiting.admissionResponse.resolve({ appId: waiting.environment.apps[0].config.appId, replicas: ['alpha', 'beta'].map((id, index) => ({ id, enrollmentToken: Buffer.alloc(32, index + 1).toString('base64url') })) });
  await tick(); assert.equal(waiting.calls.prepare.length, 0); assert.equal(waiting.calls.stores.length, 0);
  const preparing = await fixture(t, { enrollment: true, url: '?app=markdown' }); preparing.$('receive-existing').click(); await tick();
  preparing.window.dispatchEvent(new preparing.window.Event('pagehide')); assert.equal(preparing.calls.prepare[0].signal.aborted, true);
  preparing.prepared.resolve({ status: 'ready', text: 'Late private draft', independentlyVerified: true, replicas: ['alpha', 'beta'].map(id => diagnostic(id, 'verified')) }); await tick();
  assert.equal(preparing.$('draft-markdown').value, ''); assert.equal(preparing.$('recover').disabled, true); assert.equal(preparing.calls.clears, 2); assert.doesNotMatch(preparing.$('status').textContent, /is prepared/);
});

test('untrusted environment and expired configuration fail before any activity', async t => {
  for (const mutation of [value => ({ ...value, expiresAt: new Date(Date.now() - 1000).toISOString() }), value => ({ ...value, apps: [...value.apps].reverse() }), value => ({ ...value, replicas: [...value.replicas].reverse() }), value => ({ ...value, recoveryOrigin: 'https://foreign.invalid' })]) {
    await assert.rejects(fixture(t, { mutation }), /COLLECTION_|ORIGIN_|PORT_INVALID/);
  }
});

test('late cancelled setup completion cannot clear or abort a newer deliberate collection recovery', async t => {
  for (const delayedAdmission of [false, true]) {
    const f = await fixture(t, { enrollment: true, delayedAdmission, url: '?app=textarea' }); f.$('receive-existing').click(); await tick();
    f.$('cancel-setup').click(); f.$('recover').click(); assert.equal(f.calls.recover.length, 1); const signal = f.calls.recover[0].signal;
    if (delayedAdmission) f.admissionResponse.resolve({ appId: f.environment.apps[0].config.appId, replicas: ['alpha', 'beta'].map((id, index) => ({ id, enrollmentToken: Buffer.alloc(32, index + 1).toString('base64url') })) });
    else f.prepared.resolve({ status: 'ready', text: 'Late setup draft', independentlyVerified: true, replicas: ['alpha', 'beta'].map(id => diagnostic(id, 'verified')) });
    await tick(); assert.equal(signal.aborted, false); f.pending[0].resolve(f.results()); await tick(); assert.equal(f.$('draft-markdown').value, texts[1]);
    assert.equal(f.calls.prepare.length, delayedAdmission ? 0 : 1); assert.doesNotMatch(f.$('status').textContent, /Late setup draft/);
  }
});
