// LOCAL SIMULATION ONLY. Never deploy this adapter or its server endpoint.
const encode = value => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
export function syntheticClient(fetcher) {
  async function call(input, action) {
    const response = await fetcher('/api/synthetic', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, rpId: input.rp?.id ?? input.rpId,
        salt: Array.from(input.prfSalt, byte => byte.toString(16).padStart(2, '0')).join(''),
        ...(input.allowCredential ? { credentialId: encode(input.allowCredential.credentialId) } : {}) }) });
    if (!response.ok) throw Object.assign(new Error('SYNTHETIC_CREDENTIAL_UNAVAILABLE'), { code: 'SYNTHETIC_CREDENTIAL_UNAVAILABLE' });
    const value = await response.json();
    return { credentialId: decode(value.credentialId), prfOutput: decode(value.prfOutput), prfEnabled: true };
  }
  return Object.freeze({ createCredential: input => call(input, 'create'), getCredential: input => call(input, 'get') });
}
