export const MAX_RECORD_BYTES = 65536;
export const MAX_RECORDS = 16;
export const SCHEMA = 'account-reserve-ciphertext/v1';
export const fail = code => Object.assign(new Error(code), { code });
export const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

// Origins are configured by the operator, never selected by a request or record.
export function httpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 300) throw fail('RELEASE_CONFIG_INVALID');
  let url;
  try { url = new URL(value); } catch { throw fail('RELEASE_CONFIG_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.port || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(url.hostname) || url.hostname.endsWith('.localhost')) throw fail('RELEASE_CONFIG_INVALID');
  return value;
}

export function releaseProfile(profile, allowedOrigins = []) {
  if (profile == null || profile.enabled === false) return undefined;
  if (!exact(profile, ['version', 'enabled', 'releaseId', 'recoveryOrigin', 'expiresAt']) || profile.version !== 1 || profile.enabled !== true || typeof profile.releaseId !== 'string' || !/^[a-f0-9]{32}$/.test(profile.releaseId)) throw fail('RELEASE_CONFIG_INVALID');
  const origin = httpsOrigin(profile.recoveryOrigin);
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length !== 1 || httpsOrigin(allowedOrigins[0]) !== origin) throw fail('RELEASE_CONFIG_INVALID');
  const expires = Date.parse(profile.expiresAt);
  if (typeof profile.expiresAt !== 'string' || !Number.isSafeInteger(expires) || expires <= 0 || expires > Date.now() + 45 * 86400000 || new Date(expires).toISOString() !== profile.expiresAt) throw fail('RELEASE_CONFIG_INVALID');
  return Object.freeze({ ...profile, expires, namespace: `accountreserve:v1:${profile.releaseId}` });
}

export function base64url(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decode64(value, max = MAX_RECORD_BYTES) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail('RECORD_INVALID');
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); } catch { throw fail('RECORD_INVALID'); }
  if (!bytes.length || bytes.length > max || base64url(bytes) !== value) throw fail('RECORD_INVALID');
  return bytes;
}
export function validLocator(value) {
  try { return typeof value === 'string' && value.length === 43 && decode64(value, 32).length === 32; } catch { return false; }
}
export async function enrollmentTicketHash(token) {
  if (!validLocator(token)) throw fail('ENROLLMENT_DENIED');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
