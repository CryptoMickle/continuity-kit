import {
  createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecretVaultWithExistingPasskey,
  decryptSecretVaultWithPasskey, parseSecretVault, createSecp256k1SigningSession,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { hexToBytes, sha256, toBytes, verifyMessage } from 'viem';
import { createWebAuthnScope } from './webauthn-scope.mjs';

// New experimental signer-reserve protocol. Not the published data-only CK protocol.
export const PROTOCOL = 'account-continuity/reserve-v1';
const INDEX_FORMAT = `${PROTOCOL}/index`;
const MANIFEST_FORMAT = `${PROTOCOL}/manifest`;
const KEY_FORMAT = `${PROTOCOL}/key`;
const MAX_RECORD_BYTES = 65536;
const MAX_HEADER_BYTES = 8192;
const IO_TIMEOUT_MS = 10000;
const fields = ['appId', 'originalRpId', 'recoveryRpId', 'derivation'];
const reservations = new Set();
const createdCredentials = new WeakMap();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class ReserveError extends Error {
  constructor(code) { super(code); this.name = 'ReserveError'; this.code = code; }
}
function check(value, code) { if (!value) throw new ReserveError(code); }
function active(signal) { check(!signal?.aborted, 'OPERATION_CANCELLED'); }
// Observers receive stage names only. UI failures must not change the operation;
// cancellation requested by an observer must still stop it before further work.
function progress(observer, stage, signal) {
  active(signal);
  try { Promise.resolve(observer?.(stage)).catch(() => {}); } catch { /* Informational observer only. */ }
  active(signal);
}
function exact(value, keys, code) {
  check(value && typeof value === 'object' && !Array.isArray(value), code);
  check(Object.keys(value).sort().join(',') === [...keys].sort().join(','), code);
}
function freezeConfig(value) {
  exact(value, fields, 'CONFIG_INVALID');
  check(typeof value.appId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.appId), 'CONFIG_INVALID');
  check(typeof value.derivation === 'string' && /^[A-Za-z0-9][A-Za-z0-9:./'_-]{0,191}$/.test(value.derivation), 'CONFIG_INVALID');
  for (const name of ['originalRpId', 'recoveryRpId']) {
    check(typeof value[name] === 'string' && value[name].length <= 253 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value[name]), 'CONFIG_INVALID');
  }
  check(value.originalRpId !== value.recoveryRpId, 'CONFIG_INVALID');
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, value[field]])));
}
function owner(value) { check(typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value), 'OWNER_INVALID'); return value; }
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}
function encode(value) { return encoder.encode(JSON.stringify(sorted(value))); }
function parse(bytes, max = MAX_RECORD_BYTES) {
  check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= max, 'RECORD_INVALID');
  let value;
  try {
    const text = decoder.decode(bytes);
    value = JSON.parse(text);
    check(JSON.stringify(sorted(value)) === text, 'RECORD_INVALID');
  } catch { throw new ReserveError('RECORD_INVALID'); }
  return value;
}
function b64(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function unb64(text, max, exactLength) {
  check(typeof text === 'string' && text.length > 0 && text.length <= Math.ceil(max * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(text), 'RECORD_INVALID');
  let bytes;
  try { bytes = Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0)); }
  catch { throw new ReserveError('RECORD_INVALID'); }
  check(bytes.length <= max && (exactLength === undefined || bytes.length === exactLength) && b64(bytes) === text, 'RECORD_INVALID');
  return bytes;
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
async function digest(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
function validateCredential(credential) {
  check(credential && typeof credential === 'object', 'CREDENTIAL_INVALID');
  unb64(credential.credentialId, 1024);
  check(credential.transports === undefined || (Array.isArray(credential.transports) && credential.transports.length <= 8 && credential.transports.every((v) => typeof v === 'string' && v.length <= 32)), 'CREDENTIAL_INVALID');
  return Object.freeze({ credentialId: credential.credentialId, ...(credential.transports ? { transports: [...credential.transports] } : {}) });
}
function validateVault(value) {
  exact(value, ['version', 'credential', 'prfSalt', 'nonce', 'ciphertext'], 'RECORD_INVALID');
  exact(value.credential, value.credential?.transports === undefined ? ['credentialId'] : ['credentialId', 'transports'], 'RECORD_INVALID');
  validateCredential(value.credential);
  unb64(value.ciphertext, MAX_HEADER_BYTES + 1024);
  return parseSecretVault(value);
}
async function io(action, unknownWrite = false, signal) {
  let timer;
  let cancel;
  try {
    active(signal);
    return await Promise.race([
      Promise.resolve().then(() => { active(signal); return action(); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new ReserveError(unknownWrite ? 'STORE_WRITE_UNKNOWN' : 'STORE_UNAVAILABLE')), IO_TIMEOUT_MS); }),
      new Promise((_, reject) => {
        cancel = () => reject(new ReserveError('OPERATION_CANCELLED'));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      }),
    ]);
  } catch (error) {
    if (error instanceof ReserveError) throw error;
    throw new ReserveError(unknownWrite ? 'STORE_WRITE_UNKNOWN' : 'STORE_UNAVAILABLE');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
function storeMethods(store, writing = false) {
  check(store && typeof store.get === 'function' && (!writing || typeof store.putIfAbsent === 'function'), 'STORE_INVALID');
}

function bootstrapSalt(config) { return hexToBytes(sha256(toBytes(`${PROTOCOL}/bootstrap\0${config.appId}`))); }
async function discoveryMaterial(result, signal) {
  let lookup;
  try {
    active(signal);
    const material = await crypto.subtle.importKey('raw', result.prfOutput, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const hkdfSalt = await digest(encoder.encode(`${PROTOCOL}/hkdf`));
    lookup = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: encoder.encode(`${PROTOCOL}/locator`) }, material, 256));
    const locator = b64(await digest(lookup));
    const manifestKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: encoder.encode(`${PROTOCOL}/manifest-aes-gcm`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    active(signal);
    return { credentialId: result.credentialId, locator, manifestKey };
  } finally { lookup?.fill(0); }
}
async function discovery(config, webAuthnClient, credential, signal) {
  active(signal);
  const salt = bootstrapSalt(config);
  let result;
  try {
    result = await getPasskeyPrfOutput({ rpId: config.recoveryRpId, prfSalt: salt, ...(credential ? { credential } : {}), webAuthnClient });
    return await discoveryMaterial(result, signal);
  } finally { result?.prfOutput.fill(0); salt.fill(0); }
}

/** Explicit native creation. Only this exact, short-lived object can reuse its
 * creation PRF for initial discovery; ordinary metadata keeps the existing path. */
export async function createReserveCredential({ config: suppliedConfig, user, webAuthnClient, signal, timeoutMs = 300000 }) {
  const config = freezeConfig(suppliedConfig);
  check(user && typeof user.name === 'string' && user.name.trim().length > 0 && user.name.length <= 128 && typeof user.displayName === 'string' && user.displayName.trim().length > 0 && user.displayName.length <= 128, 'USER_INVALID');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'TIMEOUT_INVALID');
  active(signal);
  const controller = new AbortController();
  const record = { config, controller, expiresAt: Date.now() + timeoutMs, state: 'creating', found: undefined };
  let timer;
  const stop = code => {
    if (record.state !== 'consumed') { record.state = 'closed'; record.error = code; }
    record.found = undefined;
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (!controller.signal.aborted) controller.abort(new ReserveError(code));
  };
  const abort = () => stop('OPERATION_CANCELLED');
  record.stop = stop;
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => stop('RESERVE_CREDENTIAL_EXPIRED'), timeoutMs);
  // Do not keep a Node consumer alive solely for an unused example credential.
  timer.unref?.();
  if (signal?.aborted) abort();
  const salt = bootstrapSalt(config);
  let ceremony, created, succeeded = false;
  try {
    ceremony = createWebAuthnScope({ webAuthnClient, signal: controller.signal, timeoutMs });
    ceremony.assertActive();
    const boundClient = {
      createCredential: request => ceremony.client.createCredential(request),
      async getCredential(request) {
        check(request.rpId === config.recoveryRpId && equal(request.prfSalt, salt), 'CREDENTIAL_MISMATCH');
        const result = await ceremony.client.getCredential(request);
        if (!request.allowCredential || !equal(result.credentialId, request.allowCredential.credentialId)) {
          result.prfOutput?.fill(0); throw new ReserveError('CREDENTIAL_MISMATCH');
        }
        return result;
      },
    };
    // bootstrapSalt is synchronous; this reaches native create in the original
    // call stack before any await, preserving the user's click activation.
    created = await createPasskeyWithPrfOutput({ rp: { id: config.recoveryRpId, name: 'Continuity independent reserve' }, user: { name: user.name, displayName: user.displayName }, prfSalt: salt, timeout: timeoutMs, webAuthnClient: boundClient });
    ceremony.assertActive();
    const metadata = validateCredential(created);
    record.found = await discoveryMaterial(created, controller.signal);
    ceremony.assertActive();
    check(Date.now() < record.expiresAt, 'RESERVE_CREDENTIAL_EXPIRED');
    const credential = Object.freeze({ credentialId: metadata.credentialId, ...(metadata.transports ? { transports: Object.freeze([...metadata.transports]) } : {}), close: () => stop('RESERVE_CREDENTIAL_CLOSED') });
    record.credential = credential;
    record.state = 'ready'; createdCredentials.set(credential, record); succeeded = true;
    return credential;
  } catch (error) { ceremony?.assertActive(); throw error; }
  finally {
    created?.prfOutput.fill(0); created?.prfSalt?.fill(0); salt.fill(0); ceremony?.close();
    if (!succeeded) stop('RESERVE_CREDENTIAL_CLOSED');
  }
}

