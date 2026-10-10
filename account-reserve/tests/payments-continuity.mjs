import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createPublicClient,createWalletClient,http,getAddress} from 'viem';
import {startSequentialPaymentChain} from '../payments/harness.mjs';
import {createPaymentGuard} from '../payments/guard.mjs';
import {createPaymentExecutor} from '../payments/executor.mjs';
import {createBrowserPaymentPendingStore,validatePaymentPolicy} from '../payments/pending.mjs';
import {makeDerivedSdkFixture} from './sdk-derived-fixture.mjs';

function browserPersistence(){
 const values=new Map();let queue=Promise.resolve();
 return {storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},locks:{request(_key,_options,fn){const p=queue.then(()=>fn({name:_key,mode:'exclusive'}));queue=p.catch(()=>{});return p;}},values};
}
async function primaryHost(){
 let offline=false,requests=0;const server=createServer((_q,r)=>{requests++;r.writeHead(offline?503:200,{'content-type':'text/plain'});r.end(offline?'Original app unavailable':'Original app available');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}`,offline(){offline=true;},requests:()=>requests,close:()=>new Promise(resolve=>server.close(resolve))};
}
test('same prepared account settles a new funded obligation after original app outage',async t=>{
 const fixture=await makeDerivedSdkFixture('iris'),harness=await startSequentialPaymentChain(),primary=await primaryHost();
 let recovered,first,second,third;
 t.after(async()=>{first?.close();second?.close();third?.close();recovered?.close();fixture.cleanup();await primary.close();await harness.close();});
 const chain={id:31337,name:'Local sequential payment continuity',nativeCurrency:{name:'Synthetic test units',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[harness.rpcUrl]}}};
 const clients=[0,1].map(()=>createPublicClient({chain,cacheTime:0,transport:http(harness.rpcUrl,{retryCount:0})}));
 const owner=fixture.originalAccount.address,amount=10n**16n;
 const profile={chainId:31337,address:harness.contractAddress,owner,issuer:harness.issuer,expectedRuntimeCodeHash:harness.runtimeCodeHash,expiresAt:new Date(Date.now()+3600000).toISOString(),claims:[{rightId:1n,amount,nonce:0},{rightId:2n,amount,nonce:1}]};
 const guard=createPaymentGuard({profile,clients}), persistence=browserPersistence();let broadcasts=0;
 const makeExecutor=(account,rightId)=>{
  const c=guard.forRight(rightId),wallet=createWalletClient({account,chain,transport:http(harness.rpcUrl,{retryCount:0})});
  return createPaymentExecutor({wallet,policy:c.policy,pendingStore:createBrowserPaymentPendingStore({chainId:31337,owner,storage:persistence.storage,locks:persistence.locks}),publicClient:{
   getChainId:()=>clients[0].getChainId(),sendRawTransaction:args=>{broadcasts++;return clients[0].sendRawTransaction(args);},
   getTransactionReceipt:({hash,policy=c.policy})=>{const expected=validatePaymentPolicy(guard.policyFor(policy.rightId));assert.deepEqual(policy,expected);return guard.forRight(policy.rightId).getTransactionReceipt({hash});},
  }},c.guards);
 };
 await fixture.prepare();const preparedStats=fixture.stats();const ciphertext=[...fixture.store.records()].map(([k,v])=>[k,Buffer.from(v).toString('hex')]);
 assert.equal((await fetch(primary.url)).status,200);
 const obligation1=await harness.preparePayment(owner,{amount});assert.equal(obligation1.id,1n);await harness.rpc('anvil_mine',['0x40']);
 await guard.forRight(1n).guards.beforePrepare();
 first=makeExecutor(fixture.originalAccount,1n);const before1=await clients[0].getBalance({address:owner});
 let result1=await first.claim();if(!result1.receipt){await harness.rpc('anvil_mine',['0x40']);result1=await first.check();}assert.equal(result1.receipt.status,'success');
 assert.equal(await clients[0].getBalance({address:owner}),before1+amount-result1.receipt.gasUsed*result1.receipt.effectiveGasPrice);first.close();
 fixture.closeOriginal();primary.offline();assert.equal((await fetch(primary.url)).status,503);
 await assert.rejects(fixture.originalAccount.signMessage({message:'Original signer closed'}),e=>e.code==='SESSION_ENDED');
 const obligation2=await harness.preparePayment(owner,{amount});assert.equal(obligation2.id,2n);await harness.rpc('anvil_mine',['0x40']);assert.equal(obligation2.beneficiary,getAddress(owner));
 const before=fixture.stats(),primaryRequests=primary.requests();
 const sdk=await import('../sdk/index.mjs?fresh-sequential-recovery='+Date.now());
 recovered=await sdk.recoverReserve({config:fixture.config,webAuthnClient:fixture.newRecoveryClient(),store:{get:locator=>fixture.store.get(locator)}});
 assert.equal(getAddress(recovered.owner),getAddress(owner));assert.equal(fixture.stats().originalRequests,before.originalRequests);assert.equal(primary.requests(),primaryRequests);
 assert.equal(fixture.stats().creates,preparedStats.creates);
 assert.deepEqual([...fixture.store.records()].map(([k,v])=>[k,Buffer.from(v).toString('hex')]),ciphertext);
 second=makeExecutor(recovered.account,2n);const before2=await clients[0].getBalance({address:owner});
 let result2=await second.claim();if(!result2.receipt){await harness.rpc('anvil_mine',['0x40']);result2=await second.check();}assert.equal(result2.receipt.status,'success');
 assert.equal(await clients[0].getBalance({address:owner}),before2+amount-result2.receipt.gasUsed*result2.receipt.effectiveGasPrice);
 assert.equal(broadcasts,2);assert.equal((await harness.readRight(1n)).claimed,true);assert.equal((await harness.readRight(2n)).claimed,true);
 third=makeExecutor(recovered.account,2n);await third.claim();assert.equal(broadcasts,2);
 assert.equal(await clients[0].getTransactionCount({address:owner}),2);assert.equal(await clients[0].getBalance({address:harness.contractAddress}),0n);
 assert.equal((await fetch(primary.url)).status,503);recovered.close();
 await assert.rejects(recovered.account.signMessage({message:'Recovery signer closed'}),e=>e.code==='SESSION_ENDED');
 console.log(JSON.stringify({sequentialPaymentContinuity:true,chainId:31337,publicBlockchain:false,physicalPasskey:false,externalAdoption:false,preparedReserves:1,beneficiaryClaims:2,distinctFundedObligations:2,sameBeneficiary:true,secondPaymentFundedAfterOutage:true,primaryHttpStatusDuringRecovery:503,primaryCredentialCallsDuringRecovery:0,primaryHttpRequestsDuringRecovery:0,recoveryStoreWrites:0,newRecoveryCredentials:0,exactBalancesAfterGas:true,duplicateBroadcasts:0,signersClosed:true,receiptHashes:[result1.hash,result2.hash],limits:['synthetic authenticator','local disposable EVM','same process SDK recovery','both local RPC clients point to one EVM; not provider independence','demonstration funding is not demand']}));
});
