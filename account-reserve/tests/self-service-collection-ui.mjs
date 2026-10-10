import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountTextReserveCollection } from '../self-service/apps/collection.mjs';
import { buildEditorAssets } from '../integrations/multi-app/build.mjs';

const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const assets = await mkdtemp(join(tmpdir(), 'continuity-collection-editors-'));
await buildEditorAssets({ outDir: assets });
test.after(() => rm(assets, { recursive: true, force: true }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const firstText = '\ufeffTest A — iPhone\r\nLiteral <img src="https://evil.example/a"> 🦊\n';
const secondText = '# Test B\n\nA separate draft.\n';
const apps = [
  { id: 'textarea', label: 'Textarea', config: { appId: 'continuity-textarea-v1', recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example' } },
  { id: 'markdown', label: 'Markdown Studio', config: { appId: 'continuity-markdown-v1', recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example' } },
];
const ready = (index, text) => ({ appId: apps[index].config.appId, status: 'recovered', reserve: { protocol: 'account-continuity/text-reserve-v1', text, textDigest: 'a'.repeat(64), locator: 'A'.repeat(43) } });
const both = () => [ready(0, firstText), ready(1, secondText)];

function fixture(t, { delayedEditor = false, storeThrows = false, realEditors = false } = {}) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://reserve.example/apps/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom, { document } = window;
  const root = document.getElementById('app'), lifetime = new AbortController(), recovery = deferred(), loading = deferred();
  let time = Date.UTC(2026, 9, 10), interval, currentEditor;
  const calls = { recoveries: [], stores: 0, storeClears: 0, editorLoads: [], mounts: 0, destroys: 0, reloads: 0, external: [] }, blobs = [], revoked = [], links = [];
  window.setInterval = fn => { interval = fn; return 1; }; window.clearInterval = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  window.Range.prototype.getClientRects = () => []; window.focus = () => {}; window.scrollTo = () => {};
  window.HTMLAnchorElement.prototype.click = function () { links.push({ href: this.href, filename: this.download }); };
  const trap = name => () => { calls.external.push(name); throw new Error('UNEXPECTED_' + name); };
  window.fetch = trap('fetch'); window.open = trap('open');
  window.Storage.prototype.setItem = trap('storage'); window.history.pushState = trap('pushState'); window.history.replaceState = trap('replaceState');
  const dependencies = {
    now: () => time, Blob, reload() { calls.reloads++; },
    urls: { createObjectURL(blob) { blobs.push(blob); return 'blob:collection-' + blobs.length; }, revokeObjectURL(url) { revoked.push(url); } },
    makeStore(options) {
      calls.stores++; if (storeThrows) throw new Error('STORE_UNAVAILABLE');
      assert.equal(options.enrollmentToken, undefined);
      return { get: trap('unmocked get'), clearEnrollmentCapability() { calls.storeClears++; } };
    },
    recover(options) { calls.recoveries.push(options); return recovery.promise; },
    async loadEditor(id) {
      calls.editorLoads.push(id); if (delayedEditor) await loading.promise;
      if (realEditors) {
        const read = file => readFile(join(assets, file), 'utf8');
        if (id === 'textarea') {
          window.eval((await read('plain-text-editing.mjs')).replace('export function installPlainTextEditing', 'function installPlainTextEditing') + '\nglobalThis.__install = installPlainTextEditing;');
          window.eval((await read('textarea-editor.mjs')).replace("import { installPlainTextEditing } from './plain-text-editing.mjs';", 'const installPlainTextEditing = globalThis.__install;').replace('export function mountEditor', 'function mountEditor') + '\nglobalThis.__mount = mountEditor;');
        } else {
          window.eval((await read('easymde-runtime.mjs')).replace('export default module.exports;', 'globalThis.__EasyMDE = module.exports;'));
          window.eval((await read('easymde-editor.mjs')).replace("import EasyMDE from './easymde-runtime.mjs';", 'const EasyMDE = globalThis.__EasyMDE;').replace('export function mountEditor', 'function mountEditor') + '\nglobalThis.__mount = mountEditor;');
        }
        return { mountEditor(options) { calls.mounts++; currentEditor = window.__mount(options); return { ...currentEditor, destroy() { calls.destroys++; currentEditor.destroy(); } }; } };
      }
      return { mountEditor({ element, initialText, onChange }) {
        assert.equal(element.closest('section').hidden, false, 'real editor must mount visibly');
        calls.mounts++;
        const input = document.createElement('textarea'); input.value = initialText; input.setAttribute('aria-label', 'Fixture editor'); element.replaceChildren(input);
        input.addEventListener('input', onChange); let destroyed = false;
        currentEditor = { getText() { assert.equal(destroyed, false); return input.value; }, setText(text) { input.value = text; onChange(); }, destroy() { assert.equal(destroyed, false); destroyed = true; calls.destroys++; input.value = ''; input.remove(); } };
        return currentEditor;
      } };
    },
  };
  const controller = mountTextReserveCollection({ root, env: { apps }, expiresAtMs: time + 86400000, lifetime, dependencies });
  const $ = id => document.getElementById('collection-' + id);
  const card = id => root.querySelector('[data-app="' + id + '"]');
  t.after(() => { controller.dispose(); window.close(); });
  return { root, document, window, lifetime, recovery, loading, calls, blobs, links, revoked, $, card,
    open() { $('open').click(); }, choose(id) { card(id).querySelector('button').click(); },
    edit(text) { currentEditor.setText(text); }, text: () => currentEditor.getText(),
    advance(ms) { time += ms; interval(); }, controller };
}

test('collection waits for click and checks both app namespaces in one immediate recovery call', async t => {
  const f = fixture(t);
  assert.equal(f.calls.recoveries.length, 0); assert.equal(f.calls.stores, 0);
  assert.equal(f.$('editor-panel').hidden, true);
  assert.match(f.root.textContent, /device may show more than one confirmation/);
  f.open();
  assert.equal(f.calls.recoveries.length, 1, 'SDK invocation is synchronous in the click handler');
  assert.deepEqual(f.calls.recoveries[0].configs, apps.map(app => app.config));
  assert.equal(f.calls.recoveries[0].webAuthnClient, undefined);
  assert.equal(f.$('open').disabled, true); assert.equal(f.$('cancel').hidden, false);
  f.open(); assert.equal(f.calls.recoveries.length, 1);
  f.recovery.resolve(both()); await tick();
  assert.match(f.$('status').textContent, /Both app reserves opened and verified/);
  assert.equal(f.$('editor-panel').hidden, true); assert.equal(f.calls.mounts, 0);
  assert.equal(f.calls.storeClears, 1); assert.equal(f.document.activeElement, f.$('status'));
  assert.equal(f.calls.external.length, 0);
});

test('same-page switching preserves separate drafts and exports exact current text without further recovery', async t => {
  const f = fixture(t); f.open(); f.recovery.resolve(both()); await tick();
  f.choose('textarea'); await tick();
  assert.equal(f.text(), firstText.replaceAll('\r\n', '\n'), 'fixture textarea has native newline normalization');
  const edited = 'Edited A\nLiteral <script>alert(1)</script> Å🦊\n';
  f.edit(edited); assert.match(f.$('edit-state').textContent, /Edited here/);
  f.choose('markdown'); await tick(); assert.equal(f.text(), secondText);
  f.edit('Edited B\n'); f.$('export-json').click();
  assert.deepEqual(JSON.parse(await f.blobs[0].text()), { format: 'continuity-text-export/v1', text: 'Edited B\n' });
  assert.equal(f.links[0].filename, 'markdown-reserve.json');
  f.choose('textarea'); await tick(); assert.equal(f.text(), edited);
  f.$('export-text').click(); assert.equal(await f.blobs[1].text(), edited);
  assert.equal(f.links[1].filename, 'textarea-reserve.txt');
  assert.equal(f.calls.recoveries.length, 1); assert.equal(f.calls.mounts, 3);
  assert.equal(f.root.querySelector('script,img'), null);
  assert.equal(f.window.location.href, 'https://reserve.example/apps/');
  assert.equal(f.calls.external.length, 0);
});

test('real EasyMDE viewing, switching and exporting preserves original BOM and CRLF until an actual edit', async t => {
  const f = fixture(t, { realEditors: true }), raw = '\ufeff# Raw draft\r\n\r\nÅ and 🦊.\r\n';
  async function mounted(count) { for (let i = 0; i < 100 && f.calls.mounts < count; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(f.calls.mounts, count); }
  f.open(); f.recovery.resolve([ready(0, firstText), ready(1, raw)]); await tick();
  f.choose('markdown'); await mounted(1);
  assert.equal(f.text(), raw.replaceAll('\r\n', '\n'), 'actual CodeMirror normalizes its view');
  assert.equal(f.$('edit-state').textContent, 'Recovered snapshot');
  f.$('export-text').click();
  assert.deepEqual(Buffer.from(await f.blobs[0].arrayBuffer()), Buffer.from(raw));
  f.choose('textarea'); await mounted(2); f.choose('markdown'); await mounted(3);
  f.$('export-json').click(); assert.equal(JSON.parse(await f.blobs[1].text()).text, raw);
  f.edit('# Actually edited\r\nSecond line.\r\n');
  assert.match(f.$('edit-state').textContent, /Edited here/);
  f.$('export-text').click(); assert.equal(await f.blobs[2].text(), '# Actually edited\nSecond line.\n');
  assert.equal(f.calls.recoveries.length, 1); assert.equal(f.calls.external.length, 0);
});

for (const status of ['missing', 'unavailable', 'rejected']) test(`a ${status} app is distinct from its healthy sibling`, async t => {
  const f = fixture(t); f.open();
  f.recovery.resolve([ready(0, firstText), { appId: apps[1].config.appId, status, code: 'TEST_ERROR' }]); await tick();
  assert.match(f.$('status').textContent, /One app reserve opened/);
  assert.equal(f.card('textarea').querySelector('button').hidden, false);
  assert.equal(f.card('markdown').querySelector('button').hidden, true);
  const expected = { missing: /No snapshot for this app/, unavailable: /Availability could not be confirmed/, rejected: /failed verification and was not opened/ };
  assert.match(f.card('markdown').textContent, expected[status]);
  f.choose('textarea'); await tick(); assert.equal(f.calls.mounts, 1);
});

test('all-missing results permit deliberate selection of a different existing key', async t => {
  const f = fixture(t); f.open(); f.recovery.resolve(apps.map(app => ({ appId: app.config.appId, status: 'missing', code: 'RESERVE_MISSING' }))); await tick();
  assert.equal(f.$('open').disabled, false); assert.equal(f.$('open').hidden, false);
  assert.equal(f.$('close-area').hidden, true); assert.match(f.$('status').textContent, /No snapshots were found for this key/);
  assert.equal(f.calls.mounts, 0);
});

test('batch shape or app mismatch cannot display a partial verified copy', async t => {
  const f = fixture(t); f.open(); f.recovery.resolve([ready(0, firstText), { ...ready(1, secondText), appId: 'unexpected-app' }]); await tick();
  assert.equal(f.card('textarea').querySelector('button').hidden, true);
  assert.equal(f.$('editor-panel').hidden, true); assert.equal(f.$('open').disabled, false);
  assert.match(f.$('status').textContent, /could not be opened/);
});

test('cancellation aborts the batch and ignores a late plaintext result', async t => {
  const f = fixture(t); f.open(); f.$('cancel').click();
  assert.equal(f.calls.recoveries[0].signal.aborted, true);
  f.recovery.resolve(both()); await tick();
  assert.equal(f.card('textarea').querySelector('button').hidden, true);
  assert.equal(f.$('editor-panel').hidden, true); assert.equal(f.calls.mounts, 0);
  assert.equal(f.$('open').disabled, false);
  assert.match(f.$('status').textContent, /Opening stopped/);
});

test('pagehide aborts recovery, disposes an open editor, and revokes downloads', async t => {
  const f = fixture(t); f.open(); f.recovery.resolve(both()); await tick(); f.choose('textarea'); await tick(); f.$('export-text').click();
  f.window.dispatchEvent(new f.window.PageTransitionEvent('pagehide'));
  assert.equal(f.calls.destroys, 1); assert.equal(f.$('editor').textContent, '');
  assert.equal(f.$('editor-panel').hidden, true); assert.deepEqual(f.revoked, ['blob:collection-1']);
  f.choose('markdown'); await tick(); assert.equal(f.calls.mounts, 1);
  assert.equal(f.$('open').disabled, true);
  f.window.dispatchEvent(new f.window.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(f.calls.reloads, 1, 'BFCache restoration reloads after pagehide disposal');
});

test('navigation during opening or delayed editor load never displays later plaintext', async t => {
  const a = fixture(t); a.open(); a.lifetime.abort(); a.recovery.resolve(both()); await tick();
  assert.equal(a.calls.recoveries[0].signal.aborted, true); assert.equal(a.card('textarea').querySelector('button').hidden, true);
  const b = fixture(t, { delayedEditor: true }); b.open(); b.recovery.resolve(both()); await tick(); b.choose('textarea');
  b.controller.dispose(); b.loading.resolve(); await tick(); assert.equal(b.calls.mounts, 0);
});

test('expiry aborts in-flight recovery while keeping already opened copies editable and exportable', async t => {
  const waiting = fixture(t); waiting.open(); waiting.advance(86400001); waiting.recovery.resolve(both()); await tick();
  assert.equal(waiting.calls.recoveries[0].signal.aborted, true); assert.equal(waiting.$('open').disabled, true);
  assert.equal(waiting.card('textarea').querySelector('button').hidden, true); assert.match(waiting.$('status').textContent, /expired/);
  const opened = fixture(t); opened.open(); opened.recovery.resolve(both()); await tick(); opened.choose('markdown'); await tick();
  opened.advance(86400001); opened.edit('After expiry, still in this window.'); opened.$('export-text').click();
  assert.equal(await opened.blobs[0].text(), 'After expiry, still in this window.');
  opened.$('close').click(); assert.equal(opened.$('editor-panel').hidden, true); assert.equal(opened.$('open').disabled, true);
});

test('closing clears both edited copies and allows deliberate fresh discovery', async t => {
  const f = fixture(t); f.open(); f.recovery.resolve(both()); await tick(); f.choose('textarea'); await tick(); f.edit('Changed.');
  f.$('close').click();
  assert.equal(f.calls.destroys, 1); assert.equal(f.$('editor-panel').hidden, true);
  assert.equal(f.card('textarea').querySelector('button').hidden, true); assert.equal(f.$('open').disabled, false);
  assert.equal(f.document.activeElement, f.$('open')); f.open(); assert.equal(f.calls.recoveries.length, 2);
});

test('store creation errors restore controls without attempting native discovery', async t => {
  const f = fixture(t, { storeThrows: true }); f.open(); await tick();
  assert.equal(f.calls.recoveries.length, 0); assert.equal(f.$('open').disabled, false); assert.match(f.$('status').textContent, /could not be opened/);
});

test('collection implementation contains no credential creation, writes or persistence flow', async () => {
  const source = await readFile(new URL('../self-service/apps/collection.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createTextReserveCredential|selectTextReserveCredential|prepareTextReserve|putIfAbsent|enrollmentToken|localStorage|sessionStorage|navigator\.credentials/);
});
