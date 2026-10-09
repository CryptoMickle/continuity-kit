import { JSDOM } from 'jsdom';
import { upstreamSource, integrationScript, integrationHtml } from './upstream-build.mjs';
import { installPlainTextEditing } from './plain-text-editing.mjs';

// Test-only DOM implementation, not a physical browser/passkey claim.
// JSDOM does not load resources; only the locally inspected pinned script runs.
export async function createEditorTestHost(origin) {
  const html = await upstreamSource();
  let historyWrites = 0, serviceWorkerRequests = 0;
  const dom = new JSDOM(integrationHtml(html, ''), {
    url: origin, runScripts: 'outside-only', pretendToBeVisual: true,
    beforeParse(window) {
      window.console.log = () => {};
      window.history.replaceState = () => { historyWrites++; throw new Error('PLAINTEXT_URL_WRITE'); };
      Object.defineProperty(window.navigator, 'serviceWorker', { value: { register() { serviceWorkerRequests++; throw new Error('SERVICE_WORKER_UNEXPECTED'); } } });
    },
  });
  dom.window.__installPlainTextEditing = installPlainTextEditing;
  const script = integrationScript(html)
    .replace("import { installPlainTextEditing } from '/plain-text-editing.mjs';", 'const installPlainTextEditing = globalThis.__installPlainTextEditing;')
    .replace('export { editor, article, readDocument };', 'globalThis.__textareaBridge = { editor, article, readDocument };');
  dom.window.eval(script);
  const { editor, article, readDocument } = dom.window.__textareaBridge;
  const pause = () => new Promise(resolve => setTimeout(resolve, 60));
  return {
    editor, article, readDocument,
    async edit(text) {
      // JSDOM does not implement native typing. Update the actual contenteditable
      // DOM, then dispatch upstream's editing/highlighting path explicitly.
      editor.set(article.textContent);
      dom.window.getSelection().selectAllChildren(article);
      dom.window.getSelection().collapseToEnd();
      article.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }));
      article.textContent = text;
      dom.window.getSelection().selectAllChildren(article);
      dom.window.getSelection().collapseToEnd();
      article.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      article.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'x', code: 'KeyX', bubbles: true }));
      await pause();
    },
    async editHtml(html) {
      // Regression fixture for browser-generated contenteditable structure.
      article.innerHTML = html;
      dom.window.getSelection().selectAllChildren(article);
      dom.window.getSelection().collapseToEnd();
      article.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      await pause();
    },
    selectPrefix(length) {
      const walker = dom.window.document.createTreeWalker(article, dom.window.NodeFilter.SHOW_TEXT);
      let node, remaining = length;
      while ((node = walker.nextNode())) {
        if (remaining <= node.nodeValue.length) {
          dom.window.getSelection().setBaseAndExtent(article, 0, node, remaining); return;
        }
        remaining -= node.nodeValue.length;
      }
      throw new Error('SELECTION_OUTSIDE_DOCUMENT');
    },
    selectAll() {
      const event = new dom.window.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true });
      article.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error('EXPLICIT_SELECT_ALL_NOT_HANDLED');
      return dom.window.getSelection().toString();
    },
    async paste(text, { replace = false, keepSelection = false } = {}) {
      const selection = dom.window.getSelection();
      if (!keepSelection) {
        selection.selectAllChildren(article);
        if (!replace) selection.collapseToEnd();
      }
      const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { types: ['text/plain'], getData: type => type === 'text/plain' ? text : '' } });
      article.dispatchEvent(event);
      await pause();
      return event.defaultPrevented;
    },
    undo() {
      article.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
    },
    get historyWrites() { return historyWrites; },
    get serviceWorkerRequests() { return serviceWorkerRequests; },
    close() { dom.window.close(); },
  };
}
