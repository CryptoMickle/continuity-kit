import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Defaults also work when this file is copied into the project's tests/ folder.
const projectRoot = process.env.CK_EXPIRY_PROJECT_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const templateRoot = process.env.CK_EXPIRY_TEMPLATE_ROOT ?? join(projectRoot, 'text-starter');
const require = createRequire(pathToFileURL(join(projectRoot, 'integrations/multi-app/package.json')));
const { JSDOM } = require('jsdom');
const { configuration, validateEnvironment } = await import(pathToFileURL(join(projectRoot, 'text-starter/config.mjs')));
const { validateText } = await import(pathToFileURL(join(projectRoot, 'sdk/text-reserve.mjs')));
const html = await readFile(join(templateRoot, 'index.html'), 'utf8');
const main = (await readFile(join(templateRoot, 'main.mjs'), 'utf8')).replace(/^import .*;\n/gm, '');
const adapterSource = (await readFile(join(projectRoot, 'text-starter/adapter.mjs'), 'utf8'))
  .replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ');
const adapter = new Function('validateText', adapterSource + '\nreturn {captureText,restoreText,exportText,textareaAdapter};')(validateText);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(role, { primaryOnline = true, deferPrimary = false } = {}) {
  const settings = configuration();
  const origin = role === 'primary' ? settings.originalOrigin : settings.recoveryOrigin;
  const dom = new JSDOM(html, { url: origin + '/', runScripts: 'outside-only' });
  const { window } = dom, setupResult = deferred(), primaryControl = deferred(), exported = [], requests = [];
  const counts = { setup: 0, prepare: 0, recover: 0, credential: 0, native: 0, storage: 0, store: 0, clear: 0 };
  const $ = id => window.document.getElementById(id);
  let setupOptions, receiverOptions;
  window.AbortController = AbortController;
  window.AbortSignal = AbortSignal;
  Object.defineProperty(window.navigator, 'credentials', { value: {
    create() { counts.native++; throw new Error('NATIVE_FORBIDDEN'); },
    get() { counts.native++; throw new Error('NATIVE_FORBIDDEN'); },
  } });
  window.Storage.prototype.setItem = () => { counts.storage++; throw new Error('STORAGE_FORBIDDEN'); };
  window.URL.createObjectURL = blob => { exported.push({ blob }); return `blob:local-export-${exported.length}`; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {
    const item = exported.at(-1);
    assert.ok(item, 'an explicit export must create its blob first');
    item.filename = this.download;
    item.href = this.href;
  };
  const synthetic = {
    createCredential() { counts.credential++; throw new Error('UNEXPECTED_CREDENTIAL'); },
    getCredential() { counts.credential++; throw new Error('UNEXPECTED_CREDENTIAL'); },
  };
  window.fetch = async (path, init = {}) => {
    requests.push({ path, method: init.method ?? 'GET' });
    if (path === '/api/config') return { ok: true, json: async () => ({
      ...settings, synthetic: true, role, ...(role === 'recovery' ? { enrollmentToken: 'a'.repeat(43) } : {}),
    }) };
    if (path === '/api/status') return { ok: true, json: async () => ({ primaryOnline }) };
    if (path === '/api/primary' && init.method === 'POST') {
      if (deferPrimary) await primaryControl.promise;
      primaryOnline = JSON.parse(init.body).online;
      assert.equal(typeof primaryOnline, 'boolean');
      return { ok: true, json: async () => ({ primaryOnline }) };
    }
    throw new Error('UNEXPECTED_REQUEST');
  };
  window.__deps = {
    ...adapter, validateEnvironment, syntheticClient: () => synthetic,
    startTextReserveSetup(options) {
      counts.setup++; setupOptions = options;
      options.onState?.({ state: 'waiting' });
      return { completion: setupResult.promise, cancel() {} };
    },
    createTextReserveReceiver(options) {
      receiverOptions = options;
      return { isEnrollment: true, dispose() {}, prepare() { counts.prepare++; throw new Error('UNEXPECTED_PREPARATION'); } };
    },
    createReserveHttpStore() { counts.store++; return { clearEnrollmentCapability() { counts.clear++; } }; },
    recoverTextReserve() { counts.recover++; throw new Error('UNEXPECTED_RECOVERY'); },
  };
  await window.eval('(async () => { const { ' + Object.keys(window.__deps).join(',') + ' } = window.__deps;\n' + main + '\n})()');
  return { window, $, counts, requests, exported, settings, setupResult, primaryControl,
    get setupOptions() { return setupOptions; }, get receiverOptions() { return receiverOptions; },
    async exportedText(index = 0) {
      return await new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(exported[index].blob);
      });
    },
    close() { window.close(); },
  };
}

