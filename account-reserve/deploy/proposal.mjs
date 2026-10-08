import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { encodeFunctionData, getAddress, getContractAddress, isAddress, keccak256 } from 'viem';

const CHAIN_ID = 10143;
const MAX_FEE = 200000000000n;
const PRIORITY = 2000000000n;
const PAYMENT = 100000000000000000n;
const CLAIM_GAS = 300000n;
const GAS_FUNDING = CLAIM_GAS * MAX_FEE;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => { throw new Error(code); };
const encode = (n) => `0x${BigInt(n).toString(16)}`;
const artifactPath = new URL('./PaymentRight.paris.json', import.meta.url);

export function readCandidateArtifact() {
  const raw = readFileSync(artifactPath);
  const artifact = JSON.parse(raw);
  if (artifact.format !== 'account-reserve-testnet-artifact/v1' || artifact.compilerSettings?.evmVersion !== 'paris' || artifact.sourceSha256 !== sha256(readFileSync(new URL('./PaymentRight.sol', import.meta.url))) || artifact.settingsSha256 !== sha256(readFileSync(new URL('./foundry.toml', import.meta.url))) || keccak256(artifact.bytecode) !== artifact.creationCodeHash) fail('CANDIDATE_ARTIFACT_MISMATCH');
  return { artifact, artifactSha256: sha256(raw) };
}

function address(value) {
  if (typeof value !== 'string' || !isAddress(value) || /^0x0{40}$/i.test(value)) fail('PROPOSAL_ADDRESS_INVALID');
  return getAddress(value);
}

function nonce(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER) - 2n) fail('PROPOSAL_NONCE_INVALID');
  return BigInt(value);
}

/** Patch the sole Solidity immutable (issuer) to predict this exact runtime. */
export function runtimeForIssuer(artifact, issuerInput) {
  const issuer = address(issuerInput);
  const groups = Object.values(artifact.immutableReferences ?? {});
  if (groups.length !== 1 || groups[0].length < 1) fail('IMMUTABLE_LAYOUT_INVALID');
  const bytes = Buffer.from(artifact.runtimeTemplate.slice(2), 'hex');
  const word = Buffer.from(issuer.slice(2).toLowerCase().padStart(64, '0'), 'hex');
  const occupied = new Set();
  for (const { start, length } of groups[0]) {
    if (!Number.isSafeInteger(start) || start < 0 || length !== 32 || start + length > bytes.length) fail('IMMUTABLE_LAYOUT_INVALID');
    for (let i = start; i < start + length; i++) {
      if (occupied.has(i) || bytes[i] !== 0) fail('IMMUTABLE_LAYOUT_INVALID');
      occupied.add(i);
    }
    word.copy(bytes, start);
  }
  return `0x${bytes.toString('hex')}`;
}

