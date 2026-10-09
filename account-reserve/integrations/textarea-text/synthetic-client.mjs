// Explicit local test adapter. The browser never calls navigator.credentials.
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export function syntheticClient(fetcher) {
  async function call(input, action) {
    const response = await fetcher('/api/synthetic', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, rpId: input.rp?.id ?? input.rpId,
        salt: Array.from(input.prfSalt, b => b.toString(16).padStart(2, '0')).join(''),
        credentialId: input.allowCredential ? encode(input.allowCredential.credentialId) : undefined }),
    });
    if (!response.ok) throw new Error('LOCAL_SYNTHETIC_CREDENTIAL_UNAVAILABLE');
    const value = await response.json();
    return { credentialId: decode(value.credentialId), prfOutput: decode(value.prfOutput), prfEnabled: true };
  }
  return Object.freeze({ createCredential: input => call(input, 'create'), getCredential: input => call(input, 'get') });
}
