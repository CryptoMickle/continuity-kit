import assert from 'node:assert/strict';
import test from 'node:test';
import {custom,encodeAbiParameters,encodeEventTopics,encodeFunctionData,encodeFunctionResult,getAddress,keccak256,parseTransaction,toHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createTestnetPaymentVerifier} from '../payments/testnet.mjs';
import {PAYMENT_ABI,PAYMENT_LIMITS} from '../payments/guard.mjs';
import {APPROVED_TESTNET_RPCS} from '../release/client-profile.mjs';
const code=expected=>e=>e.code===expected&&e.message===expected;
const h=n=>'0x'+n.toString(16).padStart(64,'0');

async function fixture(){
  const account=privateKeyToAccount(generatePrivateKey()),address=getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'),issuer=getAddress('0xbcdefabcdefabcdefabcdefabcdefabcdefabcde');
  const amount=10n**16n,profile={chainId:10143,address,owner:account.address,issuer,expectedRuntimeCodeHash:keccak256('0x6000'),expiresAt:'2025-01-01T00:00:00.000Z',claims:[{rightId:1n,amount,nonce:0}]};
  const data=encodeFunctionData({abi:PAYMENT_ABI,functionName:'claim',args:[1n]}),raw=await account.signTransaction({type:'eip1559',chainId:10143,to:address,nonce:0,data,value:0n,gas:60000n,maxFeePerGas:PAYMENT_LIMITS.maxFeePerGas,maxPriorityFeePerGas:PAYMENT_LIMITS.maxPriorityFeePerGas,accessList:[]});
  const parsed=parseTransaction(raw),hash=keccak256(raw),blockHash=h(100),calls=[];
  let mode='success',gate;
  const tx={hash,from:account.address,to:address,input:data,value:'0x0',nonce:'0x0',chainId:'0x279f',type:'0x2',gas:'0xea60',maxFeePerGas:toHex(parsed.maxFeePerGas),maxPriorityFeePerGas:toHex(parsed.maxPriorityFeePerGas),accessList:[],r:parsed.r,s:parsed.s,yParity:toHex(parsed.yParity),v:toHex(BigInt(parsed.yParity)),blockHash,blockNumber:'0x64',transactionIndex:'0x0'};
  const receipt=()=>({transactionHash:hash,from:account.address,to:address,contractAddress:null,blockHash,blockNumber:'0x64',transactionIndex:'0x0',type:'0x2',status:mode==='reverted'?'0x0':'0x1',gasUsed:'0x7530',cumulativeGasUsed:'0x7530',effectiveGasPrice:'0x1',logsBloom:'0x'+'0'.repeat(512),logs:mode==='reverted'?[]:[{address,data:encodeAbiParameters([{type:'uint256'}],[mode==='wrong-event'?1n:amount]),topics:encodeEventTopics({abi:PAYMENT_ABI,eventName:'RightClaimed',args:{id:1n,beneficiary:account.address}}),blockHash,blockNumber:'0x64',transactionHash:hash,transactionIndex:'0x0',logIndex:'0x0',removed:false}]});
  const rpcTransport=url=>{assert.ok(APPROVED_TESTNET_RPCS.includes(url));return custom({async request({method,params}){
    calls.push({url,method,params});
    if(gate)await gate;
    switch(method){
      case 'eth_chainId':return '0x279f';
      case 'eth_getTransactionReceipt':assert.equal(params[0],hash);if(mode==='unavailable')throw new Error('PRIVATE_RPC_TEXT');return mode==='missing'?null:receipt();
      case 'eth_getTransactionByHash':assert.equal(params[0],hash);return tx;
      case 'eth_getBlockByNumber':return {number:mode==='unfinalized'&&params[0]==='finalized'?'0x63':'0x64',hash:blockHash,timestamp:'0x1',baseFeePerGas:'0x1',transactions:[]};
      case 'eth_getCode':return '0x6000';
      case 'eth_call':if(params[0].data===encodeFunctionData({abi:PAYMENT_ABI,functionName:'issuer'}))return encodeFunctionResult({abi:PAYMENT_ABI,functionName:'issuer',result:issuer});return encodeFunctionResult({abi:PAYMENT_ABI,functionName:'getRight',result:{beneficiary:account.address,amount,claimed:true}});
      default:throw new Error('UNEXPECTED_RPC_'+method);
    }
  }},{retryCount:0});};
  const verifier=createTestnetPaymentVerifier({profile},{rpcTransport});
  return {profile,verifier,hash,calls,amount,setMode:value=>{mode=value;},hold(){let release;gate=new Promise(r=>release=r);return ()=>{gate=undefined;release();};}};
}

