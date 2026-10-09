// Preserve the document's plain-text line breaks across contenteditable browsers.
// Rich paste is not part of Textarea's document model. Keep literal clipboard text
// and upstream undo/highlight; normalize only structural BR/DIV/P editing markup.
export function installPlainTextEditing(article, editor) {
  const document = article.ownerDocument, view = document.defaultView;
  const block = node => node?.nodeType === 1 && /^(DIV|P)$/.test(node.tagName);
  const inside = node => node && (node === article || article.contains(node));
  function caretPlaceholder(node) {
    // A BR ending an inline span is still a real line break when text follows
    // outside that span. Only the end of its entire effective block can be a
    // contenteditable caret placeholder (including nested empty span/b wrappers).
    for (let cursor = node; cursor !== article && !block(cursor); cursor = cursor.parentNode) {
      if (cursor.nextSibling) return false;
    }
    return true;
  }

  function readDom() {
    let text = '';
    const positions = new Map();
    function walk(node) {
      if (node.nodeType === 3) {
        positions.set(node, { start: text.length, length: node.nodeValue.length });
        text += node.nodeValue; return;
      }
      const offsets = [];
      positions.set(node, { offsets });
      const children = [...node.childNodes];
      for (let i = 0; i < children.length; i++) {
        const child = children[i], previous = children[i - 1];
        // Block wrappers add a line boundary, independently of visual heading
        // styles. Empty blocks still represent empty lines between paragraphs.
        if (i > 0 && (block(child) || block(previous))) {
          const existingBreak = !block(previous) && text.endsWith('\n');
          if (!existingBreak) text += '\n';
        }
        offsets[i] = text.length;
        if (child.nodeType === 1 && child.tagName === 'BR') {
          positions.set(child, { offsets: [text.length] });
          // A final BR at block level is the caret placeholder. An intentional
          // final empty line is represented by two BRs or an empty final block.
          if (!caretPlaceholder(child)) text += '\n';
        } else walk(child);
      }
      offsets[children.length] = text.length;
    }
    walk(article);
    const offset = (node, index) => {
      const value = positions.get(node);
      return value?.offsets ? value.offsets[Math.min(index, value.offsets.length - 1)] :
        value ? value.start + Math.min(index, value.length) : undefined;
    };
    return { text, offset };
  }
  function normalize() {
    if (!article.querySelector('br, div, p')) return false;
    const selection = document.getSelection();
    const saved = readDom();
    const retain = inside(selection?.anchorNode) && inside(selection?.focusNode);
    const anchor = retain ? saved.offset(selection.anchorNode, selection.anchorOffset) : undefined;
    const focus = retain ? saved.offset(selection.focusNode, selection.focusOffset) : undefined;
    article.textContent = saved.text;
    if (retain) {
      const node = article.firstChild ?? article.appendChild(document.createTextNode(''));
      selection.setBaseAndExtent(node, anchor ?? 0, node, focus ?? 0);
    }
    return true;
  }
  function readDocument() { normalize(); return article.textContent; }
  // Capture phase runs before the upstream key handlers/save-position/highlight.
  for (const type of ['keydown', 'keyup', 'input']) article.addEventListener(type, event => {
    if (!event.isComposing && normalize() && type === 'input') editor.refresh();
    if (type === 'keydown' && !event.defaultPrevented && !event.isComposing &&
        (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
        event.key.toLowerCase() === 'a') {
      // Some contenteditable selections omit the last newline. The explicit
      // select-all command must cover every node; do not infer intent from a
      // partial selection or trim legitimate clipboard/document whitespace.
      event.preventDefault();
      document.getSelection().selectAllChildren(article);
    }
  }, true);
  article.addEventListener('paste', event => {
    const clipboard = event.clipboardData;
    if (!clipboard || !Array.from(clipboard.types).includes('text/plain')) return;
    event.preventDefault();
    normalize();
    const selection = document.getSelection();
    if (!inside(selection?.anchorNode) || !inside(selection?.focusNode)) {
      selection.selectAllChildren(article); selection.collapseToEnd();
    }
    editor.remember();
    const text = clipboard.getData('text/plain');
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const inserted = document.createTextNode(text);
    range.insertNode(inserted);
    selection.setBaseAndExtent(inserted, text.length, inserted, text.length);
    article.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    editor.remember();
    editor.refresh();
  }, true);
  return { readDocument, normalize };
}
