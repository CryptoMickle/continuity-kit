import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildReleaseProposal, readCandidateArtifact, runtimeForIssuer } from '../deploy/proposal.mjs';
import { makeDerivedSdkFixture } from './sdk-derived-fixture.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const chain = { id: 10143, name: 'LOCAL Anvil profile 10143, not Monad', nativeCurrency: { name: 'Local test units', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: [] } } };

async function localAnvil() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(process.env.CONTINUITY_ANVIL ?? join(homedir(), '.foundry/bin/anvil'), ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '10143', '--accounts', '0', '--hardfork', 'paris', '--silent'], { stdio: ['ignore', 'ignore', 'ignore'] });
  const rpcUrl = `http://127.0.0.1:${port}`;
  let requestId = 0;
  const rpc = async (method, params = []) => {
    const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (body.error) throw new Error('LOCAL_ANVIL_RPC_ERROR');
    return body.result;
  };
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await ended; clearTimeout(timer);
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('LOCAL_ANVIL_EXITED');
      try {
        if (await rpc('eth_chainId') === '0x279f') {
          assert.match(await rpc('web3_clientVersion'), /anvil/i);
          assert.deepEqual(await rpc('eth_accounts'), []);
          return { rpcUrl, rpc, close };
        }
      } catch {}
      await wait(30);
    }
    throw new Error('LOCAL_ANVIL_NOT_READY');
  } catch (error) { await close(); throw error; }
}

test('testnet proposal is local, immutable-account-bound, four-transaction and unapproved', async t => {
  const issuer = privateKeyToAccount(generatePrivateKey());
  const beneficiary = privateKeyToAccount(generatePrivateKey());
  const input = { issuer: issuer.address, issuerNonce: '7', beneficiary: beneficiary.address, beneficiaryNonce: '0' };
  const originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  globalThis.fetch = () => { forbiddenCalls++; throw new Error('NO_NETWORK_ALLOWED'); };
  let proposal;
  try { proposal = buildReleaseProposal(input); } finally { globalThis.fetch = originalFetch; }
  assert.equal(forbiddenCalls, 0);
  assert.equal(proposal.status, 'proposal-only-unapproved-no-signing-or-broadcast');
  assert.equal(proposal.network.chainId, 10143);
  assert.equal(proposal.contract.evmVersion, 'paris');
  assert.equal(proposal.nonceCurrentlyVerified, false);
  assert.equal(proposal.releaseProfile.primaryOrigin, null);
  assert.equal(proposal.releaseProfile.enabled, false);
  assert.equal(proposal.releaseProfile.claim.gasLimit, '300000');
  assert.equal(proposal.releaseProfile.claim.valueWei, '0');
  assert.deepEqual(proposal.transactions.map(tx => tx.nonce), ['7', '8', '9', '0']);
  assert.deepEqual(proposal.transactions.map(tx => tx.role), ['deploy', 'fund-beneficiary-gas', 'issue-fixed-right', 'claim-after-prepared-recovery']);
  assert.equal(proposal.budget.maxTransactionCount, 4);
  assert.equal(proposal.budget.maxTotalFeeWei, parseEther('0.326').toString());
  assert.equal(proposal.budget.issuerStartingCoverageWei, parseEther('0.426').toString());
  assert.equal(proposal.budget.sumOfAllFeeAndValueEnvelopesWei, parseEther('0.486').toString());
  assert.equal(proposal.transactions[1].to, beneficiary.address);
  assert.equal(proposal.transactions[1].valueWei, parseEther('0.06').toString());
  assert.equal(proposal.transactions[2].valueWei, parseEther('0.1').toString());
  assert.equal(proposal.transactions[3].valueWei, '0');
  for (const tx of proposal.transactions) {
    assert.equal(tx.selectedGas, null); assert.equal(tx.requiresFreshNativeEstimate, true);
  }
  assert.throws(() => buildReleaseProposal({ ...input, chainId: 1 }), /PROPOSAL_INPUT_INVALID/);
  assert.throws(() => buildReleaseProposal({ ...input, beneficiary: issuer.address }), /DISTINCT_ACTORS_REQUIRED/);
  assert.throws(() => buildReleaseProposal({ ...input, beneficiary: proposal.contract.address }), /CONTRACT_CANNOT_BE_BENEFICIARY/);
  assert.throws(() => buildReleaseProposal({ ...input, beneficiaryNonce: '1' }), /FRESH_BENEFICIARY_REQUIRED/);
  for (const issuerNonce of [-1, '01', '0x1', '-1', '9007199254740991']) assert.throws(() => buildReleaseProposal({ ...input, issuerNonce }), /PROPOSAL_NONCE_INVALID/);
  for (const invalid of [null, '', '0x0000000000000000000000000000000000000000']) assert.throws(() => buildReleaseProposal({ ...input, issuer: invalid }), /PROPOSAL_ADDRESS_INVALID/);
  const { artifact } = readCandidateArtifact();
  assert.equal(keccak256(runtimeForIssuer(artifact, issuer.address)), proposal.contract.expectedRuntimeCodeHash);
  assert.notEqual(keccak256(runtimeForIssuer(artifact, beneficiary.address)), proposal.contract.expectedRuntimeCodeHash);
  assert.throws(() => runtimeForIssuer({ ...artifact, immutableReferences: {} }, issuer.address), /IMMUTABLE_LAYOUT_INVALID/);
  const originalSource = await readFile(new URL('../chain/PaymentRight.sol', import.meta.url), 'utf8');
  const candidateSource = await readFile(new URL('../deploy/PaymentRight.sol', import.meta.url), 'utf8');
  const codeOnly = s => s.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.equal(codeOnly(candidateSource), codeOnly(originalSource), 'candidate changes compiler target and explanatory comments, not contract behavior');
});

