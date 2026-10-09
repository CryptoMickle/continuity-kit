import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CLAIM_CONFIRMATION, createWorkEntitlementScenario, finishFictionalHandoff } from './scenario.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--claim-existing-payment')) throw new Error('Usage: node examples/work-entitlement/run.mjs [--claim-existing-payment]');
const shouldClaim = args.includes('--claim-existing-payment');
const scenario = await createWorkEntitlementScenario();
try {
  scenario.takePrimaryOffline();
  assert.throws(() => scenario.primary.readWork(), /SYNTHETIC_PRIMARY_UNAVAILABLE/);
  await assert.rejects(scenario.primary.signMessage({ message: 'Original signer must be retired' }));
  const beforeRecovery = await scenario.client.getTransactionCount({ address: scenario.owner });
  const recovered = await scenario.recoverWork();
  assert.deepEqual(recovered.work, scenario.work);
  assert.equal(recovered.owner, scenario.owner.toLowerCase());
  assert.equal('account' in recovered, false);
  const handoff = finishFictionalHandoff(recovered.work);
  assert.equal(scenario.recoveryCalls().account, 0);
  assert.equal(await scenario.client.getTransactionCount({ address: scenario.owner }), beforeRecovery);
  assert.equal((await scenario.harness.readRight(scenario.entitlement.id)).claimed, false);
  const out = resolve('examples/work-entitlement/output');
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, 'fictional-handoff.json'), handoff.json);
  await writeFile(resolve(out, 'fictional-handoff.txt'), handoff.text);
  const report = {
    format: 'local-work-entitlement/v1', executedAt: new Date().toISOString(),
    scope: 'Disposable loopback Anvil 31337; synthetic RAM credential; fictional work only',
    realFunds: false, publicBlockchain: false, physicalPasskey: false, externalIntegration: false,
    owner: scenario.owner, workDigest: recovered.workDigest,
    originalAppUnavailable: 'local source/session model; not an HTTP/domain outage test',
    originalSignerClosed: true, preparedWorkRecovered: true,
    workReadAndExportOpenedSigner: false, workReadAndExportSentTransaction: false,
    localExportCreatesEntitlement: false,
    entitlementIssuedBeforeOutage: true, paymentOptional: true, paymentClaimed: false,
    limitations: [
      'A local integration example, not new evidence for an old public receipt or hosted deployment.',
      'The existing PaymentRight fixture binds a fixed beneficiary; it does not attest work completion or client approval.',
      'One immutable prepared snapshot; editing only changes the local export.',
      'All recovery material and synthetic credentials remain in one process; this is not a browser or hardware security test.',
    ],
  };
  if (shouldClaim) {
    const result = await scenario.claimPreIssuedPayment(recovered, CLAIM_CONFIRMATION);
    assert.equal(result.balanceAfter, result.balanceBefore + result.discovered.amount - result.receipt.gasUsed * result.receipt.effectiveGasPrice);
    assert.equal(result.discovered.id, scenario.entitlement.id);
    await assert.rejects(result.closedAccount.signMessage({ message: 'Local verification: closed payment signer must reject signing' }), error => error.code === 'SESSION_ENDED');
    report.paymentClaimed = true;
    report.localClaim = {
      contract: scenario.harness.contractAddress, rightId: result.discovered.id.toString(),
      amountWei: result.discovered.amount.toString(), transactionHash: result.transactionHash,
      status: result.receipt.status, balanceAfterGasVerified: true, signerClosedAfterAction: true,
      signingAfterClosureRejected: 'SESSION_ENDED',
    };
  }
  report.events = scenario.events();
  await writeFile(resolve(out, 'local-proof.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Prepared work recovered and fictional handoff exported. Account signing stayed locked during work use.\n${shouldClaim ? 'Optional pre-issued payment claimed once on disposable local Anvil; signer closed.' : 'No payment claimed. The original entitlement remains unclaimed.'}\nOutput: ${out}`);
} finally { await scenario.close(); }
