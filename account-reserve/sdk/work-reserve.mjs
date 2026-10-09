import {
  createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecretVaultWithExistingPasskey,
  decryptSecretVaultWithPasskey, parseSecretVault, createSecp256k1SigningSession,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { hexToBytes, sha256, toBytes, verifyMessage } from 'viem';
import { createWebAuthnScope } from './webauthn-scope.mjs';

// Separate immutable private-work protocol; no legacy enrollment or record migration.
export const WORK_PROTOCOL = 'account-continuity/work-reserve-v1';
const PROTOCOL = WORK_PROTOCOL;
export const WORK_SCHEMA = 'continuity-work/brief-v1';
export const MAX_WORK_BYTES = 16384;
const WORK_FORMAT = `${PROTOCOL}/work`;
const CONTEXT_TIMEOUT_MS = 300000;
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

export class WorkReserveError extends Error {
  constructor(code) { super(code); this.name = 'WorkReserveError'; this.code = code; }
}
function check(value, code) { if (!value) throw new WorkReserveError(code); }
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
  } catch { throw new WorkReserveError('RECORD_INVALID'); }
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
  catch { throw new WorkReserveError('RECORD_INVALID'); }
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
      new Promise((_, reject) => { timer = setTimeout(() => reject(new WorkReserveError(unknownWrite ? 'STORE_WRITE_UNKNOWN' : 'STORE_UNAVAILABLE')), IO_TIMEOUT_MS); }),
      new Promise((_, reject) => {
        cancel = () => reject(new WorkReserveError('OPERATION_CANCELLED'));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      }),
    ]);
  } catch (error) {
    if (error instanceof WorkReserveError) throw error;
    throw new WorkReserveError(unknownWrite ? 'STORE_WRITE_UNKNOWN' : 'STORE_UNAVAILABLE');
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
    const workKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: encoder.encode(`${PROTOCOL}/work-aes-gcm`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    active(signal);
    return { credentialId: result.credentialId, locator, manifestKey, workKey };
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
export async function createWorkReserveCredential({ config: suppliedConfig, user, webAuthnClient, signal, timeoutMs = 300000 }) {
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
    if (!controller.signal.aborted) controller.abort(new WorkReserveError(code));
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
          result.prfOutput?.fill(0); throw new WorkReserveError('CREDENTIAL_MISMATCH');
        }
        return result;
      },
    };
    // bootstrapSalt is synchronous; this reaches native create in the original
    // call stack before any await, preserving the user's click activation.
    created = await createPasskeyWithPrfOutput({ rp: { id: config.recoveryRpId, name: 'Continuity private work reserve' }, user: { name: user.name, displayName: user.displayName }, prfSalt: salt, timeout: timeoutMs, webAuthnClient: boundClient });
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
function aad(config, locator) { return encode({ format: INDEX_FORMAT, config, locator }); }
function makeSigner(key) {
  const session = createSecp256k1SigningSession({ privateKey: key });
  try {
    const account = toViemAccount(session);
    return { session, account, owner: account.address.toLowerCase(), close: () => session.end() };
  } catch (error) { session.end(); throw error; }
}

const workFields = ['schema', 'title', 'client', 'brief', 'deliverable', 'nextStep'];
/** Snapshot only. No HTML, active content, update operation or implicit migration. */
export function validateWork(value) {
  exact(value, workFields, 'WORK_INVALID');
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'WORK_INVALID');
  check(Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).length === workFields.length, 'WORK_INVALID');
  for (const field of workFields) check(typeof Object.getOwnPropertyDescriptor(value, field)?.value === 'string', 'WORK_INVALID');
  check(value.schema === WORK_SCHEMA && value.title.length <= 256 && value.client.length <= 256, 'WORK_INVALID');
  const work = Object.freeze(Object.fromEntries(workFields.map(field => [field, value[field]])));
  check(encode(work).length <= MAX_WORK_BYTES, 'WORK_TOO_LARGE');
  return work;
}
function hash(bytes) { return sha256(bytes).slice(2); }
function hashValue(value) { return hash(encode(value)); }
function validateHash(value) { check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'RECORD_INVALID'); return value; }
function workBinding(config, locator, authenticatedOwner, credentialId, workDigest, vaultDigest) {
  return { format: WORK_FORMAT, config, locator, owner: authenticatedOwner, credentialId, workDigest, vaultDigest };
}
// Mera accepts adapter metadata; explicitly bind every allowlisted assertion as
// well as the browser's own allowCredentials enforcement.
function boundClient(client, config) {
  return {
    createCredential: request => client.createCredential(request),
    async getCredential(request) {
      check(request.rpId === config.recoveryRpId, 'CREDENTIAL_MISMATCH');
      const result = await client.getCredential(request);
      if (request.allowCredential && !equal(result.credentialId, request.allowCredential.credentialId)) {
        result.prfOutput?.fill(0); throw new WorkReserveError('CREDENTIAL_MISMATCH');
      }
      return result;
    },
  };
}
function lifetime(signal, timeoutMs = CONTEXT_TIMEOUT_MS) {
  active(signal);
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  let timer;
  const close = () => { clearTimeout(timer); signal?.removeEventListener('abort', close); if (!controller.signal.aborted) controller.abort(); };
  signal?.addEventListener('abort', close, { once: true });
  timer = setTimeout(close, timeoutMs); timer.unref?.();
  if (signal?.aborted) close();
  return { signal: controller.signal, close, assertActive() { if (Date.now() >= expiresAt) close(); active(controller.signal); } };
}
function joinSignals(signals) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals.filter(Boolean)) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
  return { signal: controller.signal, close() { for (const signal of signals.filter(Boolean)) signal.removeEventListener('abort', abort); } };
}

