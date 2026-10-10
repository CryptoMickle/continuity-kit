import { validateText } from '@continuitykit/account-reserve/text-reserve';

// Replace this adapter with your editor's two methods. The SDK only needs text.
export function captureText(editor) { return validateText(editor.getText()); }
export function restoreText(text, editor) { editor.applyText(validateText(text)); }
export function exportText(editor, format = 'txt') {
  const text = captureText(editor);
  if (format === 'txt') return text;
  if (format === 'json') return JSON.stringify({ format: 'continuity-text-export/v1', text }, null, 2) + '\n';
  throw new Error('EXPORT_FORMAT_INVALID');
}
export function textareaAdapter(element) {
  let raw = '', initialView = '';
  return Object.freeze({
    // Textarea normalizes CRLF on assignment. Preserve exact recovered bytes
    // while merely viewing them; actual editing follows browser text behavior.
    getText() { return element.value === initialView ? raw : element.value; },
    applyText(text) { raw = validateText(text); element.value = raw; initialView = element.value; },
    clear() { raw = ''; initialView = ''; element.value = ''; },
  });
}