function takeCreatedCredential(credential) {
  const record = createdCredentials.get(credential);
  if (!record) return undefined;
  if (record.state === 'ready' && Date.now() >= record.expiresAt) record.stop('RESERVE_CREDENTIAL_EXPIRED');
  check(record.state === 'ready', record.error ?? 'RESERVE_CREDENTIAL_CONSUMED');
  const found = record.found;
  record.found = undefined; record.state = 'consumed';
  return { record, found };
}
function aad(config, locator) { return encode({ format: INDEX_FORMAT, appId: config.appId, recoveryRpId: config.recoveryRpId, locator }); }
function makeSigner(key) {
  const session = createSecp256k1SigningSession({ privateKey: key });
  try {
    const account = toViemAccount(session);
    return { session, account, owner: account.address.toLowerCase(), close: () => session.end() };
  } catch (error) { session.end(); throw error; }
}

/** B chooses a discoverable credential. Config contains no account, locator or secret. */
export async function recoverReserve({ config: suppliedConfig, webAuthnClient, store, signal, onProgress }) {
  const config = freezeConfig(suppliedConfig);
  storeMethods(store);
  const ceremony = createWebAuthnScope({ webAuthnClient, signal });
  webAuthnClient = ceremony.client; signal = ceremony.signal;
  let plaintext;
  let secret;
  let key;
  let signer;
  const cancel = () => { signer?.close(); plaintext?.fill(0); secret?.fill(0); key?.fill(0); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    progress(onProgress, 'find-reserve', signal);
    const found = await discovery(config, webAuthnClient, undefined, signal);
    const stored = await io(() => store.get(found.locator), false, signal);
    active(signal);
    check(stored !== undefined && stored !== null, 'RESERVE_MISSING');
    const record = parse(stored);
    exact(record, ['format', 'nonce', 'ciphertext'], 'RECORD_INVALID');
    check(record.format === INDEX_FORMAT, 'RECORD_INVALID');
    const nonce = unb64(record.nonce, 12, 12);
    const ciphertext = unb64(record.ciphertext, MAX_RECORD_BYTES);
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(config, found.locator), tagLength: 128 }, found.manifestKey, ciphertext));
    } catch { throw new ReserveError('MANIFEST_AUTH_FAILED'); }
    active(signal);
    const manifest = parse(plaintext);
    exact(manifest, ['format', 'config', 'owner', 'credentialId', 'vault'], 'MANIFEST_INVALID');
    check(manifest.format === MANIFEST_FORMAT, 'MANIFEST_INVALID');
    const authenticatedConfig = freezeConfig(manifest.config);
    check(equal(encode(config), encode(authenticatedConfig)), 'POLICY_MISMATCH');
    const authenticatedOwner = owner(manifest.owner);
    check(manifest.credentialId === found.credentialId, 'CREDENTIAL_MISMATCH');
    const vault = validateVault(manifest.vault);
    check(vault.credential.credentialId === found.credentialId, 'CREDENTIAL_MISMATCH');
    // RP remains the trusted configured B, never an untrusted storage field.
    progress(onProgress, 'unlock-reserve', signal);
    secret = await decryptSecretVaultWithPasskey({ vault, rpId: config.recoveryRpId, webAuthnClient });
    active(signal);
    check(secret.length >= 37 && secret.length <= MAX_HEADER_BYTES + 36, 'PAYLOAD_INVALID');
    const headerLength = new DataView(secret.buffer, secret.byteOffset, secret.byteLength).getUint32(0, false);
    check(headerLength > 0 && headerLength <= MAX_HEADER_BYTES && headerLength + 36 === secret.length, 'PAYLOAD_INVALID');
    const header = parse(secret.subarray(4, 4 + headerLength), MAX_HEADER_BYTES);
    exact(header, ['format', 'config', 'owner', 'credentialId'], 'PAYLOAD_INVALID');
    check(header.format === KEY_FORMAT && header.owner === authenticatedOwner && header.credentialId === found.credentialId, 'PAYLOAD_MISMATCH');
    check(equal(encode(freezeConfig(header.config)), encode(config)), 'PAYLOAD_MISMATCH');
    key = secret.slice(4 + headerLength);
    signer = makeSigner(key);
    check(signer.owner === authenticatedOwner, 'OWNER_MISMATCH');
    active(signal);
    return { ...signer, policy: Object.freeze({ ...config, expectedOwner: authenticatedOwner }), locator: found.locator };
  } catch (error) { signer?.close(); ceremony.assertActive(); throw error; }
  finally { signal.removeEventListener('abort', cancel); plaintext?.fill(0); secret?.fill(0); key?.fill(0); ceremony.close(); }
}

