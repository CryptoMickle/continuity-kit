import { installPlainTextEditing } from './plain-text-editing.mjs';

// The build places verified upstream Editor, parseMarkdown and debounce
// functions inside this wrapper. Persistence, URL sharing and SW are omitted.
export function mountEditor({ element, initialText = '', onChange = () => {} }) {
  if (!element?.ownerDocument || typeof initialText !== 'string' || typeof onChange !== 'function') throw new TypeError('EDITOR_INPUT_INVALID');
  const document = element.ownerDocument, view = document.defaultView, Node = view.Node;
  const article = document.createElement('article');
  article.className = 'ck-textarea-document';
  article.setAttribute('contenteditable', 'plaintext-only');
  article.setAttribute('role', 'textbox');
  article.setAttribute('aria-label', 'Textarea document');
  article.setAttribute('aria-multiline', 'true');
  article.spellcheck = false;
  element.replaceChildren(article);
  let disposed = false;
  const timers = new Set();
  const setTimeout = (fn, delay) => { const id = view.setTimeout(() => { timers.delete(id); if (!disposed) fn(); }, delay); timers.add(id); return id; };
  const clearTimeout = id => { timers.delete(id); view.clearTimeout(id); };
  /* VERIFIED_UPSTREAM_FUNCTIONS */
  const editor = new Editor(article, parseMarkdown);
  const { readDocument } = installPlainTextEditing(article, editor);
  let lastEmitted = initialText;
  const changed = () => {
    if (disposed) return;
    const text = readDocument();
    if (text !== lastEmitted) { lastEmitted = text; onChange(text); }
  };
  // Upstream undo changes DOM directly rather than dispatching input. These
  // listeners run after upstream's editing handlers and cover that path too.
  for (const type of ['input', 'keydown', 'keyup', 'beforeinput']) article.addEventListener(type, changed);
  // Keep links literal and inert while composing; no navigation or plaintext URL.
  const preventNavigation = event => { if (event.target.closest?.('a')) event.preventDefault(); };
  article.addEventListener('click', preventNavigation);
  editor.set(initialText);
  return Object.freeze({
    getText() { if (disposed) throw new Error('EDITOR_DESTROYED'); return readDocument(); },
    setText(text) { if (disposed) throw new Error('EDITOR_DESTROYED'); if (typeof text !== 'string') throw new TypeError('TEXT_INVALID'); editor.set(text); changed(); },
    destroy() {
      if (disposed) return;
      disposed = true;
      for (const timer of timers) view.clearTimeout(timer);
      timers.clear();
      for (const type of ['input', 'keydown', 'keyup', 'beforeinput']) article.removeEventListener(type, changed);
      article.removeEventListener('click', preventNavigation);
      editor.destroy();
      article.textContent = '';
      article.remove();
    },
  });
}
