import assert from 'node:assert/strict';
import test from 'node:test';
import {custom,encodeFunctionData,encodeFunctionResult,getAddress,keccak256,toHex} from 'viem';
import {createPaymentGuard,PAYMENT_ABI,PAYMENT_LIMITS} from '../payments/guard.mjs';
import {createTestnetPaymentAvailability} from '../payments/testnet.mjs';
import {APPROVED_TESTNET_RPCS} from '../release/client-profile.mjs';
const code=expected=>e=>e.code===expected&&e.message===expected;
const h=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture(){
  let time=1000,mode='funded',gate;
  const profile={chainId:10143,address:getAddress('0x'+'12'.repeat(20)),owner:getAddress('0x'+'ab'.repeat(20)),issuer:getAddress('0x'+'34'.repeat(20)),expectedRuntimeCodeHash:keccak256('0x6000'),expiresAt:new Date(10000).toISOString(),claims:[{rightId:1n,amount:10n**16n,nonce:0}]};
  const calls=[],numbered=[0,0];
  const right=()=>({beneficiary:profile.owner,amount:10n**16n,claimed:mode==='collected'});
  const clients=[0,1].map(i=>({
    async getChainId(){calls.push(['chain',i]);if(gate)await gate;return mode==='wrong-chain'?31337:10143;},
    async getBlock(args){calls.push(['block',i,args]);if(args.blockNumber!==undefined){numbered[i]++;return {number:args.blockNumber,hash:mode==='canonical-conflict'&&i===1||mode==='changed-hash'&&numbered[i]>1?h(99):h(100)};}return {number:mode==='bad-head'?undefined:100n+BigInt(i),hash:mode==='bad-head'?'invalid':h(100+i),baseFeePerGas:mode==='bad-fee'?null:mode==='expensive'?PAYMENT_LIMITS.maxFeePerGas:mode==='fee-conflict'&&i===1?2n:1n};},
    async getCode({address}){calls.push(['code',i,address]);return address===profile.address?'0x6000':'0x';},
    async readContract(args){calls.push(['read',i,args]);if(mode==='rpc-failure')throw new Error('PRIVATE_PROVIDER_MESSAGE');switch(args.functionName){case 'issuer':return profile.issuer;case 'nextId':return mode==='not-issued'?1n:mode==='bad-next'?0n:mode==='next-conflict'&&i===1?3n:2n;case 'rightForOwner':return 1n;case 'getRight':return {...right(),...(mode==='wrong-owner'?{beneficiary:profile.issuer}:{}),...(mode==='wrong-amount'?{amount:1n}:{}),...(mode==='right-conflict'&&i===1?{claimed:true}:{}),...(mode==='state-changed'&&args.blockTag?{claimed:true}:{})};default:throw Error('UNEXPECTED_METHOD');}},
    async getTransactionCount(){return mode==='bad-nonce'?'0':mode==='nonce'?1:mode==='nonce-conflict'&&i===1?1:0;},
    async estimateGas(){return mode==='bad-estimate'?'60000':mode==='gas-limit'?300000n:mode==='estimate-conflict'&&i===1?60000n:50000n;},
    async getBalance(){return mode==='gas-empty'||mode==='balance-conflict'&&i===1?0n:10n**18n;},
  }));
  return {profile,clients,calls,guard:createPaymentGuard({profile,clients,now:()=>time}),setMode(value){mode=value;},setTime(value){time=value;},hold(){let release;gate=new Promise(r=>release=r);return ()=>{gate=undefined;release();};}};
}

test('funded readiness uses the common finalized numbered snapshot, checks live eligibility and returns no payment proof',async()=>{
  const f=fixture(),result=await f.guard.availability(1n);
  assert.deepEqual(result,{chainId:10143,contract:f.profile.address,beneficiary:f.profile.owner,rightId:1n,amount:10n**16n,readOnly:true,paymentVerified:false,observedAt:new Date(1000).toISOString(),blockNumber:100n,blockHash:h(100),status:'funded'});
  assert.ok(Object.isFrozen(result));
  for(const i of [0,1]){const numbered=f.calls.filter(c=>c[0]==='block'&&c[1]===i&&c[2].blockNumber!==undefined);assert.equal(numbered.length,2);assert.ok(numbered.every(c=>c[2].blockNumber===100n));}
  for(const c of f.calls.filter(c=>c[0]==='read'&&c[2].blockNumber!==undefined))assert.equal(c[2].blockNumber,100n);
});

test('unissued is established by a corroborated canonical nextId, and collected state stays readable after expiry',async()=>{
  const f=fixture();f.setMode('not-issued');const absent=await f.guard.availability(1n);assert.equal(absent.status,'not-available');assert.equal(absent.reason,'not-issued');assert.equal(f.calls.some(c=>c[0]==='read'&&c[2].functionName==='getRight'),false);
  const g=fixture();g.setMode('collected');g.setTime(20000);const paid=await g.guard.availability(1n);assert.equal(paid.status,'already-collected');assert.equal(paid.paymentVerified,false);assert.equal(g.calls.some(c=>c[0]==='read'&&c[2].blockTag),false);
});

test('agreed known live preflight blocks return specific availability reasons',async()=>{
  for(const [mode,reason] of [['nonce','nonce-mismatch'],['gas-empty','insufficient-gas'],['expensive','fee-cap-exceeded'],['gas-limit','gas-limit-exceeded'],['state-changed','state-changed']]){const f=fixture();f.setMode(mode);const result=await f.guard.availability(1n);assert.equal(result.status,'not-available');assert.equal(result.reason,reason);assert.equal(result.paymentVerified,false);}
  const expired=fixture();expired.setTime(10000);assert.equal((await expired.guard.availability(1n)).reason,'expired');
});

