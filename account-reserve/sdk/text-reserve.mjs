import { createPasskeyWithPrfOutput, getPasskeyPrfOutput } from '@category-labs/mera';
import { createWebAuthnScope } from './webauthn-scope.mjs';

export const TEXT_PROTOCOL = 'account-continuity/text-reserve-v1';
export const MAX_TEXT_BYTES = 16384;
const INDEX_FORMAT = `${TEXT_PROTOCOL}/index`;
const MANIFEST_FORMAT = `${TEXT_PROTOCOL}/manifest`;
const TEXT_FORMAT = `${TEXT_PROTOCOL}/text`;
const MAX_RECORD_BYTES = 65536;
const MAX_TIMEOUT_MS = 300000;
const IO_TIMEOUT_MS = 10000;
const CONFIG_FIELDS = ['appId', 'recoveryOrigin', 'recoveryRpId'];
const encoder = new TextEncoder();
// Preserve an initial U+FEFF as text rather than consuming it as a transport BOM.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const createdCredentials = new WeakMap();
const reservations = new Set();
// SHA-256(UTF-8(TEXT_PROTOCOL + '/prf')). A fixed synchronous bootstrap lets
// native WebAuthn start in the caller's click stack. HKDF below binds the full
// configuration and selected credential, separately for every derived key.
const PRF_SALT_HEX = '20b9d60bc82e9d394a6e32b02bfb225927685add7cc924188fb8b7117e034d12';

