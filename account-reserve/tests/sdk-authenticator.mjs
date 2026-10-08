import { randomBytes } from 'node:crypto';

// TEST ONLY: independent RAM oracle, not browser WebAuthn or CTAP emulation.
export function syntheticAuthenticator(originalRpId) {
  const records = new Map();
  const stats = { originalRequests: 0, recoveryRequests: 0, creates: 0 };
  function add(rpId) {
    const credentialId = randomBytes(24).toString('base64url');
    records.set(credentialId, { rpId, outputs: new Map() });
    return Object.freeze({ credentialId });
  }
  function client(originRpId, available = () => true) {
    return {
      async createCredential() { stats.creates++; throw new Error('SYNTHETIC_CREATION_DISABLED'); },
      async getCredential(request) {
        if (originRpId === originalRpId) stats.originalRequests++; else stats.recoveryRequests++;
        if (!available()) throw new Error('SYNTHETIC_ORIGINAL_UNAVAILABLE');
        if (request.rpId !== originRpId) throw new Error('SYNTHETIC_RP_SCOPE_REJECTED');
        const id = request.allowCredential
          ? Buffer.from(request.allowCredential.credentialId).toString('base64url')
          : [...records].find(([, record]) => record.rpId === request.rpId)?.[0];
        const record = records.get(id);
        if (!record || record.rpId !== request.rpId) throw new Error('SYNTHETIC_CREDENTIAL_MISSING');
        const salt = Buffer.from(request.prfSalt).toString('hex');
        if (!record.outputs.has(salt)) record.outputs.set(salt, new Uint8Array(randomBytes(32)));
        return { credentialId: new Uint8Array(Buffer.from(id, 'base64url')), prfOutput: new Uint8Array(record.outputs.get(salt)) };
      },
    };
  }
  function forget(credential) {
    for (const output of records.get(credential.credentialId)?.outputs.values() ?? []) output.fill(0);
    records.delete(credential.credentialId);
  }
  function cleanup() { for (const id of [...records.keys()]) forget({ credentialId: id }); }
  return { add, client, forget, stats, cleanup };
}
