import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Also usable unchanged after copying into the repository's tests/ folder.
const projectRoot = process.env.CK_DIAGNOSTICS_PROJECT_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const templateRoot = process.env.CK_DIAGNOSTICS_TEMPLATE_ROOT ?? join(projectRoot, 'text-starter');
const require = createRequire(pathToFileURL(join(projectRoot, 'integrations/multi-app/package.json')));
const { JSDOM } = require('jsdom');
const { configuration, validateEnvironment } = await import(pathToFileURL(join(projectRoot, 'text-starter/config.mjs')));
const core = await import(pathToFileURL(join(projectRoot, 'sdk/text-reserve.mjs')));
const { syntheticClient } = await import(pathToFileURL(join(templateRoot, 'synthetic-client.mjs')));
const html = await readFile(join(templateRoot, 'index.html'), 'utf8');
const main = (await readFile(join(templateRoot, 'main.mjs'), 'utf8')).replace(/^import .*;\n/gm, '');
const adapterSource = (await readFile(join(projectRoot, 'text-starter/adapter.mjs'), 'utf8'))
  .replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ');
const adapter = new Function('validateText', adapterSource + '\nreturn {captureText,restoreText,exportText,textareaAdapter};')(core.validateText);
const tick = () => new Promise(resolve => setImmediate(resolve));
const failure = code => Object.assign(new Error(code), { code });
const response = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check) {
  for (let attempt = 0; attempt < 30; attempt++) { if (check()) return; await tick(); }
  assert.ok(check(), 'the expected UI state did not settle');
}

async function fixture({ enrollment = false, syntheticResponse = () => response(404, 'CREDENTIAL_MISSING'), recoveryAction, preparationAction } = {}) {
  const settings = configuration();
  const dom = new JSDOM(html, { url: settings.recoveryOrigin + '/', runScripts: 'outside-only' });
  const { window } = dom, requests = [], storeOptions = [], observedErrors = [];
  const counts = { prepare: 0, recover: 0, setup: 0, native: 0, persistence: 0, writes: 0, reads: 0, clear: 0 };
  const $ = id => window.document.getElementById(id);
  window.AbortController = AbortController; window.AbortSignal = AbortSignal;
  Object.defineProperty(window.navigator, 'credentials', { value: {
    create() { counts.native++; throw new Error('NATIVE_FORBIDDEN'); },
    get() { counts.native++; throw new Error('NATIVE_FORBIDDEN'); },
  } });
  window.Storage.prototype.setItem = () => { counts.persistence++; throw new Error('PERSISTENCE_FORBIDDEN'); };
  window.URL.revokeObjectURL = () => {};
  window.fetch = async (path, init = {}) => {
    if (path === '/api/config') return { ok: true, json: async () => ({ ...settings, synthetic: true, role: 'recovery',
      ...(enrollment ? { enrollmentToken: 'a'.repeat(43) } : {}) }) };
    if (path === '/api/status') return { ok: true, json: async () => ({ primaryOnline: true }) };
    assert.equal(path, '/api/synthetic');
    assert.equal(init.method, 'POST');
    const action = JSON.parse(init.body).action;
    assert.ok(['create', 'get'].includes(action));
    requests.push({ path, method: init.method, action });
    return await syntheticResponse({ action, index: requests.length, signal: init.signal });
  };
  window.__deps = {
    ...adapter, validateEnvironment, syntheticClient,
    startTextReserveSetup() { counts.setup++; throw new Error('UNEXPECTED_SETUP'); },
    createTextReserveReceiver() {
      return { isEnrollment: enrollment, dispose() {}, async prepare(options) {
        counts.prepare++;
        if (preparationAction) return await preparationAction(options, { settings, counts, observedErrors });
        // Real credential/Mera wrapping; the handoff itself is outside this fixture.
        return await core.createTextReserveCredential({ config: settings.config, webAuthnClient: options.webAuthnClient,
          signal: options.signal, user: { name: 'Fictional trial', displayName: 'LOCAL SIMULATION' } });
      } };
    },
    createReserveHttpStore(options) {
      storeOptions.push({ enrollment: Object.hasOwn(options, 'enrollmentToken') });
      return {
        clearEnrollmentCapability() { counts.clear++; },
        async get() { counts.reads++; throw new Error('UNEXPECTED_READ'); },
        async putIfAbsent() { counts.writes++; throw new Error('WRITE_FORBIDDEN'); },
      };
    },
    async recoverTextReserve(options) {
      counts.recover++;
      if (recoveryAction) return await recoveryAction(options, { settings, counts, observedErrors });
      try { return await core.recoverTextReserve({ ...options, config: settings.config }); }
      catch (error) { observedErrors.push(error.code); throw error; }
    },
  };
  await window.eval('(async () => { const { ' + Object.keys(window.__deps).join(',') + ' } = window.__deps;\n' + main + '\n})()');
  return { window, $, settings, requests, counts, storeOptions, observedErrors, close: () => window.close() };
}

