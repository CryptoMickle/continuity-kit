import { createHash } from 'node:crypto';
import { decodeEventLog, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction } from 'viem';
import { buildReleaseProposal, readCandidateArtifact } from './proposal.mjs';

export const OPERATOR_ROLES = Object.freeze(['deploy', 'fund-beneficiary-gas', 'issue-fixed-right']);
const fail = code => Object.assign(new Error(code), { code });
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hexHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const emptyCode = code => code === undefined || code === '0x';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const canonical = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const copy = value => JSON.parse(JSON.stringify(value));

export function operatorProposalHash(proposal) {
  const rebuilt = buildReleaseProposal({ issuer: proposal?.issuer, beneficiary: proposal?.beneficiary, issuerNonce: proposal?.proposedIssuerNonce, beneficiaryNonce: '0' });
  if (canonical(proposal) !== canonical(rebuilt)) throw fail('OPERATOR_PROPOSAL_MISMATCH');
  return createHash('sha256').update(canonical(rebuilt)).digest('hex');
}

export function validateOperatorApproval({ approval, proposalHash, network, rpcUrls, now = Date.now }) {
    if (!exact(approval, ['format', 'proposalHash', 'network', 'rpcUrls', 'roles', 'expiresAt', 'approvedByUser']) || approval.format !== 'account-reserve-operator-approval/v1' || approval.proposalHash !== proposalHash || approval.network !== network || approval.approvedByUser !== true || canonical(approval.rpcUrls) !== canonical(rpcUrls) || canonical(approval.roles) !== canonical(OPERATOR_ROLES)) throw fail('OPERATOR_EXACT_APPROVAL_REQUIRED');
    const expires = Date.parse(approval.expiresAt);
    if (!Number.isSafeInteger(now()) || !Number.isSafeInteger(expires) || typeof approval.expiresAt !== 'string' || new Date(expires).toISOString() !== approval.expiresAt || expires <= now() || expires > now() + 86400000) throw fail('OPERATOR_APPROVAL_EXPIRED');
 }

/**
 * No transport, signer, credential, RPC or public CLI is created here. Adapters
 * are trusted dependencies; their declared URL is not proof of transport identity.
 * Explicit approval is required on every new step and binds the complete proposal.
 * Re-entering an existing step only reconciles its pinned hash, never sends again.
 */