/** Prepare once with a newly dedicated B credential. No credential creation is hidden here. */
export async function prepareReserve(options) {
  const prepared = takeCreatedCredential(options?.recoveryCredential);
  let joined, detach;
  try {
    if (prepared) {
      joined = new AbortController();
      const sources = [options.signal, prepared.record.controller.signal].filter(Boolean);
      const abort = () => joined.abort(new ReserveError('OPERATION_CANCELLED'));
      for (const source of sources) { source.addEventListener('abort', abort, { once: true }); if (source.aborted) abort(); }
      detach = () => { for (const source of sources) source.removeEventListener('abort', abort); };
    }
    return await prepareReserveInternal(prepared ? { ...options, signal: joined.signal } : options, prepared);
  } finally {
    detach?.();
    if (prepared) { prepared.found = undefined; prepared.record.stop('RESERVE_CREDENTIAL_CONSUMED'); }
  }
}

async function prepareReserveInternal({ privateKey, policy, recoveryCredential, webAuthnClient, store, signal, onProgress }, prepared) {
  exact(policy, [...fields, 'expectedOwner'], 'POLICY_INVALID');
  const expectedOwner = owner(policy.expectedOwner);
  const config = freezeConfig(Object.fromEntries(fields.map((field) => [field, policy[field]])));
  const credential = validateCredential(recoveryCredential);
  if (prepared) check(equal(encode(config), encode(prepared.record.config)) && credential.credentialId === prepared.found?.credentialId && recoveryCredential === prepared.record.credential, 'CREDENTIAL_MISMATCH');
  storeMethods(store, true);
  active(signal);
  check(privateKey instanceof Uint8Array && privateKey.length === 32, 'KEY_INVALID');
  const ceremony = createWebAuthnScope({ webAuthnClient, signal, ...(prepared ? { timeoutMs: Math.max(1, prepared.record.expiresAt - Date.now()) } : {}) });
  webAuthnClient = ceremony.client; signal = ceremony.signal;
  const key = new Uint8Array(privateKey);
  let secret;
  let manifestBytes;
  let identity;
  let independent;
  let writeStarted = false;
  const cancel = () => { identity?.close(); independent?.close(); key.fill(0); secret?.fill(0); manifestBytes?.fill(0); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    progress(onProgress, 'protect-reserve', signal);
    identity = makeSigner(key);
    check(identity.owner === expectedOwner, 'OWNER_MISMATCH');
    identity.close();
    const found = prepared ? prepared.found : await discovery(config, webAuthnClient, credential, signal);
    if (prepared) prepared.found = undefined;
    active(signal);
    check(found.credentialId === credential.credentialId, 'CREDENTIAL_MISMATCH');
    check(!reservations.has(found.locator), 'RESERVE_ALREADY_ATTEMPTED');
    // Never release this guard after an uncertain/cancelled attempt in this client.
    reservations.add(found.locator);
    const existing = await io(() => store.get(found.locator), false, signal);
    active(signal);
    check(existing === undefined || existing === null, 'RESERVE_EXISTS');
    const header = encode({ format: KEY_FORMAT, config, owner: expectedOwner, credentialId: found.credentialId });
    secret = new Uint8Array(4 + header.length + 32);
    new DataView(secret.buffer).setUint32(0, header.length, false);
    secret.set(header, 4); secret.set(key, 4 + header.length);
    const vault = await createSecretVaultWithExistingPasskey({ secret, credential, rpId: config.recoveryRpId, webAuthnClient });
    active(signal);
    manifestBytes = encode({ format: MANIFEST_FORMAT, config, owner: expectedOwner, credentialId: found.credentialId, vault });
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(config, found.locator), tagLength: 128 }, found.manifestKey, manifestBytes));
    const bytes = encode({ format: INDEX_FORMAT, nonce: b64(nonce), ciphertext: b64(encrypted) });
    check(bytes.length <= MAX_RECORD_BYTES, 'RECORD_INVALID');
    active(signal);
    writeStarted = true;
    const created = await io(() => store.putIfAbsent(found.locator, new Uint8Array(bytes)), true, signal);
    active(signal);
    check(created === true || created === false, 'STORE_WRITE_UNKNOWN');
    check(created, 'RESERVE_EXISTS');
    const readback = await io(() => store.get(found.locator), false, signal);
    active(signal);
    check(readback instanceof Uint8Array && equal(readback, bytes), 'READBACK_FAILED');
    // Public recovery entry point gets no expectedOwner, private key or saved vault.
    progress(onProgress, 'verify-reserve', signal);
    independent = await recoverReserve({ config, webAuthnClient, store, signal });
    check(independent.owner === expectedOwner && independent.locator === found.locator, 'INDEPENDENT_CHECK_FAILED');
    const challenge = `${PROTOCOL}/readiness:${b64(crypto.getRandomValues(new Uint8Array(32)))}`;
    const signature = await independent.account.signMessage({ message: challenge });
    check(await verifyMessage({ address: expectedOwner, message: challenge, signature }), 'INDEPENDENT_CHECK_FAILED');
    active(signal);
    return Object.freeze({ status: 'ready', owner: expectedOwner, locator: found.locator, independentlyVerified: true, protocol: PROTOCOL });
  } catch (error) {
    // Existing record may survive an interrupted write/check; never report ready.
    try { ceremony.assertActive(); } catch (cancelled) { error = cancelled; }
    if (error && typeof error === 'object') error.recordMayExist = writeStarted;
    throw error;
  } finally { signal.removeEventListener('abort', cancel); identity?.close(); independent?.close(); key.fill(0); secret?.fill(0); manifestBytes?.fill(0); ceremony.close(); }
}
