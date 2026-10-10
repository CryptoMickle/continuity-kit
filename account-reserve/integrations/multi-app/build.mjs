import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('./', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
function once(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('UPSTREAM_PATCH_MISMATCH');
  return text.replace(from, to);
}
export async function verifyEditorSources() {
  const provenance = JSON.parse(await read('provenance.json'));
  for (const [path, hash] of Object.entries(provenance.files)) {
    const bytes = await readFile(new URL(path, root));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('UPSTREAM_DIGEST_CHANGED: ' + path);
  }
  return provenance;
}
export async function buildEditorAssets({ outDir }) {
  const provenance = await verifyEditorSources();
  const destination = resolve(outDir);
  if (destination === fileURLToPath(root).replace(/\/$/, '')) throw new Error('OUTPUT_MUST_BE_SEPARATE');
  await mkdir(destination, { recursive: true });
  const html = await read('vendor/textarea/index.html');
  const debounce = html.slice(html.indexOf('  function debounce('), html.indexOf('  async function downloadHTML('));
  const highlighter = html.slice(html.indexOf('  function parseMarkdown('), html.indexOf('  function initUI('));
  let editor = html.slice(html.indexOf('  function Editor('), html.indexOf('</script>', html.indexOf('  function Editor(')));
  if (!debounce.startsWith('  function debounce(') || !highlighter.startsWith('  function parseMarkdown(') || !editor.startsWith('  function Editor(')) throw new Error('UPSTREAM_SHAPE_CHANGED');
  // Two explicit compatibility patches: expose existing undo/highlight closures
  // for the plain-paste bridge; fix upstream destroy()'s wrong receiver variable.
  editor = once(editor, '    return {\n      set(content) {', '    return {\n      remember: recordHistory,\n      refresh: debounceHighlight,\n      set(content) {');
  editor = once(editor, 'for (const [type, fn] of listeners) editor.removeEventListener(type, fn)', 'for (const [type, fn] of listeners) element.removeEventListener(type, fn)');
  const textarea = once(await read('src/textarea-shell.mjs'), '  /* VERIFIED_UPSTREAM_FUNCTIONS */', debounce + highlighter + editor);
  const upstreamRuntime = await read('vendor/easymde/dist/easymde.min.js');
  const runtime = '// EasyMDE 2.20.0 official bundle. Licenses: ./THIRD_PARTY_NOTICES.txt\nconst module = {exports:{}}; const exports = module.exports;\n' + upstreamRuntime + '\nexport default module.exports;\n';
  const outputs = {
    'textarea-editor.mjs': textarea,
    'plain-text-editing.mjs': await read('src/plain-text-editing.mjs'),
    'easymde-editor.mjs': await read('src/easymde-editor.mjs'),
    'easymde-runtime.mjs': runtime,
    'editors.css': await read('vendor/easymde/dist/easymde.min.css') + '\n' + await read('src/editors.css'),
    'THIRD_PARTY_NOTICES.txt': await read('THIRD_PARTY_NOTICES.txt'),
    'editor-provenance.json': JSON.stringify(provenance, null, 2) + '\n',
  };
  for (const [name, source] of Object.entries(outputs)) await writeFile(resolve(destination, name), source);
  return { outDir: destination, files: Object.keys(outputs), bytes: Object.fromEntries(Object.entries(outputs).map(([name,source]) => [name, Buffer.byteLength(source)])) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await buildEditorAssets({ outDir: process.argv[2] ?? fileURLToPath(new URL('dist/', root)) }), null, 2));
}