export function createReleaseOperator({ proposal: input, endpoints, signer, journal, network = 'public-testnet', now = Date.now }) {
  const proposalHash = operatorProposalHash(input);
  const proposal = copy(input);
  const { artifact } = readCandidateArtifact();
  if (!Array.isArray(endpoints) || endpoints.length !== 2 || endpoints.some(endpoint => !endpoint || typeof endpoint.url !== 'string' || !endpoint.client)) throw fail('OPERATOR_TWO_RPCS_REQUIRED');
  if (!['public-testnet', 'local-anvil'].includes(network)) throw fail('OPERATOR_NETWORK_INVALID');
  const rpcUrls = endpoints.map(endpoint => endpoint.url);
  if (network === 'public-testnet' && canonical(rpcUrls) !== canonical(proposal.network.rpcCandidates)) throw fail('OPERATOR_RPC_NOT_APPROVED');
  if (network === 'local-anvil' && rpcUrls.some(url => !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(url) || Number(new URL(url).port) > 65535)) throw fail('OPERATOR_LOCAL_RPC_REQUIRED');
  const clients = endpoints.map(endpoint => endpoint.client);
  let stage = 'idle';
  const traced = method => async (...args) => {
    try { return await method(...args); }
    catch (error) { if (error && typeof error === 'object' && error.operatorStage === undefined) error.operatorStage = stage; throw error; }
  };
  if (!journal || journal.durable !== true || ['read', 'reserve', 'pin', 'withLock'].some(key => typeof journal[key] !== 'function')) throw fail('OPERATOR_DURABLE_JOURNAL_REQUIRED');
  if (signer && (!eq(signer.address, proposal.issuer) || typeof signer.signTransaction !== 'function')) throw fail('OPERATOR_SIGNER_MISMATCH');
  const txFor = role => { const tx = proposal.transactions.find(tx => tx.role === role); if (!OPERATOR_ROLES.includes(role) || !tx) throw fail('OPERATOR_ROLE_NOT_APPROVED'); return tx; };
  const requestFor = (tx, gas) => ({ type: 'eip1559', chainId: 10143, ...(tx.to ? { to: tx.to } : {}), nonce: Number(tx.nonce), data: tx.data, value: BigInt(tx.valueWei), gas, maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei), accessList: [] });
  const approve = approval => validateOperatorApproval({ approval, proposalHash, network, rpcUrls, now });
  const validateEnvelope = (actual, tx, gas) => {
    if (actual.type !== 'eip1559' || actual.chainId !== 10143 || (tx.to ? !eq(actual.to, tx.to) : actual.to != null) || actual.nonce !== Number(tx.nonce) || (actual.data ?? actual.input ?? '0x') !== tx.data || (actual.value ?? 0n) !== BigInt(tx.valueWei) || actual.gas !== gas || actual.maxFeePerGas !== BigInt(tx.maxFeePerGasWei) || actual.maxPriorityFeePerGas !== BigInt(tx.maxPriorityFeePerGasWei) || (actual.accessList?.length ?? 0) !== 0 || actual.authorizationList !== undefined || actual.blobVersionedHashes !== undefined || actual.maxFeePerBlobGas !== undefined) throw fail('OPERATOR_TRANSACTION_SCOPE_MISMATCH');
  };
  const validateEntry = (entry, role) => {
    if (!entry) return undefined;
    if (!exact(entry, ['format', 'proposalHash', 'role', 'phase', 'gas', 'hash']) || entry.format !== 'account-reserve-operator-attempt/v1' || entry.proposalHash !== proposalHash || entry.role !== role || !['reserved', 'signed'].includes(entry.phase) || typeof entry.gas !== 'string' || !/^[1-9][0-9]*$/.test(entry.gas) || BigInt(entry.gas) > BigInt(txFor(role).gasLimitCeiling) || (entry.phase === 'reserved' ? entry.hash !== null : !hexHash(entry.hash))) throw fail('OPERATOR_JOURNAL_INVALID');
    return entry;
  };
  const read = async role => validateEntry(await journal.read(role), role);
  const persist = async entry => {
    await journal[entry.phase === 'reserved' ? 'reserve' : 'pin'](entry);
    if (canonical(await read(entry.role)) !== canonical(entry)) throw fail('OPERATOR_JOURNAL_READBACK_FAILED');
  };
  const blockValid = block => typeof block?.number === 'bigint' && block.number >= 0n && hexHash(block.hash) && typeof block.timestamp === 'bigint';
  const fresh = block => {
    const seconds = BigInt(Math.floor(now() / 1000));
    if (!blockValid(block) || block.timestamp > seconds + 15n || block.timestamp < seconds - 120n) throw fail('OPERATOR_STALE_OR_INVALID_HEAD');
  };
  async function heads() {
    const observed = await Promise.all(clients.map(async client => {
      const [chainId, latest, finalized] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockTag: 'finalized' })]);
      if (chainId !== 10143) throw fail('OPERATOR_CHAIN_MISMATCH');
      fresh(latest); fresh(finalized);
      if (latest.number < finalized.number || (latest.number === finalized.number && !eq(latest.hash, finalized.hash))) throw fail('OPERATOR_FINALIZED_HEAD_INVALID');
      const canonicalFinalized = await client.getBlock({ blockNumber: finalized.number });
      if (canonicalFinalized.number !== finalized.number || !eq(canonicalFinalized.hash, finalized.hash)) throw fail('OPERATOR_CANONICAL_BLOCK_MISMATCH');
      if (network === 'local-anvil') {
        const [version, accounts] = await Promise.all([client.request({ method: 'web3_clientVersion' }), client.request({ method: 'eth_accounts' })]);
        if (!/anvil/i.test(version) || !Array.isArray(accounts) || accounts.length) throw fail('OPERATOR_LOCAL_ANVIL_REQUIRED');
      }
      return { latest, finalized };
    }));
    // Providers can advance or lag normally. Agree on a numbered block at the
    // lower height, while retaining each live head for fee/freshness checks.
    const shared = {};
    for (const tag of ['latest', 'finalized']) {
      const height = observed[0][tag].number < observed[1][tag].number ? observed[0][tag].number : observed[1][tag].number;
      const blocks = await Promise.all(clients.map(client => client.getBlock({ blockNumber: height })));
      if (blocks.some(block => !blockValid(block) || block.number !== height) || !eq(blocks[0].hash, blocks[1].hash) || blocks[0].timestamp !== blocks[1].timestamp || blocks[0].baseFeePerGas !== blocks[1].baseFeePerGas) throw fail('OPERATOR_RPC_HEAD_DISAGREEMENT');
      fresh(blocks[0]); shared[tag] = blocks[0];
    }
    return { ...shared, liveHeads: observed.map(item => item.latest) };
  }
  async function assertCanonical(client, block) {
    const actual = await client.getBlock({ blockNumber: block.number });
    if (actual.number !== block.number || !eq(actual.hash, block.hash)) throw fail('OPERATOR_CANONICAL_BLOCK_MISMATCH');
  }
  async function actors(client, blockNumber) {
    const codes = await Promise.all([proposal.issuer, proposal.beneficiary].map(address => client.getCode({ address, blockNumber })));
    if (codes.some(code => !emptyCode(code))) throw fail('OPERATOR_ACTOR_CODE_UNEXPECTED');
  }
  async function contractState(client, blockNumber, issued) {
    const address = proposal.contract.address;
    const [code, issuer, nextId, mapped, balance] = await Promise.all([
      client.getCode({ address, blockNumber }),
      client.readContract({ address, abi: artifact.abi, functionName: 'issuer', blockNumber }),
      client.readContract({ address, abi: artifact.abi, functionName: 'nextId', blockNumber }),
      client.readContract({ address, abi: artifact.abi, functionName: 'rightForOwner', args: [proposal.beneficiary], blockNumber }),
      client.getBalance({ address, blockNumber }),
    ]);
    if (!code || code === '0x' || keccak256(code) !== proposal.contract.expectedRuntimeCodeHash) throw fail('OPERATOR_RUNTIME_MISMATCH');
    if (!eq(issuer, proposal.issuer) || nextId !== (issued ? 2n : 1n) || mapped !== (issued ? 1n : 0n) || balance !== (issued ? BigInt(proposal.budget.paymentEscrowWei) : 0n)) throw fail('OPERATOR_CONTRACT_STATE_MISMATCH');
    if (issued) {
      const right = await client.readContract({ address, abi: artifact.abi, functionName: 'getRight', args: [1n], blockNumber });
      if (!eq(right.beneficiary, proposal.beneficiary) || right.amount !== BigInt(proposal.budget.paymentEscrowWei) || right.claimed !== false) throw fail('OPERATOR_RIGHT_MISMATCH');
    }
  }
  async function preflight(role) {
    const tx = txFor(role), index = OPERATOR_ROLES.indexOf(role);
    const observedHeads = await heads(), block = observedHeads.latest;
    const observations = await Promise.all(clients.map(async client => {
      await actors(client, block.number);
      const [issuerNonce, pendingIssuerNonce, beneficiaryNonce, pendingBeneficiaryNonce, issuerBalance, beneficiaryBalance, priority, estimate] = await Promise.all([
        client.getTransactionCount({ address: proposal.issuer, blockNumber: block.number }), client.getTransactionCount({ address: proposal.issuer, blockTag: 'pending' }),
        client.getTransactionCount({ address: proposal.beneficiary, blockNumber: block.number }), client.getTransactionCount({ address: proposal.beneficiary, blockTag: 'pending' }),
        client.getBalance({ address: proposal.issuer, blockNumber: block.number }), client.getBalance({ address: proposal.beneficiary, blockNumber: block.number }),
        client.estimateMaxPriorityFeePerGas(), client.estimateGas({ account: proposal.issuer, ...requestFor(tx, BigInt(tx.gasLimitCeiling)) }),
      ]);
      if (issuerNonce !== Number(tx.nonce) || pendingIssuerNonce !== issuerNonce || beneficiaryNonce !== 0 || pendingBeneficiaryNonce !== 0) throw fail('OPERATOR_NONCE_NOT_APPROVED');
      // A fresh beneficiary is intentionally required to be initially empty.
      const funding = index < 2 ? 0n : BigInt(proposal.budget.beneficiaryGasFundingWei);
      if (beneficiaryBalance !== funding) throw fail('OPERATOR_BENEFICIARY_BALANCE_MISMATCH');
      const remaining = proposal.transactions.slice(index, 3).reduce((sum, item) => sum + BigInt(item.maxFeeWei) + BigInt(item.valueWei), 0n);
      if (issuerBalance < remaining) throw fail('OPERATOR_ISSUER_BALANCE_INSUFFICIENT');
      if (typeof priority !== 'bigint' || priority < 0n || priority > BigInt(tx.maxPriorityFeePerGasWei) || observedHeads.liveHeads.some(head => typeof head.baseFeePerGas !== 'bigint' || head.baseFeePerGas < 0n || head.baseFeePerGas + BigInt(tx.maxPriorityFeePerGasWei) > BigInt(tx.maxFeePerGasWei))) throw fail('OPERATOR_FEE_CAP_EXCEEDED');
      if (typeof estimate !== 'bigint' || estimate <= 0n || estimate > BigInt(tx.gasLimitCeiling)) throw fail('OPERATOR_GAS_NOT_APPROVED');
      if (index === 0) {
        const [code, contractBalance, contractNonce] = await Promise.all([client.getCode({ address: proposal.contract.address, blockNumber: block.number }), client.getBalance({ address: proposal.contract.address, blockNumber: block.number }), client.getTransactionCount({ address: proposal.contract.address, blockNumber: block.number })]);
        if (!emptyCode(code) || contractBalance !== 0n || contractNonce !== 0) throw fail('OPERATOR_CONTRACT_ALREADY_EXISTS');
      } else await contractState(client, block.number, false);
      await assertCanonical(client, block);
      return { issuerBalance, beneficiaryBalance, estimate };
    }));
    if (observations[0].issuerBalance !== observations[1].issuerBalance || observations[0].beneficiaryBalance !== observations[1].beneficiaryBalance) throw fail('OPERATOR_RPC_STATE_DISAGREEMENT');
    const estimate = observations.reduce((max, item) => item.estimate > max ? item.estimate : max, 0n);
    const gas = (estimate * 120n + 99n) / 100n;
    if (gas > BigInt(tx.gasLimitCeiling)) throw fail('OPERATOR_GAS_NOT_APPROVED');
    return gas;
  }
  const receiptShape = receipt => ({ transactionHash: receipt.transactionHash?.toLowerCase(), from: receipt.from?.toLowerCase(), to: receipt.to?.toLowerCase() ?? null, contractAddress: receipt.contractAddress?.toLowerCase() ?? null, blockHash: receipt.blockHash?.toLowerCase(), blockNumber: receipt.blockNumber, transactionIndex: receipt.transactionIndex, status: receipt.status, type: receipt.type, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, logs: receipt.logs?.map(log => ({ address: log.address?.toLowerCase(), topics: log.topics?.map(topic => topic.toLowerCase()), data: log.data?.toLowerCase(), blockHash: log.blockHash?.toLowerCase(), blockNumber: log.blockNumber, transactionHash: log.transactionHash?.toLowerCase(), transactionIndex: log.transactionIndex, logIndex: log.logIndex, removed: log.removed })) });

  async function reconcile(role) {
    const tx = txFor(role), entry = await read(role);
    if (!entry) return { role, status: 'not-attempted' };
    if (entry.phase !== 'signed') return { role, status: 'blocked-unsigned-attempt', action: 'manual-reconciliation-required' };
    const head = await heads();
    const outcomes = await Promise.allSettled(clients.map(client => client.getTransactionReceipt({ hash: entry.hash })));
    const unavailable = outcomes.find(result => result.status === 'rejected' && result.reason?.name !== 'TransactionReceiptNotFoundError');
    if (unavailable) throw unavailable.reason;
    if (outcomes.some(result => result.status === 'rejected')) return { role, hash: entry.hash, status: 'pending-or-unknown' };
    const receipts = outcomes.map(result => result.value), receipt = receipts[0];
    if (canonical(receiptShape(receipt)) !== canonical(receiptShape(receipts[1]))) throw fail('OPERATOR_RECEIPT_DISAGREEMENT');
    if (!eq(receipt.transactionHash, entry.hash) || !eq(receipt.from, proposal.issuer) || (tx.to ? !eq(receipt.to, tx.to) : receipt.to != null) || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n || !hexHash(receipt.blockHash) || !Number.isSafeInteger(receipt.transactionIndex) || receipt.transactionIndex < 0 || receipt.type !== 'eip1559' || !Array.isArray(receipt.logs) || typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed <= 0n || receipt.gasUsed > BigInt(entry.gas) || typeof receipt.effectiveGasPrice !== 'bigint' || receipt.effectiveGasPrice < 0n || receipt.effectiveGasPrice > BigInt(tx.maxFeePerGasWei)) throw fail('OPERATOR_RECEIPT_MISMATCH');
    if (receipt.logs.some(log => log.removed !== false || !eq(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber || !eq(log.transactionHash, entry.hash) || log.transactionIndex !== receipt.transactionIndex || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0)) throw fail('OPERATOR_RECEIPT_MISMATCH');
    await Promise.all(clients.map(client => assertCanonical(client, { number: receipt.blockNumber, hash: receipt.blockHash })));
    if (head.finalized.number < receipt.blockNumber) return { role, hash: entry.hash, status: 'awaiting-finality' };
    if (head.finalized.number === receipt.blockNumber && !eq(head.finalized.hash, receipt.blockHash)) throw fail('OPERATOR_CANONICAL_BLOCK_MISMATCH');
    await Promise.all(clients.map(async client => {
      const transaction = await client.getTransaction({ hash: entry.hash });
      validateEnvelope(transaction, tx, BigInt(entry.gas));
      if (!eq(transaction.hash, entry.hash) || !eq(transaction.from, proposal.issuer) || !eq(transaction.blockHash, receipt.blockHash) || transaction.blockNumber !== receipt.blockNumber || transaction.transactionIndex !== receipt.transactionIndex) throw fail('OPERATOR_TRANSACTION_MISMATCH');
      const serializedTransaction = serializeTransaction({ ...transaction, data: transaction.input ?? transaction.data }, { r: transaction.r, s: transaction.s, yParity: transaction.yParity, v: transaction.v });
      if (keccak256(serializedTransaction) !== entry.hash || !eq(await recoverTransactionAddress({ serializedTransaction }), proposal.issuer)) throw fail('OPERATOR_SIGNED_OWNER_MISMATCH');
    }));
    if (receipt.status === 'reverted') return { role, hash: entry.hash, status: 'reverted', action: 'manual-reconciliation-required' };
    if (receipt.status !== 'success' || (role === 'deploy' ? !eq(receipt.contractAddress, proposal.contract.address) : receipt.contractAddress != null)) throw fail('OPERATOR_RECEIPT_MISMATCH');
    if (role === 'issue-fixed-right') {
      if (receipt.logs.length !== 1 || !eq(receipt.logs[0].address, proposal.contract.address)) throw fail('OPERATOR_ISSUED_EVENT_MISMATCH');
      let event;
      try { event = decodeEventLog({ abi: artifact.abi, topics: receipt.logs[0].topics, data: receipt.logs[0].data, strict: true }); } catch { throw fail('OPERATOR_ISSUED_EVENT_MISMATCH'); }
      if (event.eventName !== 'RightIssued' || event.args.id !== 1n || !eq(event.args.beneficiary, proposal.beneficiary) || event.args.amount !== BigInt(proposal.budget.paymentEscrowWei)) throw fail('OPERATOR_ISSUED_EVENT_MISMATCH');
    } else if (receipt.logs.length !== 0) throw fail('OPERATOR_UNEXPECTED_EVENT');
    await Promise.all(clients.map(async client => {
      await actors(client, receipt.blockNumber);
      await contractState(client, receipt.blockNumber, role === 'issue-fixed-right');
      const [issuerNonce, beneficiaryNonce, beneficiaryBalance] = await Promise.all([
        client.getTransactionCount({ address: proposal.issuer, blockNumber: receipt.blockNumber }), client.getTransactionCount({ address: proposal.beneficiary, blockNumber: receipt.blockNumber }), client.getBalance({ address: proposal.beneficiary, blockNumber: receipt.blockNumber }),
      ]);
      if (issuerNonce !== Number(tx.nonce) + 1 || beneficiaryNonce !== 0 || beneficiaryBalance !== (role === 'deploy' ? 0n : BigInt(proposal.budget.beneficiaryGasFundingWei))) throw fail('OPERATOR_FINALIZED_STATE_MISMATCH');
      await assertCanonical(client, { number: receipt.blockNumber, hash: receipt.blockHash });
      await assertCanonical(client, head.finalized);
    }));
    return { role, hash: entry.hash, status: 'finalized', blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, network };
  }

  async function signAndSend(entry, authorized) {
    const { role } = entry, tx = txFor(role), gas = BigInt(entry.gas);
    stage = 'preflight-before-sign';
    if (await preflight(role) > gas) throw fail('OPERATOR_GAS_CHANGED');
    approve(authorized);
    stage = 'sign-transaction';
    const serializedTransaction = await signer.signTransaction(requestFor(tx, gas));
    stage = 'validate-signed-envelope';
    validateEnvelope(parseTransaction(serializedTransaction), tx, gas);
    if (!eq(await recoverTransactionAddress({ serializedTransaction }), proposal.issuer)) throw fail('OPERATOR_SIGNED_OWNER_MISMATCH');
    const hash = keccak256(serializedTransaction);
    stage = 'persist-signed-hash';
    await persist({ ...entry, phase: 'signed', hash });
    stage = 'preflight-before-broadcast';
    if (await preflight(role) > gas) throw fail('OPERATOR_GAS_CHANGED');
    approve(authorized);
    stage = 'broadcast';
    // Exactly one invocation, only after durable hash readback. No retry here.
    const returned = await clients[0].sendRawTransaction({ serializedTransaction });
    if (!eq(returned, hash)) throw fail('OPERATOR_BROADCAST_HASH_MISMATCH');
    stage = 'reconcile';
    return reconcile(role);
  }

  async function execute({ role, approval }) {
    txFor(role);
    // Snapshot approval before awaits, so mutable callers cannot broaden it.
    const authorized = approval == null ? approval : copy(approval);
    stage = 'journal-lock';
    return journal.withLock(async () => {
      if (await read(role)) return reconcile(role);
      stage = 'validate-approval';
      approve(authorized);
      if (!signer) throw fail('OPERATOR_SIGNER_REQUIRED');
      stage = 'reconcile-preceding-steps';
      for (const previous of OPERATOR_ROLES.slice(0, OPERATOR_ROLES.indexOf(role))) if ((await reconcile(previous)).status !== 'finalized') throw fail('OPERATOR_PREVIOUS_STEP_NOT_FINALIZED');
      stage = 'preflight-before-reserve';
      const tx = txFor(role), gas = await preflight(role);
      approve(authorized);
      const entry = { format: 'account-reserve-operator-attempt/v1', proposalHash, role, phase: 'reserved', gas: gas.toString(), hash: null };
      stage = 'persist-reservation';
      await persist(entry);
      return signAndSend(entry, authorized);
    });
  }

  // Explicit recovery of one intact unsigned reservation, not an automatic
  // retry. A prior process must have exited. The unchanged journal proves that
  // this runner never reached send: a signed hash is fsynced before every send.
  // A second append-only audit is written before any resumed signing; failure
  // after that point cannot consume another resume or alter the reserved gas.
  async function resumeUnsigned({ role, approval }) {
    txFor(role);
    const authorized = approval == null ? approval : copy(approval);
    stage = 'journal-lock';
    return journal.withLock(async () => {
      stage = 'validate-reservation';
      const entry = await read(role);
      if (!entry) throw fail('OPERATOR_UNSIGNED_RESERVATION_REQUIRED');
      if (entry.phase === 'signed') return reconcile(role);
      if (typeof journal.readResume !== 'function' || typeof journal.reserveResume !== 'function') throw fail('OPERATOR_RESUME_JOURNAL_REQUIRED');
      if (await journal.readResume(role)) return { role, status: 'blocked-resume-attempt', action: 'manual-reconciliation-required' };
      stage = 'validate-approval';
      approve(authorized);
      if (!signer) throw fail('OPERATOR_SIGNER_REQUIRED');
      stage = 'reconcile-preceding-steps';
      for (const previous of OPERATOR_ROLES.slice(0, OPERATOR_ROLES.indexOf(role))) if ((await reconcile(previous)).status !== 'finalized') throw fail('OPERATOR_PREVIOUS_STEP_NOT_FINALIZED');
      stage = 'preflight-before-resume';
      if (await preflight(role) > BigInt(entry.gas)) throw fail('OPERATOR_GAS_CHANGED');
      approve(authorized);
      const audit = { format: 'account-reserve-operator-resume/v1', proposalHash, role, gas: entry.gas, reservationHash: createHash('sha256').update(canonical(entry)).digest('hex'), approvedAt: new Date(now()).toISOString() };
      stage = 'persist-resume-audit';
      await journal.reserveResume(audit);
      if (canonical(await journal.readResume(role)) !== canonical(audit) || canonical(await read(role)) !== canonical(entry)) throw fail('OPERATOR_RESUME_READBACK_FAILED');
      return signAndSend(entry, authorized);
    });
  }
  return Object.freeze({ proposalHash, execute: traced(execute), resumeUnsigned: traced(resumeUnsigned), reconcile: traced(async role => { stage = 'reconcile'; return reconcile(role); }), preflight: traced(async role => { stage = 'readonly-preflight'; return { role, status: 'preflight-ready', selectedGas: (await preflight(role)).toString() }; }), async inspect() { return Promise.all(OPERATOR_ROLES.map(async role => ({ role, attempt: await read(role) ?? null }))); } });
}
