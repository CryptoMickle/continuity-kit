import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPasskeyWithPrfOutput, createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { verifyMessage } from 'viem';
import { prepareReserve, recoverReserve } from '@continuitykit/account-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { startStarter } from './server.mjs';
import { createSyntheticClient } from './synthetic-client.mjs';
import { loopbackFetch } from './loopback-fetch.mjs';

// This clean consumer uses only installed public APIs and shipped starter files.
const app = await startStarter({ primaryPort: 4773, recoveryPort: 4774 });
let key, primarySession, opened;
try {
  const a = loopbackFetch(app.originalOrigin), b = loopbackFetch(app.recoveryOrigin);
  const initial = await (await b('/api/config')).json();
  const original = await createPasskeyWithPrfOutput({ rp: { id: app.config.originalRpId, name: 'Synthetic starter A' }, user: { name: 'synthetic-account', displayName: 'Synthetic account' }, webAuthnClient: createSyntheticClient(a) });
  key = new Uint8Array(original.prfOutput); original.prfOutput.fill(0);
  primarySession = createSecp256k1SigningSession({ privateKey: key });
  const owner = toViemAccount(primarySession).address.toLowerCase();
  const credential = await createPasskeyWithPrfOutput({ rp: { id: app.config.recoveryRpId, name: 'Synthetic starter B' }, user: { name: 'synthetic-reserve', displayName: 'Synthetic reserve' }, webAuthnClient: createSyntheticClient(b) });
  credential.prfOutput.fill(0);
  const store = createReserveHttpStore({ enrollmentToken: initial.enrollmentToken, fetcher: b });
  const prepared = await prepareReserve({ privateKey: key, policy: { ...app.config, expectedOwner: owner }, recoveryCredential: { credentialId: credential.credentialId }, webAuthnClient: createSyntheticClient(b), store });
  assert.equal(prepared.independentlyVerified, true);
  key.fill(0); key = undefined; primarySession.end(); primarySession = undefined;
  store.clearEnrollmentCapability();
  await b('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: false }) });
  assert.equal((await a('/api/config')).status, 503);
  const before = await (await b('/api/status')).json();
  // No original owner, locator, credential ID, capsule, or A service is passed.
  opened = await recoverReserve({ config: app.config, webAuthnClient: createSyntheticClient(b), store: createReserveHttpStore({ fetcher: b }) });
  const challenge = 'SYNTHETIC STARTER ONLY ' + randomBytes(32).toString('hex');
  assert.equal(opened.owner, owner);
  assert.equal(await verifyMessage({ address: owner, message: challenge, signature: await opened.account.signMessage({ message: challenge }) }), true);
  opened.close();
  await assert.rejects(() => opened.account.signMessage({ message: challenge }));
  const after = await (await b('/api/status')).json();
  assert.equal(after.counts.primary, before.counts.primary);
  assert.equal(after.counts.writes, 1);
  console.log(JSON.stringify({ success: true, mode: 'synthetic-local-only', installedPublicSdk: true, sameExistingAccount: true, originalUnavailable: true, originalRequestsDuringRecovery: 0, freshRecoveryWithoutHints: true, verifiedChallenge: true, signerClosed: true, externalIntegration: false, browserHandoff: 'not exercised by this Node test; see separate browser evidence', physicalPasskeys: false }));
} finally { opened?.close(); primarySession?.end(); key?.fill(0); await app.close(); }
