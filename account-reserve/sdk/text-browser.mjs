import { createTextReserveCredential, selectTextReserveCredential, prepareTextReserve, prepareTextReserveReplicas, validateText, TEXT_PROTOCOL } from './text-reserve.mjs';
import { createWebAuthnScope } from './webauthn-scope.mjs';

const FIELDS = ['appId', 'recoveryOrigin', 'recoveryRpId'];
const MAX_TIMEOUT = 300000;
const fail = code => Object.assign(new Error(code), { code });
const check = (condition, code) => { if (!condition) throw fail(code); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const codeOf = error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '') ? error.code : 'SETUP_FAILED';
function emit(listener, state, code) { try { listener?.(Object.freeze({ state, ...(code ? { code } : {}) })); } catch { /* observer only */ } }
function trustedUrl(value) {
  let url; try { url = new URL(value); } catch { throw fail('ORIGIN_INVALID'); }
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1';
  check((url.protocol === 'https:' || url.protocol === 'http:' && local) && !url.username && !url.password, 'ORIGIN_INVALID');
  return url;
}
function trustedOrigin(value) { const url = trustedUrl(value); check(url.origin === value, 'ORIGIN_INVALID'); return url; }
function configCopy(value) {
  check(exact(value, FIELDS), 'CONFIG_INVALID');
  check(typeof value.appId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.appId), 'CONFIG_INVALID');
  const origin = trustedOrigin(value.recoveryOrigin);
  check(typeof value.recoveryRpId === 'string' && origin.hostname === value.recoveryRpId, 'CONFIG_INVALID');
  return Object.freeze(Object.fromEntries(FIELDS.map(field => [field, value[field]])));
}
function duration(value = MAX_TIMEOUT) { check(Number.isSafeInteger(value) && value >= 1000 && value <= MAX_TIMEOUT, 'TIMEOUT_INVALID'); return value; }
function browser(value) { const window = value ?? globalThis.window; check(window && typeof window.addEventListener === 'function' && typeof window.removeEventListener === 'function', 'BROWSER_REQUIRED'); return window; }
function matches(event, origin, source, nonce, kind) {
  return event.origin === origin && event.source === source && exact(event.data, ['version', 'kind', 'nonce'])
    && event.data.version === 1 && event.data.kind === kind && event.data.nonce === nonce;
}
function ready(value, text, textDigest) {
  return exact(value, ['status', 'protocol', 'text', 'textDigest', 'locator', 'independentlyVerified'])
    && value.status === 'ready' && value.protocol === TEXT_PROTOCOL && value.text === text && value.textDigest === textDigest
    && typeof value.locator === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.locator) && value.independentlyVerified === true;
}