/** A fresh read requests discovery only. It never decrypts the account vault or
 * constructs a signing session. The explicit openAccount action is separate. */
export async function recoverWorkReserve({ config: suppliedConfig, store, webAuthnClient, signal, onProgress }) {
  const config = freezeConfig(suppliedConfig);
  storeMethods(store);
  const context = lifetime(signal);
  let ceremony, manifestBytes, workBytes, retainedVault, found, succeeded = false;
  let unlocked, opening = false;
  const close = () => { context.close(); unlocked?.close(); retainedVault = undefined; };
  context.signal.addEventListener('abort', () => { unlocked?.close(); retainedVault = undefined; }, { once: true });
  try {
    ceremony = createWebAuthnScope({ webAuthnClient, signal: context.signal });
    const client = boundClient(ceremony.client, config);
    progress(onProgress, 'find-work', context.signal);
    found = await discovery(config, client, undefined, context.signal);
    const { credentialId, locator } = found;
    const stored = await io(() => store.get(locator), false, context.signal);
    context.assertActive();
    check(stored !== undefined && stored !== null, 'RESERVE_MISSING');
    const record = parse(stored);
    exact(record, ['format', 'nonce', 'ciphertext'], 'RECORD_INVALID');
    check(record.format === INDEX_FORMAT, 'RECORD_INVALID');
    try {
      manifestBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.nonce, 12, 12), additionalData: aad(config, locator), tagLength: 128 }, found.manifestKey, unb64(record.ciphertext, MAX_RECORD_BYTES)));
    } catch { throw new WorkReserveError('MANIFEST_AUTH_FAILED'); }
    context.assertActive();
    const manifest = parse(manifestBytes);
    exact(manifest, ['format', 'config', 'owner', 'credentialId', 'workDigest', 'vaultDigest', 'vault', 'workEnvelope'], 'MANIFEST_INVALID');
    check(manifest.format === MANIFEST_FORMAT, 'MANIFEST_INVALID');
    check(equal(encode(freezeConfig(manifest.config)), encode(config)), 'POLICY_MISMATCH');
    const authenticatedOwner = owner(manifest.owner);
    check(manifest.credentialId === credentialId, 'CREDENTIAL_MISMATCH');
    const workDigest = validateHash(manifest.workDigest), vaultDigest = validateHash(manifest.vaultDigest);
    const vault = validateVault(manifest.vault);
    check(vault.credential.credentialId === credentialId, 'CREDENTIAL_MISMATCH');
    check(hashValue(vault) === vaultDigest, 'VAULT_MISMATCH');
    exact(manifest.workEnvelope, ['nonce', 'ciphertext'], 'WORK_INVALID');
    const binding = workBinding(config, locator, authenticatedOwner, credentialId, workDigest, vaultDigest);
    progress(onProgress, 'open-work', context.signal);
    try {
      workBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(manifest.workEnvelope.nonce, 12, 12), additionalData: encode(binding), tagLength: 128 }, found.workKey, unb64(manifest.workEnvelope.ciphertext, MAX_RECORD_BYTES)));
    } catch { throw new WorkReserveError('WORK_AUTH_FAILED'); }
    context.assertActive();
    const payload = parse(workBytes);
    exact(payload, [...Object.keys(binding), 'work'], 'WORK_INVALID');
    const { work: rawWork, ...payloadBinding } = payload;
    check(equal(encode(payloadBinding), encode(binding)), 'WORK_BINDING_MISMATCH');
    const work = validateWork(rawWork);
    check(hashValue(work) === workDigest, 'WORK_DIGEST_MISMATCH');
    // Account opening needs only these authenticated primitives and encrypted vault.
    // Drop discovery CryptoKey references before exposing the long-lived closure.
    found.manifestKey = undefined; found.workKey = undefined; found = undefined;
    retainedVault = vault;
    const openAccount = async ({ signal: unlockSignal } = {}) => {
      context.assertActive(); active(unlockSignal);
      check(!opening && !unlocked, 'ACCOUNT_ALREADY_OPEN');
      opening = true;
      const joined = joinSignals([context.signal, unlockSignal]);
      let unlockCeremony, secret, key, signer, success = false;
      const cancel = () => { signer?.close(); secret?.fill(0); key?.fill(0); };
      joined.signal.addEventListener('abort', cancel, { once: true });
      try {
        unlockCeremony = createWebAuthnScope({ webAuthnClient, signal: joined.signal });
        context.assertActive();
        const openingVault = retainedVault;
        check(openingVault && hashValue(openingVault) === vaultDigest, 'VAULT_MISMATCH');
        secret = await decryptSecretVaultWithPasskey({ vault: openingVault, rpId: config.recoveryRpId, webAuthnClient: boundClient(unlockCeremony.client, config) });
        context.assertActive(); unlockCeremony.assertActive();
        check(secret.length >= 37 && secret.length <= MAX_HEADER_BYTES + 36, 'PAYLOAD_INVALID');
        const headerLength = new DataView(secret.buffer, secret.byteOffset, secret.byteLength).getUint32(0, false);
        check(headerLength > 0 && headerLength <= MAX_HEADER_BYTES && headerLength + 36 === secret.length, 'PAYLOAD_INVALID');
        const header = parse(secret.subarray(4, 4 + headerLength), MAX_HEADER_BYTES);
        exact(header, ['format', 'config', 'owner', 'credentialId', 'workDigest'], 'PAYLOAD_INVALID');
        check(header.format === KEY_FORMAT && header.owner === authenticatedOwner && header.credentialId === credentialId && header.workDigest === workDigest, 'PAYLOAD_MISMATCH');
        check(equal(encode(freezeConfig(header.config)), encode(config)), 'PAYLOAD_MISMATCH');
        key = secret.slice(4 + headerLength);
        signer = makeSigner(key);
        check(signer.owner === authenticatedOwner, 'OWNER_MISMATCH');
        context.assertActive(); unlockCeremony.assertActive();
        const closeSigner = () => { signer.close(); unlockSignal?.removeEventListener('abort', closeSigner); if (unlocked === result) unlocked = undefined; };
        const result = Object.freeze({ ...signer, policy: Object.freeze({ ...config, expectedOwner: authenticatedOwner }), close: closeSigner });
        unlocked = result;
        unlockSignal?.addEventListener('abort', closeSigner, { once: true });
        if (unlockSignal?.aborted) closeSigner();
        success = true;
        return result;
      } catch (error) { context.assertActive(); unlockCeremony?.assertActive(); throw error; }
      finally {
        if (!success) signer?.close(); secret?.fill(0); key?.fill(0);
        joined.signal.removeEventListener('abort', cancel); joined.close(); unlockCeremony?.close(); opening = false;
      }
    };
    succeeded = true;
    return Object.freeze({ owner: authenticatedOwner, work, workDigest, locator: locator, openAccount, close });
  } catch (error) { context.assertActive(); ceremony?.assertActive(); throw error; }
  finally {
    if (found) { found.manifestKey = undefined; found.workKey = undefined; found = undefined; }
    manifestBytes?.fill(0); workBytes?.fill(0); ceremony?.close(); if (!succeeded) close();
  }
}

