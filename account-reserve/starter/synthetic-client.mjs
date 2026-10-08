// LOCAL EXAMPLE ONLY. Never deploy this authenticator or its server endpoints.
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = s => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export function createSyntheticClient(fetcher = fetch) {
  async function request(input, action) {
    const response = await fetcher('/api/synthetic', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, rpId: input.rp?.id ?? input.rpId, salt: Array.from(input.prfSalt, b => b.toString(16).padStart(2, '0')).join(''), credentialId: input.allowCredential ? encode(input.allowCredential.credentialId) : undefined }),
    });
    if (!response.ok) throw new Error('SYNTHETIC_CREDENTIAL_UNAVAILABLE');
    const value = await response.json();
    return { credentialId: decode(value.credentialId), prfOutput: decode(value.prfOutput), prfEnabled: true };
  }
  return { createCredential: input => request(input, 'create'), getCredential: input => request(input, 'get') };
}
