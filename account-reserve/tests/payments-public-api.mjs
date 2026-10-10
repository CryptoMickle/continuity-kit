import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import ts from 'typescript';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {createTestnetPaymentClient,createTestnetPaymentReader,createTestnetPaymentVerifier} from '@continuitykit/account-reserve/payments';

const root=fileURLToPath(new URL('../',import.meta.url));
const code=expected=>error=>error.code===expected&&error.message===expected;
function fixture(){
  const account=privateKeyToAccount(generatePrivateKey());
  const profile={chainId:10143,address:'0x'+'12'.repeat(20),owner:account.address,issuer:'0x'+'34'.repeat(20),expectedRuntimeCodeHash:'0x'+'56'.repeat(32),expiresAt:new Date(Date.now()+3600000).toISOString(),claims:[{rightId:1n,amount:10n**16n,nonce:0}]};
  const storage={getItem:()=>null,setItem(){throw new Error('UNEXPECTED_WRITE');}},locks={request:async(name,options,callback)=>callback({name,mode:options.mode})};
  let closed=0;
  return {profile,storage,locks,recovered:{owner:account.address,account,close(){closed++;}},closed:()=>closed};
}

test('public payment entry exports only the three fixed-endpoint factories and allowlists their browser dependency graph',async()=>{
  const module=await import('@continuitykit/account-reserve/payments');
  assert.deepEqual(Object.keys(module).sort(),['createTestnetPaymentClient','createTestnetPaymentReader','createTestnetPaymentVerifier']);
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  assert.deepEqual(manifest.exports['./payments'],{types:'./payments/index.d.ts',import:'./payments/index.mjs'});
  assert.deepEqual(manifest.files.filter(name=>name.startsWith('payments/')).sort(),['executor.mjs','guard.mjs','index.d.ts','index.mjs','pending.mjs','testnet.mjs'].map(name=>'payments/'+name).sort());
  assert.deepEqual(manifest.files.filter(name=>name.startsWith('release/')).sort(),['client-profile.mjs','paced-rpc.mjs','profile.mjs'].map(name=>'release/'+name).sort());
  assert.ok(!manifest.files.includes('payments')&&!manifest.files.includes('release'));
  await assert.rejects(import('@continuitykit/account-reserve/payments/testnet.mjs'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
});

test('public options refuse RPC/transport injection, extra arguments and accessors before reading them',()=>{
  const f=fixture();let evaluated=0;
  for(const [factory,options]of [[createTestnetPaymentClient,{profile:f.profile,recovered:f.recovered,storage:f.storage,locks:f.locks}],[createTestnetPaymentReader,{profile:f.profile,storage:f.storage,locks:f.locks}],[createTestnetPaymentVerifier,{profile:f.profile}]]){
    for(const name of ['rpcTransport','transport','rpcUrls','endpoints','url','publicClient','wallet']){
      const extra=Object.defineProperty({...options},name,{enumerable:true,get(){evaluated++;return ()=>{};}});
      assert.throws(()=>factory(extra),code('PAYMENT_OPTIONS_INVALID'));
    }
    for(const value of [undefined,null,{},Object.create(options),{...options,[Symbol('transport')]:()=>{}}])assert.throws(()=>factory(value),code('PAYMENT_OPTIONS_INVALID'));
    assert.throws(()=>factory(),code('PAYMENT_OPTIONS_INVALID'));
    assert.throws(()=>factory(options,{rpcTransport(){evaluated++;}}),code('PAYMENT_OPTIONS_INVALID'));
    assert.throws(()=>factory(options,undefined),code('PAYMENT_OPTIONS_INVALID'));
    const getter=Object.defineProperty({...options},'profile',{enumerable:true,get(){evaluated++;return f.profile;}});
    assert.throws(()=>factory(getter),code('PAYMENT_OPTIONS_INVALID'));
  }
  for(const name of ['storage','locks','recovered'])assert.throws(()=>createTestnetPaymentVerifier({profile:f.profile,[name]:f[name]}),code('PAYMENT_OPTIONS_INVALID'));
  assert.equal(evaluated,0);assert.equal(f.closed(),0);
});

test('fresh public import/construction does no IO, credential operation or signing; only client close ends supplied session',()=>{
  const output=execFileSync(process.execPath,['--input-type=module','-'],{cwd:root,encoding:'utf8',input:`
    import assert from 'node:assert/strict';
    const calls={network:0,credentials:0,signatures:0,reads:0,writes:0,closed:0};
    const forbidden=key=>()=>{calls[key]++;throw new Error('UNEXPECTED_'+key);};
    globalThis.fetch=forbidden('network');
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{credentials:{get:forbidden('credentials'),create:forbidden('credentials')}}});
    const {createTestnetPaymentClient,createTestnetPaymentReader,createTestnetPaymentVerifier}=await import('@continuitykit/account-reserve/payments');
    const owner='0x'+'ab'.repeat(20),account={address:owner,type:'local',source:'test-only',signTransaction:forbidden('signatures')};
    const profile={chainId:10143,address:'0x'+'12'.repeat(20),owner,issuer:'0x'+'34'.repeat(20),expectedRuntimeCodeHash:'0x'+'56'.repeat(32),expiresAt:new Date(Date.now()+3600000).toISOString(),claims:[{rightId:1n,amount:100n,nonce:0}]};
    const storage={getItem(){calls.reads++;return null;},setItem:forbidden('writes')},locks={request:async(name,options,callback)=>callback({name,mode:options.mode})};
    const recovered={owner,account,close(){calls.closed++;}};
    const client=createTestnetPaymentClient({profile,recovered,storage,locks}),reader=createTestnetPaymentReader({profile,storage,locks}),executor=client.forRight(1n);
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('STATELESS_STORAGE_FORBIDDEN');}});
    Object.defineProperty(globalThis.navigator,'locks',{get(){throw new Error('STATELESS_LOCKS_FORBIDDEN');}});
    const verifier=createTestnetPaymentVerifier({profile});
    assert.deepEqual(calls,{network:0,credentials:0,signatures:0,reads:0,writes:0,closed:0});
    profile.claims[0].rightId=2n;assert.throws(()=>client.forRight(2n),e=>e.code==='PAYMENT_NOT_APPROVED');
    executor.close();assert.equal(calls.closed,0);
    await assert.rejects(verifier.check({rightId:2n,hash:'0x'+'11'.repeat(32)}),e=>e.code==='PAYMENT_NOT_APPROVED');
    await assert.rejects(reader.check(1n),e=>e.code==='PAYMENT_TRANSACTION_MISSING');
    client.close();assert.equal(calls.closed,1);assert.throws(()=>client.forRight(1n),e=>e.code==='SESSION_CLOSED');
    assert.deepEqual(calls,{network:0,credentials:0,signatures:0,reads:1,writes:0,closed:1});console.log(JSON.stringify(calls));
  `,timeout:10000});
  assert.deepEqual(JSON.parse(output),{network:0,credentials:0,signatures:0,reads:1,writes:0,closed:1});
});

test('public declarations accept SDK recovery and native persistence while rejecting unsafe or mistyped API use',()=>{
  const filename=join(root,'tests','__payment_public_api_types__.mts');
  const source=`
    import type {RecoveredReserve} from '@continuitykit/account-reserve';
    import type {Hash} from 'viem';
    import {createTestnetPaymentClient,createTestnetPaymentReader,createTestnetPaymentVerifier,type PaymentProfile,type PaymentResult,type PaymentLocks,type PaymentVerificationResult} from '@continuitykit/account-reserve/payments';
    declare const recovered:RecoveredReserve;
    const profile:PaymentProfile={chainId:10143,address:'0x12',owner:recovered.owner,issuer:'0x34',expectedRuntimeCodeHash:'0x56',expiresAt:'2026-11-10T00:00:00.000Z',claims:[{rightId:1n,amount:100n,nonce:0}]};
    const locks:PaymentLocks=navigator.locks;
    const client=createTestnetPaymentClient({profile,recovered,storage:localStorage,locks});
    const executor=client.forRight(1n);
    const result:Promise<PaymentResult>=executor.claim();
    const hash:Hash|undefined=executor.hash;
    const status:'not-attempted'|'attempted'|'unknown'|'confirmed'=executor.deliveryStatus;
    const reader=createTestnetPaymentReader({profile,storage:localStorage,locks:navigator.locks});
    const checked:Promise<PaymentResult>=reader.check(1n);
    const verifier=createTestnetPaymentVerifier({profile});
    const verified:Promise<PaymentVerificationResult>=verifier.check({rightId:1n,hash:'0x12'});
    void verified.then(value=>{const amount:bigint=value.amount;if(value.paymentVerified){const status:'finalized'=value.status;const block:bigint=value.blockNumber;void status;void block;}if(value.status==='pending-or-unknown'){const finalized:false=value.finalized;void finalized;}void amount;});
    void result;void checked;void hash;void status;executor.close();client.close();
    // @ts-expect-error no transport override parameter
    createTestnetPaymentClient({profile,recovered},{rpcTransport:()=>{}});
    // @ts-expect-error no RPC endpoint in public options
    createTestnetPaymentReader({profile,rpcUrls:['https://example.invalid']});
    // @ts-expect-error reader never takes a signer
    createTestnetPaymentReader({profile,recovered});
    // @ts-expect-error stateless verifier cannot take storage or signer state
    createTestnetPaymentVerifier({profile,storage:localStorage});
    // @ts-expect-error no verifier transport override
    createTestnetPaymentVerifier({profile},{rpcTransport:()=>{}});
    // @ts-expect-error explicit exact transaction input required
    verifier.check(1n);
    // @ts-expect-error JSON right strings are not approved bigint identifiers
    verifier.check({rightId:'1',hash:'0x12'});
    // @ts-expect-error exact bigint right identifier
    reader.check('1');
    // @ts-expect-error testnet only
    const mainnet:PaymentProfile={...profile,chainId:1};
    // @ts-expect-error JSON strings must be parsed into bigints
    const jsonClaims:PaymentProfile={...profile,claims:[{rightId:'1',amount:'100',nonce:0}]};
    // @ts-expect-error account SDK compatibility must not degrade to any
    createTestnetPaymentClient({profile,recovered:{owner:recovered.owner,account:{},close(){}}});
  `;
  const options={strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext};
  const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host),get=host.getSourceFile.bind(host);
  host.readFile=name=>name===filename?source:read(name);host.fileExists=name=>name===filename||exists(name);
  host.getSourceFile=(name,language,onError,shouldCreate)=>name===filename?ts.createSourceFile(name,source,language,true):get(name,language,onError,shouldCreate);
  const program=ts.createProgram([filename],options,host),diagnostics=ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:name=>name,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));
});
