import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeAbiParameters, encodeEventTopics, http, keccak256, parseAbi, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPaymentExecutor } from '../payments/executor.mjs';
import { createBrowserPaymentPendingStore } from '../payments/pending.mjs';
import { startSequentialPaymentChain } from '../payments/harness.mjs';
import { createPaymentGuard } from '../payments/guard.mjs';

const ABI=parseAbi(['function claim(uint256 id)','event RightClaimed(uint256 indexed id,address indexed beneficiary,uint256 amount)']);
const address='0x'+'22'.repeat(20),other='0x'+'33'.repeat(20);
const account=privateKeyToAccount('0x'+'01'.repeat(32)); // Isolated, unfunded offline test key only.
const code=expected=>error=>error.code===expected&&error.message===expected;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture() {
  const values=new Map(),queues=new Map(),receipts=new Map(),checked=[],writes=[],calls={prepare:0,sign:0,send:0,preflight:0,broadcastGuard:0,checkGuard:0};
  const hooks={};let automaticReceipt=true;
  const storage={getItem:key=>values.get(key)??null,setItem(key,value){hooks.write?.(JSON.parse(value));values.set(key,value);writes.push(JSON.parse(value));hooks.afterWrite?.(JSON.parse(value));}};
  const locks={request(name,options,callback){const next=(queues.get(name)??Promise.resolve()).then(()=>callback({name,mode:'exclusive'}));queues.set(name,next.catch(()=>{}));return next;}};
  const policies=new Map(),chain={id:31337};
  const policy=(rightId=1n,nonce=0,extra={})=>{const p={chainId:31337,address,owner:account.address,rightId,amount:rightId*100n,nonce,gas:100000n,maxFeePerGas:20n,maxPriorityFeePerGas:1n,...extra};policies.set(`${p.address.toLowerCase()}:${p.rightId}`,{...p});return p;};
  const wallet={account,chain,async prepareTransactionRequest(request){calls.prepare++;assert.equal(store().read().entries.at(-1).phase,'reserved');return hooks.prepare?hooks.prepare(request):request;},async signTransaction(request){calls.sign++;if(hooks.sign)return hooks.sign(request);return account.signTransaction(request);}};
  function receipt(hash,p,extra={}) {return{transactionHash:hash,to:p.address,from:p.owner,status:'success',logs:[{address:p.address,topics:encodeEventTopics({abi:ABI,eventName:'RightClaimed',args:{id:p.rightId,beneficiary:p.owner}}),data:encodeAbiParameters([{type:'uint256'}],[p.amount])}],...extra};}
  const client={async getChainId(){return hooks.chainId??31337;},async sendRawTransaction({serializedTransaction}){
    calls.send++;const hash=keccak256(serializedTransaction),tx=parseTransaction(serializedTransaction),id=decodeFunctionData({abi:ABI,data:tx.data}).args[0],p=policies.get(`${tx.to.toLowerCase()}:${id}`);
    assert.equal(store().read().entries.at(-1).hash,hash);assert.equal(store().read().entries.at(-1).phase,'signed');
    if(automaticReceipt)receipts.set(hash,receipt(hash,p));return hooks.send?hooks.send({hash,serializedTransaction,p}):hash;
  },async getTransactionReceipt(args){checked.push(args);if(hooks.receipt)return hooks.receipt(args);const r=receipts.get(args.hash);if(!r)throw Object.assign(new Error('pending'),{name:'TransactionReceiptNotFoundError'});return r;}};
  const guards={async beforePrepare(){calls.preflight++;return hooks.beforePrepare?hooks.beforePrepare():80000n;},async beforeBroadcast(args){calls.broadcastGuard++;await hooks.beforeBroadcast?.(args);},async beforeCheck(){calls.checkGuard++;await hooks.beforeCheck?.();}};
  const store=()=>createBrowserPaymentPendingStore({chainId:31337,owner:account.address,storage,locks});
  const executor=p=>createPaymentExecutor({wallet,publicClient:client,policy:p,pendingStore:store()},guards);
  return{hooks,calls,values,writes,receipts,checked,policy,wallet,client,guards,store,executor,receipt,set automaticReceipt(value){automaticReceipt=value;}};
}