test('malformed RPC values, policy mismatches, conflicting providers and changed canonical hashes never become unavailable funds',async()=>{
  for(const [mode,expected] of [['bad-head','PAYMENT_FINALIZED_HEAD_INVALID'],['bad-next','PAYMENT_AVAILABILITY_RESPONSE_INVALID'],['bad-fee','PAYMENT_AVAILABILITY_RESPONSE_INVALID'],['bad-estimate','PAYMENT_AVAILABILITY_RESPONSE_INVALID'],['bad-nonce','PAYMENT_AVAILABILITY_RESPONSE_INVALID'],['wrong-chain','PAYMENT_CHAIN_MISMATCH'],['wrong-owner','PAYMENT_RIGHT_MISMATCH'],['wrong-amount','PAYMENT_RIGHT_MISMATCH'],['right-conflict','PAYMENT_STATE_DISAGREEMENT'],['next-conflict','PAYMENT_STATE_DISAGREEMENT'],['nonce-conflict','PAYMENT_STATE_DISAGREEMENT'],['balance-conflict','PAYMENT_STATE_DISAGREEMENT'],['estimate-conflict','PAYMENT_STATE_DISAGREEMENT'],['fee-conflict','PAYMENT_STATE_DISAGREEMENT'],['canonical-conflict','PAYMENT_CANONICAL_BLOCK_MISMATCH'],['changed-hash','PAYMENT_CANONICAL_BLOCK_MISMATCH']]){const f=fixture();f.setMode(mode);await assert.rejects(f.guard.availability(1n),code(expected));}
});

test('expiry while reads are outstanding prevents funded readiness at completion',async()=>{
  const f=fixture(),release=f.hold(),pending=f.guard.availability(1n);await new Promise(r=>setImmediate(r));f.setTime(20000);release();const result=await pending;assert.equal(result.status,'not-available');assert.equal(result.reason,'expired');assert.equal(result.observedAt,new Date(20000).toISOString());
});

function rpcFixture(){
  const f=fixture();f.profile.expiresAt=new Date(Date.now()+60000).toISOString();let requests=0,mode='funded';
  const rpcTransport=url=>{assert.ok(APPROVED_TESTNET_RPCS.includes(url));return custom({async request({method,params}){requests++;if(mode==='rpc-failure')throw new Error('PRIVATE_PROVIDER_MESSAGE');switch(method){
    case 'eth_chainId':return '0x279f';case 'eth_getCode':return params[0].toLowerCase()===f.profile.address.toLowerCase()?'0x6000':'0x';
    case 'eth_getBlockByNumber':return {number:'0x64',hash:h(100),baseFeePerGas:'0x1',timestamp:'0x1',transactions:[]};
    case 'eth_getTransactionCount':return '0x0';case 'eth_estimateGas':return toHex(50000n);case 'eth_getBalance':return toHex(10n**18n);
    case 'eth_call':for(const functionName of ['issuer','nextId','rightForOwner','getRight']){const args=functionName==='getRight'?[1n]:functionName==='rightForOwner'?[f.profile.owner]:undefined;if(params[0].data===encodeFunctionData({abi:PAYMENT_ABI,functionName,args})){const result=functionName==='issuer'?f.profile.issuer:functionName==='nextId'?2n:functionName==='rightForOwner'?1n:{beneficiary:f.profile.owner,amount:10n**16n,claimed:false};return encodeFunctionResult({abi:PAYMENT_ABI,functionName,result});}}throw Error('UNEXPECTED_CALL');
    default:throw Error('UNEXPECTED_RPC_'+method);
  }}},{retryCount:0});};
  return {...f,availability:createTestnetPaymentAvailability({profile:f.profile},{rpcTransport}),requests:()=>requests,setRpcMode(value){mode=value;}};
}

test('stateless factory accepts exact captured inputs only and sanitizes provider failure without storage/signing',async()=>{
  const f=rpcFixture();assert.equal(f.requests(),0);let invoked=0;
  for(const input of [undefined,null,{},Object.create({rightId:1n}),{rightId:'1'},{rightId:0n},{rightId:2n**256n},{rightId:1n,hash:h(1)},Object.defineProperty({},'rightId',{enumerable:true,get(){invoked++;return 1n;}})])await assert.rejects(f.availability.check(input),code('PAYMENT_AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(f.availability.check(),code('PAYMENT_AVAILABILITY_INPUT_INVALID'));await assert.rejects(f.availability.check({rightId:1n},undefined),code('PAYMENT_AVAILABILITY_INPUT_INVALID'));await assert.rejects(f.availability.check({rightId:2n}),code('PAYMENT_NOT_APPROVED'));assert.equal(f.requests(),0);assert.equal(invoked,0);
  const input={rightId:1n},pending=f.availability.check(input);input.rightId=2n;f.profile.claims[0].amount=1n;const result=await pending;assert.equal(result.status,'funded');assert.equal(result.amount,10n**16n);assert.ok(Object.isFrozen(f.availability));
  f.setRpcMode('rpc-failure');await assert.rejects(f.availability.check({rightId:1n}),code('PAYMENT_AVAILABILITY_FAILED'));
});
