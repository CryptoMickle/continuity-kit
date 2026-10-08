import { randomBytes } from 'node:crypto';
import { createSecp256k1SigningSession, createSecretVaultWithExistingPasskey, decryptSecretVaultWithPasskey } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { prepareReserve, recoverReserve } from '../sdk/index.mjs';
import { syntheticAuthenticator } from './sdk-authenticator.mjs';

export function memoryStore() {
  const data = new Map();
  const calls = { get: 0, put: 0 };
  return {
    calls,
    async get(locator) { calls.get++; const value = data.get(locator); return value && new Uint8Array(value); },
    async putIfAbsent(locator, bytes) {
      calls.put++;
      if (data.has(locator)) return false;
      data.set(locator, new Uint8Array(bytes)); return true;
    },
    records() { return [...data].map(([locator, bytes]) => [locator, new Uint8Array(bytes)]); },
    replace(locator, bytes) { data.set(locator, new Uint8Array(bytes)); },
  };
}

export function makeSdkFixture(options = {}) {
  const config = Object.freeze(options.config ?? {
    appId: 'synthetic-sdk-account', originalRpId: 'a.example.localhost',
    recoveryRpId: 'b.example.localhost', derivation: 'synthetic-leaf:v1',
  });
  const auth = syntheticAuthenticator(config.originalRpId);
  const b = auth.add(config.recoveryRpId);
  const otherB = auth.add(config.recoveryRpId);
  const webAuthnClient = auth.client(config.recoveryRpId);
  const privateKey = new Uint8Array(options.privateKey ?? randomBytes(32));
  const primary = createSecp256k1SigningSession({ privateKey });
  const originalAccount = toViemAccount(primary);
  const policy = Object.freeze({ ...config, expectedOwner: originalAccount.address.toLowerCase() });
  const store = memoryStore();
  const opened = new Set();
  const track = (value) => { opened.add(value); return value; };
  return {
    config, policy, store, webAuthnClient, b, otherB, originalAccount,
    stats: () => ({ ...auth.stats }),
    closeOriginal() { primary.end(); privateKey.fill(0); },
    newRecoveryClient: () => auth.client(config.recoveryRpId),
    wrongRpClient: () => auth.client(config.originalRpId),
    loseB() { auth.forget(b); },
    async prepare(overrides = {}, implementation = prepareReserve) {
      return implementation({ privateKey, policy, recoveryCredential: b, webAuthnClient, store, ...overrides });
    },
    async recover(overrides = {}, implementation = recoverReserve) {
      return track(await implementation({ config, webAuthnClient, store, ...overrides }));
    },
    async exportEncryptedBaseline() {
      const header = new TextEncoder().encode(JSON.stringify({ format: 'competent-key-export/v1', config, owner: policy.expectedOwner }));
      const secret = new Uint8Array(4 + header.length + 32);
      new DataView(secret.buffer).setUint32(0, header.length, false);
      secret.set(header, 4); secret.set(privateKey, 4 + header.length);
      try {
        const vault = await createSecretVaultWithExistingPasskey({ secret, rpId: config.recoveryRpId, credential: b, webAuthnClient });
        return new TextEncoder().encode(JSON.stringify(vault));
      } finally { secret.fill(0); }
    },
    async importEncryptedBaseline(bytes) {
      const vault = JSON.parse(new TextDecoder().decode(bytes));
      const secret = await decryptSecretVaultWithPasskey({ vault, rpId: config.recoveryRpId, webAuthnClient });
      let leaf; let session;
      try {
        if (secret.length < 37) throw new Error('BASELINE_INVALID');
        const length = new DataView(secret.buffer, secret.byteOffset, secret.byteLength).getUint32(0, false);
        if (length + 36 !== secret.length) throw new Error('BASELINE_INVALID');
        const header = JSON.parse(new TextDecoder().decode(secret.subarray(4, 4 + length)));
        if (header.format !== 'competent-key-export/v1' || JSON.stringify(header.config) !== JSON.stringify(config)) throw new Error('BASELINE_INVALID');
        leaf = secret.slice(4 + length);
        session = createSecp256k1SigningSession({ privateKey: leaf });
        const account = toViemAccount(session);
        if (account.address.toLowerCase() !== header.owner) throw new Error('BASELINE_OWNER_MISMATCH');
        return track({ session, account, owner: account.address.toLowerCase(), close: () => session.end() });
      } catch (error) { session?.end(); throw error; }
      finally { secret.fill(0); leaf?.fill(0); }
    },
    cleanup() { primary.end(); for (const signer of opened) signer.close(); privateKey.fill(0); auth.cleanup(); },
  };
}
