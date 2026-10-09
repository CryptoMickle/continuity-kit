import { createHash, createHmac } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { WORK_PROTOCOL, WORK_SCHEMA, validateWork } from '../sdk/work-reserve.mjs';

export const SAMPLE_WORK = Object.freeze({
  schema: WORK_SCHEMA,
  title: 'A calmer checkout',
  client: 'Studio North',
  brief: 'Show delivery costs before payment. Keep guest checkout available. This is a fictional developer drill.',
  deliverable: 'Keep the order summary visible. Still to finish: address-error and confirmation copy.',
  nextStep: 'Finish the two messages and export the client handoff.',
});

// Public deterministic test material. This is not WebAuthn/CTAP or a secure wallet.
// Never connect this fixture to a chain, put funds on its address or use real work.
export function createDrillFixture({ seed = 'public-continuity-work-drill-v1', work = SAMPLE_WORK, creationFallback = false } = {}) {
  if (typeof seed !== 'string' || !seed.length || seed.length > 128) throw new Error('FIXTURE_SEED_INVALID');
  const fixtureId = createHash('sha256').update(seed).digest('hex').slice(0, 16);
  const derive = purpose => createHmac('sha256', seed).update('synthetic-drill/' + purpose).digest();
  const privateKey = new Uint8Array(derive('unfunded-account'));
  privateKey[0] = 0; privateKey[31] |= 1;
  const owner = privateKeyToAccount('0x' + Buffer.from(privateKey).toString('hex')).address.toLowerCase();
  const prfKey = derive('credential-prf'), credentialId = derive('credential-id').subarray(0, 24);
  const config = Object.freeze({ appId: 'synthetic-work-drill-' + fixtureId, originalRpId: 'primary.drill.localhost', recoveryRpId: 'reserve.drill.localhost', derivation: 'public-synthetic-leaf:v1' });
  const workSalt = createHash('sha256').update(`${WORK_PROTOCOL}/bootstrap\0${config.appId}`).digest();
  const operations = {}, clients = [];
  let created = false, closed = false;
  function client(phase, { workOnly = false, credentialLost = false } = {}) {
    const counts = operations[phase] ??= { creates: 0, assertions: 0, accountPrfDenied: 0 };
    const adapter = {
      async createCredential(request) {
        counts.creates++;
        if (closed || request.rp?.id !== config.recoveryRpId || request.userVerification !== 'required') throw new Error('SYNTHETIC_SCOPE_REJECTED');
        created = true;
        return { credentialId: new Uint8Array(credentialId), prfEnabled: true, transports: ['internal'], ...(!creationFallback ? { prfOutput: new Uint8Array(createHmac('sha256', prfKey).update(request.prfSalt).digest()) } : {}) };
      },
      async getCredential(request) {
        counts.assertions++;
        if (closed || !created || credentialLost) throw new Error('SYNTHETIC_CREDENTIAL_MISSING');
        if (request.rpId !== config.recoveryRpId || request.userVerification !== 'required') throw new Error('SYNTHETIC_SCOPE_REJECTED');
        if (request.allowCredential && !Buffer.from(request.allowCredential.credentialId).equals(credentialId)) throw new Error('SYNTHETIC_CREDENTIAL_MISMATCH');
        if (workOnly && !Buffer.from(request.prfSalt).equals(workSalt)) { counts.accountPrfDenied++; throw new Error('ACCOUNT_VAULT_FORBIDDEN_IN_WORK_DRILL'); }
        return { credentialId: new Uint8Array(credentialId), prfOutput: new Uint8Array(createHmac('sha256', prfKey).update(request.prfSalt).digest()) };
      },
    };
    clients.push(adapter);
    return adapter;
  }
  return {
    fixtureId, config, owner, privateKey, work: validateWork(work), client,
    enrollmentToken: derive('local-enrollment').toString('base64url'),
    operations: () => structuredClone(operations),
    clientCount: () => clients.length,
    close() { closed = true; privateKey.fill(0); prfKey.fill(0); credentialId.fill(0); workSalt.fill(0); },
  };
}
