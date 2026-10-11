import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEditorAssets } from '../integrations/multi-app/build.mjs';
import { validateEnvironment as validateAppsEnvironment } from '../self-service/apps/config.mjs';
import { validateEnvironment as validateTextEnvironment } from '../self-service/text/config.mjs';
import { validateText, MAX_TEXT_BYTES } from '../sdk/text-reserve.mjs';

// Execute each actual UI against a real DOM/editor. Only configuration delivery,
// recovered plaintext and unsupported setup/transport boundaries are substituted.
// This proves editing/export bytes, not passkeys, ciphertext or a hosted browser.
const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const assets = await mkdtemp(join(tmpdir(), 'self-service-exact-editors-'));
await buildEditorAssets({ outDir: assets });
test.after(() => rm(assets, { recursive: true, force: true }));
const sources = Object.fromEntries(await Promise.all(['text', 'apps'].map(async id => [id,
  (await readFile(new URL('../self-service/' + id + '/app.mjs', import.meta.url), 'utf8'))
    .replace('await import(/* @vite-ignore */ ', 'await loadEditorModule(')
    .split('\n').filter(line => !line.startsWith('import ')).join('\n'),
])));
const raw = '\ufeff# Recovered draft\r\nA CRLF line.\rA bare-CR line.\r\nLiteral <script>stay text</script> Å 🦊\r\n';
const editedInput = '\ufeff# Deliberately edited\r\nNew second line.\rBare CR after editing.\r\n';
const newlineView = text => text.replace(/\r\n?/g, '\n');
const routes = [
  { id: 'text', source: 'text', path: '/text/' },
  { id: 'textarea', source: 'apps', path: '/apps/textarea/' },
  { id: 'markdown', source: 'apps', path: '/apps/markdown/' },
];
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function environment(kind) {
  const recoveryOrigin = 'https://reserve.example.test';
  const config = appId => ({ appId, recoveryOrigin, recoveryRpId: 'reserve.example.test' });
  const env = { hosted: true, physicalEnabled: true, synthetic: false, selfService: true, fictionalOnly: true, role: 'recovery',
    originalOrigin: 'https://original.example.test', recoveryOrigin, expiresAt: new Date(Date.now() + 86400000).toISOString(),
    limits: { maxRecords: 64, maxRecordBytes: 65536, maxIssuedCapabilities: 256, capabilityTtlMs: 300000 } };
  return kind === 'text' ? { ...env, config: config('continuity-judge-text-v1') } : { ...env, operatorHosted: false, enrollmentRequiresInvitation: false,
    apps: [{ id: 'textarea', label: 'Textarea', config: config('continuity-textarea-v1') }, { id: 'markdown', label: 'Markdown Studio', config: config('continuity-markdown-v1') }] };
}