export class TextReserveError extends Error {
  constructor(code) { super(code); this.name = 'TextReserveError'; this.code = code; }
}
function check(value, code) { if (!value) throw new TextReserveError(code); }
function active(signal) { check(!signal?.aborted, 'OPERATION_CANCELLED'); }
function exact(value, keys, code) {
  check(value && typeof value === 'object' && !Array.isArray(value), code);
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, code);
  check(Object.getOwnPropertySymbols(value).length === 0, code);
  check(Object.getOwnPropertyNames(value).sort().join(',') === [...keys].sort().join(','), code);
  for (const name of keys) check(Object.hasOwn(Object.getOwnPropertyDescriptor(value, name), 'value'), code);
}
function freezeConfig(value) {
  exact(value, CONFIG_FIELDS, 'CONFIG_INVALID');
  check(typeof value.appId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.appId), 'CONFIG_INVALID');
  check(typeof value.recoveryOrigin === 'string' && value.recoveryOrigin.length <= 2048, 'CONFIG_INVALID');
  check(typeof value.recoveryRpId === 'string' && value.recoveryRpId.length <= 253 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value.recoveryRpId), 'CONFIG_INVALID');
  let url;
  try { url = new URL(value.recoveryOrigin); } catch { throw new TextReserveError('CONFIG_INVALID'); }
  const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1';
  check((url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && url.origin === value.recoveryOrigin && url.hostname === value.recoveryRpId, 'CONFIG_INVALID');
  return Object.freeze(Object.fromEntries(CONFIG_FIELDS.map(name => [name, value[name]])));
}
function assertOrigin(config) {
  // A custom non-browser adapter is trusted to enforce its platform's RP and
  // origin. In browsers reject even same-RP sibling/port origins explicitly.
  if (typeof globalThis.location?.origin === 'string') check(globalThis.location.origin === config.recoveryOrigin, 'RECOVERY_ORIGIN_MISMATCH');
}
function freezeCollection(value) {
  check(Array.isArray(value) && value.length >= 1 && value.length <= 8, 'CONFIG_COLLECTION_INVALID');
  check(Object.getOwnPropertySymbols(value).length === 0, 'CONFIG_COLLECTION_INVALID');
  const fields = ['length', ...Array.from({ length: value.length }, (_, index) => String(index))];
  check(Object.getOwnPropertyNames(value).sort().join(',') === fields.sort().join(','), 'CONFIG_COLLECTION_INVALID');
  const configs = [], appIds = new Set();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    check(descriptor && Object.hasOwn(descriptor, 'value'), 'CONFIG_COLLECTION_INVALID');
    const config = freezeConfig(descriptor.value);
    check(!appIds.has(config.appId), 'CONFIG_COLLECTION_INVALID');
    check(!configs.length || (config.recoveryOrigin === configs[0].recoveryOrigin && config.recoveryRpId === configs[0].recoveryRpId), 'CONFIG_COLLECTION_INVALID');
    appIds.add(config.appId); configs.push(config);
  }
  return Object.freeze(configs);
}
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
function encode(value) { return encoder.encode(JSON.stringify(sorted(value))); }
function parse(bytes) {
  check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_RECORD_BYTES, 'RECORD_INVALID');
  try {
    const text = decoder.decode(bytes), value = JSON.parse(text);
    check(JSON.stringify(sorted(value)) === text, 'RECORD_INVALID');
    return value;
  } catch { throw new TextReserveError('RECORD_INVALID'); }
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
function b64(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function unb64(text, max, length) {
  check(typeof text === 'string' && text.length > 0 && text.length <= Math.ceil(max * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(text), 'RECORD_INVALID');
  let bytes;
  try { bytes = Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
  catch { throw new TextReserveError('RECORD_INVALID'); }
  check(bytes.length <= max && (length === undefined || bytes.length === length) && b64(bytes) === text, 'RECORD_INVALID');
  return bytes;
}
function validateCredential(value) {
  check(value && typeof value === 'object', 'CREDENTIAL_INVALID');
  try { unb64(value.credentialId, 1024); } catch { throw new TextReserveError('CREDENTIAL_INVALID'); }
  check(value.transports === undefined || (Array.isArray(value.transports) && value.transports.length <= 8 && value.transports.every(v => typeof v === 'string' && v.length <= 32)), 'CREDENTIAL_INVALID');
  return { credentialId: value.credentialId, ...(value.transports === undefined ? {} : { transports: Object.freeze([...value.transports]) }) };
}
function salt() { return Uint8Array.from(PRF_SALT_HEX.match(/../g), value => Number.parseInt(value, 16)); }
async function digest(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
async function textHash(bytes) { return [...await digest(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }

/** Validate without native activity. No normalization, HTML interpretation or
 * replacement of malformed surrogate sequences; all accepted text roundtrips. */
export function validateText(value) {
  check(typeof value === 'string', 'TEXT_INVALID');
  check(value.length <= MAX_TEXT_BYTES, 'TEXT_TOO_LARGE');
  const bytes = encoder.encode(value);
  try {
    check(bytes.length <= MAX_TEXT_BYTES, 'TEXT_TOO_LARGE');
    check(decoder.decode(bytes) === value, 'TEXT_INVALID');
    return value;
  } finally { bytes.fill(0); }
}
function progress(observer, stage, signal) {
  active(signal);
  try { Promise.resolve(observer?.(stage)).catch(() => {}); } catch { /* Observational only. */ }
  active(signal);
}
function storeMethods(store, writing = false) {
  check(store && typeof store.get === 'function' && (!writing || typeof store.putIfAbsent === 'function'), 'STORE_INVALID');
  return { get: store.get.bind(store), ...(writing ? { putIfAbsent: store.putIfAbsent.bind(store) } : {}) };
}
function recordCopy(bytes) {
  check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_RECORD_BYTES, 'RECORD_INVALID');
  return new Uint8Array(bytes);
}
async function io(action, signal, writing = false) {
  let timer, cancel;
  try {
    active(signal);
    return await Promise.race([
      Promise.resolve().then(() => { active(signal); return action(); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new TextReserveError(writing ? 'STORE_WRITE_UNKNOWN' : 'STORE_UNAVAILABLE')), IO_TIMEOUT_MS); }),
      new Promise((_, reject) => {
        cancel = () => reject(new TextReserveError('OPERATION_CANCELLED'));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      }),
    ]);
  } catch (error) {
    if (error instanceof TextReserveError) throw error;
    throw new TextReserveError(writing ? 'STORE_WRITE_UNKNOWN' : 'STORE_UNAVAILABLE');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
function boundClient(client, config) {
  return {
    createCredential: request => client.createCredential(request),
    async getCredential(request) {
      check(request.rpId === config.recoveryRpId && equal(request.prfSalt, salt()), 'CREDENTIAL_MISMATCH');
      const result = await client.getCredential(request);
      if (request.allowCredential && !equal(result.credentialId, request.allowCredential.credentialId)) {
        result.prfOutput?.fill(0); throw new TextReserveError('CREDENTIAL_MISMATCH');
      }
      return result;
    },
  };
}
async function discoveryMaterial(result, config, signal) {
  validateCredential(result);
  let lookup;
  try {
    active(signal);
    const material = await crypto.subtle.importKey('raw', result.prfOutput, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const hkdfSalt = await digest(encode({ format: `${TEXT_PROTOCOL}/hkdf`, config, credentialId: result.credentialId }));
    const params = purpose => ({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: encoder.encode(`${TEXT_PROTOCOL}/${purpose}`) });
    lookup = new Uint8Array(await crypto.subtle.deriveBits(params('locator'), material, 256));
    const locator = b64(await digest(lookup));
    const manifestKey = await crypto.subtle.deriveKey(params('manifest-aes-gcm'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    active(signal);
    const textKey = await crypto.subtle.deriveKey(params('text-aes-gcm'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    active(signal);
    return { credentialId: result.credentialId, locator, manifestKey, textKey };
  } finally { lookup?.fill(0); }
}
async function discovery(config, client, signal) {
  active(signal);
  let result;
  const prfSalt = salt();
  try {
    result = await getPasskeyPrfOutput({ rpId: config.recoveryRpId, prfSalt, webAuthnClient: boundClient(client, config) });
    return await discoveryMaterial(result, config, signal);
  } finally { result?.prfOutput.fill(0); prfSalt.fill(0); }
}

/** Only an exact, one-use handle carries private PRF-derived material into
 * setup. Both acquisition paths preserve the caller's native-click boundary. */
export function createTextReserveCredential(options) { return credentialHandle(options, false); }

/** Explicit discoverable selection of an existing passkey. Never creates a
 * credential, writes storage or falls back to a new credential on failure. */
export function selectTextReserveCredential(options) { return credentialHandle(options, true); }

async function credentialHandle({ config: suppliedConfig, user, webAuthnClient, signal, timeoutMs = MAX_TIMEOUT_MS }, existing) {
  const config = freezeConfig(suppliedConfig);
  if (!existing) {
    exact(user, ['name', 'displayName'], 'USER_INVALID');
    for (const field of ['name', 'displayName']) check(typeof user[field] === 'string' && user[field].trim().length > 0 && user[field].length <= 128, 'USER_INVALID');
  }
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS, 'TIMEOUT_INVALID');
  assertOrigin(config); active(signal);
  const controller = new AbortController();
  const record = { config, controller, expiresAt: Date.now() + timeoutMs, state: existing ? 'selecting' : 'creating', found: undefined };
  let timer;
  const stop = code => {
    if (record.state !== 'consumed') { record.state = 'closed'; record.error = code; }
    record.found = undefined;
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (!controller.signal.aborted) controller.abort(new TextReserveError(code));
  };
  const abort = () => stop('OPERATION_CANCELLED');
  record.stop = stop;
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => stop('RESERVE_CREDENTIAL_EXPIRED'), timeoutMs);
  timer.unref?.();
  if (signal?.aborted) abort();
  let ceremony, created, succeeded = false;
  const prfSalt = salt();
  try {
    ceremony = createWebAuthnScope({ webAuthnClient, signal: controller.signal, timeoutMs });
    ceremony.assertActive();
    created = existing
      ? await getPasskeyPrfOutput({ rpId: config.recoveryRpId, prfSalt, webAuthnClient: boundClient(ceremony.client, config) })
      : await createPasskeyWithPrfOutput({ rp: { id: config.recoveryRpId, name: 'Continuity text reserve' }, user: { name: user.name, displayName: user.displayName }, prfSalt, timeout: timeoutMs, webAuthnClient: boundClient(ceremony.client, config) });
    ceremony.assertActive();
    const metadata = validateCredential(created);
    record.found = await discoveryMaterial(created, config, controller.signal);
    ceremony.assertActive();
    check(Date.now() < record.expiresAt, 'RESERVE_CREDENTIAL_EXPIRED');
    const credential = Object.freeze({ ...metadata, close: () => stop('RESERVE_CREDENTIAL_CLOSED') });
    record.credential = credential; record.state = 'ready'; createdCredentials.set(credential, record); succeeded = true;
    return credential;
  } catch (error) { ceremony?.assertActive(); throw error; }
  finally {
    created?.prfOutput.fill(0); created?.prfSalt?.fill(0); prfSalt.fill(0); ceremony?.close();
    if (!succeeded) stop('RESERVE_CREDENTIAL_CLOSED');
  }
}
function takeCredential(credential, config) {
  const record = createdCredentials.get(credential);
  check(record, 'RESERVE_CREDENTIAL_INVALID');
  if (record.state === 'ready' && Date.now() >= record.expiresAt) record.stop('RESERVE_CREDENTIAL_EXPIRED');
  check(record.state === 'ready', record.error ?? 'RESERVE_CREDENTIAL_CONSUMED');
  check(equal(encode(record.config), encode(config)), 'CREDENTIAL_MISMATCH');
  const found = record.found;
  record.found = undefined; record.state = 'consumed';
  return { record, found };
}
function joinSignals(signals) {
  const controller = new AbortController(), abort = () => controller.abort();
  for (const signal of signals.filter(Boolean)) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
  return { signal: controller.signal, close() { for (const signal of signals.filter(Boolean)) signal.removeEventListener('abort', abort); } };
}
function indexAAD(config, locator, credentialId) { return encode({ format: INDEX_FORMAT, config, locator, credentialId }); }
function textBinding(config, locator, credentialId, textDigest) { return { format: TEXT_FORMAT, config, locator, credentialId, textDigest }; }

/** One immutable write, byte-for-byte readback and an independent discoverable
 * assertion/decryption. Any dispatched write may have committed on failure. */
export async function prepareTextReserve({ config: suppliedConfig, recoveryCredential, text: suppliedText, store, webAuthnClient, signal, onProgress }) {
  const config = freezeConfig(suppliedConfig), text = validateText(suppliedText), storage = storeMethods(store, true);
  assertOrigin(config); active(signal);
  const prepared = takeCredential(recoveryCredential, config);
  const joined = joinSignals([signal, prepared.record.controller.signal]);
  let ceremony, manifestBytes, textBytes, found = prepared.found, writeStarted = false;
  prepared.found = undefined;
  try {
    ceremony = createWebAuthnScope({ webAuthnClient, signal: joined.signal, timeoutMs: Math.max(1, prepared.record.expiresAt - Date.now()) });
    signal = ceremony.signal;
    ceremony.assertActive();
    progress(onProgress, 'protect-text', signal);
    check(!reservations.has(found.locator), 'RESERVE_ALREADY_ATTEMPTED'); reservations.add(found.locator);
    const existing = await io(() => storage.get(found.locator), signal);
    active(signal); check(existing === undefined || existing === null, 'RESERVE_EXISTS');
    textBytes = encoder.encode(text);
    const textDigest = await textHash(textBytes), binding = textBinding(config, found.locator, found.credentialId, textDigest);
    active(signal);
    const textNonce = crypto.getRandomValues(new Uint8Array(12));
    const encryptedText = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: textNonce, additionalData: encode(binding), tagLength: 128 }, found.textKey, textBytes));
    active(signal);
    manifestBytes = encode({ format: MANIFEST_FORMAT, config, credentialId: found.credentialId, textDigest, textEnvelope: { nonce: b64(textNonce), ciphertext: b64(encryptedText) } });
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encryptedManifest = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: indexAAD(config, found.locator, found.credentialId), tagLength: 128 }, found.manifestKey, manifestBytes));
    const bytes = encode({ format: INDEX_FORMAT, nonce: b64(nonce), ciphertext: b64(encryptedManifest) });
    check(bytes.length <= MAX_RECORD_BYTES, 'RECORD_INVALID'); active(signal);
    writeStarted = true;
    const created = await io(() => storage.putIfAbsent(found.locator, new Uint8Array(bytes)), signal, true);
    active(signal); check(created === true || created === false, 'STORE_WRITE_UNKNOWN'); check(created, 'RESERVE_EXISTS');
    const readback = recordCopy(await io(() => storage.get(found.locator), signal));
    active(signal); check(equal(readback, bytes), 'READBACK_FAILED');
    const locator = found.locator;
    found = undefined;
    progress(onProgress, 'verify-text', signal);
    const independent = await recoverTextReserve({ config, store: storage, webAuthnClient, signal });
    check(independent.locator === locator && independent.textDigest === textDigest && independent.text === text, 'INDEPENDENT_CHECK_FAILED');
    active(signal);
    return Object.freeze({ status: 'ready', protocol: TEXT_PROTOCOL, text, textDigest, locator, independentlyVerified: true });
  } catch (error) {
    try { ceremony?.assertActive(); } catch (cancelled) { error = cancelled; }
    if (error && typeof error === 'object') error.recordMayExist = writeStarted;
    throw error;
  } finally {
    manifestBytes?.fill(0); textBytes?.fill(0); found = undefined;
    ceremony?.close(); joined.close(); prepared.record.stop('RESERVE_CREDENTIAL_CONSUMED');
  }
}

// Shared authenticated read: callers own discovery and key lifetime. Neither
// storage nor an observer receives the derived keys or unauthenticated text.
async function openStoredText(config, found, storage, signal, onProgress) {
  let manifestBytes, textBytes;
  try {
    const stored = await io(() => storage.get(found.locator), signal);
    active(signal); check(stored !== undefined && stored !== null, 'RESERVE_MISSING');
    const record = parse(recordCopy(stored));
    exact(record, ['format', 'nonce', 'ciphertext'], 'RECORD_INVALID');
    check(record.format === INDEX_FORMAT, 'RECORD_INVALID');
    try {
      manifestBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.nonce, 12, 12), additionalData: indexAAD(config, found.locator, found.credentialId), tagLength: 128 }, found.manifestKey, unb64(record.ciphertext, MAX_RECORD_BYTES)));
    } catch { throw new TextReserveError('MANIFEST_AUTH_FAILED'); }
    active(signal);
    const manifest = parse(manifestBytes);
    exact(manifest, ['format', 'config', 'credentialId', 'textDigest', 'textEnvelope'], 'MANIFEST_INVALID');
    check(manifest.format === MANIFEST_FORMAT, 'MANIFEST_INVALID');
    check(equal(encode(freezeConfig(manifest.config)), encode(config)), 'POLICY_MISMATCH');
    check(manifest.credentialId === found.credentialId, 'CREDENTIAL_MISMATCH');
    check(typeof manifest.textDigest === 'string' && /^[0-9a-f]{64}$/.test(manifest.textDigest), 'TEXT_DIGEST_INVALID');
    exact(manifest.textEnvelope, ['nonce', 'ciphertext'], 'TEXT_INVALID');
    progress(onProgress, 'open-text', signal);
    try {
      textBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(manifest.textEnvelope.nonce, 12, 12), additionalData: encode(textBinding(config, found.locator, found.credentialId, manifest.textDigest)), tagLength: 128 }, found.textKey, unb64(manifest.textEnvelope.ciphertext, MAX_TEXT_BYTES + 16)));
    } catch { throw new TextReserveError('TEXT_AUTH_FAILED'); }
    active(signal);
    let text;
    try { text = validateText(decoder.decode(textBytes)); } catch { throw new TextReserveError('TEXT_INVALID'); }
    check(await textHash(textBytes) === manifest.textDigest, 'TEXT_DIGEST_MISMATCH');
    active(signal);
    return Object.freeze({ protocol: TEXT_PROTOCOL, text, textDigest: manifest.textDigest, locator: found.locator });
  } finally { manifestBytes?.fill(0); textBytes?.fill(0); }
}

