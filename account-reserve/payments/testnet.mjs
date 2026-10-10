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
