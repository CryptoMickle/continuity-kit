import EasyMDE from './easymde-runtime.mjs';

// EasyMDE is an independently authored Markdown editor component. This app
// adapter is by ContinuityKit; upstream has not adopted or endorsed it.
export function mountEditor({ element, initialText = '', onChange = () => {} }) {
  if (!element?.ownerDocument || typeof initialText !== 'string' || typeof onChange !== 'function') throw new TypeError('EDITOR_INPUT_INVALID');
  const document = element.ownerDocument;
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', 'Markdown document');
  textarea.value = initialText;
  const toolbar = document.createElement('div');
  toolbar.className = 'ck-markdown-toolbar';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', 'Markdown formatting');
  element.replaceChildren(toolbar, textarea);
  let disposed = false;
  const editor = new EasyMDE({
    element: textarea,
    autoDownloadFontAwesome: false,
    autosave: { enabled: false },
    spellChecker: false,
    nativeSpellcheck: false,
    uploadImage: false,
    toolbar: false,
    status: false,
    autofocus: false,
    autoRefresh: false,
    forceSync: true,
    inputStyle: 'textarea',
    lineWrapping: true,
    minHeight: '300px',
    maxHeight: '380px',
    shortcuts: { togglePreview: null, toggleSideBySide: null, toggleFullScreen: null, drawImage: null, drawLink: null },
    // Defence in depth: even a future explicit preview request renders literal
    // text only, so HTML and Markdown images cannot create active content.
    previewRender(text) { const pre = document.createElement('pre'); pre.textContent = text; return pre.outerHTML; },
  });
  editor.codemirror.getInputField().setAttribute('aria-label', 'Markdown document');
  const changed = () => { if (!disposed) onChange(editor.value()); };
  editor.codemirror.on('change', changed);
  const buttons = [
    ['Bold', 'B', () => EasyMDE.toggleBold(editor)],
    ['Italic', 'I', () => EasyMDE.toggleItalic(editor)],
    ['Heading', 'H', () => EasyMDE.toggleHeadingSmaller(editor)],
    ['Bullet list', 'List', () => EasyMDE.toggleUnorderedList(editor)],
    ['Undo', 'Undo', () => EasyMDE.undo(editor)],
    ['Redo', 'Redo', () => EasyMDE.redo(editor)],
  ];
  for (const [label, text, action] of buttons) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text;
    button.setAttribute('aria-label', label); button.title = label;
    button.addEventListener('click', () => { if (!disposed) { action(); editor.codemirror.focus(); } });
    toolbar.append(button);
  }
  return Object.freeze({
    getText() { if (disposed) throw new Error('EDITOR_DESTROYED'); return editor.value(); },
    setText(text) { if (disposed) throw new Error('EDITOR_DESTROYED'); if (typeof text !== 'string') throw new TypeError('TEXT_INVALID'); editor.value(text); },
    destroy() {
      if (disposed) return;
      disposed = true;
      editor.codemirror.off('change', changed);
      editor.toTextArea();
      textarea.value = '';
      element.replaceChildren();
    },
  });
}
