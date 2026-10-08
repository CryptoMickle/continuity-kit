import { createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { createReserveCredential, prepareReserve, ReserveError, PROTOCOL } from './index.mjs';
import { createWebAuthnScope } from './webauthn-scope.mjs';

const CONFIG_FIELDS = ['appId', 'originalRpId', 'recoveryRpId', 'derivation'];
const MAX_TIMEOUT = 300000;
const fail = code => new ReserveError(code);
const check = (ok, code) => { if (!ok) throw fail(code); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const emit = (listener, state, code) => {
  // UI observers must not interrupt key cleanup or receive transported material.
  try { listener?.(Object.freeze({ state, ...(code ? { code } : {}) })); } catch { /* observer only */ }
};
const codeOf = error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '') ? error.code : 'SETUP_FAILED';
function configCopy(value) {
  check(exact(value, CONFIG_FIELDS), 'CONFIG_INVALID');
  check(typeof value.appId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.appId), 'CONFIG_INVALID');
  check(typeof value.derivation === 'string' && /^[A-Za-z0-9][A-Za-z0-9:./'_-]{0,191}$/.test(value.derivation), 'CONFIG_INVALID');
  for (const name of ['originalRpId', 'recoveryRpId']) check(typeof value[name] === 'string' && value[name].length <= 253 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value[name]), 'CONFIG_INVALID');
  check(value.originalRpId !== value.recoveryRpId, 'CONFIG_INVALID');
  return Object.freeze(Object.fromEntries(CONFIG_FIELDS.map(name => [name, value[name]])));
}
function trustedUrl(input, rpId) {
  let url;
  try { url = new URL(input); } catch { throw fail('ORIGIN_INVALID'); }
  const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1';
  check((url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && !url.username && !url.password && url.hostname === rpId, 'ORIGIN_INVALID');
  return url;
}
function timeout(value = MAX_TIMEOUT) {
  check(Number.isSafeInteger(value) && value >= 1000 && value <= MAX_TIMEOUT, 'TIMEOUT_INVALID');
  return value;
}
function targetWindow(value) {
  const window = value ?? globalThis.window;
  check(window && typeof window.addEventListener === 'function' && typeof window.removeEventListener === 'function', 'BROWSER_REQUIRED');
  return window;
}
function messageMatches(event, { origin, source, nonce }, kind) {
  return event.origin === origin && event.source === source && exact(event.data, ['version', 'kind', 'nonce'])
    && event.data.version === 1 && event.data.kind === kind && event.data.nonce === nonce;
}
function ready(value, owner) {
  return exact(value, ['status', 'owner', 'locator', 'independentlyVerified', 'protocol']) && value.status === 'ready'
    && value.owner === owner && typeof value.locator === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.locator)
    && value.independentlyVerified === true && value.protocol === PROTOCOL;
}

/** Call directly from a deliberate click. The caller retains ownership of its input key. */
export function startReserveSetup({ config: input, recoveryUrl, privateKey, expectedOwner, signal, onState, timeoutMs, window: suppliedWindow }) {
  const config = configCopy(input), window = targetWindow(suppliedWindow), duration = timeout(timeoutMs);
  trustedUrl(window.location.href, config.originalRpId);
  const target = trustedUrl(recoveryUrl, config.recoveryRpId);
  check(!target.hash, 'ORIGIN_INVALID');
  check(!signal?.aborted, 'OPERATION_CANCELLED');
  check(privateKey instanceof Uint8Array && privateKey.length === 32, 'KEY_INVALID');
  check(typeof expectedOwner === 'string' && /^0x[0-9a-f]{40}$/.test(expectedOwner), 'OWNER_INVALID');
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  target.hash = 'enroll=' + nonce;
  const key = new Uint8Array(privateKey);
  let checkSession;
  try {
    try { checkSession = createSecp256k1SigningSession({ privateKey: key }); } catch { throw fail('KEY_INVALID'); }
    check(toViemAccount(checkSession).address.toLowerCase() === expectedOwner, 'OWNER_MISMATCH');
  } catch (error) { key.fill(0); throw error; }
  finally { checkSession?.end(); }
  let popup;
  try { popup = window.open(target.href, '_blank'); } catch { key.fill(0); throw fail('POPUP_BLOCKED'); }
  if (!popup) { key.fill(0); throw fail('POPUP_BLOCKED'); }
  const expiresAt = Date.now() + duration;
  let phase = 'waiting', port, transferredPort, timer, poll, resolve, reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Consumers can attach after a synchronous cancel without an unhandled rejection.
  completion.catch(() => {});
  const clean = () => {
    key.fill(0); clearTimeout(timer); clearInterval(poll); port?.close(); transferredPort?.close();
    window.removeEventListener('message', receive); window.removeEventListener('pagehide', pagehide);
    signal?.removeEventListener('abort', abort);
  };
  const stop = code => {
    if (phase === 'ready' || phase === 'failed') return;
    const recordMayExist = phase === 'transferred'; phase = 'failed';
    try { popup.postMessage({ version: 1, kind: 'cancel', nonce }, target.origin); } catch { /* popup gone */ }
    clean(); emit(onState, 'failed', code);
    const error = fail(code); error.recordMayExist = recordMayExist; reject(error);
  };
  function abort() { stop('OPERATION_CANCELLED'); }
  function pagehide() { stop('OPERATION_CANCELLED'); }
  function receive(event) {
    if (phase !== 'waiting' || Date.now() >= expiresAt || !messageMatches(event, { origin: target.origin, source: popup, nonce }, 'receive')) return;
    phase = 'transferred';
    try {
      const channel = new window.MessageChannel(); port = channel.port1; transferredPort = channel.port2;
      port.onmessage = event => {
        if (phase !== 'transferred' || Date.now() >= expiresAt) return;
        const message = event.data;
        if (exact(message, ['kind', 'code']) && message.kind === 'failed' && /^[A-Z][A-Z0-9_]{1,63}$/.test(message.code)) { stop(message.code); return; }
        if (!exact(message, ['kind', 'result']) || message.kind !== 'prepared' || !ready(message.result, expectedOwner)) return;
        const result = Object.freeze({ ...message.result }); phase = 'ready'; clean(); emit(onState, 'ready'); resolve(result);
      };
      port.start();
      popup.postMessage({ version: 1, kind: 'channel', nonce }, target.origin, [channel.port2]);
      // This is an owned transferable copy, never the caller's buffer.
      const outgoing = new Uint8Array(key);
      try { port.postMessage({ kind: 'account', config, privateKey: outgoing, expectedOwner, expiresAt }, [outgoing.buffer]); }
      finally { if (outgoing.byteLength) outgoing.fill(0); key.fill(0); }
      emit(onState, 'preparing');
    } catch { stop('HANDOFF_FAILED'); }
  }
  window.addEventListener('message', receive); window.addEventListener('pagehide', pagehide, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => stop('SETUP_EXPIRED'), duration);
  poll = setInterval(() => { if (popup.closed) stop('SETUP_WINDOW_CLOSED'); }, 250);
  emit(onState, 'waiting');
  if (signal?.aborted) abort();
  return Object.freeze({ completion, cancel: abort });
}

/** Construct on B page load. No key or credential is created until prepare(). */
export function createReserveReceiver({ config: input, originalOrigin, onState, timeoutMs, window: suppliedWindow }) {
  const config = configCopy(input), window = targetWindow(suppliedWindow), duration = timeout(timeoutMs);
  trustedUrl(window.location.href, config.recoveryRpId);
  const original = trustedUrl(originalOrigin, config.originalRpId);
  check(original.origin === originalOrigin, 'ORIGIN_INVALID');
  const hash = window.location.hash;
  const nonce = /^#enroll=[a-f0-9]{64}$/.test(hash) ? hash.slice(8) : null;
  const opener = window.opener;
  const isEnrollment = Boolean(nonce && opener);
  // Enrollment material is public, but remove it before subsequent page activity.
  if (hash.startsWith('#enroll=')) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  let expiresAt = Date.now() + duration, attempted = false, receivedKey = false, receivedPayload, closed = false, completed = false, port, timer, rejectPayload;
  const controller = new AbortController();
  let externalSignal, externalAbort;
  const clear = () => {
    clearTimeout(timer); port?.close(); port = undefined;
    window.removeEventListener('message', receiveChannel); window.removeEventListener('message', receiveCancel); window.removeEventListener('pagehide', dispose);
    externalSignal?.removeEventListener('abort', externalAbort);
  };
  const stop = code => {
    if (closed || completed) return;
    closed = true;
    receivedPayload?.privateKey.fill(0);
    try { port?.postMessage({ kind: 'failed', code }); } catch { /* caller gone */ }
    const error = fail(code); error.recordMayExist = receivedKey;
    controller.abort(error); rejectPayload?.(error); clear(); emit(onState, 'failed', code);
  };
  function dispose() { stop('OPERATION_CANCELLED'); }
  function receiveCancel(event) {
    if (messageMatches(event, { origin: original.origin, source: opener, nonce }, 'cancel')) stop('OPERATION_CANCELLED');
  }
  let resolvePayload;
  function receiveChannel(event) {
    if (closed || !attempted || port || Date.now() >= expiresAt || !messageMatches(event, { origin: original.origin, source: opener, nonce }, 'channel') || event.ports?.length !== 1) return;
    port = event.ports[0]; window.removeEventListener('message', receiveChannel);
    port.onmessage = event => {
      const value = event.data;
      if (closed || Date.now() >= expiresAt) { value?.privateKey?.fill?.(0); return; }
      const valid = exact(value, ['kind', 'config', 'privateKey', 'expectedOwner', 'expiresAt']) && value.kind === 'account'
        && value.privateKey instanceof Uint8Array && value.privateKey.length === 32
        && typeof value.expectedOwner === 'string' && /^0x[0-9a-f]{40}$/.test(value.expectedOwner)
        && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + MAX_TIMEOUT
        && exact(value.config, CONFIG_FIELDS) && CONFIG_FIELDS.every(name => value.config[name] === config[name]);
      if (!valid) { value?.privateKey?.fill?.(0); stop('HANDOFF_INVALID'); return; }
      receivedKey = true; receivedPayload = value;
      port.onmessage = event => { event.data?.privateKey?.fill?.(0); }; // one transfer only
      expiresAt = Math.min(expiresAt, value.expiresAt); clearTimeout(timer);
      timer = setTimeout(() => stop('SETUP_EXPIRED'), Math.max(0, expiresAt - Date.now()));
      resolvePayload(value);
    };
    port.start();
  }
  if (isEnrollment) {
    timer = setTimeout(() => stop('SETUP_EXPIRED'), duration);
    window.addEventListener('message', receiveCancel); window.addEventListener('pagehide', dispose, { once: true });
    emit(onState, 'available');
  }
  function active() { if (closed || controller.signal.aborted) throw controller.signal.reason ?? fail('OPERATION_CANCELLED'); if (Date.now() >= expiresAt) throw fail('SETUP_EXPIRED'); }
  async function prepare({ store, user, webAuthnClient, signal } = {}) {
    check(isEnrollment, 'ENROLLMENT_UNAVAILABLE'); check(!attempted, 'RESERVE_ALREADY_ATTEMPTED'); active();
    check(store && typeof store.get === 'function' && typeof store.putIfAbsent === 'function', 'STORE_INVALID');
    check(user && typeof user.name === 'string' && user.name.trim().length > 0 && user.name.length <= 128 && typeof user.displayName === 'string' && user.displayName.trim().length > 0 && user.displayName.length <= 128, 'USER_INVALID');
    check(!signal?.aborted, 'OPERATION_CANCELLED'); attempted = true;
    externalSignal = signal; externalAbort = dispose; signal?.addEventListener('abort', externalAbort, { once: true });
    const ceremony = createWebAuthnScope({ webAuthnClient, signal: controller.signal, timeoutMs: Math.max(1, expiresAt - Date.now()) });
    webAuthnClient = ceremony.client;
    let rejectCancelled;
    const cancelled = new Promise((_, no) => { rejectCancelled = no; });
    const cancelListener = () => rejectCancelled(controller.signal.reason ?? fail('OPERATION_CANCELLED'));
    controller.signal.addEventListener('abort', cancelListener, { once: true });
    const work = (async () => {
      let credential, payload;
      try {
        emit(onState, 'creating-credential');
        active();
        credential = await createReserveCredential({ config, user, webAuthnClient, signal: controller.signal, timeoutMs: Math.max(1, expiresAt - Date.now()) });
        active();
        payload = await new Promise((yes, no) => {
          resolvePayload = yes; rejectPayload = no;
          window.addEventListener('message', receiveChannel);
          opener.postMessage({ version: 1, kind: 'receive', nonce }, original.origin);
        });
        rejectPayload = undefined; active(); emit(onState, 'preparing');
        const result = await prepareReserve({ privateKey: payload.privateKey, policy: { ...config, expectedOwner: payload.expectedOwner }, recoveryCredential: credential, store, webAuthnClient, signal: controller.signal });
        active();
        port.postMessage({ kind: 'prepared', result }); completed = true; clear(); emit(onState, 'ready'); return result;
      } catch (error) { stop(codeOf(error)); throw error; }
      finally { credential?.close(); payload?.privateKey.fill(0); ceremony.close(); }
    })();
    try { return await Promise.race([work, cancelled]); }
    finally { controller.signal.removeEventListener('abort', cancelListener); ceremony.close(); }
  }
  return Object.freeze({ isEnrollment, prepare, dispose });
}
