import { createPublicClient, createWalletClient, getAddress } from 'viem';
import { APPROVED_TESTNET_RPCS } from '../release/client-profile.mjs';
import { publicTestnetTransport } from '../release/paced-rpc.mjs';
import { createPaymentGuard, validatePaymentProfile } from './guard.mjs';
import { createBrowserPaymentPendingStore, validatePaymentPolicy, paymentEntryPolicy } from './pending.mjs';
import { createPaymentExecutor } from './executor.mjs';

const fail = code => Object.assign(new Error(code),{code});
// Construction never requests a credential, reads the network or sends a
// transaction. The existing account recovery session is supplied explicitly.
export function createTestnetPaymentClient({profile:input,recovered,storage,locks},{rpcTransport=publicTestnetTransport}={}) {
  const profile=validatePaymentProfile(input);
  if(profile.chainId!==10143)throw fail('PAYMENT_TESTNET_REQUIRED');
  if(getAddress(recovered?.owner)!==profile.owner||getAddress(recovered?.account?.address)!==profile.owner)throw fail('PAYMENT_SIGNER_MISMATCH');
  const chain={id:10143,name:'Monad testnet sequential payments',nativeCurrency:{name:'Test MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:[...APPROVED_TESTNET_RPCS]}}};
  const clients=APPROVED_TESTNET_RPCS.map(url=>createPublicClient({chain,ccipRead:false,cacheTime:0,transport:rpcTransport(url)}));
  const wallet=createWalletClient({account:recovered.account,chain,cacheTime:0,transport:rpcTransport(APPROVED_TESTNET_RPCS[0])});
  const guard=createPaymentGuard({profile,clients});
  const pendingStore=createBrowserPaymentPendingStore({chainId:10143,owner:profile.owner,...(storage?{storage}:{}),...(locks?{locks}:{})});
  const executors=new Set();let closed=false;
  return Object.freeze({
    forRight(rightId){
      if(closed)throw fail('SESSION_CLOSED');
      const checked=guard.forRight(rightId);
      const executor=createPaymentExecutor({wallet,policy:checked.policy,pendingStore,publicClient:{
        getChainId:()=>clients[0].getChainId(),
        sendRawTransaction:args=>clients[0].sendRawTransaction(args),
        getTransactionReceipt:({hash,policy=checked.policy})=>{
          const approved=validatePaymentPolicy(guard.policyFor(policy.rightId));
          if(Object.keys(approved).some(k=>approved[k]!==policy[k]))throw fail('PAYMENT_NOT_APPROVED');
          return guard.forRight(policy.rightId).getTransactionReceipt({hash});
        },
      }},checked.guards);
      executors.add(executor);return executor;
    },
    close(){closed=true;for(const executor of executors)executor.close();executors.clear();recovered.close();},
  });
}

// Chain reads and a public journal confirmation only. Does not need or construct
// a signing session, so an uncertain send remains checkable after page reload.
export function createTestnetPaymentReader({profile:input,storage,locks},{rpcTransport=publicTestnetTransport}={}) {
  const profile=validatePaymentProfile(input);
  if(profile.chainId!==10143)throw fail('PAYMENT_TESTNET_REQUIRED');
  const chain={id:10143,name:'Monad testnet payment reader',nativeCurrency:{name:'Test MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:[...APPROVED_TESTNET_RPCS]}}};
  const clients=APPROVED_TESTNET_RPCS.map(url=>createPublicClient({chain,ccipRead:false,cacheTime:0,transport:rpcTransport(url)}));
  const guard=createPaymentGuard({profile,clients});
  const store=createBrowserPaymentPendingStore({chainId:10143,owner:profile.owner,...(storage?{storage}:{}),...(locks?{locks}:{})});
  return Object.freeze({
    check(rightId){return store.withLock(async()=>{
      const policy=validatePaymentPolicy(guard.policyFor(rightId)),journal=await store.read();
      const index=journal?.entries.findIndex(e=>e.address===policy.address&&e.rightId===String(rightId))??-1;
      if(index<0)throw fail('PAYMENT_TRANSACTION_MISSING');
      const entry=journal.entries[index];
      const saved=paymentEntryPolicy(entry,{chainId:profile.chainId,owner:profile.owner});
      if(Object.keys(policy).some(k=>saved[k]!==policy[k]))throw fail('PAYMENT_NOT_APPROVED');
      if(entry.phase==='reserved')throw fail('PAYMENT_RECONCILIATION_REQUIRED');
      let receipt;
      try{receipt=await guard.forRight(rightId).getTransactionReceipt({hash:entry.hash});}
      catch(e){if(e?.name==='TransactionReceiptNotFoundError')return {hash:entry.hash};throw e;}
      if(receipt.status!=='success')throw fail('PAYMENT_REVERTED');
      if(entry.phase==='signed'){
        const entries=journal.entries.map((e,i)=>i===index?{...e,phase:'confirmed'}:e);
        await store.put({...journal,entries,active:null});
      }
      return {hash:entry.hash,receipt};
    });},
  });
}

const VERIFICATION_ERRORS = new Set([
  'PAYMENT_VERIFICATION_INPUT_INVALID','PAYMENT_NOT_APPROVED','PAYMENT_RECEIPT_UNAVAILABLE',
  'PAYMENT_RECEIPT_MISMATCH','PAYMENT_RECEIPT_DISAGREEMENT','PAYMENT_EVENT_MISMATCH',
  'PAYMENT_CHAIN_MISMATCH','PAYMENT_RUNTIME_MISMATCH','PAYMENT_ISSUER_MISMATCH',
  'PAYMENT_CANONICAL_BLOCK_MISMATCH','PAYMENT_FINALIZED_HEAD_INVALID','PAYMENT_TRANSACTION_MISMATCH',
  'PAYMENT_TRANSACTION_SIGNATURE_INVALID','PAYMENT_TRANSACTION_HASH_MISMATCH',
  'PAYMENT_SIGNED_OWNER_MISMATCH','PAYMENT_RIGHT_MISMATCH',
]);
function verificationCode(error) {
  try { const d=Object.getOwnPropertyDescriptor(error,'code');return d&&Object.hasOwn(d,'value')?d.value:undefined; }
  catch { return undefined; }
}
function verificationInput(input,count) {
  try {
    if(count!==1||!input||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw 0;
    const keys=Reflect.ownKeys(input);if(keys.length!==2||keys.some(k=>!['rightId','hash'].includes(k)))throw 0;
    const captured={};for(const name of ['rightId','hash']){const d=Object.getOwnPropertyDescriptor(input,name);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw 0;captured[name]=d.value;}
    if(typeof captured.rightId!=='bigint'||captured.rightId<=0n||captured.rightId>=2n**256n||typeof captured.hash!=='string'||captured.hash.length!==66||!/^0x[0-9a-f]{64}$/i.test(captured.hash))throw 0;
    return {rightId:captured.rightId,hash:captured.hash.toLowerCase()};
  }catch{throw fail('PAYMENT_VERIFICATION_INPUT_INVALID');}
}

// Stateless receipt verification. Does not construct or touch browser storage,
// Web Locks, a signing account, credentials, or the local attempt journal.
export function createTestnetPaymentVerifier({profile:input},{rpcTransport=publicTestnetTransport}={}) {
  const profile=validatePaymentProfile(input);
  if(profile.chainId!==10143)throw fail('PAYMENT_TESTNET_REQUIRED');
  const chain={id:10143,name:'Monad testnet exact payment verifier',nativeCurrency:{name:'Test MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:[...APPROVED_TESTNET_RPCS]}}};
  const clients=APPROVED_TESTNET_RPCS.map(url=>createPublicClient({chain,ccipRead:false,cacheTime:0,transport:rpcTransport(url)}));
  const guard=createPaymentGuard({profile,clients});
  return Object.freeze({
    async check(input){
      try{
        const {rightId,hash}=verificationInput(input,arguments.length),selected=guard.forRight(rightId);
        const identity={chainId:profile.chainId,contract:profile.address,beneficiary:profile.owner,rightId,amount:selected.policy.amount,hash,readOnly:true};
        let receipt;
        try{receipt=await selected.getTransactionReceipt({hash});}
        catch(error){if(verificationCode(error)==='PAYMENT_CONFIRMATION_PENDING')return Object.freeze({...identity,status:'pending-or-unknown',finalized:false,paymentVerified:false});throw error;}
        return Object.freeze({...identity,status:receipt.status==='success'?'finalized':'reverted',finalized:true,paymentVerified:receipt.status==='success',blockNumber:receipt.blockNumber,blockHash:receipt.blockHash});
      }catch(error){const code=verificationCode(error);throw fail(VERIFICATION_ERRORS.has(code)?code:'PAYMENT_VERIFICATION_FAILED');}
    },
  });
}

const AVAILABILITY_ERRORS = new Set([
  'PAYMENT_AVAILABILITY_INPUT_INVALID','PAYMENT_NOT_APPROVED','PAYMENT_CHAIN_MISMATCH',
  'PAYMENT_RUNTIME_MISMATCH','PAYMENT_ISSUER_MISMATCH','PAYMENT_RIGHT_MISMATCH',
  'PAYMENT_CANONICAL_BLOCK_MISMATCH','PAYMENT_FINALIZED_HEAD_INVALID',
  'PAYMENT_AVAILABILITY_RESPONSE_INVALID','PAYMENT_STATE_DISAGREEMENT','PAYMENT_OWNER_CODE_UNEXPECTED',
]);
function availabilityInput(input,count) {
  try {
    if(count!==1||!input||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw 0;
    const keys=Reflect.ownKeys(input),d=Object.getOwnPropertyDescriptor(input,'rightId');
    if(keys.length!==1||keys[0]!=='rightId'||!d?.enumerable||!Object.hasOwn(d,'value')||typeof d.value!=='bigint'||d.value<=0n||d.value>=2n**256n)throw 0;
    return d.value;
  }catch{throw fail('PAYMENT_AVAILABILITY_INPUT_INVALID');}
}

// Eligibility observation before authentication. No journal, account, Storage
// or Web Locks are constructed. This is neither a receipt nor a signing grant.
export function createTestnetPaymentAvailability({profile:input},{rpcTransport=publicTestnetTransport}={}) {
  const profile=validatePaymentProfile(input);
  if(profile.chainId!==10143)throw fail('PAYMENT_TESTNET_REQUIRED');
  const chain={id:10143,name:'Monad testnet payment availability',nativeCurrency:{name:'Test MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:[...APPROVED_TESTNET_RPCS]}}};
  const clients=APPROVED_TESTNET_RPCS.map(url=>createPublicClient({chain,ccipRead:false,cacheTime:0,transport:rpcTransport(url)}));
  const guard=createPaymentGuard({profile,clients});
  return Object.freeze({async check(input){
    try{return await guard.availability(availabilityInput(input,arguments.length));}
    catch(error){const code=verificationCode(error);throw fail(AVAILABILITY_ERRORS.has(code)?code:'PAYMENT_AVAILABILITY_FAILED');}
  }});
}
