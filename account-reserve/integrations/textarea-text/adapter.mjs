import { validateText } from '@continuitykit/account-reserve/text-reserve';

// Textarea owns a single document. Its exact text is the complete snapshot:
// no invented project/client metadata and no account identity or key.
export function captureText(documentText) { return validateText(documentText); }
export function restoreText(text, editor) {
  const checked = validateText(text);
  editor.set(checked); // The actual upstream Editor.set, including highlighting.
  return checked;
}
export function exportText(documentText, format = 'txt') {
  const text = captureText(documentText);
  if (format === 'txt') return text;
  if (format === 'json') return JSON.stringify({ text }, null, 2) + '\n';
  throw new Error('EXPORT_FORMAT_INVALID');
}