function assertNoCredentialOrPersistence(f) {
  assert.equal(f.counts.credential, 0);
  assert.equal(f.counts.native, 0);
  assert.equal(f.counts.storage, 0);
}

for (const outcome of ['absent', 'possible', 'unknown']) {
  test(`primary expiry preserves export and closes setup when stored-copy outcome is ${outcome}`, async () => {
    const f = await fixture('primary');
    try {
      const draft = 'Fictional draft — preserve this correction.\nÆØÅ and a second line.';
      f.$('draft').value = draft;
      f.$('prepare').click();
      assert.equal(f.counts.setup, 1);
      assert.equal(f.setupOptions.text, draft);
      const waitingMessage = f.$('status').textContent;
      const error = Object.assign(new Error('SETUP_EXPIRED'), { code: 'SETUP_EXPIRED',
        ...(outcome === 'unknown' ? {} : { recordMayExist: outcome === 'possible' }) });
      f.setupOptions.onState({ state: 'failed', code: 'SETUP_EXPIRED' });
      f.setupResult.reject(error);
      await tick();

      assert.equal(f.$('draft').value, draft);
      assert.equal(f.$('draft').disabled, false);
      assert.equal(f.$('prepare').hidden, false);
      assert.equal(f.$('prepare').disabled, true);
      assert.match(f.$('prepare').textContent, /setup closed/i);
      assert.match(f.$('status').textContent, /five-minute setup window has closed/i);
      assert.match(f.$('status').textContent, /draft is still here.*export/i);
      assert.match(f.$('status').textContent, /Restoring A does not renew/i);
      assert.match(waitingMessage, /five minutes/i);
      if (outcome === 'absent') {
        assert.match(f.$('status').textContent, /did not save a snapshot/i);
        assert.doesNotMatch(f.$('status').textContent, /saved copy may still exist/i);
      } else {
        assert.match(f.$('status').textContent, /saved copy may still exist/i);
        assert.doesNotMatch(f.$('status').textContent, /did not save a snapshot/i);
      }
      const link = f.$('check-reserve');
      assert.ok(link);
      assert.equal(link.hidden, false);
      assert.equal(link.href, f.settings.recoveryOrigin + '/');
      assert.equal(new URL(link.href).hash, '');
      assert.equal(link.target, '_blank');
      assert.match(link.rel, /\bnoopener\b/);
      for (const format of ['txt', 'json']) {
        assert.equal(f.$('export-' + format).hidden, false);
        assert.equal(f.$('export-' + format).disabled, false);
      }
      f.$('export-txt').click();
      assert.equal(f.exported.length, 1);
      assert.equal(f.exported[0].filename, 'continuity-draft.txt');
      assert.equal(await f.exportedText(), draft);

      // Even an explicit event dispatched at the disabled control cannot retry.
      f.$('prepare').dispatchEvent(new f.window.MouseEvent('click'));
      await tick();
      assert.equal(f.counts.setup, 1);
      assert.equal(f.counts.prepare, 0);
      assert.equal(f.counts.recover, 0);
      assertNoCredentialOrPersistence(f);
    } finally { f.close(); }
  });
}

