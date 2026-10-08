import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http, parseEventLogs } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startLocalChain } from '../chain/harness.mjs';

const localChain = (rpcUrl) => ({
  id: 31337,
  name: 'Disposable local fixture',
  nativeCurrency: { name: 'Synthetic test units', symbol: 'TEST', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const namedRevert = (name) => (error) => {
  const reverted = error.walk?.((cause) => cause.name === 'ContractFunctionRevertedError');
  assert.equal(reverted?.data?.errorName, name);
  return true;
};

test('local funded right belongs to the same account, transfers once, and survives fresh discovery', async (t) => {
  const harness = await startLocalChain();
  t.after(() => harness.close());
  const chain = localChain(harness.rpcUrl);
  const client = createPublicClient({ chain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
  const beneficiary = privateKeyToAccount(generatePrivateKey());
  const unrelated = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({ account: beneficiary, chain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
  const amount = 1_000_000_000_000_000n;
  let right;

  await t.test('only loopback Anvil, chain 31337, and no default unlocked accounts', async () => {
    assert.match(harness.rpcUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await client.getChainId(), 31337);
    assert.deepEqual(await harness.rpc('eth_accounts'), []);
    assert.equal(await harness.rightForOwner(beneficiary.address), null);
    assert.notEqual(await client.getCode({ address: harness.contractAddress }), '0x');
  });

  await t.test('issuer locks real synthetic native units for the fixed beneficiary', async () => {
    right = await harness.prepareRight(beneficiary.address, { amount });
    assert.equal(right.beneficiary, beneficiary.address);
    assert.equal(right.amount, amount);
    assert.equal(right.claimed, false);
    assert.equal(right.alreadyPrepared, false);
    assert.equal(await client.getBalance({ address: harness.contractAddress }), amount);
    assert.equal(await client.getBalance({ address: beneficiary.address }), 10n ** 18n);
  });

  await t.test('repeated and concurrent preparation preserves one right and its escrowed balance', async () => {
    const retries = await Promise.all([
      harness.prepareRight(beneficiary.address, { amount }),
      harness.prepareRight(beneficiary.address, { amount }),
    ]);
    assert.ok(retries.every((retried) => retried.id === right.id && retried.alreadyPrepared && retried.transactionHash === null));
    assert.equal(await client.getBalance({ address: harness.contractAddress }), amount);
    await assert.rejects(harness.prepareRight(beneficiary.address, { amount: amount + 1n }), /different synthetic payment/);
  });

  await t.test('fresh client discovers the original right using only its account and the fixed contract', async () => {
    const freshClient = createPublicClient({ chain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
    const foundId = await freshClient.readContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'rightForOwner', args: [beneficiary.address] });
    assert.equal(foundId, right.id);
    const found = await freshClient.readContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'getRight', args: [foundId] });
    assert.equal(getAddress(found.beneficiary), beneficiary.address);
    assert.equal(found.amount, amount);
    assert.equal(found.claimed, false);
  });

  await t.test('a new unrelated account is not allowed to take the original right', async () => {
    await assert.rejects(client.simulateContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'claim', args: [right.id], account: unrelated }), namedRevert('WrongBeneficiary'));
    assert.equal((await harness.readRight(right.id)).claimed, false);
    assert.equal(await client.getBalance({ address: harness.contractAddress }), amount);
  });

  await t.test('a nonissuer cannot create a replacement entitlement', async () => {
    await assert.rejects(client.simulateContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'issue', args: [unrelated.address], value: amount, account: beneficiary }), namedRevert('OnlyIssuer'));
    assert.equal(await harness.rightForOwner(unrelated.address), null);
  });

  await t.test('the beneficiary receives exactly the owed native amount less its own gas', async () => {
    const before = await client.getBalance({ address: beneficiary.address });
    const transactionHash = await wallet.writeContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'claim', args: [right.id] });
    const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, timeout: 5000 });
    assert.equal(receipt.status, 'success');
    const after = await client.getBalance({ address: beneficiary.address });
    assert.equal(after, before + amount - receipt.gasUsed * receipt.effectiveGasPrice);
    assert.equal(await client.getBalance({ address: harness.contractAddress }), 0n);
    assert.equal((await harness.readRight(right.id)).claimed, true);
    const emitted = parseEventLogs({ abi: harness.abi, eventName: 'RightClaimed', logs: receipt.logs, strict: true });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].args.id, right.id);
    assert.equal(getAddress(emitted[0].args.beneficiary), beneficiary.address);
    assert.equal(emitted[0].args.amount, amount);
    const evidence = await harness.claimReceipt(transactionHash);
    assert.equal(evidence.status, 'success');
    assert.equal(evidence.claims.length, 1);
    assert.equal(evidence.claims[0].id, right.id);
  });

  await t.test('the same right cannot transfer twice and remains discoverable as claimed', async () => {
    await assert.rejects(client.simulateContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'claim', args: [right.id], account: beneficiary }), namedRevert('AlreadyClaimed'));
    const found = await harness.rightForOwner(beneficiary.address);
    assert.equal(found.id, right.id);
    assert.equal(found.claimed, true);
    assert.equal(await client.getBalance({ address: harness.contractAddress }), 0n);
  });

  await t.test('an unknown right is rejected by name', async () => {
    await assert.rejects(client.simulateContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'claim', args: [9999n], account: beneficiary }), namedRevert('UnknownRight'));
  });

  await t.test('closing terminates the child and makes RPC unavailable', async () => {
    await harness.close();
    await harness.close();
    await assert.rejects(harness.rpc('eth_chainId'), /closed/);
  });
});
