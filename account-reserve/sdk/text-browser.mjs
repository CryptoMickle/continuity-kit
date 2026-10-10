import { createTextReserveCredential, selectTextReserveCredential, prepareTextReserve, validateText, TEXT_PROTOCOL } from './text-reserve.mjs';
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

/** Call synchronously from a user click. This flow transports text only. */
export function startTextReserveSetup({ config: supplied, originalOrigin, recoveryUrl, text: suppliedText, signal, onState, timeoutMs, window: suppliedWindow }) {
  const config = configCopy(supplied), window = browser(suppliedWindow), timeout = duration(timeoutMs);
  const original = trustedOrigin(originalOrigin), current = trustedUrl(window.location.href), target = trustedUrl(recoveryUrl);
  check(current.origin === original.origin && original.origin !== config.recoveryOrigin && original.hostname !== config.recoveryRpId, 'ORIGIN_INVALID');
  check(target.origin === config.recoveryOrigin && !target.hash, 'ORIGIN_INVALID');
  check(!signal?.aborted, 'OPERATION_CANCELLED');
  let text = validateText(suppliedText);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
  target.hash = 'text-enroll=' + nonce;
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
  const stop = code => {
    if (phase === 'ready' || phase === 'failed') return;
    const recordMayExist = phase === 'transferred'; phase = 'failed';
    try { popup.postMessage({ version: 1, kind: 'cancel', nonce }, target.origin); } catch { /* popup gone */ }
    clean(); emit(onState, 'failed', code); const error = fail(code); error.recordMayExist = recordMayExist; reject(error);
  };
  function abort() { stop('OPERATION_CANCELLED'); }
  function pagehide() { stop('OPERATION_CANCELLED'); }
  function receive(event) {
    if (phase !== 'waiting' || Date.now() >= expiresAt) return;
    if (event.origin === target.origin && event.source === popup && exact(event.data, ['version', 'kind', 'nonce', 'code'])
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
        if (exact(message, ['kind', 'code']) && message.kind === 'failed' && /^[A-Z][A-Z0-9_]{1,63}$/.test(message.code)) { stop(message.code); return; }
        if (!exact(message, ['kind', 'result']) || message.kind !== 'prepared') return;
        let digest; try { digest = await digestPromise; } catch { stop('HANDOFF_FAILED'); return; }
        if (phase !== 'transferred') return;
        if (signal?.aborted) { stop('OPERATION_CANCELLED'); return; }
        if (Date.now() >= expiresAt) { stop('SETUP_EXPIRED'); return; }
        if (!ready(message.result, text, digest)) { stop('HANDOFF_INVALID'); return; }
        const result = Object.freeze({ ...message.result }); phase = 'ready'; clean(); emit(onState, 'ready'); resolve(result);
      };
      port.start(); popup.postMessage({ version: 1, kind: 'channel', nonce }, target.origin, [channel.port2]);
      port.postMessage({ kind: 'text', config, text, expiresAt }); emit(onState, 'preparing');
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
export function createTextReserveReceiver({ config: supplied, originalOrigin, onState, timeoutMs, window: suppliedWindow }) {
  const config = configCopy(supplied), window = browser(suppliedWindow), timeout = duration(timeoutMs);
  const original = trustedOrigin(originalOrigin);
  check(trustedUrl(window.location.href).origin === config.recoveryOrigin && original.origin !== config.recoveryOrigin && original.hostname !== config.recoveryRpId, 'ORIGIN_INVALID');
  const hash = window.location.hash, nonce = /^#text-enroll=[a-f0-9]{64}$/.test(hash) ? hash.slice(13) : null;
  const opener = window.opener, isEnrollment = Boolean(nonce && opener);
  if (hash.startsWith('#text-enroll=')) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  let expiresAt = Date.now() + timeout, attempted = false, received = false, payload, closed = false, completed = false, port, timer, resolvePayload, rejectPayload;
  let externalSignal, externalAbort;
  const controller = new AbortController();
  const clear = () => {
    clearTimeout(timer); port?.close(); port = undefined; payload = undefined;
    window.removeEventListener('message', receiveChannel); window.removeEventListener('message', receiveCancel); window.removeEventListener('pagehide', dispose);
    externalSignal?.removeEventListener('abort', externalAbort);
  };
  const stop = code => {
    if (closed || completed) return;
    closed = true; const error = fail(code); error.recordMayExist = received;
    try {
      if (port) port.postMessage({ kind: 'failed', code });
      else if (isEnrollment) opener.postMessage({ version: 1, kind: 'failed', nonce, code }, original.origin);
    } catch { /* caller gone */ }
    controller.abort(error); rejectPayload?.(error); clear(); emit(onState, 'failed', code);
  };
  function dispose() { stop('OPERATION_CANCELLED'); }
  function receiveCancel(event) { if (matches(event, original.origin, opener, nonce, 'cancel')) stop('OPERATION_CANCELLED'); }
  function receiveChannel(event) {
    if (closed || !attempted || port || Date.now() >= expiresAt || !matches(event, original.origin, opener, nonce, 'channel') || event.ports?.length !== 1) return;
    port = event.ports[0]; window.removeEventListener('message', receiveChannel);
    port.onmessage = event => {
      if (closed || Date.now() >= expiresAt) return;
      const value = event.data;
      if (!exact(value, ['kind', 'config', 'text', 'expiresAt']) || value.kind !== 'text'
        || !exact(value.config, FIELDS) || !FIELDS.every(field => value.config[field] === config[field])
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
  async function prepare({ store, user, credentialMode = 'create', webAuthnClient, signal } = {}) {
    check(isEnrollment, 'ENROLLMENT_UNAVAILABLE'); check(!attempted, 'RESERVE_ALREADY_ATTEMPTED'); active();
    check(store && typeof store.get === 'function' && typeof store.putIfAbsent === 'function', 'STORE_INVALID');
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
        const result = await prepareTextReserve({ config, recoveryCredential: credential, text: receivedPayload.text, store, webAuthnClient, signal: controller.signal });
        active(); port.postMessage({ kind: 'prepared', result }); completed = true; clear(); emit(onState, 'ready'); return result;
      } catch (error) { stop(codeOf(error)); throw error; }
      finally { credential?.close(); receivedPayload = undefined; ceremony.close(); }
    })();
    try { return await Promise.race([work, cancelled]); }
    finally { controller.signal.removeEventListener('abort', cancelListener); ceremony.close(); }
  }
  return Object.freeze({ isEnrollment, prepare, dispose });
}
