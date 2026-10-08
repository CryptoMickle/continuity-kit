// Mera 0.2 exposes a WebAuthnClient adapter but does not forward AbortSignal.
// Keep cancellation here, at the native boundary, instead of merely abandoning
// a promise while a system prompt and its result remain live.
const MAX_TIMEOUT_MS = 300000;
const failure = code => Object.assign(new Error(code), { name: 'ReserveError', code });

function clearOutput(value) {
  try { value?.prfOutput?.fill(0); } catch { /* A detached output is already inaccessible. */ }
}
function bytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw failure('PRF_UNAVAILABLE');
}
function nativeCredential(value) {
  if (value?.type !== 'public-key' || !(value.rawId instanceof ArrayBuffer)
    || typeof value.getClientExtensionResults !== 'function') throw failure('PASSKEY_OPERATION_FAILED');
  return value;
}
function nativeClient(signal) {
  return {
    async createCredential(request) {
      const credential = nativeCredential(await globalThis.navigator?.credentials?.create({
        signal,
        publicKey: {
          rp: request.rp, user: request.user, challenge: request.challenge,
          pubKeyCredParams: request.algorithms.map(alg => ({ type: 'public-key', alg })),
          timeout: request.timeout, attestation: request.attestation,
          authenticatorSelection: { residentKey: request.residentKey, requireResidentKey: true, userVerification: request.userVerification },
          extensions: { prf: { eval: { first: request.prfSalt } } },
        },
      }));
      const prf = credential.getClientExtensionResults().prf;
      const transports = credential.response?.getTransports?.();
      return {
        credentialId: new Uint8Array(credential.rawId), prfEnabled: prf?.enabled === true,
        ...(transports === undefined ? {} : { transports }),
        ...(prf?.results?.first === undefined ? {} : { prfOutput: bytes(prf.results.first) }),
      };
    },
    async getCredential(request) {
      const credential = nativeCredential(await globalThis.navigator?.credentials?.get({
        signal,
        publicKey: {
          rpId: request.rpId, challenge: request.challenge, timeout: request.timeout,
          userVerification: request.userVerification,
          extensions: { prf: { eval: { first: request.prfSalt } } },
          ...(request.allowCredential ? { allowCredentials: [{
            type: 'public-key', id: request.allowCredential.credentialId,
            ...(request.allowCredential.transports === undefined ? {} : { transports: request.allowCredential.transports }),
          }] } : {}),
        },
      }));
      const first = credential.getClientExtensionResults().prf?.results?.first;
      return { credentialId: new Uint8Array(credential.rawId), ...(first === undefined ? {} : { prfOutput: bytes(first) }) };
    },
  };
}

/** One bounded operation; constructing a scope never requests a credential.
 * close() cancels pending work and erases adapter-owned PRF outputs. Mera copies
 * these outputs; callers must still wipe their own returned PRF/key buffers.
 * A custom client may ignore cancellation; its late output is discarded/wiped.
 */
export function createWebAuthnScope({ webAuthnClient, signal, timeoutMs = MAX_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw failure('TIMEOUT_INVALID');
  if (webAuthnClient && ['createCredential', 'getCredential'].some(name => typeof webAuthnClient[name] !== 'function')) throw failure('WEBAUTHN_CLIENT_INVALID');
  const controller = new AbortController();
  const outputs = new Set();
  const deadline = Date.now() + timeoutMs;
  let timer;
  const cleanOutputs = () => { for (const result of outputs) clearOutput(result); outputs.clear(); };
  const stop = code => {
    if (!controller.signal.aborted) controller.abort(failure(code));
    clearTimeout(timer); signal?.removeEventListener('abort', externalAbort); cleanOutputs();
  };
  const externalAbort = () => stop('OPERATION_CANCELLED');
  const assertActive = () => {
    if (!controller.signal.aborted && Date.now() >= deadline) stop('OPERATION_TIMED_OUT');
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  signal?.addEventListener('abort', externalAbort, { once: true });
  timer = setTimeout(() => stop('OPERATION_TIMED_OUT'), timeoutMs);
  if (signal?.aborted) externalAbort();
  const adapter = webAuthnClient ?? nativeClient(controller.signal);

  function invoke(method, request) {
    try { assertActive(); } catch (error) { return Promise.reject(error); }
    const remaining = Math.max(1, deadline - Date.now());
    const timeout = Number.isFinite(request.timeout) ? Math.max(1, Math.min(request.timeout, remaining)) : remaining;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = () => { if (!settled) { settled = true; reject(controller.signal.reason); } };
      controller.signal.addEventListener('abort', cancel, { once: true });
      let work;
      try {
        // Invoke synchronously to retain the original click's user activation.
        work = adapter[method]({ ...request, timeout });
      } catch (error) { work = Promise.reject(error); }
      Promise.resolve(work).then(result => {
        controller.signal.removeEventListener('abort', cancel);
        if (settled || controller.signal.aborted || Date.now() >= deadline) {
          clearOutput(result);
          if (!settled) { settled = true; stop('OPERATION_TIMED_OUT'); reject(controller.signal.reason); }
          return;
        }
        outputs.add(result); settled = true; resolve(result);
      }, error => {
        controller.signal.removeEventListener('abort', cancel);
        if (!settled) { settled = true; reject(controller.signal.aborted ? controller.signal.reason : error); }
      });
      if (controller.signal.aborted) cancel();
    });
  }
  return Object.freeze({
    client: Object.freeze({ createCredential: request => invoke('createCredential', request), getCredential: request => invoke('getCredential', request) }),
    signal: controller.signal,
    assertActive,
    close: () => stop('OPERATION_CANCELLED'),
  });
}
