import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { startWorkDemo } from '../work/server.mjs';
import { loopbackFetch } from '../starter/loopback-fetch.mjs';
import { createSyntheticClient } from '../starter/synthetic-client.mjs';
import { createReserveHttpStore } from '../sdk/http-store.mjs';
import { createWorkReserveCredential, prepareWorkReserve, recoverWorkReserve } from '../sdk/work-reserve.mjs';

const work = { schema: 'continuity-work/brief-v1', title: 'Client delivery', client: 'Example studio', brief: 'Carry the private brief across app failure.', deliverable: 'The final correction belongs in this version.', nextStep: 'Finish the handoff and export.' };

test('independent HTTP origin recovers useful private work while primary is unavailable, without opening signing access', async () => {
  const app = await startWorkDemo({ primaryPort: 5183, recoveryPort: 5184 });
  const key = new Uint8Array(randomBytes(32)); let credential, recovered, unlocked;
  try {
    const original = loopbackFetch(app.originalOrigin), fetcher = loopbackFetch(app.recoveryOrigin);
    const env = await (await fetcher('/api/config')).json();
    assert.equal(env.synthetic, true);
    const auth = createSyntheticClient(fetcher), store = createReserveHttpStore({ fetcher, enrollmentToken: env.enrollmentToken });
    const expectedOwner = privateKeyToAccount('0x' + Buffer.from(key).toString('hex')).address.toLowerCase();
    credential = await createWorkReserveCredential({ config: app.config, user: { name: 'Work test', displayName: 'Work test' }, webAuthnClient: auth });
    const prepared = await prepareWorkReserve({ privateKey: key, policy: { ...app.config, expectedOwner }, work, recoveryCredential: credential, store, webAuthnClient: auth });
    credential.close(); credential = null; key.fill(0);
    assert.equal(prepared.independentlyVerified, true);
    // The public transport contains ciphertext, not private work or the account leaf.
    const ciphertext = await (await fetcher('/api/reserve/' + prepared.locator)).json();
    assert.equal(JSON.stringify(ciphertext).includes(work.deliverable), false);
    assert.equal(Buffer.from(ciphertext.bytes, 'base64url').toString().includes(work.deliverable), false);
    await fetcher('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: false }) });
    assert.equal((await original('/api/config')).status, 503);
    const before = await (await fetcher('/api/status')).json();
    // New read-only store and fresh SDK call carry no locator, address or old session.
    recovered = await recoverWorkReserve({ config: app.config, store: createReserveHttpStore({ fetcher }), webAuthnClient: createSyntheticClient(fetcher) });
    assert.deepEqual(recovered.work, work); assert.equal(recovered.owner, expectedOwner);
    assert.equal('account' in recovered, false); assert.equal('session' in recovered, false);
    const localEdit = { ...recovered.work, deliverable: 'Ready to send; local export only.' };
    assert.equal(JSON.parse(JSON.stringify(localEdit)).deliverable, localEdit.deliverable);
    assert.equal(recovered.work.deliverable, work.deliverable);
    const after = await (await fetcher('/api/status')).json();
    assert.equal(after.counts.primary, before.counts.primary); assert.equal(after.counts.writes, 1);
    unlocked = await recovered.openAccount();
    assert.equal(unlocked.owner, expectedOwner);
    const message = 'Synthetic local ownership check; no transaction';
    const signature = await unlocked.account.signMessage({ message });
    assert.equal(await verifyMessage({ address: expectedOwner, message, signature }), true);
    unlocked.close(); unlocked = null;
    recovered.close();
    await assert.rejects(() => recovered.openAccount());
    assert.equal((await (await fetcher('/api/status')).json()).counts.writes, 1);
  } finally { unlocked?.close(); recovered?.close(); credential?.close(); key.fill(0); await app.close(); }
});