// Replica enrollment is additive. The legacy wire and ready shape stay exact.
const REPLICA_STAGES = new Set(['preflight', 'write', 'readback', 'verify']);
const REPLICA_STATUSES = new Set(['pending', 'missing', 'existing', 'written', 'verified', 'unavailable', 'rejected', 'unknown']);
const REPLICA_CODES = new Set(['RESERVE_MISSING', 'RESERVE_EXISTS', 'STORE_UNAVAILABLE', 'STORE_WRITE_UNKNOWN', 'RECORD_INVALID', 'READBACK_FAILED', 'OPERATION_CANCELLED', 'MANIFEST_AUTH_FAILED', 'MANIFEST_INVALID', 'POLICY_MISMATCH', 'TEXT_AUTH_FAILED', 'TEXT_DIGEST_INVALID', 'TEXT_DIGEST_MISMATCH', 'TEXT_INVALID', 'CONFIG_INVALID', 'CREDENTIAL_MISMATCH']);
const REPLICA_FAILURES = new Set(['SETUP_FAILED', 'HANDOFF_INVALID', 'HANDOFF_FAILED', 'REPLICA_IDS_MISMATCH', 'SETUP_EXPIRED', 'SETUP_WINDOW_CLOSED', 'OPERATION_CANCELLED', 'OPERATION_TIMED_OUT', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_MISMATCH', 'PRF_UNAVAILABLE', 'PASSKEY_OPERATION_FAILED', 'PASSKEY_DENIED', 'RESERVE_ALREADY_ATTEMPTED', 'REPLICA_PREPARATION_FAILED', 'REPLICA_CONFLICT', 'INDEPENDENT_CHECK_FAILED', 'RESERVE_MISSING', 'REPLICA_RECOVERY_FAILED', 'TEXT_INVALID']);
function dataObject(value, fields) {
  return exact(value, fields) && Object.getOwnPropertySymbols(value).length === 0
    && Object.getOwnPropertyNames(value).length === fields.length
    && fields.every(field => Object.hasOwn(Object.getOwnPropertyDescriptor(value, field), 'value'));
}
function replicaArray(value) {
  check(Array.isArray(value) && value.length >= 2 && value.length <= 3, 'REPLICAS_INVALID');
  check(Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).length === value.length + 1, 'REPLICAS_INVALID');
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    check(descriptor && Object.hasOwn(descriptor, 'value'), 'REPLICAS_INVALID'); return descriptor.value;
  });
}
function replicaIdsCopy(value) {
  const ids = replicaArray(value);
  check(ids.every(id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id)) && new Set(ids).size === ids.length, 'REPLICAS_INVALID');
  return Object.freeze(ids);
}
function sameIds(value, ids) { return Array.isArray(value) && value.length === ids.length && ids.every((id, index) => value[index] === id); }
function writeReplicasCopy(value, ids) {
  const targets = replicaArray(value), stores = new Set();
  const captured = targets.map((target, index) => {
    check(dataObject(target, ['id', 'store']), 'REPLICAS_INVALID');
    check(target.id === ids[index], 'REPLICA_IDS_MISMATCH');
    const store = target.store;
    check(store && !stores.has(store), 'REPLICAS_INVALID'); stores.add(store);
    // Read each trusted adapter method once and preserve its receiver. Mutation
    // during a pending passkey prompt cannot redirect the intended writes.
    const get = store.get, put = store.putIfAbsent;
    check(typeof get === 'function' && typeof put === 'function', 'STORE_INVALID');
    return Object.freeze({ id: target.id, store: Object.freeze({ get: get.bind(store), putIfAbsent: put.bind(store) }) });
  });
  check(captured.length === ids.length, 'REPLICA_IDS_MISMATCH');
  return Object.freeze(captured);
}
function diagnosticsCopy(value, ids, verified = false) {
  try {
    const values = replicaArray(value);
    check(values.length === ids.length, 'HANDOFF_INVALID');
    return Object.freeze(values.map((item, index) => {
      const fields = item && Object.hasOwn(item, 'code') ? ['id', 'stage', 'status', 'code'] : ['id', 'stage', 'status'];
      check(dataObject(item, fields) && item.id === ids[index] && REPLICA_STAGES.has(item.stage) && REPLICA_STATUSES.has(item.status), 'HANDOFF_INVALID');
      check(!Object.hasOwn(item, 'code') || REPLICA_CODES.has(item.code), 'HANDOFF_INVALID');
      check(!verified || item.stage === 'verify' && item.status === 'verified' && fields.length === 3, 'HANDOFF_INVALID');
      return Object.freeze({ id: item.id, stage: item.stage, status: item.status, ...(fields.length === 4 ? { code: item.code } : {}) });
    }));
  } catch { return undefined; }
}
function pendingDiagnostics(ids) { return Object.freeze(ids.map(id => Object.freeze({ id, stage: 'preflight', status: 'pending' }))); }
function replicaFailure(code, ids, recordMayExist, diagnostics) {
  const error = fail(REPLICA_FAILURES.has(code) ? code : 'SETUP_FAILED');
  error.replicas = diagnosticsCopy(diagnostics, ids) ?? pendingDiagnostics(ids);
  // A contradictory peer flag cannot erase reported write-stage uncertainty.
  error.recordMayExist = recordMayExist || error.replicas.some(item => item.stage !== 'preflight');
  return error;
}
function replicaReady(value, text, digest, ids) {
  if (!exact(value, ['status', 'protocol', 'text', 'textDigest', 'locator', 'independentlyVerified', 'replicas'])) return undefined;
  const { replicas, ...single } = value;
  const diagnostics = diagnosticsCopy(replicas, ids, true);
  return ready(single, text, digest) && diagnostics ? Object.freeze({ ...single, replicas: diagnostics }) : undefined;
}