test('two sequential rights use one account, distinct nonces, durable intent history and prior-policy receipt checks',async()=>{
  const f=fixture(),p1=f.policy(),p2=f.policy(2n,1),first=f.executor(p1);
  const one=await first.claim();assert.equal(first.deliveryStatus,'confirmed');assert(one.receipt);
  const second=f.executor(p2),two=await second.claim();assert(two.receipt);assert.notEqual(one.hash,two.hash);
  assert.deepEqual(f.calls,{prepare:2,sign:2,send:2,preflight:2,broadcastGuard:2,checkGuard:3});
  assert.deepEqual(f.checked.map(x=>x.policy.rightId),[1n,1n,2n]);
  const old=await f.executor(p1).claim();assert.equal(old.hash,one.hash);assert.equal(f.calls.send,2);
  assert.deepEqual(f.store().read().entries.map(e=>[e.rightId,e.nonce,e.phase]),[['1',0,'confirmed'],['2',1,'confirmed']]);
  assert.equal(f.writes.length,6);assert(f.writes.every(j=>!JSON.stringify(j).includes('serializedTransaction')));
});

test('concurrent repeated requests and separate executors send each fixed intent at most once',async()=>{
  const f=fixture(),p=f.policy(),a=f.executor(p),b=f.executor(p),gate=deferred();f.hooks.prepare=async r=>{await gate.promise;return r;};
  const one=a.claim(),same=a.claim(),two=b.claim();assert.equal(one,same);await tick();assert.equal(f.calls.prepare,1);gate.resolve();
  const results=await Promise.all([one,same,two]);assert.equal(new Set(results.map(r=>r.hash)).size,1);assert.equal(f.calls.sign,1);assert.equal(f.calls.send,1);
});

test('concurrent different rights advance only after successful prior receipt, with account-wide locking across contracts',async()=>{
  const f=fixture(),a=f.executor(f.policy()),b=f.executor(f.policy(1n,1,{address:other}));
  await Promise.all([a.claim(),b.claim()]);assert.equal(f.calls.send,2);assert.equal(f.store().read().entries[1].address,other);
  const broken=fixture();broken.automaticReceipt=false;
  await broken.executor(broken.policy()).claim();
  await assert.rejects(broken.executor(broken.policy(1n,1,{address:other})).claim(),code('PAYMENT_ACCOUNT_BLOCKED'));assert.equal(broken.calls.send,1);
});

test('unknown send response pins the hash and fresh instances only check, never sign or broadcast again',async()=>{
  const f=fixture(),p=f.policy();f.hooks.send=()=>{throw new Error('private RPC data');};
  const first=f.executor(p);await assert.rejects(first.claim(),code('PAYMENT_BROADCAST_UNKNOWN'));assert(first.hash);assert.equal(first.deliveryStatus,'attempted');
  const second=f.executor(p),result=await second.claim();assert.equal(result.hash,first.hash);assert.equal(second.deliveryStatus,'confirmed');assert.equal(f.calls.send,1);assert.equal(f.calls.sign,1);
});

test('pending receipt and returned hash disagreement never resend and block a later payment',async()=>{
  for(const mismatch of [false,true]) {
    const f=fixture(),p=f.policy();f.automaticReceipt=false;if(mismatch)f.hooks.send=()=> '0x'+'aa'.repeat(32);
    const first=f.executor(p);if(mismatch)await assert.rejects(first.claim(),code('PAYMENT_BROADCAST_HASH_MISMATCH'));else assert.deepEqual(await first.claim(),{hash:first.hash});
    const fresh=f.executor(p);assert.deepEqual(await fresh.check(),{hash:first.hash});await fresh.claim();
    await assert.rejects(f.executor(f.policy(2n,1)).claim(),code('PAYMENT_ACCOUNT_BLOCKED'));
    assert.equal(f.calls.sign,1);assert.equal(f.calls.send,1);assert.equal(f.store().read().active,0);
  }
});

test('failed prepare/sign permanently reserve the intent; unrelated and same-intent retries do not re-sign',async()=>{
  for(const name of ['prepare','sign']) {
    const f=fixture(),p=f.policy();f.hooks[name]=()=>{throw new Error('sensitive');};
    await assert.rejects(f.executor(p).claim(),code(name==='prepare'?'PAYMENT_PREPARATION_FAILED':'PAYMENT_SIGNING_FAILED'));
    await assert.rejects(f.executor(p).claim(),code('PAYMENT_RECONCILIATION_REQUIRED'));
    await assert.rejects(f.executor(f.policy(2n,1)).claim(),code('PAYMENT_ACCOUNT_BLOCKED'));assert.equal(f.calls.send,0);assert.equal(f.calls[name],1);
  }
});

