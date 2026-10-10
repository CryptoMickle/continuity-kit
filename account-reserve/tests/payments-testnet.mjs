import assert from 'node:assert/strict';
import test from 'node:test';
import {custom,encodeAbiParameters,encodeEventTopics,encodeFunctionData,encodeFunctionResult,getAddress,keccak256,parseTransaction,toHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createTestnetPaymentClient,createTestnetPaymentReader} from '../payments/testnet.mjs';
import {PAYMENT_ABI,PAYMENT_LIMITS} from '../payments/guard.mjs';
import {createBrowserPaymentPendingStore,paymentEntry} from '../payments/pending.mjs';
import {APPROVED_TESTNET_RPCS} from '../release/client-profile.mjs';

const code=expected=>e=>e.code===expected;
const h=n=>'0x'+n.toString(16).padStart(64,'0');
async function fixture(){
  const account=privateKeyToAccount(generatePrivateKey());
  const address=getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'),issuer=getAddress('0xbcdefabcdefabcdefabcdefabcdefabcdefabcde');
  const profile={chainId:10143,address,owner:account.address,issuer,expectedRuntimeCodeHash:keccak256('0x6000'),expiresAt:new Date(Date.now()+3600000).toISOString(),claims:[{rightId:1n,amount:10n**16n,nonce:0},{rightId:2n,amount:10n**16n,nonce:1}]};
  const policies=profile.claims.map(c=>({chainId:10143,address,owner:profile.owner,...c,...PAYMENT_LIMITS}));
  const data=encodeFunctionData({abi:PAYMENT_ABI,functionName:'claim',args:[1n]});
  const raw=await account.signTransaction({type:'eip1559',chainId:10143,to:address,nonce:0,data,value:0n,gas:60000n,maxFeePerGas:PAYMENT_LIMITS.maxFeePerGas,maxPriorityFeePerGas:PAYMENT_LIMITS.maxPriorityFeePerGas,accessList:[]});
  const parsed=parseTransaction(raw),hash=keccak256(raw),blockHash=h(100),values=new Map(),calls=[];
  let queue=Promise.resolve(),writes=0,signatures=0,closed=0,pending=false,reverted=false,alterEvent=false;
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{writes++;values.set(key,value);}};
  const locks={request(name,options,callback){assert.deepEqual(options,{mode:'exclusive'});const p=queue.then(()=>callback({name,mode:'exclusive'}));queue=p.catch(()=>{});return p;}};
  const store=createBrowserPaymentPendingStore({chainId:10143,owner:profile.owner,storage,locks});
  const block={number:'0x64',hash:blockHash,timestamp:toHex(BigInt(Math.floor(Date.now()/1000))),baseFeePerGas:'0x1',transactions:[]};
  const transaction={hash,from:profile.owner,to:address,input:data,value:'0x0',nonce:'0x0',chainId:'0x279f',type:'0x2',gas:toHex(parsed.gas),maxFeePerGas:toHex(parsed.maxFeePerGas),maxPriorityFeePerGas:toHex(parsed.maxPriorityFeePerGas),accessList:[],r:parsed.r,s:parsed.s,yParity:toHex(parsed.yParity),v:toHex(BigInt(parsed.yParity)),blockHash,blockNumber:'0x64',transactionIndex:'0x0'};
  const receipt=()=>({transactionHash:hash,from:profile.owner,to:address,contractAddress:null,blockHash,blockNumber:'0x64',transactionIndex:'0x0',type:'0x2',status:reverted?'0x0':'0x1',gasUsed:'0x7530',cumulativeGasUsed:'0x7530',effectiveGasPrice:'0x1',logsBloom:'0x'+'0'.repeat(512),logs:reverted?[]:[{address,data:encodeAbiParameters([{type:'uint256'}],[alterEvent?1n:profile.claims[0].amount]),topics:encodeEventTopics({abi:PAYMENT_ABI,eventName:'RightClaimed',args:{id:1n,beneficiary:profile.owner}}),blockHash,blockNumber:'0x64',transactionHash:hash,transactionIndex:'0x0',logIndex:'0x0',removed:false}]});
  const rpcTransport=url=>{assert.ok(APPROVED_TESTNET_RPCS.includes(url));return custom({async request({method,params}){
    calls.push({url,method,params});
    switch(method){
      case 'eth_chainId':return '0x279f';
      case 'eth_getTransactionReceipt':assert.equal(params[0],hash);return pending?null:receipt();
      case 'eth_getTransactionByHash':assert.equal(params[0],hash);return transaction;
      case 'eth_getBlockByNumber':return block;
      case 'eth_getCode':return params[0].toLowerCase()===address.toLowerCase()?'0x6000':'0x';
      case 'eth_getTransactionCount':return '0x0';
      case 'eth_estimateGas':return '0xc350';
      case 'eth_getBalance':return toHex(10n**18n);
      case 'eth_call':{
        const d=params[0].data;
        if(d===encodeFunctionData({abi:PAYMENT_ABI,functionName:'issuer'}))return encodeFunctionResult({abi:PAYMENT_ABI,functionName:'issuer',result:issuer});
        if(d===encodeFunctionData({abi:PAYMENT_ABI,functionName:'rightForOwner',args:[profile.owner]}))return encodeFunctionResult({abi:PAYMENT_ABI,functionName:'rightForOwner',result:2n});
        for(const id of [1n,2n])if(d===encodeFunctionData({abi:PAYMENT_ABI,functionName:'getRight',args:[id]}))return encodeFunctionResult({abi:PAYMENT_ABI,functionName:'getRight',result:{beneficiary:profile.owner,amount:profile.claims[Number(id)-1].amount,claimed:id===1n}});
        throw new Error('UNEXPECTED_READ');
      }
      default:throw new Error('UNEXPECTED_RPC_'+method);
    }
  }},{retryCount:0});};
  const recovered={owner:account.address,account:{...account,async signTransaction(){signatures++;throw new Error('SIGNING_FORBIDDEN_IN_READER_TEST');}},close(){closed++;}};
  const options={profile,storage,locks};
  const reader=()=>createTestnetPaymentReader(options,{rpcTransport});
  const client=()=>createTestnetPaymentClient({...options,recovered},{rpcTransport});
  async function seed(phase='signed'){
    await store.withLock(()=>{const e=paymentEntry(policies[0],60000n),j={version:1,chainId:10143,owner:profile.owner.toLowerCase(),active:0,entries:[e]};store.put(j);if(phase==='reserved')return;const signed={...e,phase:'signed',hash};store.put({...j,entries:[signed]});if(phase==='confirmed')store.put({...j,active:null,entries:[{...signed,phase:'confirmed'}]});});
  }
  return {profile,policies,hash,store,calls,storage,locks,values,reader,client,seed,options,rpcTransport,counts:()=>({writes,signatures,closed}),pending(value=true){pending=value;},reverted(){reverted=true;},alterEvent(){alterEvent=true;}};
}

