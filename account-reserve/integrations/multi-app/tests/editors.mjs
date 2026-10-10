import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildEditorAssets } from '../build.mjs';

const output = await mkdtemp(join(tmpdir(), 'continuity-editors-'));
await buildEditorAssets({ outDir: output });
test.after(() => rm(output, { recursive: true, force: true }));
const read = file => readFile(join(output, file), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 70));

async function host(kind) {
  const faults = [], changes = [], boundaryCalls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => faults.push(error.message));
  const dom = new JSDOM('<!doctype html><div id="editor"></div>', { url: 'https://app.example/apps/' + kind, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const trap = name => () => { boundaryCalls.push(name); throw new Error('UNEXPECTED_BOUNDARY_' + name); };
  window.fetch = trap('fetch');
  window.XMLHttpRequest = trap('xhr');
  window.open = trap('open');
  window.history.pushState = trap('pushState'); window.history.replaceState = trap('replaceState');
  Object.defineProperty(window.navigator, 'serviceWorker', { value: { register: trap('serviceWorker') } });
  for (const method of ['setItem', 'removeItem', 'clear']) window.Storage.prototype[method] = trap('storage-' + method);
  // JSDOM omits layout measurements needed by the real CodeMirror runtime.
  // These zero rectangles are layout shims, not substitutes for editor code.
  window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  window.Range.prototype.getClientRects = () => [];
  window.scrollTo = () => {};
  window.focus = () => {};
  if (kind === 'textarea') {
    window.eval((await read('plain-text-editing.mjs')).replace('export function installPlainTextEditing', 'function installPlainTextEditing') + '\nglobalThis.__install = installPlainTextEditing;');
    window.eval((await read('textarea-editor.mjs')).replace("import { installPlainTextEditing } from './plain-text-editing.mjs';", 'const installPlainTextEditing = globalThis.__install;').replace('export function mountEditor', 'function mountEditor') + '\nglobalThis.__mount = mountEditor;');
  } else {
    window.eval((await read('easymde-runtime.mjs')).replace('export default module.exports;', 'globalThis.__EasyMDE = module.exports;'));
    window.eval((await read('easymde-editor.mjs')).replace("import EasyMDE from './easymde-runtime.mjs';", 'const EasyMDE = globalThis.__EasyMDE;').replace('export function mountEditor', 'function mountEditor') + '\nglobalThis.__mount = mountEditor;');
  }
  const element = window.document.getElementById('editor');
  const editor = window.__mount({ element, initialText: '# Private draft\nInitial text.', onChange: text => changes.push(text) });
  return { dom, window, element, editor, changes, faults, boundaryCalls, close() { editor.destroy(); dom.window.close(); } };
}

for (const kind of ['textarea', 'easymde']) {
  test(kind + ': actual editor mounts, roundtrips literal text and disposes without persistence/network', async () => {
    const h = await host(kind);
    try {
      assert.equal(h.editor.getText(), '# Private draft\nInitial text.');
      const literal = '# Ærlig utkast\n\n<script>alert(1)</script>\n![pixel](https://invalid.example/private-marker)\nA & B 🔒';
      h.editor.setText(literal);
      assert.equal(h.editor.getText(), literal);
      assert.equal(h.changes.at(-1), literal);
      assert.equal(h.element.querySelectorAll('script,img,iframe').length, 0);
      assert.equal(h.window.location.href, 'https://app.example/apps/' + kind);
      assert.equal(h.window.document.querySelectorAll('link[href^="http"]').length, 0);
      await pause();
      assert.deepEqual(h.boundaryCalls, []);
      assert.deepEqual(h.faults, []);
      h.editor.destroy();
      assert.equal(h.element.textContent, '');
      assert.throws(() => h.editor.getText(), /EDITOR_DESTROYED/);
      assert.throws(() => h.editor.setText('later'), /EDITOR_DESTROYED/);
    } finally { h.close(); }
  });
}

test('Textarea runs upstream Markdown highlighter and normalizes contenteditable editing', async () => {
  const h = await host('textarea');
  try {
    assert.equal(h.element.querySelector('.md-h1').textContent, '# Private draft');
    const article = h.element.querySelector('article');
    article.innerHTML = '<div>First</div><div>Second</div><div><br></div>';
    h.window.document.getSelection().selectAllChildren(article);
    h.window.document.getSelection().collapseToEnd();
    article.dispatchEvent(new h.window.InputEvent('input', { bubbles: true }));
    await pause();
    assert.equal(h.editor.getText(), 'First\nSecond\n');
    assert.equal(h.changes.at(-1), 'First\nSecond\n');
    assert.deepEqual(h.faults, []);
  } finally { h.close(); }
});

test('EasyMDE runs CodeMirror editing, Markdown toolbar, undo and redo', async () => {
  const h = await host('easymde');
  try {
    const cm = h.element.querySelector('.CodeMirror').CodeMirror;
    assert.equal(cm.constructor.version, '5.65.15');
    cm.setValue('A calmer checkout');
    cm.setSelection({ line: 0, ch: 2 }, { line: 0, ch: 8 });
    h.element.querySelector('[aria-label="Bold"]').click();
    assert.equal(h.editor.getText(), 'A **calmer** checkout');
    assert.equal(h.changes.at(-1), 'A **calmer** checkout');
    h.element.querySelector('[aria-label="Undo"]').click();
    assert.equal(h.editor.getText(), 'A calmer checkout');
    h.element.querySelector('[aria-label="Redo"]').click();
    assert.equal(h.editor.getText(), 'A **calmer** checkout');
    assert.equal(cm.getOption('extraKeys')['Cmd-P'], undefined);
    assert.equal(cm.getOption('extraKeys').F9, undefined);
    assert.deepEqual(h.boundaryCalls, []);
    assert.deepEqual(h.faults, []);
  } finally { h.close(); }
});
