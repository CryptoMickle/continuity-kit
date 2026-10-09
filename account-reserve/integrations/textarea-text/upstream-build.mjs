import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('./', import.meta.url);
export async function upstreamSource() {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [file, expected] of Object.entries(provenance.files)) {
    const bytes = await readFile(new URL('upstream/' + file, root));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('UPSTREAM_DIGEST_CHANGED: ' + file);
  }
  return readFile(new URL('upstream/index.html', root), 'utf8');
}
function once(text, original, replacement) {
  if (text.split(original).length !== 2) throw new Error('UPSTREAM_PATCH_MISMATCH');
  return text.replace(original, replacement);
}
export function integrationScript(html) {
  const match = /^([\s\S]*?)<script>([\s\S]*?)<\/script>([\s\S]*)$/.exec(html);
  if (!match || match[3].includes('<script')) throw new Error('UPSTREAM_SCRIPT_SHAPE_CHANGED');
  let script = match[2];
  // Leave the highlighter unchanged. URL persistence is deliberately
  // disabled: a compressed fragment is still plaintext-equivalent content.
  for (const line of [
    "  article.addEventListener('input', debounce(500, save))\n",
    "  article.addEventListener('blur', save)\n",
    "  addEventListener('DOMContentLoaded', load)\n",
    "  addEventListener('hashchange', load)\n",
    "  addEventListener('load', () => new MutationObserver(save).observe(article, {attributeFilter: ['style']}))\n",
  ]) script = once(script, line, '');
  script = once(script, "  if ('serviceWorker' in navigator) {\n    navigator.serviceWorker.register('sw.js')\n  }", '  // Local integration: no service worker or cached recovery state.');
  // Expose existing closures to the plain-paste bridge, preserving upstream
  // undo snapshots and selection-aware highlight instead of inventing a stack.
  script = once(script, '    return {\n      set(content) {', '    return {\n      remember: recordHistory,\n      refresh: debounceHighlight,\n      set(content) {');
  return "import { installPlainTextEditing } from '/plain-text-editing.mjs';\n" + script + `\n// Explicit integration bridge; the vendored original is unchanged.\nconst { readDocument } = installPlainTextEditing(article, editor);\narticle.addEventListener('input', updateTitle);\ndocument.querySelector('#share-link').style.display = 'none';\ndocument.querySelector('a[href="#new"]').style.display = 'none';\nexport { editor, article, readDocument };\n`;
}
export function integrationHtml(html, controls) {
  let page = once(html, '<link rel="manifest" href="manifest.json">', '<!-- No upstream service worker or manifest in the local integration. -->');
  page = once(page, '<button id="button" class="noprint">', '<button id="button" class="noprint" aria-label="Textarea menu" aria-haspopup="menu">');
  page = page.replace(/<script>[\s\S]*?<\/script>/, '<script type="module" src="/main.mjs"></script>');
  return once(page, '<article contenteditable="plaintext-only" spellcheck autofocus></article>', controls + '\n<article contenteditable="plaintext-only" spellcheck autofocus aria-label="Textarea document"></article>');
}