/** Call synchronously from a user click. This flow transports text only. */
export function startTextReserveSetup(options) { return startSetup(options); }
/** Explicit replica enrollment; call synchronously from the original app click. */
export function startTextReserveReplicaSetup(options) { return startSetup(options, replicaIdsCopy(options.replicaIds)); }
function startSetup({ config: supplied, originalOrigin, recoveryUrl, text: suppliedText, signal, onState, timeoutMs, window: suppliedWindow }, replicaIds) {
  const config = configCopy(supplied), window = browser(suppliedWindow), timeout = duration(timeoutMs);
  const original = trustedOrigin(originalOrigin), current = trustedUrl(window.location.href), target = trustedUrl(recoveryUrl);
  check(current.origin === original.origin && original.origin !== config.recoveryOrigin && original.hostname !== config.recoveryRpId, 'ORIGIN_INVALID');
  check(target.origin === config.recoveryOrigin && !target.hash, 'ORIGIN_INVALID');
  check(!signal?.aborted, 'OPERATION_CANCELLED');
  let text = validateText(suppliedText);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
  target.hash = replicaIds ? 'text-replica-enroll=' + nonce + ':' + config.appId + ':' + replicaIds.join(',') : 'text-enroll=' + nonce;
  const digestPromise = crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(value => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join(''));
  digestPromise.catch(() => {});
  let popup;
  try { popup = window.open(target.href, '_blank'); } catch { throw fail('POPUP_BLOCKED'); }
  if (!popup) throw fail('POPUP_BLOCKED');
  const expiresAt = Date.now() + timeout;
  let phase = 'waiting', port, transferredPort, timer, poll, resolve, reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; }); completion.catch(() => {});
  const clean = () => {
    text = undefined; clearTimeout(timer); clearInterval(poll); port?.close(); transferredPort?.close();
    window.removeEventListener('message', receive); window.removeEventListener('pagehide', pagehide); signal?.removeEventListener('abort', abort);
  };
  const stop = (code, details) => {
    if (phase === 'ready' || phase === 'failed') return;
    const recordMayExist = phase === 'transferred'; phase = 'failed';
    try { popup.postMessage({ version: 1, kind: 'cancel', nonce }, target.origin); } catch { /* popup gone */ }
    const error = replicaIds ? replicaFailure(code, replicaIds, typeof details?.recordMayExist === 'boolean' ? details.recordMayExist : recordMayExist, details?.replicas) : fail(code);
    if (!replicaIds) error.recordMayExist = recordMayExist;
    clean(); emit(onState, 'failed', error.code); reject(error);
  };
  function abort() { stop('OPERATION_CANCELLED'); }
  function pagehide() { stop('OPERATION_CANCELLED'); }
  function receive(event) {
    if (phase !== 'waiting' || Date.now() >= expiresAt) return;
    if (replicaIds && event.origin === target.origin && event.source === popup && exact(event.data, ['version', 'kind', 'nonce', 'code', 'recordMayExist', 'replicas'])
      && event.data.version === 1 && event.data.kind === 'failed' && event.data.nonce === nonce) {
      if (!REPLICA_FAILURES.has(event.data.code) || typeof event.data.recordMayExist !== 'boolean' || !diagnosticsCopy(event.data.replicas, replicaIds)) { stop('HANDOFF_INVALID'); return; }
      stop(event.data.code, event.data); return;
    }
    if (!replicaIds && event.origin === target.origin && event.source === popup && exact(event.data, ['version', 'kind', 'nonce', 'code'])
      && event.data.version === 1 && event.data.kind === 'failed' && event.data.nonce === nonce && /^[A-Z][A-Z0-9_]{1,63}$/.test(event.data.code)) {
      stop(event.data.code); return;
    }
    if (!matches(event, target.origin, popup, nonce, 'receive')) return;
    phase = 'transferred';
    try {
      const channel = new window.MessageChannel(); port = channel.port1; transferredPort = channel.port2;
      port.onmessage = async event => {
        if (phase !== 'transferred' || Date.now() >= expiresAt) return;
        const message = event.data;
        if (replicaIds && message?.kind === 'failed') {
          if (!exact(message, ['kind', 'code', 'recordMayExist', 'replicas']) || !REPLICA_FAILURES.has(message.code) || typeof message.recordMayExist !== 'boolean' || !diagnosticsCopy(message.replicas, replicaIds)) { stop('HANDOFF_INVALID'); return; }
          stop(message.code, message); return;
        }
        if (!replicaIds && exact(message, ['kind', 'code']) && message.kind === 'failed' && /^[A-Z][A-Z0-9_]{1,63}$/.test(message.code)) { stop(message.code); return; }
        if (!exact(message, ['kind', 'result']) || message.kind !== 'prepared') return;
        let digest; try { digest = await digestPromise; } catch { stop('HANDOFF_FAILED'); return; }
        if (phase !== 'transferred') return;
        if (signal?.aborted) { stop('OPERATION_CANCELLED'); return; }
        if (Date.now() >= expiresAt) { stop('SETUP_EXPIRED'); return; }
        const result = replicaIds ? replicaReady(message.result, text, digest, replicaIds) : ready(message.result, text, digest) && Object.freeze({ ...message.result });
        if (!result) { stop('HANDOFF_INVALID'); return; }
        phase = 'ready'; clean(); emit(onState, 'ready'); resolve(result);
      };
      port.start(); popup.postMessage({ version: 1, kind: 'channel', nonce }, target.origin, [channel.port2]);
      port.postMessage({ kind: 'text', config, text, expiresAt, ...(replicaIds ? { replicaIds } : {}) }); emit(onState, 'preparing');
    } catch { stop('HANDOFF_FAILED'); }
  }
  window.addEventListener('message', receive); window.addEventListener('pagehide', pagehide, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => stop('SETUP_EXPIRED'), timeout);
  poll = setInterval(() => { if (popup.closed) stop('SETUP_WINDOW_CLOSED'); }, 250);
  emit(onState, 'waiting'); if (signal?.aborted) abort();
  return Object.freeze({ completion, cancel: abort });
}

