import { decodeEventLog, encodeFunctionData, getAddress, keccak256, parseAbi, recoverTransactionAddress, serializeTransaction } from 'viem';

export const PAYMENT_ABI = parseAbi([
  'function claim(uint256 id)',
  'function issuer() view returns (address)',
  'function rightForOwner(address owner) view returns (uint256)',
  'function getRight(uint256 id) view returns ((address beneficiary,uint256 amount,bool claimed))',
  'event RightClaimed(uint256 indexed id, address indexed beneficiary, uint256 amount)',
]);
export const PAYMENT_LIMITS = Object.freeze({ gas: 300000n, maxFeePerGas: 200000000000n, maxPriorityFeePerGas: 2000000000n });
const fail = code => Object.assign(new Error(code), { code });
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const uint = value => typeof value === 'bigint' && value > 0n && value < 2n ** 256n;
function signatureScalar(input) {
  // RPCs expose r/s as either fixed-width data or minimally encoded quantities.
  // Normalize the same integer before rebuilding the signed transaction.
  if (typeof input !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(input)) throw 0;
  const scalar = BigInt(input);
  if (scalar <= 0n || scalar >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n) throw 0;
  return '0x' + input.slice(2).padStart(64, '0');
}
function capture(value, names) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('PAYMENT_PROFILE_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) throw fail('PAYMENT_PROFILE_INVALID');
  const result = {};
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw fail('PAYMENT_PROFILE_INVALID');
    result[name] = d.value;
  }
  return result;
}
export function validatePaymentProfile(input) {
  const p = capture(input, ['chainId','address','owner','issuer','expectedRuntimeCodeHash','expiresAt','claims']);
  if (![31337,10143].includes(p.chainId) || typeof p.expiresAt !== 'string' || !Number.isFinite(Date.parse(p.expiresAt)) || new Date(p.expiresAt).toISOString() !== p.expiresAt) throw fail('PAYMENT_PROFILE_INVALID');
  for (const key of ['address','owner','issuer']) {
    try { p[key] = getAddress(p[key]); } catch { throw fail('PAYMENT_PROFILE_INVALID'); }
    if (/^0x0{40}$/i.test(p[key])) throw fail('PAYMENT_PROFILE_INVALID');
  }
  if (new Set([p.address,p.owner,p.issuer].map(s => s.toLowerCase())).size !== 3 || typeof p.expectedRuntimeCodeHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(p.expectedRuntimeCodeHash) || /^0x0{64}$/.test(p.expectedRuntimeCodeHash)) throw fail('PAYMENT_PROFILE_INVALID');
  if (!Array.isArray(p.claims) || p.claims.length < 1 || p.claims.length > 8 || Reflect.ownKeys(p.claims).length !== p.claims.length + 1) throw fail('PAYMENT_PROFILE_INVALID');
  const ids = new Set(), nonces = new Set();
  let previous;
  p.claims = Array.from({length:p.claims.length}, (_, index) => {
    const d = Object.getOwnPropertyDescriptor(p.claims, String(index));
    if (!d?.enumerable || !Object.hasOwn(d,'value')) throw fail('PAYMENT_PROFILE_INVALID');
    const c = capture(d.value, ['rightId','amount','nonce']);
    if (!uint(c.rightId) || !uint(c.amount) || c.amount > 10n ** 18n || !Number.isSafeInteger(c.nonce) || c.nonce < 0 || ids.has(c.rightId) || nonces.has(c.nonce)) throw fail('PAYMENT_PROFILE_INVALID');
    if (previous && (c.rightId <= previous.rightId || c.nonce !== previous.nonce + 1)) throw fail('PAYMENT_PROFILE_INVALID');
    ids.add(c.rightId); nonces.add(c.nonce); previous=c; return Object.freeze(c);
  });
  return Object.freeze({...p,claims:Object.freeze(p.claims)});
}