test('B expiry before any click removes enrollment capability and exposes only explicit recovery', async () => {
  const f = await fixture('recovery');
  try {
    assert.equal(f.$('receive').hidden, false);
    assert.equal(f.$('recover').hidden, true);
    assert.equal(f.counts.store, 1);
    f.receiverOptions.onState?.({ state: 'failed', code: 'SETUP_EXPIRED' });
    await tick();
    assert.equal(f.$('receive').hidden, true);
    assert.equal(f.$('recover').hidden, false);
    assert.equal(f.$('recover').disabled, false);
    assert.equal(f.$('draft').value, '');
    assert.equal(f.$('draft').disabled, true);
    assert.equal(f.$('export-txt').hidden, true);
    assert.equal(f.counts.clear, 1);
    assert.match(f.$('status').textContent, /five-minute setup window has closed/i);
    assert.match(f.$('status').textContent, /saved copy may still exist/i);
    assert.match(f.$('status').textContent, /original A tab to export/i);
    assert.equal(f.$('fresh').href, f.settings.recoveryOrigin + '/');
    f.$('receive').dispatchEvent(new f.window.MouseEvent('click'));
    await tick();
    assert.equal(f.counts.prepare, 0);
    assert.equal(f.counts.setup, 0);
    assert.equal(f.counts.recover, 0);
    assertNoCredentialOrPersistence(f);
  } finally { f.close(); }
});

test('restoring A after B expiry does not revive enrollment or recreate a capability', async () => {
  const f = await fixture('recovery', { primaryOnline: false });
  try {
    assert.match(f.$('offline').textContent, /restore A/i);
    f.receiverOptions.onState?.({ state: 'failed', code: 'SETUP_EXPIRED' });
    f.$('offline').click();
    await tick();
    assert.match(f.$('availability').textContent, /A is currently available/i);
    assert.match(f.$('status').textContent, /A is available again.*expired setup stays closed/i);
    assert.match(f.$('status').textContent, /original tab.*export/i);
    assert.equal(f.$('receive').hidden, true);
    assert.equal(f.$('recover').hidden, false);
    assert.equal(f.$('recover').disabled, false);
    assert.equal(f.$('draft').value, '');
    assert.equal(f.counts.store, 1);
    assert.equal(f.counts.clear, 1);
    assert.equal(f.requests.filter(value => value.path === '/api/primary' && value.method === 'POST').length, 1);
    f.$('receive').dispatchEvent(new f.window.MouseEvent('click'));
    await tick();
    assert.equal(f.counts.prepare, 0);
    assert.equal(f.counts.setup, 0);
    assert.equal(f.counts.recover, 0);
    assertNoCredentialOrPersistence(f);
  } finally { f.close(); }
});

test('B expiry closes enrollment even while an unrelated Restore A request is pending', async () => {
  const f = await fixture('recovery', { primaryOnline: false, deferPrimary: true });
  try {
    f.$('offline').click();
    assert.equal(f.requests.filter(value => value.path === '/api/primary').length, 1);
    assert.equal(f.$('receive').hidden, false);
    assert.equal(f.$('receive').disabled, true, 'Restore A is still pending');
    f.receiverOptions.onState?.({ state: 'failed', code: 'SETUP_EXPIRED' });
    assert.equal(f.$('receive').hidden, true, 'expiry must close enrollment during the unrelated operation');
    assert.equal(f.counts.clear, 1);
    assert.match(f.$('status').textContent, /five-minute setup window has closed/i);
    assertNoCredentialOrPersistence(f);

    f.primaryControl.resolve();
    await tick();
    assert.match(f.$('availability').textContent, /A is currently available/i);
    assert.match(f.$('status').textContent, /expired setup stays closed/i);
    assert.equal(f.$('receive').hidden, true);
    assert.equal(f.$('recover').hidden, false);
    assert.equal(f.$('recover').disabled, false);
    assert.equal(f.counts.clear, 1);
    assert.equal(f.counts.store, 1);
    f.$('receive').dispatchEvent(new f.window.MouseEvent('click'));
    await tick();
    assert.equal(f.counts.prepare, 0);
    assert.equal(f.counts.setup, 0);
    assert.equal(f.counts.recover, 0);
    assertNoCredentialOrPersistence(f);
  } finally { f.primaryControl.resolve(); f.close(); }
});