/** Read-only discovery and authenticated decryption. Returns data only; all
 * PRF bytes are wiped and derived CryptoKey references dropped before return. */
export async function recoverTextReserve({ config: suppliedConfig, store, webAuthnClient, signal, onProgress }) {
  const config = freezeConfig(suppliedConfig), storage = storeMethods(store);
  assertOrigin(config); active(signal);
  const ceremony = createWebAuthnScope({ webAuthnClient, signal });
  signal = ceremony.signal;
  let found;
  try {
    progress(onProgress, 'find-text', signal);
    found = await discovery(config, ceremony.client, signal);
    return await openStoredText(config, found, storage, signal, onProgress);
  } catch (error) { ceremony.assertActive(); throw error; }
  finally { found = undefined; ceremony.close(); }
}

const COLLECTION_REJECTIONS = new Set(['RECORD_INVALID', 'MANIFEST_AUTH_FAILED', 'MANIFEST_INVALID', 'CONFIG_INVALID',
  'POLICY_MISMATCH', 'CREDENTIAL_MISMATCH', 'TEXT_DIGEST_INVALID', 'TEXT_INVALID', 'TEXT_AUTH_FAILED', 'TEXT_DIGEST_MISMATCH']);

/** One discoverable assertion opens a caller-selected, bounded collection of
 * existing app namespaces. The v1 derivation and records remain unchanged.
 * Missing or rejected apps do not suppress valid siblings; native failure or
 * cancellation rejects the whole operation. There is no session or write API. */
