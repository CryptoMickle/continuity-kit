import { validateWork, WORK_SCHEMA } from '@continuitykit/account-reserve/work-reserve';

// Textarea owns exactly one plain-text document. The four other fields belong
// to this adapter's envelope, not an invented upstream account/project model.
export const ENVELOPE_FIELDS = Object.freeze(['title', 'client', 'brief', 'nextStep']);
export function captureWork(documentText, envelope) {
  if (typeof documentText !== 'string' || !envelope ||
      Object.keys(envelope).sort().join(',') !== [...ENVELOPE_FIELDS].sort().join(',')) {
    throw new Error('EDITOR_ENVELOPE_INVALID');
  }
  return validateWork({ schema: WORK_SCHEMA, ...envelope, deliverable: documentText });
}
export function restoreWork(work, editor, writeEnvelope) {
  const checked = validateWork(work);
  editor.set(checked.deliverable); // Real upstream Editor.set, including highlighting.
  writeEnvelope(Object.fromEntries(ENVELOPE_FIELDS.map(field => [field, checked[field]])));
  return checked;
}
export function exportWork(documentText, envelope) {
  return JSON.stringify(captureWork(documentText, envelope), null, 2) + '\n';
}