function assertReadOnlyFailure(f) {
  assert.equal(f.counts.setup, 0);
  assert.equal(f.counts.prepare, 0);
  assert.equal(f.counts.writes, 0);
  assert.equal(f.counts.reads, 0, 'failed credential selection must not reach snapshot storage');
  assert.equal(f.counts.native, 0);
  assert.equal(f.counts.persistence, 0);
  assert.ok(f.storeOptions.every(value => !value.enrollment), 'recovery must have no upload capability');
  assert.equal(f.$('receive').hidden, true);
  assert.equal(f.$('recover').hidden, false);
  assert.equal(f.$('recover').disabled, false);
  assert.equal(f.$('draft').value, '');
  assert.equal(f.$('draft').disabled, true);
}

test('404 credential selection explains the responding route despite real SDK/Mera error wrapping', async () => {
  const f = await fixture();
  try {
    f.$('recover').click();
    await until(() => f.$('status').textContent.includes('The action stopped'));
    assert.deepEqual(f.observedErrors, ['PASSKEY_OPERATION_FAILED']);
    assert.match(f.$('status').textContent, /PASSKEY_OPERATION_FAILED/);
    assert.match(f.$('status').textContent, /POST \/api\/synthetic; action=get; HTTP 404; CREDENTIAL_MISSING/);
    assert.match(f.$('status').textContent, /could not find.*simulated credential/i);
    assert.match(f.$('status').textContent, /route did respond/i);
    assert.doesNotMatch(f.$('status').textContent, /route.*does not exist/i);
    await tick();
    assert.deepEqual(f.requests, [{ path: '/api/synthetic', method: 'POST', action: 'get' }]);
    assert.equal(f.counts.recover, 1, 'a failure must not retry or fall back to creation');
    assertReadOnlyFailure(f);
  } finally { f.close(); }
});

test('preparation retains direct client diagnostics when the adapter caller rethrows only a code', async () => {
  const f = await fixture({ enrollment: true, syntheticResponse: () => response(404, 'ROUTE_UNAVAILABLE'),
    async preparationAction(options, { settings, observedErrors }) {
      try {
        await core.createTextReserveCredential({ config: settings.config, webAuthnClient: options.webAuthnClient,
          signal: options.signal, user: { name: 'Fictional trial', displayName: 'LOCAL SIMULATION' } });
        assert.fail('credential creation must fail');
      } catch (error) {
        observedErrors.push(error.code);
        throw { code: error.code }; // Deliberately no message, cause or diagnostic fields.
      }
    } });
  try {
    f.$('receive').click();
    await until(() => f.$('status').textContent.includes('The action stopped'));
    assert.deepEqual(f.observedErrors, ['PASSKEY_OPERATION_FAILED']);
    assert.match(f.$('status').textContent, /POST \/api\/synthetic; action=create; HTTP 404; ROUTE_UNAVAILABLE/);
    assert.match(f.$('status').textContent, /did not recognize this route for this request/i);
    assert.doesNotMatch(f.$('status').textContent, /could not find.*simulated credential/i);
    assert.equal(f.$('receive').hidden, true);
    assert.equal(f.$('recover').hidden, false);
    assert.equal(f.$('recover').disabled, false);
    assert.equal(f.counts.clear, 1);
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.native, 0);
    assert.equal(f.counts.persistence, 0);
    f.$('receive').dispatchEvent(new f.window.MouseEvent('click'));
    await tick();
    assert.equal(f.counts.prepare, 1);
    assert.equal(f.counts.recover, 0);
    assert.equal(f.requests.length, 1, 'closing failed preparation must not attempt another credential');
  } finally { f.close(); }
});

