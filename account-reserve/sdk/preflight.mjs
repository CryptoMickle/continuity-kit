// Static, synchronous and read-only. Never creates credentials or probes a store.
const CONFIG_FIELDS = ['appId', 'originalRpId', 'recoveryRpId', 'derivation'];
function validConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...CONFIG_FIELDS].sort().join(',')) return false;
  if (typeof value.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.appId)) return false;
  if (typeof value.derivation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:./'_-]{0,191}$/.test(value.derivation)) return false;
  for (const field of ['originalRpId', 'recoveryRpId']) {
    if (typeof value[field] !== 'string' || value[field].length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value[field])) return false;
  }
  return value.originalRpId !== value.recoveryRpId;
}
function origin(value) {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  let parsed;
  try { parsed = new URL(value); } catch { return undefined; }
  if (parsed.origin !== value || parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) return undefined;
  const localhost = parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost');
  if (parsed.protocol !== 'https:' && !localhost) return undefined;
  return parsed;
}
function browserEnvironment() {
  return {
    origin: globalThis.location?.origin,
    isSecureContext: globalThis.isSecureContext,
    crypto: globalThis.crypto,
    navigator: globalThis.navigator,
    PublicKeyCredential: globalThis.PublicKeyCredential,
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
  };
}

/**
 * ok means only "none of the static checks failed". It does NOT certify PRF
 * support, physical passkeys, popup permission, server durability or recovery.
 * environment is an explicit synthetic-test snapshot; omit it in real clients.
 */
export function checkReserveEnvironment({ config, role, originalOrigin, recoveryOrigin, environment } = {}) {
  const env = environment ?? browserEnvironment();
  const checks = [];
  function check(id, pass, success, failure) { checks.push(Object.freeze({ id, status: pass ? 'pass' : 'fail', message: pass ? success : failure })); }
  const configurationValid = validConfig(config);
  check('config', configurationValid, 'Configuration has the supported four fields and distinct relying-party IDs.', 'Use only appId, originalRpId, recoveryRpId and derivation; relying-party IDs must be valid and distinct.');
  const roleValid = role === 'primary' || role === 'recovery';
  check('role', roleValid, 'Client role is explicit.', 'Set role to primary or recovery.');
  const a = origin(originalOrigin);
  const b = origin(recoveryOrigin);
  check('origins', Boolean(a && b && originalOrigin !== recoveryOrigin), 'Both configured origins are exact HTTPS or localhost origins.', 'Use two different exact origins, with HTTPS outside localhost and no path, query, credentials or fragment.');
  check('rp-origin-binding', Boolean(configurationValid && a && b && a.hostname === config.originalRpId && b.hostname === config.recoveryRpId), 'Each relying-party ID exactly matches its configured origin hostname.', 'Each relying-party ID must equal its configured origin hostname; shared parent-domain IDs are unsupported.');
  const expectedOrigin = role === 'primary' ? originalOrigin : role === 'recovery' ? recoveryOrigin : undefined;
  check('current-origin', Boolean(roleValid && a && b && env?.origin === expectedOrigin), 'This client is on its configured origin.', 'Serve this client on the exact origin configured for its role.');
  check('secure-context', env?.isSecureContext === true && Boolean(origin(env?.origin)), 'The current client reports a secure HTTPS or localhost context.', 'Use a secure browser context: HTTPS, or localhost for an explicitly local test.');
  const subtleMethods = ['digest', 'importKey', 'deriveBits', 'deriveKey', 'encrypt', 'decrypt'];
  check('web-crypto', typeof env?.crypto?.getRandomValues === 'function' && subtleMethods.every(method => typeof env?.crypto?.subtle?.[method] === 'function'), 'Required Web Crypto API methods are present.', 'This browser must provide secure random values and the required Web Crypto methods.');
  check('webauthn-api', typeof env?.PublicKeyCredential === 'function' && typeof env?.navigator?.credentials?.create === 'function' && typeof env?.navigator?.credentials?.get === 'function', 'WebAuthn API methods are present; credential and PRF support remain unverified.', 'WebAuthn credential creation and assertion APIs are not available in this environment.');
  check('transport-apis', ['fetch', 'AbortController', 'TextEncoder', 'TextDecoder'].every(name => typeof env?.[name] === 'function'), 'Required HTTP, cancellation and text encoding APIs are present.', 'This browser must provide fetch, AbortController, TextEncoder and TextDecoder.');
  checks.push(Object.freeze({ id: 'physical-passkey', status: 'unverified', message: 'Actual credential availability, PRF support and system prompt behavior require an explicit physical test. No credential operation was performed.' }));
  checks.push(Object.freeze({ id: 'storage-durability', status: 'unverified', message: 'Static checks cannot verify server reachability, atomic writes, retention, independent hosting or successful recovery. No storage request was made.' }));
  return Object.freeze({ ok: checks.every(item => item.status !== 'fail'), checks: Object.freeze(checks), physicalPasskey: 'unverified' });
}