async function fixture(t, route) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://reserve.example.test' + route.path, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom, { document } = window;
  const $ = id => document.getElementById(id), env = environment(route.source);
  const calls = { config: 0, recover: 0, stores: 0, cleared: 0, mounted: 0, destroyed: 0, forbidden: [] };
  const blobs = [], links = [], revoked = [];
  let editor, signal, hidden = false;
  const pagehide = () => { if (!hidden) { hidden = true; window.dispatchEvent(new window.PageTransitionEvent('pagehide')); } };
  t.after(() => { pagehide(); window.close(); });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  window.Range.prototype.getClientRects = () => [];
  window.focus = () => {}; window.scrollTo = () => {};
  window.HTMLAnchorElement.prototype.click = function () { links.push({ href: this.href, filename: this.download }); };
  window.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:exact-export-' + blobs.length; };
  window.URL.revokeObjectURL = url => { revoked.push(url); };
  const forbidden = name => () => { calls.forbidden.push(name); throw new Error('UNEXPECTED_' + name); };
  window.open = forbidden('popup'); window.Storage.prototype.setItem = forbidden('storage');
  window.__deps = {
    Blob, TextEncoder, validateText, MAX_TEXT_BYTES, prismBackdrop: '', prismSculpture: '',
    validateEnvironment: route.source === 'text' ? validateTextEnvironment : validateAppsEnvironment,
    validateCapability: forbidden('capability'), startTextReserveSetup: forbidden('setup'), mountTextReserveCollection: forbidden('collection'),
    createTextReserveReceiver() { return { isEnrollment: false, dispose() {}, prepare: forbidden('prepare') }; },
    createReserveHttpStore(options) {
      calls.stores++; assert.equal(options.enrollmentToken, undefined);
      return { get: forbidden('store-read'), putIfAbsent: forbidden('store-write'), clearEnrollmentCapability() { calls.cleared++; } };
    },
    async recoverTextReserve(options) {
      calls.recover++; signal = options.signal;
      assert.equal(options.webAuthnClient, undefined);
      return { protocol: 'account-continuity/text-reserve-v1', text: raw, textDigest: 'a'.repeat(64), locator: 'A'.repeat(43) };
    },
    async fetch(path, options) {
      assert.equal(path, '/api/' + (route.source === 'text' ? 'text' : 'apps') + '-config');
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); calls.config++;
      return { ok: true, json: async () => env };
    },
    async loadEditorModule(path) {
      assert.equal(path, '/apps/editors/' + (route.id === 'textarea' ? 'textarea' : 'easymde') + '-editor.mjs');
      const read = name => readFile(join(assets, name), 'utf8');
      if (route.id === 'textarea') {
        window.eval((await read('plain-text-editing.mjs')).replace('export function installPlainTextEditing', 'function installPlainTextEditing') + '\nglobalThis.__install = installPlainTextEditing;');
        window.eval((await read('textarea-editor.mjs')).replace("import { installPlainTextEditing } from './plain-text-editing.mjs';", 'const installPlainTextEditing = globalThis.__install;').replace('export function mountEditor', 'function mountEditor') + '\nglobalThis.__mount = mountEditor;');
      } else {
        window.eval((await read('easymde-runtime.mjs')).replace('export default module.exports;', 'globalThis.__EasyMDE = module.exports;'));
        window.eval((await read('easymde-editor.mjs')).replace("import EasyMDE from './easymde-runtime.mjs';", 'const EasyMDE = globalThis.__EasyMDE;').replace('export function mountEditor', 'function mountEditor') + '\nglobalThis.__mount = mountEditor;');
      }
      return { mountEditor(options) {
        calls.mounted++; editor = window.__mount(options);
        return { ...editor, destroy() { calls.destroyed++; editor.destroy(); } };
      } };
    },
  };
  await window.eval('(async () => { const { ' + Object.keys(window.__deps).join(',') + ' } = window.__deps;\n' + sources[route.source] + '\n})()');
  await until(() => [...($('actions')?.querySelectorAll('button') ?? [])].some(button => button.textContent === 'Open my existing reserve'), 'actual recovery UI did not initialize');
  assert.equal(calls.recover, 0);
  [...$('actions').querySelectorAll('button')].find(button => button.textContent === 'Open my existing reserve').click();
  assert.equal(calls.recover, 1, 'only the deliberate click invokes recovery');
  await until(() => $('editor')?.hidden === false && $('status').textContent.startsWith('Text recovered and verified.'), 'recovered editor did not open');
  const read = () => route.id === 'text' ? $('work-deliverable').value : editor.getText();
  return { $, window, document, calls, blobs, links, revoked, read, pagehide,
    edit(text) {
      if (route.id === 'text') { $('work-deliverable').value = text; $('work-deliverable').dispatchEvent(new window.Event('input', { bubbles: true })); }
      else editor.setText(text);
    },
    async exports() {
      const count = blobs.length; $('export-text').click(); $('export-json').click(); assert.equal(blobs.length, count + 2);
      return [Buffer.from(await blobs[count].arrayBuffer()), Buffer.from(await blobs[count + 1].arrayBuffer())];
    },
    assertClosed() {
      assert.equal(signal.aborted, true); assert.equal(calls.cleared, 1);
      if (route.id === 'text') assert.equal($('work-deliverable').value, '');
      else { assert.equal(calls.destroyed, 1); assert.equal($('work-deliverable').textContent, ''); }
      assert.deepEqual([...new Set(revoked)].sort(), blobs.map((_, i) => 'blob:exact-export-' + (i + 1)).sort());
      const count = blobs.length; $('export-text').click(); $('export-json').click(); assert.equal(blobs.length, count);
      assert.equal(calls.config, 1); assert.equal(calls.recover, 1); assert.deepEqual(calls.forbidden, []);
    },
  };
}

const expectedExports = text => [Buffer.from(text), Buffer.from(JSON.stringify({ format: 'continuity-text-export/v1', text }, null, 2) + '\n')];
for (const route of routes) {
  test(route.path + ' exports original BOM, CRLF and bare CR byte-exactly before any edit', async t => {
    const f = await fixture(t, route);
    assert.deepEqual(await f.exports(), expectedExports(raw), 'both TXT and JSON must preserve the recovered text before editing');
    f.pagehide(); f.assertClosed();
  });
  test(route.path + ' does not label editor newline normalization as a user edit', async t => {
    const f = await fixture(t, route);
    assert.equal(f.$('edit-state').textContent, 'Recovered snapshot');
    assert.equal(f.document.querySelector('#work-deliverable script'), null);
  });
  test(route.path + ' genuine edits export the current editor value and pagehide clears it', async t => {
    const f = await fixture(t, route);
    f.edit(editedInput);
    const current = f.read();
    assert.equal(current, route.id === 'textarea' ? editedInput : newlineView(editedInput));
    assert.match(f.$('edit-state').textContent, /Edited here/);
    assert.deepEqual(await f.exports(), expectedExports(current));
    f.pagehide(); f.assertClosed();
  });
}