test('an explicit later recovery distinguishes route failure from missing credential without automatic creation', async () => {
  const f = await fixture({ syntheticResponse: ({ index }) => response(404, index === 1 ? 'CREDENTIAL_MISSING' : 'ROUTE_UNAVAILABLE') });
  try {
    f.$('recover').click();
    await until(() => f.$('status').textContent.includes('CREDENTIAL_MISSING'));
    assert.equal(f.requests.length, 1);
    f.$('recover').click();
    await until(() => f.$('status').textContent.includes('ROUTE_UNAVAILABLE'));
    assert.doesNotMatch(f.$('status').textContent, /CREDENTIAL_MISSING|route did respond/i);
    assert.match(f.$('status').textContent, /did not recognize this route for this request/i);
    assert.deepEqual(f.requests.map(value => value.action), ['get', 'get']);
    assert.equal(f.counts.recover, 2);
    assertReadOnlyFailure(f);
  } finally { f.close(); }
});

test('late diagnostics from a timed-out action cannot contaminate a later action', async () => {
  const delayedHttp = deferred(), firstOutcome = deferred(), secondOutcome = deferred();
  let lateCredential;
  const f = await fixture({ syntheticResponse: () => delayedHttp.promise,
    recoveryAction(options, { settings, counts }) {
      if (counts.recover === 1) {
        lateCredential = options.webAuthnClient.getCredential({ rpId: settings.config.recoveryRpId, prfSalt: new Uint8Array(32) }).catch(() => {});
        return firstOutcome.promise;
      }
      return secondOutcome.promise;
    } });
  try {
    f.$('recover').click();
    await until(() => f.requests.length === 1);
    firstOutcome.reject(failure('OPERATION_TIMED_OUT'));
    await until(() => f.$('status').textContent.includes('OPERATION_TIMED_OUT'));
    assert.doesNotMatch(f.$('status').textContent, /Local request:/);
    f.$('recover').click();
    assert.equal(f.counts.recover, 2);
    assert.equal(f.$('recover').disabled, true);
    delayedHttp.resolve(response(404, 'CREDENTIAL_MISSING'));
    await lateCredential;
    assert.doesNotMatch(f.$('status').textContent, /CREDENTIAL_MISSING|Local request:/);
    secondOutcome.reject(failure('SECOND_ACTION_FAILED'));
    await until(() => f.$('status').textContent.includes('SECOND_ACTION_FAILED'));
    assert.doesNotMatch(f.$('status').textContent, /CREDENTIAL_MISSING|HTTP 404|Local request:/);
    assert.equal(f.requests.length, 1);
    assertReadOnlyFailure(f);
  } finally {
    delayedHttp.resolve(response(404, 'CREDENTIAL_MISSING'));
    firstOutcome.resolve(); secondOutcome.resolve();
    await lateCredential;
    f.close();
  }
});

test('pagehide suppresses late HTTP diagnostics and cannot reopen recovery or display plaintext', async () => {
  const delayedHttp = deferred();
  const f = await fixture({ syntheticResponse: () => delayedHttp.promise });
  try {
    f.$('recover').click();
    await until(() => f.requests.length === 1);
    f.window.dispatchEvent(new f.window.Event('pagehide'));
    const closedMessage = f.$('status').textContent;
    assert.match(closedMessage, /This view is closed/);
    delayedHttp.resolve(response(404, 'CREDENTIAL_MISSING'));
    await tick(); await tick();
    assert.equal(f.$('status').textContent, closedMessage);
    assert.doesNotMatch(f.$('status').textContent, /CREDENTIAL_MISSING|Local request:/);
    assert.equal(f.$('draft').value, '');
    assert.equal(f.$('draft').disabled, true);
    assert.equal(f.$('recover').disabled, true);
    f.$('recover').dispatchEvent(new f.window.MouseEvent('click'));
    await tick();
    assert.equal(f.counts.recover, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.counts.prepare, 0);
    assert.equal(f.counts.setup, 0);
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.native, 0);
    assert.equal(f.counts.persistence, 0);
  } finally { delayedHttp.resolve(response(404, 'CREDENTIAL_MISSING')); f.close(); }
});
