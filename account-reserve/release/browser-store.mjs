import { base64url, decode64, validLocator, fail, MAX_RECORD_BYTES } from './profile.mjs';

// Pass the enrollment token from an explicit operator/user setup action only.
// It is never included in ciphertext or required by subsequent recovery GETs.
export function createReserveHttpStore({ enrollmentToken, fetcher = fetch } = {}) {
  let token = enrollmentToken;
  let attempted = false;
  if (token !== undefined && !validLocator(token)) throw fail('ENROLLMENT_DENIED');
  return Object.freeze({
    async get(locator) {
      if (!validLocator(locator)) throw fail('LOCATOR_INVALID');
      const response = await fetcher(`/api/reserve/${locator}`, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (response.status === 404) return undefined;
      if (response.status !== 200) throw fail('STORE_UNAVAILABLE');
      const json = await response.json();
      if (!json || Object.keys(json).join(',') !== 'bytes') throw fail('STORE_UNAVAILABLE');
      return decode64(json.bytes);
    },
    async putIfAbsent(locator, bytes) {
      if (!validLocator(locator) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_RECORD_BYTES) throw fail('RECORD_INVALID');
      if (attempted || !token) throw fail('ENROLLMENT_DENIED');
      attempted = true;
      const capability = token; token = undefined;
      let response;
      try {
        response = await fetcher(`/api/reserve/${locator}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${capability}` }, body: JSON.stringify({ bytes: base64url(bytes) }), credentials: 'omit', cache: 'no-store', redirect: 'error' });
      } catch { throw fail('STORE_WRITE_UNKNOWN'); }
      if (response.status === 409) return false;
      if (response.status !== 201 || (await response.json()).created !== true) throw fail('STORE_WRITE_UNKNOWN');
      return true;
    },
    clearEnrollmentCapability() { token = undefined; attempted = true; },
  });
}