test('storage failures at reserve, signed persistence and confirmation never allow an unsafe send or repeat',async()=>{
  for(const phase of ['reserved','signed','confirmed']) {
    const f=fixture(),p=f.policy();f.hooks.write=j=>{if(j.entries.at(-1).phase===phase)throw new Error('quota');};
    await assert.rejects(f.executor(p).claim(),code('PAYMENT_STORE_UNAVAILABLE'));
    assert.equal(f.calls.send,phase==='confirmed'?1:0);assert.equal(f.calls.sign,phase==='reserved'?0:1);
    if(phase==='signed') {delete f.hooks.write;await assert.rejects(f.executor(p).claim(),code('PAYMENT_RECONCILIATION_REQUIRED'));assert.equal(f.calls.sign,1);}
    if(phase==='confirmed') {delete f.hooks.write;await f.executor(p).check();assert.equal(f.calls.send,1);assert.equal(f.store().read().active,null);}
  }
  const f=fixture(),p=f.policy();f.hooks.afterWrite=j=>{if(j.entries.at(-1).phase==='signed')throw new Error('unknown persistence');};
  await assert.rejects(f.executor(p).claim(),code('PAYMENT_STORE_UNAVAILABLE'));assert.equal(f.calls.send,0);delete f.hooks.afterWrite;
  await f.executor(p).claim();assert.equal(f.calls.send,0);assert.equal(f.calls.sign,1);assert.equal(f.store().read().entries[0].phase,'signed');
});

test('unsigned transaction mutations are rejected before signing and leave a durable blocker',async()=>{
  for(const change of [{nonce:1},{chainId:10143},{type:'legacy'},{to:other},{data:'0x1234'},{value:1n},{gas:80001n},{maxFeePerGas:21n},{maxPriorityFeePerGas:2n},{gasPrice:1n},{accessList:[{address:other,storageKeys:[]}]},{authorizationList:[]},{from:other},{account:{address:account.address}},{chain:{id:31337}}]) {
    const f=fixture(),p=f.policy();f.hooks.prepare=r=>({...r,...change});await assert.rejects(f.executor(p).claim(),code('PAYMENT_TRANSACTION_MISMATCH'));assert.equal(f.calls.sign,0);assert.equal(f.calls.send,0);assert.equal(f.store().read().active,0);
  }
});

test('signed envelope, signer and access list are independently verified; zero fee fields are valid',async()=>{
  for(const change of [{nonce:1},{to:other},{data:'0x1234'},{value:1n},{gas:80001n},{maxFeePerGas:21n},{chainId:10143},{accessList:[{address:other,storageKeys:[]}]}]) {
    const f=fixture(),p=f.policy();f.hooks.sign=r=>account.signTransaction({...r,...change});await assert.rejects(f.executor(p).claim(),code('PAYMENT_TRANSACTION_MISMATCH'));assert.equal(f.calls.send,0);
  }
  const wrong=fixture();wrong.hooks.sign=r=>privateKeyToAccount('0x'+'02'.repeat(32)).signTransaction(r);await assert.rejects(wrong.executor(wrong.policy()).claim(),code('PAYMENT_SIGNED_OWNER_MISMATCH'));assert.equal(wrong.calls.send,0);
  const zero=fixture();await zero.executor(zero.policy(1n,0,{maxPriorityFeePerGas:0n})).claim();assert.equal(zero.calls.send,1);
});

test('nonce reuse and changed fixed intent are rejected without another signing request',async()=>{
  const f=fixture(),p=f.policy();await f.executor(p).claim();
  await assert.rejects(f.executor(f.policy(2n,0)).claim(),code('PAYMENT_NONCE_REUSED'));
  await assert.rejects(f.executor({...p,amount:p.amount+1n}).claim(),code('PAYMENT_INTENT_MISMATCH'));assert.equal(f.calls.sign,1);
});