/** Pure local proposal construction: no signer, RPC, environment credential, or fetch. */
export function buildReleaseProposal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'beneficiary,beneficiaryNonce,issuer,issuerNonce') fail('PROPOSAL_INPUT_INVALID');
  const issuer = address(input.issuer), beneficiary = address(input.beneficiary);
  if (issuer === beneficiary) fail('DISTINCT_ACTORS_REQUIRED');
  const issuerNonce = nonce(input.issuerNonce), beneficiaryNonce = nonce(input.beneficiaryNonce);
  if (beneficiaryNonce !== 0n) fail('FRESH_BENEFICIARY_REQUIRED');
  const { artifact, artifactSha256 } = readCandidateArtifact();
  const contractAddress = getContractAddress({ from: issuer, nonce: issuerNonce });
  if (getAddress(contractAddress) === beneficiary) fail('CONTRACT_CANNOT_BE_BENEFICIARY');
  const runtime = runtimeForIssuer(artifact, issuer);
  const create = (role, from, txNonce, to, data, value, gas) => ({
    role, type: 'eip1559', chainId: CHAIN_ID, from, nonce: txNonce.toString(),
    to, data, valueWei: value.toString(), gasLimitCeiling: gas.toString(),
    maxFeePerGasWei: MAX_FEE.toString(), maxPriorityFeePerGasWei: PRIORITY.toString(),
    maxFeeWei: (gas * MAX_FEE).toString(),
    selectedGas: null, requiresFreshNativeEstimate: true,
  });
  const transactions = [
    create('deploy', issuer, issuerNonce, null, artifact.bytecode, 0n, 1000000n),
    create('fund-beneficiary-gas', issuer, issuerNonce + 1n, beneficiary, '0x', GAS_FUNDING, 30000n),
    create('issue-fixed-right', issuer, issuerNonce + 2n, contractAddress, encodeFunctionData({ abi: artifact.abi, functionName: 'issue', args: [beneficiary] }), PAYMENT, 300000n),
    create('claim-after-prepared-recovery', beneficiary, beneficiaryNonce, contractAddress, encodeFunctionData({ abi: artifact.abi, functionName: 'claim', args: [1n] }), 0n, CLAIM_GAS),
  ];
  const totalFee = transactions.reduce((n, tx) => n + BigInt(tx.maxFeeWei), 0n);
  const issuerFee = transactions.filter(tx => tx.from === issuer).reduce((n, tx) => n + BigInt(tx.maxFeeWei), 0n);
  return {
    format: 'account-reserve-testnet-proposal/v1', status: 'proposal-only-unapproved-no-signing-or-broadcast',
    network: { name: 'Monad testnet candidate', chainId: CHAIN_ID, rpcCandidates: ['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com'], currentAvailabilityVerified: false },
    issuer, beneficiary, proposedIssuerNonce: issuerNonce.toString(), nonceCurrentlyVerified: false,
    contract: { address: contractAddress, predictedOnly: true, artifactSha256, sourceSha256: artifact.sourceSha256, creationCodeHash: artifact.creationCodeHash, expectedRuntimeCodeHash: keccak256(runtime), compiler: artifact.compiler, evmVersion: 'paris', issuerImmutable: issuer },
    releaseProfile: {
      format: 'account-reserve-public/v1', enabled: false, chainId: CHAIN_ID,
      contractAddress, expectedRuntimeCodeHash: keccak256(runtime), issuer,
      primaryOrigin: null, recoveryOrigin: null, namespace: null, expiresAt: null,
      physicalPasskeysVerified: false,
      rpcUrls: ['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com'],
      claim: { rightId: '1', gasLimit: CLAIM_GAS.toString(), maxFeePerGasWei: MAX_FEE.toString(), maxPriorityFeePerGasWei: PRIORITY.toString(), valueWei: '0' },
    },
    transactions,
    budget: {
      maxTransactionCount: 4, maxTotalFeeWei: totalFee.toString(),
      paymentEscrowWei: PAYMENT.toString(), beneficiaryGasFundingWei: GAS_FUNDING.toString(),
      issuerStartingCoverageWei: (issuerFee + PAYMENT + GAS_FUNDING).toString(),
      sumOfAllFeeAndValueEnvelopesWei: (totalFee + PAYMENT + GAS_FUNDING).toString(),
      note: 'Coverage counts beneficiary claim gas from the issuer transfer once; envelope sum also includes it again as the final fee. Test tokens only, no current balance or cash-cost claim.',
    },
    preflightRequirements: [
      'Concrete user approval of exact actors, new RPs/credentials, hosting/storage changes, funding source and all four testnet transactions; old limits do not grant new authority.',
      'Both fixed RPCs agree on chain 10143, fresh finalized identity and runtime evidence; no arbitrary URL fallback.',
      'Issuer and beneficiary have no account code; issuer pending/latest nonce equals proposal; beneficiary pending/latest nonce is zero; predicted contract has no code.',
      'Issuer starting balance covers its exact selected three envelopes and values. Gas transfer must be finalized before beneficiary claim preflight.',
      'Estimate each exact from/to/data/value/nonce with explicit gas ceiling; select ceil(max estimate * 1.20), never exceeding ceiling.',
      'Recheck current base and priority fees against caps, nonce, funds and code immediately before signing; no auto cap increase.',
      'Verify deployed issuer-linked runtime and issuer before funding/issuance. Verify empty owner mapping and nextId 1 before issue.',
      'Verify exact RightIssued id 1, beneficiary, amount and escrow before prepared recovery. Refuse changed identity, state or namespace.',
      'Pin signed hash before each single send, persist only public pending ticket, reconcile ambiguity without fresh signing or duplicate send.',
      'After claim corroborate exact transaction, receipt, event, runtime and claimed right at accepted finalized blocks; local Anvil evidence is not this check.',
    ],
    readonlyEstimateTemplates: transactions.map(tx => ({ role: tx.role, method: 'eth_estimateGas', params: [{ from: tx.from, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: encode(tx.valueWei), nonce: encode(tx.nonce), gas: encode(tx.gasLimitCeiling) }], note: 'Template only; later steps need prior confirmed state. Do not execute all against undeployed state.' })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[2] !== '--input' || process.argv[4] !== '--out') fail('USE_--input_LOCAL_JSON_--out_NEW_LOCAL_JSON');
  const raw = readFileSync(resolve(process.argv[3]));
  if (raw.length > 4096) fail('PROPOSAL_INPUT_TOO_LARGE');
  const proposal = buildReleaseProposal(JSON.parse(raw));
  writeFileSync(resolve(process.argv[5]), JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx' });
  console.log('Saved a local unapproved proposal. No network, signing or transaction occurred.');
}