// Read-only guard. Test clients can point to isolated loopback EVMs. The public
// testnet factory fixes its own two RPCs; encrypted records never select them.
export function createPaymentGuard({profile: input, clients, now = Date.now}) {
  const profile = validatePaymentProfile(input);
  if (!Array.isArray(clients) || clients.length !== 2 || clients.some(c => !c || typeof c.getChainId !== 'function') || typeof now !== 'function') throw fail('PAYMENT_CLIENTS_INVALID');
  clients = [...clients];
  const alive = () => { if (Date.parse(profile.expiresAt) <= now()) throw fail('PAYMENT_PROFILE_EXPIRED'); };
  function policyFor(rightId) {
    const intent = profile.claims.find(c => c.rightId === rightId);
    if (!intent) throw fail('PAYMENT_NOT_APPROVED');
    return Object.freeze({chainId:profile.chainId,address:profile.address,owner:profile.owner,...intent,...PAYMENT_LIMITS});
  }
  async function environment() {
    await Promise.all(clients.map(async c => {
      const [chainId, code, issuer] = await Promise.all([
        c.getChainId(), c.getCode({address:profile.address,blockTag:'finalized'}),
        c.readContract({address:profile.address,abi:PAYMENT_ABI,functionName:'issuer',blockTag:'finalized'}),
      ]);
      if (chainId !== profile.chainId) throw fail('PAYMENT_CHAIN_MISMATCH');
      if (!code || code === '0x' || keccak256(code) !== profile.expectedRuntimeCodeHash) throw fail('PAYMENT_RUNTIME_MISMATCH');
      if (!equal(issuer, profile.issuer)) throw fail('PAYMENT_ISSUER_MISMATCH');
    }));
  }
  function requireRight(right, policy, claimed) {
    if (!right || !equal(right.beneficiary, profile.owner) || right.amount !== policy.amount || right.claimed !== claimed) throw fail('PAYMENT_RIGHT_MISMATCH');
  }
  async function preflight(policy, requiredGas = 0n) {
    alive(); await environment();
    const data = encodeFunctionData({abi:PAYMENT_ABI,functionName:'claim',args:[policy.rightId]});
    const observations = await Promise.all(clients.map(async c => {
      const [code, latest, pending, right, finalizedRight, mapped, block, estimate, balance] = await Promise.all([
        c.getCode({address:profile.owner,blockTag:'latest'}),
        c.getTransactionCount({address:profile.owner,blockTag:'latest'}), c.getTransactionCount({address:profile.owner,blockTag:'pending'}),
        c.readContract({address:profile.address,abi:PAYMENT_ABI,functionName:'getRight',args:[policy.rightId],blockTag:'latest'}),
        c.readContract({address:profile.address,abi:PAYMENT_ABI,functionName:'getRight',args:[policy.rightId],blockTag:'finalized'}),
        c.readContract({address:profile.address,abi:PAYMENT_ABI,functionName:'rightForOwner',args:[profile.owner],blockTag:'latest'}),
        c.getBlock({blockTag:'latest'}),
        c.estimateGas({account:profile.owner,to:profile.address,data,value:0n,nonce:policy.nonce,...PAYMENT_LIMITS}),
        c.getBalance({address:profile.owner}),
      ]);
      if (code && code !== '0x') throw fail('PAYMENT_OWNER_CODE_UNEXPECTED');
      if (latest !== policy.nonce || pending !== policy.nonce) throw fail('PAYMENT_NONCE_MISMATCH');
      requireRight(right,policy,false); requireRight(finalizedRight,policy,false);
      if (mapped !== policy.rightId) throw fail('PAYMENT_CURRENT_RIGHT_MISMATCH');
      if (typeof block.baseFeePerGas !== 'bigint' || block.baseFeePerGas + policy.maxPriorityFeePerGas > policy.maxFeePerGas) throw fail('PAYMENT_FEE_CAP_EXCEEDED');
      if (typeof estimate !== 'bigint' || estimate <= 0n || estimate > policy.gas || typeof balance !== 'bigint') throw fail('PAYMENT_GAS_INVALID');
      return {estimate,balance};
    }));
    const selected = (observations.reduce((max,r) => r.estimate > max ? r.estimate : max,0n) * 120n + 99n) / 100n;
    if (selected > policy.gas) throw fail('PAYMENT_GAS_INVALID');
    if (observations.some(r => r.balance < (selected > requiredGas ? selected : requiredGas) * policy.maxFeePerGas)) throw fail('PAYMENT_GAS_BALANCE_INSUFFICIENT');
    alive(); return selected;
  }
  const canonical = value => JSON.stringify(value,(_,v) => typeof v === 'bigint' ? v.toString() : typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? v.toLowerCase() : v);
  function receiptShape(r) {
    return {transactionHash:r.transactionHash,blockHash:r.blockHash,blockNumber:r.blockNumber,transactionIndex:r.transactionIndex,from:r.from,to:r.to,contractAddress:r.contractAddress??null,type:r.type,status:r.status,gasUsed:r.gasUsed,effectiveGasPrice:r.effectiveGasPrice,
      logs:r.logs?.map(l=>({address:l.address,topics:l.topics,data:l.data,logIndex:l.logIndex,transactionIndex:l.transactionIndex,transactionHash:l.transactionHash,blockHash:l.blockHash,blockNumber:l.blockNumber,removed:l.removed}))};
  }
  function pendingReceipt() { throw Object.assign(fail('PAYMENT_CONFIRMATION_PENDING'),{name:'TransactionReceiptNotFoundError'}); }
  async function finalizedReceipt(policy, {hash}) {
    const reads = await Promise.allSettled(clients.map(c => c.getTransactionReceipt({hash})));
    for (const r of reads) if (r.status === 'rejected' && r.reason?.name !== 'TransactionReceiptNotFoundError') throw fail('PAYMENT_RECEIPT_UNAVAILABLE');
    if (reads.some(r=>r.status==='rejected')) return pendingReceipt();
    const receipts=reads.map(r=>r.value),receipt=receipts[0];
    if (!receipt || !Array.isArray(receipt.logs) || receipt.logs.length > 1024 || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash ?? '') || !Number.isSafeInteger(receipt.transactionIndex) || receipt.transactionIndex < 0 || receipt.type !== 'eip1559' || !['success','reverted'].includes(receipt.status) || receipt.contractAddress != null || typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed <= 0n || receipt.gasUsed > policy.gas || typeof receipt.effectiveGasPrice !== 'bigint' || receipt.effectiveGasPrice < 0n || receipt.effectiveGasPrice > policy.maxFeePerGas || !equal(receipt.transactionHash,hash) || !equal(receipt.from,profile.owner) || !equal(receipt.to,profile.address)) throw fail('PAYMENT_RECEIPT_MISMATCH');
    if (canonical(receiptShape(receipt)) !== canonical(receiptShape(receipts[1]))) throw fail('PAYMENT_RECEIPT_DISAGREEMENT');
    if (receipt.logs.some(l => l.removed !== false || !equal(l.blockHash,receipt.blockHash) || l.blockNumber !== receipt.blockNumber || !equal(l.transactionHash,hash) || l.transactionIndex !== receipt.transactionIndex || !Number.isSafeInteger(l.logIndex) || l.logIndex < 0)) throw fail('PAYMENT_RECEIPT_MISMATCH');
    if (receipt.status === 'success') {
      const claims=[];
      for (const log of receipt.logs) {
        if (!equal(log.address,profile.address)) continue;
        try { const event=decodeEventLog({abi:PAYMENT_ABI,data:log.data,topics:log.topics,strict:true}); if(event.eventName==='RightClaimed')claims.push(event.args); } catch {}
      }
      if(claims.length!==1||claims[0].id!==policy.rightId||!equal(claims[0].beneficiary,profile.owner)||claims[0].amount!==policy.amount)throw fail('PAYMENT_EVENT_MISMATCH');
    }
    await environment();
    const observations=await Promise.all(clients.map(async c => {
      const [finalized, block, tx] = await Promise.all([c.getBlock({blockTag:'finalized'}),c.getBlock({blockNumber:receipt.blockNumber}),c.getTransaction({hash})]);
      if (block.number !== receipt.blockNumber || !equal(block.hash,receipt.blockHash)) throw fail('PAYMENT_CANONICAL_BLOCK_MISMATCH');
      if (typeof finalized.number !== 'bigint' || !/^0x[0-9a-f]{64}$/i.test(finalized.hash??'')) throw fail('PAYMENT_FINALIZED_HEAD_INVALID');
      if (finalized.number < receipt.blockNumber) return false;
      if (finalized.number === receipt.blockNumber && !equal(finalized.hash,receipt.blockHash)) throw fail('PAYMENT_CANONICAL_BLOCK_MISMATCH');
      const data=encodeFunctionData({abi:PAYMENT_ABI,functionName:'claim',args:[policy.rightId]});
      if (!equal(tx.hash,hash) || !equal(tx.from,profile.owner) || !equal(tx.to,profile.address) || tx.input !== data || tx.value !== 0n || tx.nonce !== policy.nonce || tx.chainId !== profile.chainId || tx.type !== 'eip1559' || typeof tx.gas !== 'bigint' || tx.gas <= 0n || tx.gas > policy.gas || tx.maxFeePerGas !== policy.maxFeePerGas || tx.maxPriorityFeePerGas !== policy.maxPriorityFeePerGas || (tx.accessList?.length??0)!==0 || tx.authorizationList !== undefined || tx.blobVersionedHashes !== undefined || tx.maxFeePerBlobGas !== undefined || !equal(tx.blockHash,receipt.blockHash) || tx.blockNumber !== receipt.blockNumber || tx.transactionIndex !== receipt.transactionIndex) throw fail('PAYMENT_TRANSACTION_MISMATCH');
      if (receipt.gasUsed > tx.gas) throw fail('PAYMENT_RECEIPT_MISMATCH');
      // Rebuild from the approved EIP-1559 fields, rather than trusting an RPC's
      // hash/from labels. Neither an alternate envelope nor an RPC-only signer
      // assertion can settle the pinned journal entry.
      let serialized;
      try {
        const r = signatureScalar(tx.r), s = signatureScalar(tx.s);
        const parity = tx.yParity ?? (typeof tx.v === 'bigint' ? Number(tx.v >= 27n ? tx.v - 27n : tx.v) : undefined);
        if (![0,1].includes(parity) || tx.v !== undefined && (![0n,1n,27n,28n].includes(tx.v) || Number(tx.v >= 27n ? tx.v-27n : tx.v) !== parity)) throw 0;
        serialized = serializeTransaction({type:'eip1559',chainId:tx.chainId,nonce:tx.nonce,to:tx.to,data:tx.input,value:tx.value,gas:tx.gas,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas,accessList:[]},{r,s,yParity:parity});
      } catch { throw fail('PAYMENT_TRANSACTION_SIGNATURE_INVALID'); }
      if (!equal(keccak256(serialized),hash)) throw fail('PAYMENT_TRANSACTION_HASH_MISMATCH');
      let recovered;
      try { recovered=await recoverTransactionAddress({serializedTransaction:serialized}); } catch { throw fail('PAYMENT_TRANSACTION_SIGNATURE_INVALID'); }
      if (!equal(recovered,profile.owner)) throw fail('PAYMENT_SIGNED_OWNER_MISMATCH');
      if (receipt.status === 'success') {
        const right=await c.readContract({address:profile.address,abi:PAYMENT_ABI,functionName:'getRight',args:[policy.rightId],blockNumber:receipt.blockNumber});
        requireRight(right,policy,true);
      }
      const recheck=await c.getBlock({blockNumber:receipt.blockNumber});
      if (!equal(recheck.hash,receipt.blockHash)) throw fail('PAYMENT_CANONICAL_BLOCK_MISMATCH');
      return true;
    }));
    if (observations.some(ok=>!ok)) return pendingReceipt();
    return receipt;
  }
  return Object.freeze({profile,policyFor,
    forRight(rightId) {
      const policy=policyFor(rightId);
      return Object.freeze({policy,guards:Object.freeze({beforePrepare:()=>preflight(policy),beforeBroadcast:async({gas})=>{if(await preflight(policy,gas)>gas)throw fail('PAYMENT_GAS_CHANGED');},beforeCheck:environment}),getTransactionReceipt:args=>finalizedReceipt(policy,args)});
    },
  });
}