test('a lost prior confirmation blocks a new intent even after the journal recorded success',async()=>{
  const f=fixture(),p=f.policy();await f.executor(p).claim();f.receipts.clear();
  await assert.rejects(f.executor(f.policy(2n,1)).claim(),code('PAYMENT_PRIOR_CONFIRMATION_REQUIRED'));assert.equal(f.calls.sign,1);assert.equal(f.store().read().entries.length,1);
});

test('receipt identity, exact event and successful status are all required to settle an intent',async()=>{
  const cases=[
    r=>({...r,status:'reverted'}),r=>({...r,transactionHash:'0x'+'aa'.repeat(32)}),r=>({...r,to:other}),r=>({...r,from:other}),
    r=>({...r,logs:[]}),r=>({...r,logs:[...r.logs,...r.logs]}),r=>({...r,logs:[{...r.logs[0],removed:true}]}),
    r=>({...r,logs:[{...r.logs[0],data:encodeAbiParameters([{type:'uint256'}],[999n])}]}),
    r=>({...r,logs:[{...r.logs[0],topics:encodeEventTopics({abi:ABI,eventName:'RightClaimed',args:{id:2n,beneficiary:account.address}})}]}),
    r=>({...r,logs:[{...r.logs[0],topics:encodeEventTopics({abi:ABI,eventName:'RightClaimed',args:{id:1n,beneficiary:other}})}]}),
    r=>({...r,logs:[...r.logs,{...r.logs[0],data:'0x'}]}),
  ];
  for(const [i,mutate] of cases.entries()) {
    const f=fixture(),p=f.policy();f.hooks.receipt=({hash})=>mutate(f.receipts.get(hash));
    await assert.rejects(f.executor(p).claim(),code(i===0?'PAYMENT_REVERTED':i<4?'PAYMENT_RECEIPT_MISMATCH':'PAYMENT_EVENT_MISMATCH'));
    await assert.rejects(f.executor(f.policy(2n,1)).claim(),code('PAYMENT_ACCOUNT_BLOCKED'));assert.equal(f.calls.send,1);assert.equal(f.store().read().entries[0].phase,'signed');
  }
});

test('signer/chain identity mutation after preparation, signing or guard is caught before broadcasting',async()=>{
  for(const phase of ['prepare','sign','beforeBroadcast']) {
    const f=fixture(),p=f.policy();
    f.hooks[phase]=async r=>{const result=phase==='sign'?await account.signTransaction(r):r;f.wallet.account={...account};return result;};
    await assert.rejects(f.executor(p).claim(),code('PAYMENT_SIGNER_CHANGED'));assert.equal(f.calls.send,0);
  }
  const f=fixture(),p=f.policy();f.hooks.prepare=r=>{f.wallet.chain.id=10143;return r;};await assert.rejects(f.executor(p).claim(),code('PAYMENT_SIGNER_CHANGED'));assert.equal(f.calls.sign,0);
});

test('closing at each awaited stage prevents later stages and leaves the durable phase conservative',async()=>{
  for(const phase of ['beforePrepare','prepare','sign','beforeBroadcast','send','receipt']) {
    const f=fixture(),p=f.policy(),gate=deferred(),entered=deferred();const executor=f.executor(p);
    f.hooks[phase]=async arg=>{entered.resolve();await gate.promise;if(phase==='beforePrepare')return 80000n;if(phase==='prepare')return arg;if(phase==='sign')return account.signTransaction(arg);if(phase==='send')return arg.hash;if(phase==='receipt')return f.receipts.get(arg.hash);};
    const attempt=executor.claim();await entered.promise;executor.close();gate.resolve();await assert.rejects(attempt,code('PAYMENT_SESSION_CLOSED'));
    assert.throws(()=>executor.claim(),code('PAYMENT_SESSION_CLOSED'));
    if(['beforePrepare','prepare','sign','beforeBroadcast'].includes(phase))assert.equal(f.calls.send,0);
    if(phase!=='beforePrepare')assert.notEqual(f.store().read().active,null);
  }
});

