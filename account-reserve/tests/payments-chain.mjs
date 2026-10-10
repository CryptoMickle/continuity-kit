import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPublicClient, createWalletClient, getAddress, http, keccak256, toHex, toFunctionSelector, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startSequentialPaymentChain } from '../payments/harness.mjs';

const source = readFileSync(new URL('../payments/SequentialPayment.sol', import.meta.url));
const artifact = JSON.parse(readFileSync(new URL('../payments/SequentialPayment.artifact.json', import.meta.url)));
const localChain = rpcUrl => ({ id: 31337, name: 'Owned sequential payment test', nativeCurrency: { name: 'Synthetic units', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const namedRevert = expected => error => {
  const reverted = error.walk?.(cause => cause.name === 'ContractFunctionRevertedError');
  assert.equal(reverted?.data?.errorName, expected); return true;
};
async function fixture(t) {
  const harness = await startSequentialPaymentChain(); t.after(() => harness.close());
  const chain = localChain(harness.rpcUrl), client = createPublicClient({ chain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
  const account = privateKeyToAccount(generatePrivateKey()), wallet = createWalletClient({ account, chain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
  return { harness, chain, client, account, wallet };
}

test('three distinct funded obligations settle sequentially to the same account without resetting its balance', async t => {
  const { harness, client, account, wallet } = await fixture(t);
  assert.equal(artifact.sourceSha256, createHash('sha256').update(source).digest('hex'));
  assert.match(artifact.compiler, /solc 0\.8\.30; optimizer=200; EVM=paris/);
  assert.match(harness.rpcUrl, /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal(await client.getChainId(), 31337);
  assert.deepEqual(await harness.rpc('eth_accounts'), []); assert.ok(Object.isFrozen(harness));
  assert.equal(harness.runtimeCodeHash, keccak256(await client.getCode({ address: harness.contractAddress })));
  assert.equal(await client.readContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'issuer' }), harness.issuer);
  assert.equal(await harness.rightForOwner(account.address), null);
  const old = []; let lastBalance;
  for (const amount of [10n ** 15n, 2n * 10n ** 15n, 3n * 10n ** 15n]) {
    const payment = await harness.preparePayment(account.address, { amount });
    assert.equal(payment.id, BigInt(old.length + 1)); assert.equal(payment.amount, amount); assert.equal(payment.claimed, false);
    assert.equal(payment.beneficiary, account.address); assert.match(payment.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.equal(await client.getBalance({ address: harness.contractAddress }), amount);
    const before = await client.getBalance({ address: account.address });
    assert.equal(before, lastBalance ?? 10n ** 18n, 'only the first obligation may seed local gas');
    const hash = await wallet.writeContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'claim', args: [payment.id] });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 5000 }); assert.equal(receipt.status, 'success');
    lastBalance = await client.getBalance({ address: account.address });
    assert.equal(lastBalance, before + amount - receipt.gasUsed * receipt.effectiveGasPrice);
    assert.equal(await client.getBalance({ address: harness.contractAddress }), 0n);
    assert.deepEqual((await harness.claimReceipt(hash)).claims.map(x => ({ ...x, beneficiary: getAddress(x.beneficiary) })), [{ id: payment.id, beneficiary: account.address, amount }]);
    assert.equal((await harness.rightForOwner(account.address)).id, payment.id);
    old.push(payment);
    for (const settled of old) { const saved = await harness.readRight(settled.id); assert.equal(saved.claimed, true); assert.equal(saved.amount, settled.amount); }
    await assert.rejects(client.simulateContract({ address: harness.contractAddress, abi: harness.abi, functionName: 'claim', args: [payment.id], account }), namedRevert('AlreadyClaimed'));
  }
  assert.equal(await client.getTransactionCount({ address: account.address }), 3);
});

test('issuer, beneficiary, funding and outstanding-right boundaries reject without changing liabilities', async t => {
  const { harness, client, account } = await fixture(t), other = privateKeyToAccount(generatePrivateKey());
  await harness.rpc('anvil_setBalance', [other.address, toHex(10n ** 18n)]);
  const contract = { address: harness.contractAddress, abi: harness.abi };
  const simulateIssue = (beneficiary, value, issuer = harness.issuer) => client.simulateContract({ ...contract, functionName: 'issue', args: [beneficiary], value, account: issuer });
  await assert.rejects(simulateIssue(account.address, 1n, other), namedRevert('OnlyIssuer'));
  await assert.rejects(simulateIssue(zeroAddress, 1n), namedRevert('InvalidBeneficiary'));
  await assert.rejects(simulateIssue(account.address, 0n), namedRevert('EmptyPayment'));
  const payment = await harness.preparePayment(account.address);
  await assert.rejects(simulateIssue(account.address, payment.amount), namedRevert('OutstandingPayment'));
  await assert.rejects(harness.preparePayment(account.address), { code: 'OUTSTANDING_PAYMENT' });
  await assert.rejects(client.simulateContract({ ...contract, functionName: 'claim', args: [payment.id], account: other }), namedRevert('WrongBeneficiary'));
  await assert.rejects(client.simulateContract({ ...contract, functionName: 'claim', args: [999n], account }), namedRevert('UnknownRight'));
  await assert.rejects(client.readContract({ ...contract, functionName: 'getRight', args: [999n] }), namedRevert('UnknownRight'));
  assert.equal((await harness.readRight(payment.id)).claimed, false);
  assert.equal(await client.getBalance({ address: harness.contractAddress }), payment.amount);
  assert.equal(await client.readContract({ ...contract, functionName: 'nextId' }), 2n);
  assert.equal(await harness.rightForOwner(other.address), null);
});

test('concurrent local preparation issues once and owned shutdown is idempotent', async t => {
  const { harness, account } = await fixture(t);
  const results = await Promise.allSettled([harness.preparePayment(account.address), harness.preparePayment(account.address)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'OUTSTANDING_PAYMENT');
  assert.equal((await harness.rightForOwner(account.address)).id, 1n);
  await Promise.all([harness.close(), harness.close()]);
  await assert.rejects(harness.rpc('eth_chainId'), /closed/);
});

function callbackArtifact() {
  const directory = mkdtempSync(join(tmpdir(), 'sequential-callback-build-'));
  try {
    writeFileSync(join(directory, 'SequentialPayment.sol'), source);
    writeFileSync(join(directory, 'CallbackIssuer.sol'), `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import './SequentialPayment.sol';
contract CallbackIssuer {
  SequentialPayment public immutable target = new SequentialPayment();
  bool public rejectDelivery = true;
  bytes4 public issueError;
  bytes4 public claimError;
  function allowDelivery() external { rejectDelivery = false; }
  function issueSelf() external payable { target.issue{value:msg.value}(address(this)); }
  function collect() external { target.claim(target.rightForOwner(address(this))); }
  receive() external payable {
    require(!rejectDelivery, 'DELIVERY_DENIED');
    (bool issued,bytes memory i) = address(target).call{value:1}(abi.encodeCall(target.issue,(address(0x1234))));
    require(!issued, 'REENTRANT_ISSUE_SUCCEEDED'); issueError = bytes4(i);
    (bool claimed,bytes memory c) = address(target).call(abi.encodeCall(target.claim,(target.rightForOwner(address(this)))));
    require(!claimed, 'REENTRANT_CLAIM_SUCCEEDED'); claimError = bytes4(c);
  }
}`);
    writeFileSync(join(directory, 'foundry.toml'), '[profile.default]\nsrc="."\nout="out"\nsolc_version="0.8.30"\nevm_version="paris"\noptimizer=true\noptimizer_runs=200\nbytecode_hash="none"\ncbor_metadata=false\n');
    execFileSync(process.env.CONTINUITY_FORGE ?? join(homedir(), '.foundry/bin/forge'), ['build', '--offline', '--root', directory], { stdio: ['ignore','pipe','pipe'], timeout: 60000 });
    return JSON.parse(readFileSync(join(directory, 'out/CallbackIssuer.sol/CallbackIssuer.json')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('failed delivery rolls back settlement, and issuer callbacks cannot reenter either mutation', async t => {
  const { harness, client, wallet, account } = await fixture(t), receiver = callbackArtifact();
  await harness.rpc('anvil_setBalance', [account.address, toHex(10n ** 18n)]);
  const deployment = await wallet.deployContract({ abi: receiver.abi, bytecode: receiver.bytecode.object });
  const receipt = await client.waitForTransactionReceipt({ hash: deployment, timeout: 5000 }); assert.equal(receipt.status, 'success');
  const address = receipt.contractAddress, target = await client.readContract({ address, abi: receiver.abi, functionName: 'target' });
  const call = async (functionName, value = 0n, gas) => {
    const hash = await wallet.writeContract({ address, abi: receiver.abi, functionName, value, ...(gas ? { gas } : {}) });
    return client.waitForTransactionReceipt({ hash, timeout: 5000 });
  };
  const right = id => client.readContract({ address: target, abi: harness.abi, functionName: 'getRight', args: [id] });
  assert.equal(getAddress(await client.readContract({ address: target, abi: harness.abi, functionName: 'issuer' })), getAddress(address));
  assert.equal((await call('issueSelf', 1000n)).status, 'success');
  // Explicit gas broadcasts the expected reverting transaction; state must roll back.
  assert.equal((await call('collect', 0n, 300000n)).status, 'reverted');
  assert.equal((await right(1n)).claimed, false); assert.equal(await client.getBalance({ address: target }), 1000n);
  assert.equal((await call('allowDelivery')).status, 'success');
  assert.equal((await call('collect')).status, 'success');
  assert.equal((await right(1n)).claimed, true); assert.equal(await client.getBalance({ address: target }), 0n);
  assert.equal(await client.getBalance({ address }), 1000n);
  for (const functionName of ['issueError','claimError']) assert.equal(await client.readContract({ address, abi: receiver.abi, functionName }), toFunctionSelector('ReentrantCall()'));
  assert.equal(await client.readContract({ address: target, abi: harness.abi, functionName: 'rightForOwner', args: ['0x0000000000000000000000000000000000001234'] }), 0n);
  assert.equal((await call('issueSelf', 2000n)).status, 'success');
  assert.equal((await right(2n)).claimed, false); assert.equal((await right(1n)).amount, 1000n);
  assert.equal((await call('collect')).status, 'success');
  assert.equal(await client.getBalance({ address }), 3000n); assert.equal(await client.getBalance({ address: target }), 0n);
});
