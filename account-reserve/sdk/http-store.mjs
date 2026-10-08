// Browser-only same-origin ciphertext transport. No imports from the reference app.
const MAX_RECORD_BYTES = 65536;
const MAX_JSON_BYTES = Math.ceil(MAX_RECORD_BYTES * 4 / 3) + 64;
const fail = code => Object.assign(new Error(code), { code });

function base64url(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode64(value, maximum = MAX_RECORD_BYTES) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail('RECORD_INVALID');
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0)); }
  catch { throw fail('RECORD_INVALID'); }
  if (!bytes.length || bytes.length > maximum || base64url(bytes) !== value) throw fail('RECORD_INVALID');
  return bytes;
}
function locatorValid(value) {
  try { return typeof value === 'string' && value.length === 43 && decode64(value, 32).length === 32; }
  catch { return false; }
}
function validateBasePath(value) {
  // Root-relative only: no absolute URLs, URL escapes, dot segments or base-tag
  // surprises. mode:same-origin additionally binds the native fetch request.
  if (typeof value !== 'string' || value.length > 256 || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value)) throw fail('STORE_CONFIG_INVALID');
  return value;
}

async function responseText(response, signal, limit) {
  const length = response.headers?.get?.('content-length');
  if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) throw fail('STORE_RESPONSE_INVALID');
  if (!response.body || typeof response.body.getReader !== 'function') throw fail('STORE_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw fail('STORE_RESPONSE_INVALID');
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw fail('STORE_RESPONSE_INVALID');
      if (done) break;
      if (!(value instanceof Uint8Array) || (size += value.length) > limit) throw fail('STORE_RESPONSE_INVALID');
      chunks.push(new Uint8Array(value));
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
function discard(response) { try { void response.body?.cancel().catch(() => {}); } catch { /* Best-effort body disposal. */ } }

/**
 * Supply an enrollmentToken only after an explicit enrollment action. It is
 * consumed before the first PUT and is never sent in a GET. A timeout or lost
 * response is STORE_WRITE_UNKNOWN: reconcile by reading, never retry enrollment.
 * Fetch injection is a trusted integration/testing boundary, not a sandbox.
 */
export function createReserveHttpStore({ enrollmentToken, basePath = '/api/reserve', fetcher = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const path = validateBasePath(basePath);
  if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('STORE_CONFIG_INVALID');
  let token = enrollmentToken;
  let attempted = false;
  if (token !== undefined && !locatorValid(token)) throw fail('ENROLLMENT_DENIED');

  async function request(locator, init, writing, read) {
    const controller = new AbortController();
    const errorCode = writing ? 'STORE_WRITE_UNKNOWN' : 'STORE_UNAVAILABLE';
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          const response = await fetcher(`${path}/${locator}`, { ...init, mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
          if (!response || response.redirected || !Number.isInteger(response.status)) throw fail(errorCode);
          return read(response, controller.signal);
        }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail(errorCode)); }, timeoutMs); }),
      ]);
    } catch (error) {
      if (!writing && error?.code === 'STORE_EXPIRED') throw error;
      throw fail(errorCode);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return Object.freeze({
    async get(locator) {
      if (!locatorValid(locator)) throw fail('LOCATOR_INVALID');
      return request(locator, { method: 'GET' }, false, async (response, signal) => {
        if (response.status === 404) { discard(response); return undefined; }
        if (response.status === 410) { discard(response); throw fail('STORE_EXPIRED'); }
        if (response.status !== 200) { discard(response); throw fail('STORE_UNAVAILABLE'); }
        const text = await responseText(response, signal, MAX_JSON_BYTES);
        // One exact field; duplicate properties and escaped/noncanonical base64
        // spellings are rejected before any bytes reach the reserve protocol.
        const match = /^[ \t\r\n]*\{[ \t\r\n]*"bytes"[ \t\r\n]*:[ \t\r\n]*"([A-Za-z0-9_-]+)"[ \t\r\n]*\}[ \t\r\n]*$/.exec(text);
        if (!match) throw fail('STORE_RESPONSE_INVALID');
        return decode64(match[1]);
      });
    },
    async putIfAbsent(locator, bytes) {
      if (!locatorValid(locator) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_RECORD_BYTES) throw fail('RECORD_INVALID');
      if (attempted || !token) throw fail('ENROLLMENT_DENIED');
      // Snapshot mutable input and consume capability before entering async I/O.
      const body = JSON.stringify({ bytes: base64url(new Uint8Array(bytes)) });
      const capability = token;
      attempted = true; token = undefined;
      return request(locator, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${capability}` }, body }, true, async (response, signal) => {
        if (response.status === 409) { discard(response); return false; }
        if (response.status !== 201) { discard(response); throw fail('STORE_WRITE_UNKNOWN'); }
        if (!/^[ \t\r\n]*\{[ \t\r\n]*"created"[ \t\r\n]*:[ \t\r\n]*true[ \t\r\n]*\}[ \t\r\n]*$/.test(await responseText(response, signal, 128))) throw fail('STORE_WRITE_UNKNOWN');
        return true;
      });
    },
    clearEnrollmentCapability() { token = undefined; attempted = true; },
  });
}
