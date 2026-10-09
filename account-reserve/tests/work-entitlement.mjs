import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CLAIM_CONFIRMATION, createWorkEntitlementScenario, finishFictionalHandoff } from '../examples/work-entitlement/scenario.mjs';

const namedRevert = name => error => error.walk?.(cause => cause.name === 'ContractFunctionRevertedError')?.data?.errorName === name;

test('one fictional job continues while signing stays locked, then its same account may collect an already-issued right once', async t => {
  const scenario = await createWorkEntitlementScenario();
  t.after(() => scenario.close());
  let recovered;

  await t.test('the right belongs to the reserved account before the original app is retired', async () => {
    assert.equal(scenario.ready.status, 'ready');
    assert.equal(scenario.ready.owner, scenario.entitlement.beneficiary.toLowerCase());
    assert.equal(scenario.entitlement.claimed, false);
    assert.deepEqual(scenario.events(), ['pre-existing-payment-issued', 'work-and-same-account-reserve-prepared']);
    assert.equal(await scenario.client.getChainId(), 31337);
    assert.match(scenario.harness.rpcUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(await scenario.harness.rpc('eth_accounts'), []);
    await assert.rejects(scenario.recoverWork(), /TAKE_PRIMARY_OFFLINE_FIRST/);
  });

  await t.test('fresh work recovery and completed export neither unlock nor transact, including denied vault access', async () => {
    scenario.takePrimaryOffline();
    assert.throws(() => scenario.primary.readWork(), /SYNTHETIC_PRIMARY_UNAVAILABLE/);
    await assert.rejects(scenario.primary.signMessage({ message: 'Retired original signer' }), error => error.code === 'SESSION_ENDED');
    const nonce = await scenario.client.getTransactionCount({ address: scenario.owner });
    recovered = await scenario.recoverWork();
    assert.deepEqual(recovered.work, scenario.work);
    for (const hidden of ['account', 'session', 'privateKey']) assert.equal(hidden in recovered, false);
    assert.deepEqual(scenario.recoveryCalls(), { discovery: 1, account: 0, deniedAccount: 0 });
    await assert.rejects(recovered.openAccount());
    assert.deepEqual(scenario.recoveryCalls(), { discovery: 1, account: 0, deniedAccount: 1 });
    const exported = finishFictionalHandoff(recovered.work);
    assert.deepEqual(JSON.parse(exported.json), exported.work);
    assert.equal(exported.work.brief, recovered.work.brief);
    assert.match(exported.text, /Your order is confirmed/);
    assert.match(recovered.work.deliverable, /\[unfinished\]/);
    assert.equal(await scenario.client.getTransactionCount({ address: scenario.owner }), nonce);
    assert.equal((await scenario.harness.readRight(scenario.entitlement.id)).claimed, false);
    assert.equal((await scenario.recoverWork()).workDigest, recovered.workDigest);
    await assert.rejects(scenario.claimPreIssuedPayment(recovered, undefined), /EXPLICIT_LOCAL_CLAIM_REQUIRED/);
    assert.equal(scenario.recoveryCalls().account, 0);
  });

  await t.test('an unrelated account cannot collect the job account entitlement', async () => {
    const unrelated = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(scenario.client.simulateContract({
      address: scenario.harness.contractAddress, abi: scenario.harness.abi,
      functionName: 'claim', args: [scenario.entitlement.id], account: unrelated,
    }), namedRevert('WrongBeneficiary'));
    assert.equal((await scenario.harness.readRight(scenario.entitlement.id)).claimed, false);
    assert.equal(await scenario.client.getBalance({ address: scenario.harness.contractAddress }), scenario.entitlement.amount);
  });

  await t.test('deliberate unlock recovers exactly the same beneficiary and transfers only its pre-existing payment', async () => {
    const result = await scenario.claimPreIssuedPayment(recovered, CLAIM_CONFIRMATION);
    assert.equal(result.discovered.id, scenario.entitlement.id);
    assert.equal(result.discovered.beneficiary, scenario.owner);
    assert.equal(result.receipt.status, 'success');
    assert.equal(result.balanceAfter, result.balanceBefore + result.discovered.amount - result.receipt.gasUsed * result.receipt.effectiveGasPrice);
    assert.equal(result.claim.claims.length, 1);
    assert.equal(result.claim.claims[0].id, scenario.entitlement.id);
    assert.equal(result.claim.claims[0].beneficiary.toLowerCase(), recovered.owner);
    assert.equal(result.claim.claims[0].amount, scenario.entitlement.amount);
    assert.equal(scenario.recoveryCalls().account, 1);
    assert.equal(scenario.events().at(-1), 'account-signing-closed');
    await assert.rejects(result.closedAccount.signMessage({ message: 'Closed recovery signer cannot sign again' }), error => error.code === 'SESSION_ENDED');
  });

  await t.test('the contract and consumer reject a second claim; work still exports without a new signer', async () => {
    await assert.rejects(scenario.client.simulateContract({
      address: scenario.harness.contractAddress, abi: scenario.harness.abi,
      functionName: 'claim', args: [scenario.entitlement.id], account: scenario.owner,
    }), namedRevert('AlreadyClaimed'));
    const counts = scenario.recoveryCalls();
    await assert.rejects(scenario.claimPreIssuedPayment(recovered, CLAIM_CONFIRMATION), /PAYMENT_ALREADY_CLAIMED/);
    assert.deepEqual(scenario.recoveryCalls(), counts);
    assert.equal(await scenario.client.getBalance({ address: scenario.harness.contractAddress }), 0n);
    assert.match(finishFictionalHandoff(recovered.work).text, /Your order is confirmed/);
    recovered.close();
    await assert.rejects(recovered.openAccount());
  });
});
