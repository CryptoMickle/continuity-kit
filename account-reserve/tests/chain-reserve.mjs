import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { startLocalChain } from '../chain/harness.mjs';
import { makeDerivedSdkFixture } from './sdk-derived-fixture.mjs';

async function proveDerivedAccount(kind, t) {
  const fixture = await makeDerivedSdkFixture(kind);
  const unrelatedFixture = await makeDerivedSdkFixture(kind);
  const harness = await startLocalChain();
  let recovered;
  let unrelatedRecovery;
  t.after(async () => { recovered?.close(); unrelatedRecovery?.close(); fixture.cleanup(); unrelatedFixture.cleanup(); await harness.close(); });
  const chain = {
    id: 31337,
    name: 'Synthetic reserve recovery fixture',
    nativeCurrency: { name: 'Synthetic native test units', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: [harness.rpcUrl] } },
  };
  const client = createPublicClient({ chain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
  const originalOwner = fixture.originalAccount.address;
  const originalRight = await harness.prepareRight(originalOwner);
  const ready = await fixture.prepare();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.independentlyVerified, true);
  assert.equal(originalRight.claimed, false);

  // The recovery store exposes only encrypted records. No owner, credential ID,
  // private key, saved vault, or previous locator is an input to recoverReserve.
  const copiedEncryptedRecords = new Map(fixture.store.records());
  const readonlyStore = {
    async get(locator) {
      const bytes = copiedEncryptedRecords.get(locator);
      return bytes ? new Uint8Array(bytes) : null;
    },
  };
  const config = { ...fixture.config };
  assert.deepEqual(Object.keys(config).sort(), ['appId', 'derivation', 'originalRpId', 'recoveryRpId']);
  fixture.closeOriginal();
  await assert.rejects(() => fixture.originalAccount.signMessage({ message: 'SYNTHETIC ORIGINAL SESSION ENDED' }), (error) => error.code === 'SESSION_ENDED');
  await assert.rejects(() => fixture.baselineRestoreOriginal(), (error) => error.cause?.message === 'SYNTHETIC_ORIGINAL_UNAVAILABLE');
  const before = fixture.stats();
  const freshModule = await import(`../sdk/index.mjs?chain-proof=${randomBytes(8).toString('hex')}`);
  recovered = await freshModule.recoverReserve({
    config,
    webAuthnClient: fixture.newRecoveryClient(),
    store: readonlyStore,
  });
  assert.equal(getAddress(recovered.owner), originalOwner);
  assert.equal(fixture.stats().originalRequests, before.originalRequests);
  assert.equal(fixture.stats().recoveryRequests - before.recoveryRequests, 2);

  // The fresh client discovers the right from its recovered address, not from
  // originalRight.id or the primary browser's state.
  const discoveredId = await client.readContract({
    address: harness.contractAddress, abi: harness.abi,
    functionName: 'rightForOwner', args: [recovered.account.address],
  });
  assert.equal(discoveredId, originalRight.id);
  const discovered = await harness.readRight(discoveredId);
  assert.equal(discovered.beneficiary, originalOwner);
  assert.equal(discovered.claimed, false);

  await unrelatedFixture.prepare();
  unrelatedFixture.closeOriginal();
  unrelatedRecovery = await unrelatedFixture.recover();
  assert.notEqual(getAddress(unrelatedRecovery.owner), originalOwner);
  await assert.rejects(client.simulateContract({
    address: harness.contractAddress, abi: harness.abi,
    functionName: 'claim', args: [discoveredId], account: unrelatedRecovery.account,
  }), (error) => error.walk?.((cause) => cause.name === 'ContractFunctionRevertedError')?.data?.errorName === 'WrongBeneficiary');

  const wallet = createWalletClient({ account: recovered.account, chain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
  const ownerBalanceBefore = await client.getBalance({ address: recovered.account.address });
  const transactionHash = await wallet.writeContract({
    address: harness.contractAddress, abi: harness.abi,
    functionName: 'claim', args: [discoveredId],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, timeout: 5000 });
  assert.equal(receipt.status, 'success');
  const ownerBalanceAfter = await client.getBalance({ address: recovered.account.address });
  assert.equal(ownerBalanceAfter, ownerBalanceBefore + discovered.amount - receipt.gasUsed * receipt.effectiveGasPrice);
  assert.equal((await harness.readRight(discoveredId)).claimed, true);
  assert.equal(await client.getBalance({ address: harness.contractAddress }), 0n);
  const confirmedClaim = await harness.claimReceipt(transactionHash);
  assert.equal(confirmedClaim.claims.length, 1);
  assert.equal(confirmedClaim.claims[0].id, discoveredId);

  await assert.rejects(client.simulateContract({
    address: harness.contractAddress, abi: harness.abi,
    functionName: 'claim', args: [discoveredId], account: recovered.account,
  }), (error) => error.walk?.((cause) => cause.name === 'ContractFunctionRevertedError')?.data?.errorName === 'AlreadyClaimed');
  recovered.close();
  await assert.rejects(() => recovered.account.signMessage({ message: 'SYNTHETIC RECOVERY SESSION ENDED' }), (error) => error.code === 'SESSION_ENDED');

  return {
    status: 'passed',
    adapter: kind,
    derivationEvidence: fixture.derivationEvidence,
    owner: originalOwner,
    contractAddress: harness.contractAddress,
    rightId: discoveredId.toString(),
    amount: discovered.amount.toString(),
    amountUnit: 'synthetic local native base units; 18 decimals; no economic value',
    transactionHash,
    originalSignerClosed: true,
    originalDomainRestoreRejected: true,
    originalCredentialRequestsDuringRecovery: fixture.stats().originalRequests - before.originalRequests,
    freshRecoveryInputFields: ['config', 'webAuthnClient', 'readOnlyEncryptedStore'],
    rightDiscoveredFromRecoveredOwner: true,
    sameOriginalRight: true,
    unrelatedPreparedRecoveryRejected: true,
    wrongOwnerRevert: 'WrongBeneficiary',
    receiptStatus: receipt.status,
    exactNativePaymentAfterGasVerified: true,
    duplicateRevert: 'AlreadyClaimed',
    recoveredSessionClosed: true,
  };
}

test('Iris and Accrue recovery each claims the same pre-existing local payment without primary state', async (t) => {
  const cases = [];
  for (const kind of ['iris', 'accrue']) {
    await t.test(`${kind}: prepared reserve, fresh discovery, fixed beneficiary, one native claim`, async (child) => {
      cases.push(await proveDerivedAccount(kind, child));
    });
  }
  assert.equal(cases.length, 2);
  await writeFile(new URL('../chain/reserve-claim-evidence.json', import.meta.url), JSON.stringify({
    status: 'passed',
    executedAt: new Date().toISOString(),
    scope: 'Independent source-inspected derivation fixtures; synthetic RAM authenticator; real Mera 0.2.0 and scure APIs; disposable local Anvil EVM and owned funded native escrow fixture',
    chainId: 31337,
    publicBlockchain: false,
    realFunds: false,
    physicalPasskeyTest: false,
    externalAppIntegration: false,
    securityAudit: false,
    cases,
  }, null, 2) + '\n');
});
