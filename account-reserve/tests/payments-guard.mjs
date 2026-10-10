import assert from 'node:assert/strict';
import test from 'node:test';
import {encodeFunctionData,encodeEventTopics,encodeAbiParameters,keccak256,parseTransaction} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {createPaymentGuard,validatePaymentProfile,PAYMENT_ABI,PAYMENT_LIMITS} from '../payments/guard.mjs';
const a=n=>'0x'+n.toString(16).padStart(40,'0'),h=n=>'0x'+n.toString(16).padStart(64,'0');
const ownerAccount=privateKeyToAccount('0x'+'03'.repeat(32)); // Unfunded offline test fixture.
const signedRequest={chainId:10143,type:'eip1559',to:a(1),data:encodeFunctionData({abi:PAYMENT_ABI,functionName:'claim',args:[1n]}),value:0n,nonce:1,...PAYMENT_LIMITS};
const serialized=await ownerAccount.signTransaction(signedRequest),transactionHash=keccak256(serialized),signature=parseTransaction(serialized);
function setup(change={}){
 const profile={chainId:10143,address:a(1),owner:ownerAccount.address,issuer:a(3),expectedRuntimeCodeHash:keccak256('0x6000'),expiresAt:'2026-11-10T00:00:00.000Z',claims:[{rightId:1n,amount:10n**17n,nonce:1},{rightId:2n,amount:2n*10n**17n,nonce:2}]};
 const right={beneficiary:profile.owner,amount:profile.claims[0].amount,claimed:false};
 const block={number:100n,hash:h(10),baseFeePerGas:1n};
 const receipt={transactionHash,blockHash:h(10),blockNumber:100n,transactionIndex:0,from:profile.owner,to:profile.address,type:'eip1559',contractAddress:null,status:'success',gasUsed:30000n,effectiveGasPrice:1n,logs:[{address:profile.address,data:encodeAbiParameters([{type:'uint256'}],[right.amount]),topics:encodeEventTopics({abi:PAYMENT_ABI,eventName:'RightClaimed',args:{id:1n,beneficiary:profile.owner}}),blockHash:h(10),blockNumber:100n,transactionHash,transactionIndex:0,logIndex:0,removed:false}]};
 const tx={hash:transactionHash,r:signature.r,s:signature.s,v:signature.v,yParity:signature.yParity,from:profile.owner,to:profile.address,input:encodeFunctionData({abi:PAYMENT_ABI,functionName:'claim',args:[1n]}),value:0n,nonce:1,chainId:10143,type:'eip1559',...PAYMENT_LIMITS,blockHash:h(10),blockNumber:100n,transactionIndex:0};
 const base={getChainId:async()=>10143,getCode:async({address})=>address===profile.address?'0x6000':'0x',readContract:async q=>q.functionName==='issuer'?profile.issuer:q.functionName==='rightForOwner'?1n:{...right,claimed:q.blockNumber===100n},getTransactionCount:async()=>1,getBlock:async()=>block,estimateGas:async()=>50000n,getBalance:async()=>10n**18n,getTransactionReceipt:async()=>receipt,getTransaction:async()=>tx};
 const clients=[base,{...base,...change}];const guard=createPaymentGuard({profile,clients,now:()=>Date.parse('2026-10-10T00:00:00.000Z')});
 return {profile,guard,base,clients,right,block,receipt,tx};
}
const code=c=>e=>e.code===c;
test('payment guard captures fixed immutable policy without a network read and selects bounded gas',async()=>{
 const f=setup();const p=validatePaymentProfile(f.profile);f.profile.claims[0].nonce=99;assert.equal(p.claims[0].nonce,1);assert.ok(Object.isFrozen(p.claims[0]));
 const c=f.guard.forRight(1n);assert.equal(await c.guards.beforePrepare(),60000n);await c.guards.beforeBroadcast({gas:60000n});assert.throws(()=>f.guard.forRight(9n),code('PAYMENT_NOT_APPROVED'));
 assert.equal((await c.getTransactionReceipt({hash:transactionHash})).status,'success');
});
test('wrong chains, contract code and issuer are rejected before preparation',async()=>{
 for(const [change,expected] of [[{getChainId:async()=>1},'PAYMENT_CHAIN_MISMATCH'],[{getCode:async()=> '0x6001'},'PAYMENT_RUNTIME_MISMATCH'],[{readContract:async()=>a(9)},'PAYMENT_ISSUER_MISMATCH']])await assert.rejects(setup(change).guard.forRight(1n).guards.beforePrepare(),code(expected));
});
test('pending nonce, beneficiary, amount, consumed payment and current-right drift cannot sign',async()=>{
 const f=setup();
 for(const [change,expected] of [[{getTransactionCount:async q=>q.blockTag==='pending'?2:1},'PAYMENT_NONCE_MISMATCH'],[{getCode:async q=>q.address===f.profile.owner?'0x6000':'0x6000'},'PAYMENT_OWNER_CODE_UNEXPECTED'],...[{beneficiary:a(4)},{amount:3n},{claimed:true}].map(v=>[{readContract:async q=>q.functionName==='getRight'?{...f.right,...v}:f.base.readContract(q)},'PAYMENT_RIGHT_MISMATCH']),[{readContract:async q=>q.functionName==='rightForOwner'?2n:f.base.readContract(q)},'PAYMENT_CURRENT_RIGHT_MISMATCH']])await assert.rejects(setup(change).guard.forRight(1n).guards.beforePrepare(),code(expected));
});
test('both fee and balance caps plus post-estimate gas changes fail closed',async()=>{
 await assert.rejects(setup({getBlock:async()=>({baseFeePerGas:PAYMENT_LIMITS.maxFeePerGas})}).guard.forRight(1n).guards.beforePrepare(),code('PAYMENT_FEE_CAP_EXCEEDED'));
 await assert.rejects(setup({getBalance:async()=>0n}).guard.forRight(1n).guards.beforePrepare(),code('PAYMENT_GAS_BALANCE_INSUFFICIENT'));
 await assert.rejects(setup({estimateGas:async()=>300000n}).guard.forRight(1n).guards.beforePrepare(),code('PAYMENT_GAS_INVALID'));
 await assert.rejects(setup().guard.forRight(1n).guards.beforeBroadcast({gas:59999n}),code('PAYMENT_GAS_CHANGED'));
});
test('expiry is rechecked after asynchronous preflight reads',async()=>{
 const f=setup();let now=Date.parse('2026-10-10T00:00:00.000Z');const clients=f.clients.map(c=>({...c,getBalance:async()=>{now=Date.parse(f.profile.expiresAt);return 10n**18n;}}));
 await assert.rejects(createPaymentGuard({profile:f.profile,clients,now:()=>now}).forRight(1n).guards.beforePrepare(),code('PAYMENT_PROFILE_EXPIRED'));
});
test('receipt disagreement, canonical block disagreement and unfinished finality cannot settle',async()=>{
 const f=setup();
 for(const [change,expected] of [[{getTransactionReceipt:async()=>({...f.receipt,gasUsed:1n})},'PAYMENT_RECEIPT_DISAGREEMENT'],[{getBlock:async()=>({...f.block,hash:h(9)})},'PAYMENT_CANONICAL_BLOCK_MISMATCH'],[{getBlock:async q=>q.blockTag?{...f.block,number:99n}:f.block},'PAYMENT_CONFIRMATION_PENDING']])await assert.rejects(setup(change).guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code(expected));
});
test('receipt transaction envelope is bound to the approved intent',async()=>{
 const f=setup();for(const v of [{nonce:2},{value:1n},{input:'0x'},{to:a(4)},{from:a(4)},{chainId:1},{maxFeePerGas:1n},{gas:300001n},{authorizationList:[]},{accessList:[{}]}])await assert.rejects(setup({getTransaction:async()=>({...f.tx,...v})}).guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code('PAYMENT_TRANSACTION_MISMATCH'));
});
test('pending and unavailable receipt reads are distinguished without retrying',async()=>{
 await assert.rejects(setup({getTransactionReceipt:async()=>{throw Object.assign(new Error(),{name:'TransactionReceiptNotFoundError'});}}).guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code('PAYMENT_CONFIRMATION_PENDING'));
 await assert.rejects(setup({getTransactionReceipt:async()=>{throw new Error('private transport message');}}).guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),e=>e.code==='PAYMENT_RECEIPT_UNAVAILABLE'&&!e.message.includes('private'));
});
test('invalid profile fields, malicious accessors and coercions cannot enter the policy',()=>{
 const {profile}=setup();let invoked=0;
 for(const p of [{...profile,chainId:1},{...profile,extra:true},{...profile,claims:[...profile.claims,profile.claims[0]]},{...profile,claims:[profile.claims[0],{...profile.claims[1],nonce:3}]},{...profile,owner:profile.address},{...profile,expectedRuntimeCodeHash:{toString(){invoked++;return h(1);}}},Object.defineProperty({...profile},'owner',{get(){invoked++;return a(2);},enumerable:true})])assert.throws(()=>validatePaymentProfile(p),code('PAYMENT_PROFILE_INVALID'));
 assert.equal(invoked,0);
});
test('RPC hash and sender labels cannot substitute for a reconstructable signed envelope',async()=>{
 for(const change of [{r:undefined},{s:'0x'},{r:'0x0'},{s:'0x'+'f'.repeat(65)},{yParity:2},{v:99n},{v:signature.yParity===0?28n:27n}]){
  const f=setup();Object.assign(f.tx,change);await assert.rejects(f.guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code('PAYMENT_TRANSACTION_SIGNATURE_INVALID'));
 }
 const renamed=setup(),fakeHash=h(99);renamed.tx.hash=fakeHash;renamed.receipt.transactionHash=fakeHash;renamed.receipt.logs[0].transactionHash=fakeHash;
 await assert.rejects(renamed.guard.forRight(1n).getTransactionReceipt({hash:fakeHash}),code('PAYMENT_TRANSACTION_HASH_MISMATCH'));
 const changed=setup();changed.tx.gas=PAYMENT_LIMITS.gas-1n;
 await assert.rejects(changed.guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code('PAYMENT_TRANSACTION_HASH_MISMATCH'));
});
test('a valid signature from another key is rejected even when both providers label it as the approved owner',async()=>{
 const foreign=privateKeyToAccount('0x'+'04'.repeat(32)),raw=await foreign.signTransaction(signedRequest),hash=keccak256(raw),sig=parseTransaction(raw),f=setup();
 Object.assign(f.tx,{hash,r:sig.r,s:sig.s,v:sig.v,yParity:sig.yParity});f.receipt.transactionHash=hash;f.receipt.logs[0].transactionHash=hash;
 await assert.rejects(f.guard.forRight(1n).getTransactionReceipt({hash}),code('PAYMENT_SIGNED_OWNER_MISMATCH'));
});
test('both providers must supply the same authentic signed transaction',async()=>{
 const f=setup(),guard=createPaymentGuard({profile:f.profile,clients:[f.base,{...f.base,getTransaction:async()=>({...f.tx,s:'0x'+'01'.repeat(32)})}],now:()=>Date.parse('2026-10-10T00:00:00.000Z')});
 await assert.rejects(guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code('PAYMENT_TRANSACTION_HASH_MISMATCH'));
});
test('transaction and receipt block number/index must match, even with agreeing receipt providers',async()=>{
 for(const change of [{blockNumber:99n},{blockNumber:undefined},{transactionIndex:1},{transactionIndex:undefined}]){
  const f=setup();Object.assign(f.tx,change);await assert.rejects(f.guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code('PAYMENT_TRANSACTION_MISMATCH'));
 }
 for(const change of [{type:'legacy'},{transactionIndex:-1},{transactionIndex:1.5},{blockNumber:-1n},{contractAddress:a(4)},{status:'pending'}]){
  const f=setup();Object.assign(f.receipt,change);await assert.rejects(f.guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code('PAYMENT_RECEIPT_MISMATCH'));
 }
});
test('receipt gas consumption and effective price are bounded by the actual signed transaction and approval',async()=>{
 for(const change of [{gasUsed:0n},{gasUsed:-1n},{gasUsed:300001n},{gasUsed:30000},{effectiveGasPrice:-1n},{effectiveGasPrice:PAYMENT_LIMITS.maxFeePerGas+1n},{effectiveGasPrice:1}]){
  const f=setup();Object.assign(f.receipt,change);await assert.rejects(f.guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code('PAYMENT_RECEIPT_MISMATCH'));
 }
 const f=setup(),raw=await ownerAccount.signTransaction({...signedRequest,gas:80000n}),hash=keccak256(raw),sig=parseTransaction(raw);
 Object.assign(f.tx,{gas:80000n,hash,r:sig.r,s:sig.s,v:sig.v,yParity:sig.yParity});Object.assign(f.receipt,{gasUsed:80001n,transactionHash:hash});f.receipt.logs[0].transactionHash=hash;
 await assert.rejects(f.guard.forRight(1n).getTransactionReceipt({hash}),code('PAYMENT_RECEIPT_MISMATCH'));
});
test('event metadata must identify the exact receipt position with an explicit nonremoved log',async()=>{
 for(const change of [{removed:undefined},{removed:true},{transactionIndex:1},{transactionIndex:undefined},{logIndex:-1},{logIndex:undefined},{blockNumber:99n},{blockHash:h(9)},{transactionHash:h(9)}]){
  const f=setup();Object.assign(f.receipt.logs[0],change);await assert.rejects(f.guard.forRight(1n).getTransactionReceipt({hash:transactionHash}),code('PAYMENT_RECEIPT_MISMATCH'));
 }
});
test('valid leading-zero signature scalars accept padded data and minimal RPC quantities without changing hash',async()=>{
 const found=new Map();
 for(let offset=0;offset<256&&found.size<2;offset++){
  const gas=PAYMENT_LIMITS.gas-BigInt(offset),raw=await ownerAccount.signTransaction({...signedRequest,gas}),sig=parseTransaction(raw);
  for(const field of ['r','s'])if(sig[field].startsWith('0x0')&&!found.has(field))found.set(field,{gas,raw,sig});
 }
 assert.equal(found.size,2,'deterministically exercise a leading zero in both scalar positions');
 for(const {gas,raw,sig}of found.values())for(const compact of [false,true]){
  const f=setup(),hash=keccak256(raw),scalar=value=>compact?'0x'+BigInt(value).toString(16):value;
  Object.assign(f.tx,{hash,gas,r:scalar(sig.r),s:scalar(sig.s),v:sig.v,yParity:sig.yParity});f.receipt.transactionHash=hash;f.receipt.logs[0].transactionHash=hash;
  assert.equal((await f.guard.forRight(1n).getTransactionReceipt({hash})).transactionHash,hash);
 }
});