test('mutable caller policies and methods cannot redirect a captured intent, accessor input is never invoked',async()=>{
  const f=fixture(),p=f.policy(),e=f.executor(p);p.rightId=99n;p.address=other;f.wallet.signTransaction=()=>{throw new Error('replaced');};await e.claim();assert.equal(f.store().read().entries[0].rightId,'1');
  const g=fixture();let invoked=0;Object.defineProperty(g.wallet,'signTransaction',{get(){invoked++;return()=>{};}});
  assert.throws(()=>g.executor(g.policy()),code('PAYMENT_OPTIONS_INVALID'));assert.equal(invoked,0);
  const h=fixture();h.hooks.receipt=({hash})=>{const r=h.receipts.get(hash);Object.defineProperty(r,'status',{get(){invoked++;return'success';}});return r;};await assert.rejects(h.executor(h.policy()).claim(),code('PAYMENT_RECEIPT_MISMATCH'));assert.equal(invoked,0);
});

test('receipt and provider failures disclose fixed codes and never reset the active intent',async()=>{
  const f=fixture(),p=f.policy();f.hooks.receipt=()=>{const error=new Error('private server response');Object.defineProperty(error,'code',{get(){throw new Error('private');}});throw error;};
  await assert.rejects(f.executor(p).claim(),code('PAYMENT_RECEIPT_UNAVAILABLE'));assert.equal(f.store().read().active,0);
  const g=fixture();g.hooks.beforeBroadcast=()=>{throw Object.assign(new Error('private'),{code:'PAYMENT_NONCE_MISMATCH'});};await assert.rejects(g.executor(g.policy()).claim(),code('PAYMENT_NONCE_MISMATCH'));assert.equal(g.calls.send,0);assert.equal(g.store().read().entries[0].phase,'signed');
});

test('actual viem wallet executes two guarded sequential obligations on disposable loopback Anvil',async t=>{
  const harness=await startSequentialPaymentChain();t.after(()=>harness.close());
  const chain=defineChain({id:31337,name:'Isolated test',nativeCurrency:{name:'Test',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[harness.rpcUrl]}}});
  const owner=privateKeyToAccount(generatePrivateKey()),transport=()=>http(harness.rpcUrl,{retryCount:0,timeout:5000});
  const publicClient=createPublicClient({chain,transport:transport()}),secondReader=createPublicClient({chain,transport:transport()}),wallet=createWalletClient({account:owner,chain,transport:transport()});
  const first=await harness.preparePayment(owner.address),amount=first.amount;
  await harness.rpc('anvil_mine',['0x40']);
  const profile={chainId:31337,address:harness.contractAddress,owner:owner.address,issuer:harness.issuer,expectedRuntimeCodeHash:harness.runtimeCodeHash,expiresAt:new Date(Date.now()+60000).toISOString(),claims:[{rightId:first.id,amount,nonce:0},{rightId:first.id+1n,amount,nonce:1}]};
  const guard=createPaymentGuard({profile,clients:[publicClient,secondReader]});
  // Both readers use one isolated node: this verifies integration, not provider independence.
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},locks={request:async(name,options,callback)=>callback({name,mode:'exclusive'})};
  const store=()=>createBrowserPaymentPendingStore({chainId:31337,owner:owner.address,storage,locks});
  const make=id=>{const approved=guard.forRight(id);return createPaymentExecutor({wallet,publicClient:{...publicClient,getTransactionReceipt:({hash,policy})=>guard.forRight(policy.rightId).getTransactionReceipt({hash}),async sendRawTransaction(args){const hash=await publicClient.sendRawTransaction(args);await harness.rpc('anvil_mine',['0x40']);return hash;}},policy:approved.policy,pendingStore:store()},approved.guards);};
  const complete=async executor=>{let result=await executor.claim();if(!result.receipt){await publicClient.waitForTransactionReceipt({hash:result.hash,timeout:5000});result=await executor.check();}assert.equal(result.receipt.status,'success');return result;};
  const one=await complete(make(first.id));assert.equal((await harness.readRight(first.id)).claimed,true);
  const next=await harness.preparePayment(owner.address,{amount});assert.equal(next.id,first.id+1n);
  await harness.rpc('anvil_mine',['0x40']);
  const two=await complete(make(next.id));assert.equal((await harness.readRight(next.id)).claimed,true);assert.notEqual(one.hash,two.hash);
  assert.equal(await publicClient.getTransactionCount({address:owner.address}),2);
  assert.equal((await make(first.id).claim()).hash,one.hash);assert.equal(await publicClient.getTransactionCount({address:owner.address}),2);
  assert.deepEqual(store().read().entries.map(e=>[e.nonce,e.phase]),[[0,'confirmed'],[1,'confirmed']]);
});
