import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ maxRecords: 64, maxRecordBytes: 65536, maxIssuedCapabilities: 256, capabilityTtlMs: 300000 });
export const TRANSFER_FORMAT = 'continuitykit/operator-ciphertext/v1';
export const TEXT_FORMAT = 'account-continuity/text-reserve-v1/index';
export const fail = code => Object.assign(new Error(code), { code });
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
export const canonical = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value; }
export function origin(value) {
  let url; try { url = new URL(value); } catch { throw fail('PROFILE_INVALID'); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
  if (value !== url.origin || !((url.protocol === 'https:') || (url.protocol === 'http:' && local))) throw fail('PROFILE_INVALID');
  return value;
}
export function profile(input) {
  if (!exact(input, ['version', 'primaryOrigin', 'recoveryOrigin', 'expiresAt', 'apps']) || input.version !== 1) throw fail('PROFILE_INVALID');
  const primaryOrigin = origin(input.primaryOrigin), recoveryOrigin = origin(input.recoveryOrigin);
  if (primaryOrigin === recoveryOrigin || typeof input.expiresAt !== 'string' || !Number.isSafeInteger(Date.parse(input.expiresAt))
    || new Date(input.expiresAt).toISOString() !== input.expiresAt || !Array.isArray(input.apps) || input.apps.length < 1 || input.apps.length > 8) throw fail('PROFILE_INVALID');
  const ids = new Set(), appIds = new Set();
  const apps = input.apps.map(app => {
    if (!exact(app, ['id', 'label', 'appId']) || !/^[a-z][a-z0-9-]{0,31}$/.test(app.id ?? '')
      || typeof app.label !== 'string' || !app.label.trim() || app.label.length > 64 || /[\x00-\x1f\x7f]/.test(app.label)
      || typeof app.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(app.appId)
      || ids.has(app.id) || appIds.has(app.appId)) throw fail('PROFILE_INVALID');
    ids.add(app.id); appIds.add(app.appId); return Object.freeze({ id: app.id, label: app.label, appId: app.appId });
  });
  return Object.freeze({ version: 1, primaryOrigin, recoveryOrigin, expiresAt: input.expiresAt, apps: Object.freeze(apps) });
}
export function textConfig(value, app) { return Object.freeze({ appId: app.appId, recoveryOrigin: value.recoveryOrigin, recoveryRpId: new URL(value.recoveryOrigin).hostname }); }
export function decode(value, maximum = LIMITS.maxRecordBytes) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail('RECORD_INVALID');
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64url') !== value) throw fail('RECORD_INVALID');
  return bytes;
}
export function locator(value) { try { return typeof value === 'string' && value.length === 43 && decode(value, 32).length === 32; } catch { return false; } }
export function ciphertext(value) {
  if (!(value instanceof Uint8Array) || value.length < 1 || value.length > LIMITS.maxRecordBytes) throw fail('RECORD_INVALID');
  let text, record;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(value); record = JSON.parse(text); } catch { throw fail('RECORD_INVALID'); }
  if (!exact(record, ['format', 'nonce', 'ciphertext']) || record.format !== TEXT_FORMAT || canonical(record) !== text
    || decode(record.nonce, 12).length !== 12 || decode(record.ciphertext).length < 16) throw fail('RECORD_INVALID');
  return Buffer.from(value);
}
