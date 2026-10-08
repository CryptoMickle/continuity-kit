import { decodeEventLog, encodeFunctionData, getAddress, keccak256, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';
import { validatePendingTicket } from './pending-ticket.mjs';

const CLAIM_ABI = parseAbi([
  'function claim(uint256 id)',
  'event RightClaimed(uint256 indexed id, address indexed beneficiary, uint256 amount)',
]);
const GAS = 150000n;
const MAX_FEE = 3000000000n;
const PRIORITY_FEE = 1000000000n;
const fail = (code) => Object.assign(new Error(code), { code });
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// A local-demo executor, not a restricted wallet. The underlying EOA still has
// full authority. With pendingStore, one attempt is reserved under a shared
// same-origin browser lock and retained across reloads. No ticket is auto-cleared.
// Without that adapter only this instance is protected; use it in browser UI.
export function createClaimExecutor(options) {
  if (options.chainId !== 31337 || options.wallet?.chain?.id !== 31337) throw fail('LOCAL_CHAIN_REQUIRED');
  return createScopedClaimExecutor(options, { gas: GAS, maxFee: MAX_FEE, priorityFee: PRIORITY_FEE });
}

// Internal reuse point for the strict reviewed-profile wrapper, not a general
// transaction API. External SDK signers already have unrestricted authority.
export function __createReviewedClaimExecutor(options, guards) {
  if (options.chainId !== 10143 || options.wallet?.chain?.id !== 10143 || !options.pendingStore || ['beforePrepare', 'beforeBroadcast', 'beforeCheck'].some(key => typeof guards?.[key] !== 'function')) throw fail('REVIEWED_TESTNET_REQUIRED');
  return createScopedClaimExecutor(options, { gas: 300000n, maxFee: 200000000000n, priorityFee: 2000000000n, expectedNonce: 0, expectedRight: 1n, expectedAmount: 100000000000000000n, beforePrepare: guards.beforePrepare, beforeBroadcast: guards.beforeBroadcast, beforeCheck: guards.beforeCheck });
}

function createScopedClaimExecutor({ wallet, publicClient, chainId, address, abi, owner, pendingStore }, scopePolicy) {
  let selectedGas = scopePolicy.gas;
  address = getAddress(address);
  owner = getAddress(owner);
  if (!sameAddress(wallet?.account?.address, owner)) throw fail('SIGNER_MISMATCH');
  // Supplied deployment ABI must describe the one fixed claim. No arbitrary
  // calldata, destination, native value, chain or fee input is accepted later.
  if (encodeFunctionData({ abi, functionName: 'claim', args: [1n] }) !== encodeFunctionData({ abi: CLAIM_ABI, functionName: 'claim', args: [1n] })) throw fail('CLAIM_ABI_MISMATCH');
  if (pendingStore && ['read', 'put', 'withLock'].some(key => typeof pendingStore[key] !== 'function')) throw fail('PENDING_STORE_INVALID');
  let blockedError;
  let closed = false;
  let attempted = false;
  let attempt;
  let pending = false;
  let transactionHash;
  let rightId;
  // Only an observation from this executor's lifetime. Persisted hash tickets
  // cannot establish whether another page reached the broadcast call.
  let deliveryStatus = 'not-attempted';
  const active = () => { if (closed) throw fail('SESSION_CLOSED'); };

  async function checkReceipt() {
    if (!transactionHash) throw fail('NO_TRANSACTION');
    if (scopePolicy.beforeCheck) await scopePolicy.beforeCheck();
    let receipt;
    try { receipt = await publicClient.getTransactionReceipt({ hash: transactionHash }); }
    catch (error) {
      if (error?.name === 'TransactionReceiptNotFoundError') return { hash: transactionHash };
      throw error;
    }
    if (!receipt || receipt.transactionHash?.toLowerCase() !== transactionHash || !sameAddress(receipt.to, address) || !sameAddress(receipt.from, owner)) throw fail('RECEIPT_MISMATCH');
    if (receipt.status !== 'success') throw fail('CLAIM_REVERTED');
    const claims = [];
    for (const log of receipt.logs ?? []) {
      if (!sameAddress(log.address, address)) continue;
      try {
        const event = decodeEventLog({ abi: CLAIM_ABI, data: log.data, topics: log.topics, strict: true });
        if (event.eventName === 'RightClaimed') claims.push(event.args);
      } catch { /* Unrelated events are not evidence of this claim. */ }
    }
    if (claims.length !== 1 || claims[0].id !== rightId || !sameAddress(claims[0].beneficiary, owner) || typeof claims[0].amount !== 'bigint' || claims[0].amount <= 0n || (scopePolicy.expectedAmount !== undefined && claims[0].amount !== scopePolicy.expectedAmount)) throw fail('CLAIM_EVENT_MISMATCH');
    return { hash: transactionHash, receipt };
  }

  async function preflight() {
    active();
    if (await publicClient.getChainId() !== chainId) throw fail('LOCAL_CHAIN_REQUIRED');
    active();
    if (scopePolicy.beforePrepare) {
      const gas = await scopePolicy.beforePrepare();
      if (typeof gas !== 'bigint' || gas <= 0n || gas > scopePolicy.gas) throw fail('TESTNET_GAS_NOT_APPROVED');
      selectedGas = gas;
      active();
    }
  }

  async function execute(id) {
    const data = encodeFunctionData({ abi: CLAIM_ABI, functionName: 'claim', args: [id] });
    const request = await wallet.prepareTransactionRequest({
      account: wallet.account, chain: wallet.chain, chainId,
      type: 'eip1559', to: address, data, value: 0n, gas: selectedGas,
      maxFeePerGas: scopePolicy.maxFee, maxPriorityFeePerGas: scopePolicy.priorityFee,
    });
    active();
    validate(request, data);
    const serializedTransaction = await wallet.signTransaction(request);
    active();
    validate(parseTransaction(serializedTransaction), data);
    if (!sameAddress(await recoverTransactionAddress({ serializedTransaction }), owner)) throw fail('SIGNED_OWNER_MISMATCH');
    active();
    // This is the exact signed transaction's locally computed hash. Latch it
    // BEFORE the network call: an accepted write can lose its response.
    transactionHash = keccak256(serializedTransaction);
    if (pendingStore) await persist('signed');
    active();
    if (scopePolicy.beforeBroadcast) await scopePolicy.beforeBroadcast({ gas: selectedGas });
    active();
    deliveryStatus = 'attempted';
    const returnedHash = await publicClient.sendRawTransaction({ serializedTransaction });
    if (returnedHash.toLowerCase() !== transactionHash) throw fail('BROADCAST_HASH_MISMATCH');
    return checkReceipt();
  }

  function validate(transaction, data) {
    if (transaction.chainId !== chainId || transaction.type !== 'eip1559' || !sameAddress(transaction.to, address) || transaction.data !== data || (transaction.value ?? 0n) !== 0n || transaction.gas !== selectedGas || transaction.maxFeePerGas !== scopePolicy.maxFee || transaction.maxPriorityFeePerGas !== scopePolicy.priorityFee || !Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0 || (scopePolicy.expectedNonce !== undefined && transaction.nonce !== scopePolicy.expectedNonce) || (transaction.accessList?.length ?? 0) !== 0 || transaction.authorizationList !== undefined) throw fail('TRANSACTION_SCOPE_MISMATCH');
  }

  const withLock = callback => pendingStore ? pendingStore.withLock(callback) : callback();
  const scope = { chainId, address, owner };
  async function hydrate() {
    const raw = await pendingStore.read();
    if (raw === undefined) return false;
    const ticket = validatePendingTicket(raw, scope);
    attempted = true;
    rightId = BigInt(ticket.rightId);
    if (ticket.phase !== 'signed') {
      blockedError = fail('PENDING_ATTEMPT_REQUIRES_RECONCILIATION');
      throw blockedError;
    }
    if (transactionHash !== ticket.hash) deliveryStatus = 'unknown';
    transactionHash = ticket.hash;
    return true;
  }
  async function persist(phase) {
    const ticket = { version: 1, chainId, address: address.toLowerCase(), owner: owner.toLowerCase(), rightId: String(rightId), phase, hash: phase === 'signed' ? transactionHash : null };
    await pendingStore.put(ticket);
    const stored = validatePendingTicket(await pendingStore.read(), scope);
    if (keysEqual(stored, ticket) === false) throw fail('PENDING_STORE_READBACK_FAILED');
  }
  function keysEqual(a, b) { return Object.keys(b).every(key => a[key] === b[key]); }
  async function check() {
    return withLock(async () => {
      if (pendingStore && !(await hydrate())) throw fail('PENDING_TICKET_MISSING');
      return checkReceipt();
    });
  }
  async function begin(id) {
    return withLock(async () => {
      active();
      if (pendingStore) {
        if (await hydrate()) {
          if (rightId !== id) throw fail('RIGHT_ALREADY_SELECTED');
          return checkReceipt();
        }
      }
      // These guards only read the chain. A failure here must not burn the
      // durable attempt: nothing has been prepared, signed, or broadcast.
      // Keep the browser lock throughout checks and the following reservation.
      await preflight();
      active();
      attempted = true;
      rightId = id;
      if (pendingStore) await persist('reserved');
      active();
      return execute(id);
    });
  }

  return Object.freeze({
    claim(id) {
      active();
      if (typeof id !== 'bigint' || id <= 0n || id >= 2n ** 256n) return Promise.reject(fail('INVALID_RIGHT'));
      if (scopePolicy.expectedRight !== undefined && id !== scopePolicy.expectedRight) return Promise.reject(fail('RIGHT_NOT_APPROVED'));
      if (pending) {
        if (id !== rightId) return Promise.reject(fail('RIGHT_ALREADY_SELECTED'));
        return attempt;
      }
      if (attempted) {
        if (id !== rightId) return Promise.reject(fail('RIGHT_ALREADY_SELECTED'));
        if (!transactionHash) return Promise.reject(blockedError ?? fail('PENDING_ATTEMPT_REQUIRES_RECONCILIATION'));
        return check();
      }
      blockedError = undefined;
      rightId = id;
      pending = true;
      attempt = begin(id).catch(error => { blockedError = error; throw error; }).finally(() => { pending = false; });
      return attempt;
    },
    check,
    get hash() { return transactionHash; },
    get deliveryStatus() { return deliveryStatus; },
    close() { closed = true; },
  });
}