test('stateless verifier confirms an expired-profile payment as a frozen scalar summary without an account or journal',async()=>{
  const f=await fixture();assert.equal(f.calls.length,0);
  const result=await f.verifier.check({rightId:1n,hash:f.hash.toUpperCase()});
  assert.deepEqual(result,{chainId:10143,contract:f.profile.address,beneficiary:f.profile.owner,rightId:1n,amount:f.amount,hash:f.hash,readOnly:true,status:'finalized',finalized:true,paymentVerified:true,blockNumber:100n,blockHash:h(100)});
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(f.verifier));assert.ok(f.calls.length>0);assert.ok(f.calls.every(c=>!c.method.startsWith('eth_send')&&!c.method.includes('sign')));
  assert.ok(Object.values(result).every(v=>typeof v!=='object'));
});

test('missing or unfinalized exact receipts are pending; reverted receipts never establish delivery',async()=>{
  for(const mode of ['missing','unfinalized','reverted']){
    const f=await fixture();f.setMode(mode);const result=await f.verifier.check({rightId:1n,hash:f.hash});
    assert.equal(result.paymentVerified,false);assert.equal(result.readOnly,true);assert.ok(Object.isFrozen(result));
    if(mode==='reverted'){assert.equal(result.status,'reverted');assert.equal(result.finalized,true);assert.equal(result.blockNumber,100n);}
    else{assert.equal(result.status,'pending-or-unknown');assert.equal(result.finalized,false);assert.equal(Object.hasOwn(result,'blockNumber'),false);}
  }
});

test('RPC failure and wrong payment event reject instead of degrading to a pending or successful result',async()=>{
  for(const [mode,expected]of [['unavailable','PAYMENT_RECEIPT_UNAVAILABLE'],['wrong-event','PAYMENT_EVENT_MISMATCH']]){const f=await fixture();f.setMode(mode);await assert.rejects(f.verifier.check({rightId:1n,hash:f.hash}),code(expected));}
});

test('exact check inputs reject coercions, trailing data, getters and overrides before any RPC',async()=>{
  const f=await fixture(),valid={rightId:1n,hash:f.hash};let invoked=0;
  const invalid=[undefined,null,{},Object.create(valid),{...valid,extra:true},{...valid,[Symbol('override')]:true},{...valid,rightId:'1'},{...valid,rightId:0n},{...valid,rightId:2n**256n},{...valid,hash:f.hash+'\n'},{...valid,hash:f.hash+'00'},{...valid,hash:{toString(){invoked++;return f.hash;}}},Object.defineProperty({...valid},'hash',{enumerable:true,get(){invoked++;return f.hash;}})];
  for(const input of invalid)await assert.rejects(f.verifier.check(input),code('PAYMENT_VERIFICATION_INPUT_INVALID'));
  await assert.rejects(f.verifier.check(),code('PAYMENT_VERIFICATION_INPUT_INVALID'));
  await assert.rejects(f.verifier.check(valid,undefined),code('PAYMENT_VERIFICATION_INPUT_INVALID'));
  await assert.rejects(f.verifier.check({...valid,rightId:2n}),code('PAYMENT_NOT_APPROVED'));
  assert.equal(invoked,0);assert.equal(f.calls.length,0);
});

test('profile and exact check values are captured before asynchronous reads and cannot be redirected',async()=>{
  const f=await fixture(),release=f.hold(),input={rightId:1n,hash:f.hash};
  const pending=f.verifier.check(input);input.hash=h(5);input.rightId=2n;f.profile.claims[0].amount=1n;f.profile.owner='0x'+'01'.repeat(20);release();
  const result=await pending;assert.equal(result.hash,f.hash);assert.equal(result.rightId,1n);assert.equal(result.amount,f.amount);assert.notEqual(result.beneficiary,f.profile.owner);
});