/** New work-specific enrollment only. Conditional one-time write is followed by
 * exact readback, independent work discovery and an account signing challenge. */
export async function prepareWorkReserve(options) {
  const prepared = takeCreatedCredential(options?.recoveryCredential);
  let joined;
  try {
    if (prepared) joined = joinSignals([options.signal, prepared.record.controller.signal]);
    return await prepareWorkInternal(prepared ? { ...options, signal: joined.signal } : options, prepared);
  } finally {
    joined?.close();
    if (prepared) { prepared.found = undefined; prepared.record.stop('RESERVE_CREDENTIAL_CONSUMED'); }
  }
}
async function prepareWorkInternal({ privateKey, policy, recoveryCredential, work: suppliedWork, store, webAuthnClient, signal, onProgress }, prepared) {
  exact(policy, [...fields, 'expectedOwner'], 'POLICY_INVALID');
  const expectedOwner = owner(policy.expectedOwner);
  const config = freezeConfig(Object.fromEntries(fields.map(field => [field, policy[field]])));
  const credential = validateCredential(recoveryCredential), work = validateWork(suppliedWork), workDigest = hashValue(work);
  if (prepared) check(equal(encode(config), encode(prepared.record.config)) && credential.credentialId === prepared.found?.credentialId && recoveryCredential === prepared.record.credential, 'CREDENTIAL_MISMATCH');
  storeMethods(store, true); active(signal);
  check(privateKey instanceof Uint8Array && privateKey.length === 32, 'KEY_INVALID');
  const ceremony = createWebAuthnScope({ webAuthnClient, signal, ...(prepared ? { timeoutMs: Math.max(1, prepared.record.expiresAt - Date.now()) } : {}) });
  webAuthnClient = boundClient(ceremony.client, config); signal = ceremony.signal;
  const key = new Uint8Array(privateKey);
  let secret, manifestBytes, workBytes, identity, independent, writeStarted = false;
  const cancel = () => { identity?.close(); independent?.close(); key.fill(0); secret?.fill(0); manifestBytes?.fill(0); workBytes?.fill(0); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    progress(onProgress, 'protect-work', signal);
    identity = makeSigner(key); check(identity.owner === expectedOwner, 'OWNER_MISMATCH'); identity.close();
    const found = prepared ? prepared.found : await discovery(config, webAuthnClient, credential, signal);
    if (prepared) prepared.found = undefined;
    active(signal); check(found.credentialId === credential.credentialId, 'CREDENTIAL_MISMATCH');
    check(!reservations.has(found.locator), 'RESERVE_ALREADY_ATTEMPTED'); reservations.add(found.locator);
    const existing = await io(() => store.get(found.locator), false, signal);
    active(signal); check(existing === undefined || existing === null, 'RESERVE_EXISTS');
    const header = encode({ format: KEY_FORMAT, config, owner: expectedOwner, credentialId: found.credentialId, workDigest });
    secret = new Uint8Array(4 + header.length + 32);
    new DataView(secret.buffer).setUint32(0, header.length, false); secret.set(header, 4); secret.set(key, 4 + header.length);
    const vault = await createSecretVaultWithExistingPasskey({ secret, credential, rpId: config.recoveryRpId, webAuthnClient });
    active(signal);
    const vaultDigest = hashValue(vault);
    const binding = workBinding(config, found.locator, expectedOwner, found.credentialId, workDigest, vaultDigest);
    workBytes = encode({ ...binding, work });
    const workNonce = crypto.getRandomValues(new Uint8Array(12));
    const encryptedWork = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: workNonce, additionalData: encode(binding), tagLength: 128 }, found.workKey, workBytes));
    active(signal);
    manifestBytes = encode({ format: MANIFEST_FORMAT, config, owner: expectedOwner, credentialId: found.credentialId, workDigest, vaultDigest, vault, workEnvelope: { nonce: b64(workNonce), ciphertext: b64(encryptedWork) } });
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(config, found.locator), tagLength: 128 }, found.manifestKey, manifestBytes));
    const bytes = encode({ format: INDEX_FORMAT, nonce: b64(nonce), ciphertext: b64(encrypted) });
    check(bytes.length <= MAX_RECORD_BYTES, 'RECORD_INVALID'); active(signal);
    writeStarted = true;
    const created = await io(() => store.putIfAbsent(found.locator, new Uint8Array(bytes)), true, signal);
    active(signal); check(created === true || created === false, 'STORE_WRITE_UNKNOWN'); check(created, 'RESERVE_EXISTS');
    const readback = await io(() => store.get(found.locator), false, signal);
    active(signal); check(readback instanceof Uint8Array && equal(readback, bytes), 'READBACK_FAILED');
    progress(onProgress, 'verify-work', signal);
    independent = await recoverWorkReserve({ config, webAuthnClient, store, signal });
    check(independent.owner === expectedOwner && independent.locator === found.locator && independent.workDigest === workDigest && equal(encode(independent.work), encode(work)), 'INDEPENDENT_CHECK_FAILED');
    const recoveredAccount = await independent.openAccount();
    const challenge = `${PROTOCOL}/readiness:${b64(crypto.getRandomValues(new Uint8Array(32)))}`;
    const signature = await recoveredAccount.account.signMessage({ message: challenge });
    check(await verifyMessage({ address: expectedOwner, message: challenge, signature }), 'INDEPENDENT_CHECK_FAILED');
    active(signal);
    return Object.freeze({ status: 'ready', owner: expectedOwner, locator: found.locator, workDigest, independentlyVerified: true, protocol: WORK_PROTOCOL });
  } catch (error) {
    try { ceremony.assertActive(); } catch (cancelled) { error = cancelled; }
    if (error && typeof error === 'object') error.recordMayExist = writeStarted;
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel); identity?.close(); independent?.close(); key.fill(0); secret?.fill(0); manifestBytes?.fill(0); workBytes?.fill(0); ceremony.close();
  }
}
