import { createHash } from 'node:crypto';
import { getPasskeyPrfOutput, createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { makeSdkFixture } from './sdk-fixture.mjs';
import { syntheticAuthenticator } from './sdk-authenticator.mjs';

const metadata = {
  iris: {
    source: 'https://github.com/vmlechko/Iris/blob/3a1244c418c0f8308ec95a56383c2509965ebb70/lib/account.ts',
    derivation: 'iris.account.v1:sha256-salt:prf-output-as-secp256k1-key',
    description: 'SHA256(iris.account.v1) PRF salt; namespace output is EOA leaf key.',
  },
  accrue: {
    source: 'https://github.com/pauleke65/accrue/blob/ab1d8580f339addaa02ea118e89ba4b89627e926/lib/mera-account.ts',
    derivation: "accrue-v1:mera-default-prf:bip39-en:bip32:m/44'/60'/0'/0/1:role-worker",
    description: 'Mera default PRF salt; English BIP39; BIP32 worker leaf m/44\'/60\'/0\'/0/1.',
  },
};
async function useLeaf(kind, output, use) {
  if (kind === 'iris') return use(output);
  const seed = mnemonicToSeedSync(entropyToMnemonic(output, wordlist));
  let master; let leaf; let key;
  try {
    master = HDKey.fromMasterSeed(seed); leaf = master.derive("m/44'/60'/0'/0/1");
    if (!leaf.privateKey) throw new Error('SYNTHETIC_DERIVATION_FAILED');
    key = new Uint8Array(leaf.privateKey);
    return await use(key);
  } finally { key?.fill(0); leaf?.wipePrivateData(); master?.wipePrivateData(); seed.fill(0); }
}

export async function makeDerivedSdkFixture(kind) {
  if (!Object.hasOwn(metadata, kind)) throw new Error('UNKNOWN_DERIVATION_FIXTURE');
  const config = Object.freeze({
    appId: `source-derived-${kind}`, originalRpId: `${kind}-a.localhost`, recoveryRpId: `${kind}-b.localhost`,
    derivation: metadata[kind].derivation,
  });
  const sourceAuth = syntheticAuthenticator(config.originalRpId);
  const sourceCredential = sourceAuth.add(config.originalRpId);
  let sourceAvailable = true;
  const sourceClient = sourceAuth.client(config.originalRpId, () => sourceAvailable);
  const salt = kind === 'iris' ? new Uint8Array(createHash('sha256').update('iris.account.v1').digest()) : undefined;
  const getPrf = () => getPasskeyPrfOutput({ rpId: config.originalRpId, credential: sourceCredential, ...(salt ? { prfSalt: salt } : {}), webAuthnClient: sourceClient });
  const result = await getPrf();
  let base;
  const restoredSessions = new Set();
  try { base = await useLeaf(kind, result.prfOutput, async (privateKey) => makeSdkFixture({ config, privateKey })); }
  catch (error) { sourceAuth.cleanup(); throw error; }
  finally { result.prfOutput.fill(0); }
  return {
    ...base,
    derivationEvidence: Object.freeze({ ...metadata[kind], execution: 'source-inspected independent fixture; NOT unmodified app or integration', scure: kind === 'accrue' ? '2.4.0' : null }),
    stats() { return { ...base.stats(), originalRequests: sourceAuth.stats.originalRequests }; },
    closeOriginal() { sourceAvailable = false; base.closeOriginal(); for (const session of restoredSessions) session.end(); },
    async baselineRestoreOriginal() {
      const prf = await getPrf();
      try {
        return await useLeaf(kind, prf.prfOutput, async (privateKey) => {
          const session = createSecp256k1SigningSession({ privateKey }); restoredSessions.add(session);
          const account = toViemAccount(session);
          return { session, account, owner: account.address.toLowerCase(), close: () => session.end() };
        });
      } finally { prf.prfOutput.fill(0); }
    },
    cleanup() { base.cleanup(); for (const session of restoredSessions) session.end(); sourceAuth.cleanup(); salt?.fill(0); },
  };
}