export async function recoverTextReserves({ configs: suppliedConfigs, store, webAuthnClient, signal, onProgress }) {
  const configs = freezeCollection(suppliedConfigs), storage = storeMethods(store);
  assertOrigin(configs[0]); active(signal);
  const ceremony = createWebAuthnScope({ webAuthnClient, signal });
  signal = ceremony.signal;
  const materials = [], prfSalt = salt();
  let result, adapterOutput;
  try {
    progress(onProgress, 'find-text', signal);
    // Retain the adapter output only to erase it as soon as Mera has made its
    // own copy. The scope also erases outputs on cancellation, including late
    // responses from an uncooperative adapter. Invocation stays synchronous.
    const client = {
      createCredential: ceremony.client.createCredential,
      getCredential(request) {
        return ceremony.client.getCredential(request).then(value => { adapterOutput = value; return value; });
      },
    };
    try {
      result = await getPasskeyPrfOutput({ rpId: configs[0].recoveryRpId, prfSalt, webAuthnClient: boundClient(client, configs[0]) });
      adapterOutput?.prfOutput?.fill(0); adapterOutput = undefined;
      ceremony.assertActive();
      for (const config of configs) materials.push(await discoveryMaterial(result, config, signal));
      ceremony.assertActive();
    } finally {
      result?.prfOutput?.fill(0); result?.prfSalt?.fill(0); result = undefined;
      adapterOutput?.prfOutput?.fill(0); adapterOutput = undefined; prfSalt.fill(0);
    }
    // At most eight concurrent, individually timed reads. All settle before
    // releasing the local key references; cancellation never returns partial
    // plaintext results. The operation also has the scope's five-minute bound.
    const completed = await Promise.allSettled(configs.map(async (config, index) => {
      try {
        const reserve = await openStoredText(config, materials[index], storage, signal, onProgress);
        return Object.freeze({ appId: config.appId, status: 'recovered', reserve });
      } catch (error) {
        ceremony.assertActive();
        const missing = error?.code === 'RESERVE_MISSING';
        const unavailable = error?.code === 'STORE_UNAVAILABLE' || error?.code === 'STORE_EXPIRED';
        const status = missing ? 'missing' : unavailable ? 'unavailable' : 'rejected';
        // Do not copy arbitrary provider errors, messages or locators into a
        // failed result. Only protocol-defined classifications are returned.
        const code = missing ? 'RESERVE_MISSING' : unavailable ? error.code : COLLECTION_REJECTIONS.has(error?.code) ? error.code : 'RECORD_INVALID';
        return Object.freeze({ appId: config.appId, status, code });
      } finally { materials[index] = undefined; }
    }));
    ceremony.assertActive();
    const failure = completed.find(value => value.status === 'rejected');
    if (failure) throw failure.reason;
    return Object.freeze(completed.map(value => value.value));
  } catch (error) { ceremony.assertActive(); throw error; }
  finally {
    result?.prfOutput?.fill(0); result?.prfSalt?.fill(0); adapterOutput?.prfOutput?.fill(0); prfSalt.fill(0);
    materials.fill(undefined); ceremony.close();
  }
}