/** Construct on B page load; creating/selecting a credential requires prepare(). */
export function createTextReserveReceiver(options) { return createReceiver(options); }
/** B must configure the same ordered public replica labels as A. */
export function createTextReserveReplicaReceiver(options) { return createReceiver(options, replicaIdsCopy(options.replicaIds)); }
function createReceiver({ config: supplied, originalOrigin, onState, timeoutMs, window: suppliedWindow }, replicaIds) {
  const config = configCopy(supplied), window = browser(suppliedWindow), timeout = duration(timeoutMs);
  const original = trustedOrigin(originalOrigin);
  check(trustedUrl(window.location.href).origin === config.recoveryOrigin && original.origin !== config.recoveryOrigin && original.hostname !== config.recoveryRpId, 'ORIGIN_INVALID');
  const hash = window.location.hash;
  const replicaMatch = replicaIds ? /^#text-replica-enroll=([a-f0-9]{64}):([A-Za-z0-9][A-Za-z0-9._-]{0,95}):([a-z][a-z0-9-]{0,31}(?:,[a-z][a-z0-9-]{0,31}){1,2})$/.exec(hash) : null;
  const nonce = replicaIds ? replicaMatch?.[1] ?? null : /^#text-enroll=[a-f0-9]{64}$/.test(hash) ? hash.slice(13) : null;
  const requestReplicaIds = replicaMatch?.[3].split(',');
  const opener = window.opener, isEnrollment = Boolean(nonce && opener);
  if (hash.startsWith('#text-enroll=') || hash.startsWith('#text-replica-enroll=')) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  let expiresAt = Date.now() + timeout, attempted = false, received = false, payload, closed = false, completed = false, port, timer, resolvePayload, rejectPayload;
  let externalSignal, externalAbort;
  const controller = new AbortController();
  const clear = () => {
    clearTimeout(timer); port?.close(); port = undefined; payload = undefined;
    window.removeEventListener('message', receiveChannel); window.removeEventListener('message', receiveCancel); window.removeEventListener('pagehide', dispose);
    externalSignal?.removeEventListener('abort', externalAbort);
  };
  const stop = (code, details) => {
    if (closed || completed) return controller.signal.reason;
    closed = true;
    const error = replicaIds ? replicaFailure(code, replicaIds, typeof details?.recordMayExist === 'boolean' ? details.recordMayExist : received, details?.replicas) : fail(code);
    if (!replicaIds) error.recordMayExist = received;
    try {
      const extra = replicaIds ? { recordMayExist: error.recordMayExist, replicas: error.replicas } : {};
      if (port) port.postMessage({ kind: 'failed', code: error.code, ...extra });
      else if (isEnrollment) opener.postMessage({ version: 1, kind: 'failed', nonce, code: error.code, ...extra }, original.origin);
    } catch { /* caller gone */ }
    controller.abort(error); rejectPayload?.(error); clear(); emit(onState, 'failed', error.code); return error;
  };
  function dispose() { stop('OPERATION_CANCELLED'); }
  function receiveCancel(event) { if (matches(event, original.origin, opener, nonce, 'cancel')) stop('OPERATION_CANCELLED'); }
  function receiveChannel(event) {
    if (closed || !attempted || port || Date.now() >= expiresAt || !matches(event, original.origin, opener, nonce, 'channel') || event.ports?.length !== 1) return;
    port = event.ports[0]; window.removeEventListener('message', receiveChannel);
    port.onmessage = event => {
      if (closed || Date.now() >= expiresAt) return;
      const value = event.data;
      if (!exact(value, ['kind', 'config', 'text', 'expiresAt', ...(replicaIds ? ['replicaIds'] : [])]) || value.kind !== 'text'
        || !exact(value.config, FIELDS) || !FIELDS.every(field => value.config[field] === config[field])
        || replicaIds && !sameIds(value.replicaIds, replicaIds)
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + MAX_TIMEOUT) { stop('HANDOFF_INVALID'); return; }
      try { validateText(value.text); } catch { stop('TEXT_INVALID'); return; }
      received = true; payload = value; port.onmessage = () => {};
      expiresAt = Math.min(expiresAt, value.expiresAt); clearTimeout(timer);
      timer = setTimeout(() => stop('SETUP_EXPIRED'), Math.max(0, expiresAt - Date.now()));
      resolvePayload(value);
    };
    port.start();
  }
  if (isEnrollment) {
    timer = setTimeout(() => stop('SETUP_EXPIRED'), timeout);
    window.addEventListener('message', receiveCancel); window.addEventListener('pagehide', dispose, { once: true }); emit(onState, 'available');
  }
  function active() { if (closed || controller.signal.aborted) throw controller.signal.reason ?? fail('OPERATION_CANCELLED'); if (Date.now() >= expiresAt) throw fail('SETUP_EXPIRED'); }
  async function prepare({ store, replicas: suppliedReplicas, user, credentialMode = 'create', webAuthnClient, signal } = {}) {
    check(isEnrollment, 'ENROLLMENT_UNAVAILABLE'); check(!attempted, 'RESERVE_ALREADY_ATTEMPTED'); active();
    let replicas;
    if (replicaIds) {
      check(store === undefined, 'REPLICAS_INVALID');
      replicas = writeReplicasCopy(suppliedReplicas, replicaIds);
      if (replicaMatch[2] !== config.appId) throw stop('HANDOFF_INVALID', { recordMayExist: false });
      if (!sameIds(requestReplicaIds, replicaIds)) throw stop('REPLICA_IDS_MISMATCH', { recordMayExist: false });
    } else {
      check(suppliedReplicas === undefined, 'REPLICAS_INVALID');
      check(store && typeof store.get === 'function' && typeof store.putIfAbsent === 'function', 'STORE_INVALID');
    }
    check(credentialMode === 'create' || credentialMode === 'existing', 'CREDENTIAL_MODE_INVALID');
    if (credentialMode === 'create') check(user && typeof user.name === 'string' && user.name.trim() && user.name.length <= 128 && typeof user.displayName === 'string' && user.displayName.trim() && user.displayName.length <= 128, 'USER_INVALID');
    check(!signal?.aborted, 'OPERATION_CANCELLED'); attempted = true;
    externalSignal = signal; externalAbort = dispose; signal?.addEventListener('abort', externalAbort, { once: true });
    const ceremony = createWebAuthnScope({ webAuthnClient, signal: controller.signal, timeoutMs: Math.max(1, expiresAt - Date.now()) });
    webAuthnClient = ceremony.client;
    let rejectCancelled;
    const cancelled = new Promise((_, no) => { rejectCancelled = no; });
    const cancelListener = () => rejectCancelled(controller.signal.reason ?? fail('OPERATION_CANCELLED'));
    controller.signal.addEventListener('abort', cancelListener, { once: true });
    const work = (async () => {
      let credential, receivedPayload;
      try {
        emit(onState, credentialMode === 'existing' ? 'selecting-credential' : 'creating-credential'); active();
        const acquire = credentialMode === 'existing' ? selectTextReserveCredential : createTextReserveCredential;
        credential = await acquire({ config, user, webAuthnClient, signal: controller.signal, timeoutMs: Math.max(1, expiresAt - Date.now()) });
        active();
        receivedPayload = await new Promise((yes, no) => {
          resolvePayload = yes; rejectPayload = no; window.addEventListener('message', receiveChannel);
          opener.postMessage({ version: 1, kind: 'receive', nonce }, original.origin);
        });
        rejectPayload = undefined; active(); emit(onState, 'preparing');
        const result = replicaIds
          ? await prepareTextReserveReplicas({ config, recoveryCredential: credential, text: receivedPayload.text, replicas, webAuthnClient, signal: controller.signal })
          : await prepareTextReserve({ config, recoveryCredential: credential, text: receivedPayload.text, store, webAuthnClient, signal: controller.signal });
        active(); port.postMessage({ kind: 'prepared', result }); completed = true; clear(); emit(onState, 'ready'); return result;
      } catch (error) { const stopped = stop(codeOf(error), error); throw replicaIds ? stopped ?? replicaFailure(codeOf(error), replicaIds, received, error?.replicas) : error; }
      finally { credential?.close(); receivedPayload = undefined; ceremony.close(); }
    })();
    try { return await Promise.race([work, cancelled]); }
    finally { controller.signal.removeEventListener('abort', cancelListener); ceremony.close(); }
  }
  return Object.freeze({ isEnrollment, prepare, dispose });
}
