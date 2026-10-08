import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, keccak256 } from 'viem';
import { __createReviewedClaimExecutor } from '../transaction.mjs';
import { __createTestnetPendingStore } from '../pending-ticket.mjs';
import { APPROVED_TESTNET_RPCS, PAYMENT_RIGHT_ABI, validateClientProfile } from './client-profile.mjs';
import { publicTestnetTransport } from './paced-rpc.mjs';

const fail = code => Object.assign(new Error(code), { code });
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const CLAIM_AMOUNT = 100000000000000000n;
const GAS_CEILING = 300000n;
const MAX_FEE = 200000000000n;
const PRIORITY = 2000000000n;

export function createTestnetPendingStore({ profile, owner, storage, locks }) {
  profile = validateClientProfile(profile, { allowExpired: true });
  return __createTestnetPendingStore({ chainId: profile.chainId, address: profile.contractAddress, owner, ...(storage ? { storage } : {}), ...(locks ? { locks } : {}) });
}

// Candidate only. Constructing a client makes no request. Callers must obtain
// concrete approval before enabling/publishing the profile or invoking a claim.
// RPCs are fixed here; no record, querystring or caller URL selects a network.
export function createTestnetClaimExecutor({ profile, recovered, pendingStore }, { rpcTransport = publicTestnetTransport } = {}) {
  profile = validateClientProfile(profile, { allowExpired: true });
  const owner = getAddress(recovered?.owner);
  if (!equal(recovered?.account?.address, owner)) throw fail('SIGNER_MISMATCH');
  const chain = { id: 10143, name: 'Monad testnet bounded candidate', nativeCurrency: { name: 'Test MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [...APPROVED_TESTNET_RPCS] } } };
  const clients = APPROVED_TESTNET_RPCS.map(url => createPublicClient({ chain, ccipRead: false, cacheTime: 0, transport: rpcTransport(url) }));
  const wallet = createWalletClient({ account: recovered.account, chain, cacheTime: 0, transport: rpcTransport(APPROVED_TESTNET_RPCS[0]) });
  pendingStore ??= createTestnetPendingStore({ profile, owner });
  const alive = () => { if (Date.parse(profile.expiresAt) <= Date.now()) throw fail('PUBLIC_RELEASE_EXPIRED'); };
  const data = encodeFunctionData({ abi: PAYMENT_RIGHT_ABI, functionName: 'claim', args: [1n] });

  async function environment() {
    await Promise.all(clients.map(async client => {
      const [chainId, code] = await Promise.all([
        client.getChainId(), client.getCode({ address: profile.contractAddress, blockTag: 'finalized' }),
      ]);
      if (chainId !== 10143) throw fail('TESTNET_CHAIN_MISMATCH');
      if (!code || code === '0x' || keccak256(code) !== profile.expectedRuntimeCodeHash) throw fail('TESTNET_RUNTIME_MISMATCH');
    }));
  }

  async function preflight(requiredGas = 0n) {
    alive();
    await environment();
    const observed = await Promise.all(clients.map(async client => {
      const [code, latestNonce, pendingNonce, right, mappedRight, issuer, block, estimate, balance] = await Promise.all([
        client.getCode({ address: owner, blockTag: 'latest' }),
        client.getTransactionCount({ address: owner, blockTag: 'latest' }),
        client.getTransactionCount({ address: owner, blockTag: 'pending' }),
        client.readContract({ address: profile.contractAddress, abi: PAYMENT_RIGHT_ABI, functionName: 'getRight', args: [1n] }),
        client.readContract({ address: profile.contractAddress, abi: PAYMENT_RIGHT_ABI, functionName: 'rightForOwner', args: [owner] }),
        client.readContract({ address: profile.contractAddress, abi: PAYMENT_RIGHT_ABI, functionName: 'issuer' }),
        client.getBlock({ blockTag: 'latest' }),
        client.estimateGas({ account: owner, to: profile.contractAddress, data, value: 0n, nonce: 0, gas: GAS_CEILING, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIORITY }),
        client.getBalance({ address: owner }),
      ]);
      if (code && code !== '0x') throw fail('TESTNET_OWNER_CODE_UNEXPECTED');
      if (latestNonce !== 0 || pendingNonce !== 0) throw fail('TESTNET_NONCE_NOT_APPROVED');
      if (!equal(issuer, profile.issuer) || mappedRight !== 1n || !equal(right.beneficiary, owner) || right.amount !== CLAIM_AMOUNT || right.claimed !== false) throw fail('TESTNET_RIGHT_MISMATCH');
      if (typeof block.baseFeePerGas !== 'bigint' || block.baseFeePerGas + PRIORITY > MAX_FEE) throw fail('TESTNET_FEE_CAP_EXCEEDED');
      if (estimate <= 0n || estimate > GAS_CEILING) throw fail('TESTNET_GAS_NOT_APPROVED');
      return { estimate, balance };
    }));
    const estimate = observed.reduce((max, item) => item.estimate > max ? item.estimate : max, 0n);
    const selectedGas = (estimate * 120n + 99n) / 100n;
    if (selectedGas > GAS_CEILING) throw fail('TESTNET_GAS_NOT_APPROVED');
    if (observed.some(item => item.balance < (selectedGas > requiredGas ? selectedGas : requiredGas) * MAX_FEE)) throw fail('TESTNET_FEE_BALANCE_INSUFFICIENT');
    alive();
    return selectedGas;
  }

  // Read-only corroboration. Matching JSON-RPC observations are not a light
  // client proof; both fixed RPCs must agree before the UI can claim completion.
  async function finalizedReceipt({ hash }) {
    const results = await Promise.allSettled(clients.map(client => client.getTransactionReceipt({ hash })));
    const failed = results.filter(result => result.status === 'rejected');
    const unavailable = failed.find(result => result.reason?.name !== 'TransactionReceiptNotFoundError');
    if (unavailable) throw unavailable.reason;
    const pending = () => { throw Object.assign(fail('TESTNET_CONFIRMATION_PENDING'), { name: 'TransactionReceiptNotFoundError' }); };
    if (failed.length) return pending();
    const receipts = results.map(result => result.value);
    const receipt = receipts[0];
    if (!Array.isArray(receipt.logs) || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash ?? '') || !equal(receipt.transactionHash, hash)) throw fail('TESTNET_RECEIPT_MISMATCH');
    const canonicalReceipt = value => JSON.stringify({
      transactionHash: value.transactionHash?.toLowerCase(), blockHash: value.blockHash?.toLowerCase(), blockNumber: value.blockNumber,
      transactionIndex: value.transactionIndex, from: value.from?.toLowerCase(), to: value.to?.toLowerCase(), status: value.status,
      contractAddress: value.contractAddress?.toLowerCase() ?? null, type: value.type, cumulativeGasUsed: value.cumulativeGasUsed,
      gasUsed: value.gasUsed, effectiveGasPrice: value.effectiveGasPrice, logsBloom: value.logsBloom?.toLowerCase(),
      logs: value.logs?.map(log => ({ address: log.address?.toLowerCase(), topics: log.topics?.map(topic => topic.toLowerCase()), data: log.data?.toLowerCase(),
        logIndex: log.logIndex, transactionIndex: log.transactionIndex, transactionHash: log.transactionHash?.toLowerCase(),
        blockHash: log.blockHash?.toLowerCase(), blockNumber: log.blockNumber, removed: log.removed })),
    }, (_, value) => typeof value === 'bigint' ? value.toString() : value);
    if (canonicalReceipt(receipt) !== canonicalReceipt(receipts[1])) throw fail('TESTNET_RECEIPT_DISAGREEMENT');
    if (receipt.logs.some(log => log.removed || !equal(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber || !equal(log.transactionHash, hash))) throw fail('TESTNET_RECEIPT_MISMATCH');
    const blocks = await Promise.all(clients.map(async client => ({
      finalized: await client.getBlock({ blockTag: 'finalized' }),
      canonical: await client.getBlock({ blockNumber: receipt.blockNumber }),
    })));
    if (blocks.some(({ canonical }) => canonical.number !== receipt.blockNumber || !equal(canonical.hash, receipt.blockHash))) throw fail('TESTNET_CANONICAL_BLOCK_MISMATCH');
    if (blocks.some(({ finalized }) => typeof finalized.number !== 'bigint' || !/^0x[0-9a-f]{64}$/i.test(finalized.hash ?? ''))) throw fail('TESTNET_FINALIZED_HEAD_INVALID');
    if (blocks.some(({ finalized }) => finalized.number < receipt.blockNumber)) return pending();
    if (blocks.some(({ finalized }) => finalized.number === receipt.blockNumber && !equal(finalized.hash, receipt.blockHash))) throw fail('TESTNET_CANONICAL_BLOCK_MISMATCH');
    if (receipt.status !== 'success') return receipt; // The shared executor rejects a reverted receipt.
    await Promise.all(clients.map(async client => {
      const [right, mappedRight] = await Promise.all([
        client.readContract({ address: profile.contractAddress, abi: PAYMENT_RIGHT_ABI, functionName: 'getRight', args: [1n], blockNumber: receipt.blockNumber }),
        client.readContract({ address: profile.contractAddress, abi: PAYMENT_RIGHT_ABI, functionName: 'rightForOwner', args: [owner], blockNumber: receipt.blockNumber }),
      ]);
      if (mappedRight !== 1n || !equal(right.beneficiary, owner) || right.amount !== CLAIM_AMOUNT || right.claimed !== true) throw fail('TESTNET_CLAIMED_STATE_MISMATCH');
      // Recheck the height after numbered state reads rather than silently
      // accepting a changed canonical block while the requests were in flight.
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (canonical.number !== receipt.blockNumber || !equal(canonical.hash, receipt.blockHash)) throw fail('TESTNET_CANONICAL_BLOCK_MISMATCH');
    }));
    return receipt;
  }
  const checkedPublicClient = {
    getChainId: () => clients[0].getChainId(),
    sendRawTransaction: args => clients[0].sendRawTransaction(args),
    getTransactionReceipt: finalizedReceipt,
  };

  return __createReviewedClaimExecutor({ wallet, publicClient: checkedPublicClient, chainId: 10143, address: profile.contractAddress, abi: PAYMENT_RIGHT_ABI, owner, pendingStore }, {
    beforePrepare: preflight,
    async beforeBroadcast({ gas }) {
      const needed = await preflight(gas);
      if (needed > gas) throw fail('TESTNET_GAS_CHANGED');
    },
    beforeCheck: environment,
  });
}