test('Paris candidate executes its four steps with recovered signer on disposable local Anvil only', async t => {
  const local = await localAnvil();
  t.after(local.close);
  const fixture = await makeDerivedSdkFixture('iris');
  let recovered;
  t.after(() => { recovered?.close(); fixture.cleanup(); });
  const issuer = privateKeyToAccount(generatePrivateKey());
  const proposal = buildReleaseProposal({ issuer: issuer.address, issuerNonce: '0', beneficiary: fixture.originalAccount.address, beneficiaryNonce: '0' });
  const { artifact } = readCandidateArtifact();
  const transport = http(local.rpcUrl, { retryCount: 0 });
  const client = createPublicClient({ chain, transport });
  const issuerWallet = createWalletClient({ account: issuer, chain, transport });
  await local.rpc('anvil_setBalance', [issuer.address, `0x${parseEther('1').toString(16)}`]);
  assert.equal(await client.getBalance({ address: fixture.originalAccount.address }), 0n, 'beneficiary starts with no gas funding');
  const events = [];
  const execute = async (tx, account, wallet) => {
    const call = { account, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: BigInt(tx.valueWei), nonce: Number(tx.nonce), gas: BigInt(tx.gasLimitCeiling) };
    const estimate = await client.estimateGas(call);
    const gas = (estimate * 120n + 99n) / 100n;
    assert.ok(gas <= BigInt(tx.gasLimitCeiling), `${tx.role} local estimate fits proposed cap`);
    const hash = await wallet.sendTransaction({ ...call, gas, maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei) });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 5000 });
    assert.equal(receipt.status, 'success');
    events.push({ role: tx.role, hash, localEstimateGas: estimate.toString(), selectedLocalGas: gas.toString(), localReceiptGasUsed: receipt.gasUsed.toString(), status: receipt.status });
    return receipt;
  };
  const deployment = await execute(proposal.transactions[0], issuer, issuerWallet);
  assert.equal(getAddress(deployment.contractAddress), proposal.contract.address);
  const deployedCode = await client.getCode({ address: proposal.contract.address });
  assert.equal(keccak256(deployedCode), proposal.contract.expectedRuntimeCodeHash);
  assert.equal(await client.readContract({ address: proposal.contract.address, abi: artifact.abi, functionName: 'issuer' }), issuer.address);

  await execute(proposal.transactions[1], issuer, issuerWallet);
  assert.equal(await client.getBalance({ address: fixture.originalAccount.address }), parseEther('0.06'));
  assert.equal(await client.getTransactionCount({ address: fixture.originalAccount.address }), 0);
  await execute(proposal.transactions[2], issuer, issuerWallet);
  assert.equal(await client.getBalance({ address: proposal.contract.address }), parseEther('0.1'));
  assert.equal(await client.readContract({ address: proposal.contract.address, abi: artifact.abi, functionName: 'rightForOwner', args: [fixture.originalAccount.address] }), 1n);

  const ready = await fixture.prepare();
  assert.equal(ready.independentlyVerified, true);
  fixture.closeOriginal();
  await assert.rejects(fixture.baselineRestoreOriginal, error => error.cause?.message === 'SYNTHETIC_ORIGINAL_UNAVAILABLE');
  recovered = await fixture.recover();
  const rightId = await client.readContract({ address: proposal.contract.address, abi: artifact.abi, functionName: 'rightForOwner', args: [recovered.account.address] });
  assert.equal(rightId, 1n);
  assert.equal(getAddress(recovered.owner), proposal.beneficiary);
  const claimWallet = createWalletClient({ account: recovered.account, chain, transport });
  const before = await client.getBalance({ address: recovered.account.address });
  const claimed = await execute(proposal.transactions[3], recovered.account, claimWallet);
  assert.equal(await client.getBalance({ address: recovered.account.address }), before + parseEther('0.1') - claimed.gasUsed * claimed.effectiveGasPrice);
  assert.equal(await client.getBalance({ address: proposal.contract.address }), 0n);
  const right = await client.readContract({ address: proposal.contract.address, abi: artifact.abi, functionName: 'getRight', args: [rightId] });
  assert.equal(right.claimed, true);
  assert.equal(getAddress(right.beneficiary), proposal.beneficiary);
  assert.equal(right.amount, parseEther('0.1'));
  await assert.rejects(client.simulateContract({ address: proposal.contract.address, abi: artifact.abi, functionName: 'claim', args: [rightId], account: recovered.account }), error => error.walk?.(cause => cause.name === 'ContractFunctionRevertedError')?.data?.errorName === 'AlreadyClaimed');
  assert.equal(await client.getTransactionCount({ address: issuer.address }), 3);
  assert.equal(await client.getTransactionCount({ address: recovered.account.address }), 1);
  await writeFile(new URL('../deploy/local-validation.json', import.meta.url), JSON.stringify({
    status: 'passed', executedAt: new Date().toISOString(),
    scope: 'Disposable loopback Anvil, Paris hardfork, numeric chain 10143; NOT public Monad',
    publicRpcRequests: 0, publicTransactions: 0, realFunds: false, physicalPasskeys: false,
    syntheticAuthenticator: true, sourceFixture: 'Iris-style independent fixture, not original application',
    artifactSha256: proposal.contract.artifactSha256,
    contractAddress: proposal.contract.address, issuer: proposal.issuer, beneficiary: proposal.beneficiary,
    expectedRuntimeCodeHash: proposal.contract.expectedRuntimeCodeHash, actualRuntimeCodeHash: keccak256(deployedCode),
    beneficiaryInitiallyUnfunded: true, explicitGasFundingVerified: true,
    sameOwnerAfterPreparedRecovery: true, exactNativeClaimAfterGasVerified: true,
    duplicateClaimRevert: 'AlreadyClaimed', transactions: events,
    limitation: 'Local gas observations are not Monad estimates, approval, balances, deployment or physical proof.',
  }, null, 2) + '\n');
});