test('factories and missing/reserved reconciliation never request credentials, sign, send or read RPC',async()=>{
  const f=await fixture(),reader=f.reader(),client=f.client();assert.equal(f.calls.length,0);assert.equal(f.counts().signatures,0);
  await assert.rejects(reader.check(1n),code('PAYMENT_TRANSACTION_MISSING'));await f.seed('reserved');
  await assert.rejects(reader.check(1n),code('PAYMENT_RECONCILIATION_REQUIRED'));assert.equal(f.calls.length,0);assert.equal(f.counts().signatures,0);client.close();assert.equal(f.counts().closed,1);
});

test('credential-free reader retains pending hash, then confirms exact signed receipt without a second write',async()=>{
  const f=await fixture();await f.seed();const before=f.counts().writes,reader=f.reader();f.pending();
  assert.deepEqual(await reader.check(1n),{hash:f.hash});assert.equal(f.store.read().entries[0].phase,'signed');assert.equal(f.counts().writes,before);
  f.pending(false);const result=await reader.check(1n);assert.equal(result.hash,f.hash);assert.equal(result.receipt.status,'success');assert.equal(f.store.read().active,null);assert.equal(f.store.read().entries[0].phase,'confirmed');assert.equal(f.counts().writes,before+1);
  await reader.check(1n);assert.equal(f.counts().writes,before+1);assert.equal(f.counts().signatures,0);assert.ok(f.calls.every(c=>!c.method.startsWith('eth_send')&&!c.method.includes('sign')));
});

test('checksum-address client rechecks the prior policy before a new intent preflight, without re-signing it',async()=>{
  const f=await fixture();assert.notEqual(f.profile.address,f.profile.address.toLowerCase());await f.seed('confirmed');const before=f.counts().writes,client=f.client();
  const old=await client.forRight(1n).check();assert.equal(old.receipt.status,'success');
  // The next approved nonce is deliberately absent from our read-only fixture.
  // Reaching this failure proves the preceding confirmed right was checked
  // using its own policy rather than the new right's ID/nonce or checksum case.
  await assert.rejects(client.forRight(2n).claim(),code('PAYMENT_NONCE_MISMATCH'));
  assert.ok(f.calls.filter(c=>c.method==='eth_getTransactionReceipt').length>=4);assert.equal(f.counts().writes,before);assert.equal(f.counts().signatures,0);assert.ok(f.calls.every(c=>!c.method.startsWith('eth_send')));client.close();
});

test('rechecking an older confirmed payment preserves a newer account-wide unfinished attempt',async()=>{
  const f=await fixture();await f.seed('confirmed');await f.store.withLock(()=>{const j=f.store.read();f.store.put({...j,active:1,entries:[...j.entries,paymentEntry(f.policies[1],60000n)]});});const before=f.counts().writes;
  assert.equal((await f.reader().check(1n)).receipt.status,'success');assert.equal(f.store.read().active,1);assert.equal(f.store.read().entries[1].phase,'reserved');assert.equal(f.counts().writes,before);
});

test('unapproved journal policy and unknown right stop before RPC or any confirmation write',async()=>{
  const f=await fixture();await f.seed();const before=f.counts().writes,[key,raw]=[...f.values][0],j=JSON.parse(raw);j.entries[0].amount='1';f.values.set(key,JSON.stringify(j));
  await assert.rejects(f.reader().check(1n),code('PAYMENT_NOT_APPROVED'));await assert.rejects(f.reader().check(3n),code('PAYMENT_NOT_APPROVED'));assert.equal(f.calls.length,0);assert.equal(f.counts().writes,before);
});

test('reverted or mismatched-event receipts never confirm a signed payment',async()=>{
  for(const [mutate,expected]of [['reverted','PAYMENT_REVERTED'],['alterEvent','PAYMENT_EVENT_MISMATCH']]){const f=await fixture();await f.seed();const before=f.counts().writes;f[mutate]();await assert.rejects(f.reader().check(1n),code(expected));assert.equal(f.store.read().entries[0].phase,'signed');assert.equal(f.counts().writes,before);assert.equal(f.counts().signatures,0);}
});
