// LOCAL SIMULATION ONLY. Never deploy this adapter or its server endpoint.
const encode = value => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
const knownErrors = new Map([
  ['CREDENTIAL_MISSING', 404], ['ROUTE_UNAVAILABLE', 404], ['HOST_REJECTED', 421],
  ['ORIGIN_REJECTED', 403], ['ONE_LOCAL_CREDENTIAL_PER_RUN', 409],
  ['LOCAL_REQUEST_FAILED', 400], ['PRIMARY_OFFLINE', 503],
]);
const unavailable = () => Object.assign(new Error('SYNTHETIC_CREDENTIAL_UNAVAILABLE'), { code: 'SYNTHETIC_CREDENTIAL_UNAVAILABLE' });
// Read a bounded local response; no raw response or request material goes to diagnostics.
async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 4096) { await reader.cancel(); throw unavailable(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { reader.releaseLock(); }
}
export function syntheticClient(fetcher, { onDiagnostic } = {}) {
  async function call(input, action) {
    const report = (kind, status, error) => {
      try { onDiagnostic?.(Object.freeze({ kind, method: 'POST', path: '/api/synthetic', action, status, error })); } catch { /* Diagnostics cannot change the credential outcome. */ }
    };
    let response;
    try {
      response = await fetcher('/api/synthetic', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, rpId: input.rp?.id ?? input.rpId,
          salt: Array.from(input.prfSalt, byte => byte.toString(16).padStart(2, '0')).join(''),
          ...(input.allowCredential ? { credentialId: encode(input.allowCredential.credentialId) } : {}) }) });
    } catch { report('network', null, 'NETWORK_UNAVAILABLE'); throw unavailable(); }
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
    let value;
    try { value = await boundedJson(response); } catch { /* Unknown or malformed content stays private. */ }
    if (!response.ok) {
      const error = value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 1 && knownErrors.get(value.error) === status ? value.error : 'UNRECOGNIZED_RESPONSE';
      report('http', status, error); throw unavailable();
    }
    try {
      const valid = text => typeof text === 'string' && text.length <= 1400 && /^[A-Za-z0-9_-]+$/.test(text) && encode(decode(text)) === text;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'credentialId,prfOutput'
        || !valid(value.credentialId) || !valid(value.prfOutput)) throw unavailable();
      const credentialId = decode(value.credentialId), prfOutput = decode(value.prfOutput);
      if (credentialId.length < 1 || credentialId.length > 1024 || prfOutput.length !== 32) throw unavailable();
      return { credentialId, prfOutput, prfEnabled: true };
    } catch { report('invalid-response', status, 'INVALID_RESPONSE'); throw unavailable(); }
  }
  return Object.freeze({ createCredential: input => call(input, 'create'), getCredential: input => call(input, 'get') });
}
