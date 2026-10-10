import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {mountPaymentPage} from '../payments/page.mjs';
const require=createRequire(new URL('../integrations/multi-app/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(t,options={}){
 const dom=new JSDOM('<div id="app"></div>',{url:'https://fresh.example.test/payments/'}),root=dom.window.document.getElementById('app');
 const profile={chainId:10143,owner:'0x'+'2'.repeat(40),address:'0x'+'3'.repeat(40),expiresAt:'2100-01-01T00:00:00.000Z',claims:[{rightId:1n,amount:10n**16n},{rightId:2n,amount:10n**16n}],...options.profile};
 const calls={read:0,open:0,claim:0,close:0,reader:0},identity={chainId:profile.chainId,contract:profile.address,beneficiary:profile.owner,rightId:2n,amount:10n**16n,readOnly:true,paymentVerified:false};let current=0;
 const deps={profile,role:'recovery',window:dom.window,monotonicNow:()=>current,
  createAvailability:()=>({check:async input=>{calls.read++;assert.deepEqual(input,{rightId:2n});return options.read?options.read(identity):{...identity,status:'funded'};}}),
  openAccount:async()=>{calls.open++;return {close(){calls.close++;}};},
  createClient:()=>({forRight:()=>({close(){},claim:async()=>{calls.claim++;if(options.claim)return options.claim();return {hash:'0x'+'1'.repeat(64)};}}),close(){calls.close++;}}),
  createReader:()=>({check:async()=>{calls.reader++;return {hash:'0x'+'1'.repeat(64)};}}),
  createVerifier:()=>({check:async()=>({status:'pending-or-unknown',finalized:false,paymentVerified:false})}),...options.deps};
 const mounted=mountPaymentPage(root,deps),$=id=>root.querySelector('#'+id);t.after(()=>{mounted.close();dom.window.close();});return {dom,root,$,calls,profile,identity,mounted,advance:ms=>{current+=ms;}};
}
test('one automatic public read precedes an explicit synchronous native action; never auto-opens or sends',async t=>{
 const f=fixture(t);assert.equal(f.calls.read,1);assert.equal(f.calls.open,0);assert.equal(f.$('payment-open').hidden,true);await tick();assert.equal(f.$('payment-open').hidden,false);assert.equal(f.calls.open,0);
 f.$('payment-open').click();assert.equal(f.calls.open,1,'native callback invoked in the click turn');assert.equal(f.calls.claim,0);await tick();assert.equal(f.$('payment-claim').hidden,false);
});
test('already-collected contract state needs no passkey and is not reported as receipt verification',async t=>{
 const f=fixture(t,{read:async identity=>({...identity,status:'already-collected'})});await tick();assert.match(f.$('payment-title').textContent,/already collected/);assert.match(f.$('payment-status').textContent,/transaction reference/);assert.equal(f.$('payment-open').hidden,true);f.$('payment-open').click();await tick();assert.equal(f.calls.open,0);assert.equal(f.$('payment-receipt').hidden,true);assert.equal(f.$('reference-details').hidden,true);
});
test('unfunded, expired and insufficient-gas states never request a passkey',async t=>{
 for(const reason of ['not-issued','expired','insufficient-gas']){const f=fixture(t,{read:async identity=>({...identity,status:'not-available',reason})});await tick();assert.match(f.$('payment-title').textContent,/not available/);assert.equal(f.$('payment-open').hidden,true);assert.equal(f.calls.open,0);assert.equal(f.calls.claim,0);}
});
test('RPC failure, mismatch, or malformed funded result cannot enable native auth',async t=>{
 for(const read of [async()=>{throw Error('private RPC diagnostic');},async i=>({...i,status:'funded',beneficiary:'0x'+'9'.repeat(40)}),async i=>({...i,status:'funded',paymentVerified:true}),async i=>({...i,status:'unknown'})]){const f=fixture(t,{read});await tick();assert.match(f.$('payment-title').textContent,/could not be verified/);assert.equal(f.$('payment-open').hidden,true);assert.equal(f.calls.open,0);assert.ok(!f.root.textContent.includes('private RPC'));}
});
test('freshness is local and checked synchronously even if a suspended timer did not fire',async t=>{
 const f=fixture(t);await tick();assert.equal(f.$('payment-open').hidden,false);f.advance(30001);f.$('payment-open').click();assert.equal(f.calls.open,0);await tick();assert.equal(f.$('payment-open').hidden,true);assert.equal(f.calls.read,1,'no automatic retry');
 f.$('payment-refresh').click();await tick();assert.equal(f.calls.read,2);assert.equal(f.$('payment-open').hidden,false);
});
test('signing expiry blocks an otherwise funded readiness result',async t=>{
 const f=fixture(t,{profile:{expiresAt:'2020-01-01T00:00:00.000Z'}});await tick();assert.equal(f.$('payment-open').hidden,true);f.$('payment-open').click();await tick();assert.equal(f.calls.open,0);assert.equal(f.calls.claim,0);
});
test('stop and page exit discard delayed availability without native calls',async t=>{
 for(const exit of [false,true]){let resolve;const f=fixture(t,{read:()=>new Promise(r=>resolve=r)});await tick();if(exit)f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));else f.$('payment-close').click();resolve({...f.identity,status:'funded'});await tick();assert.equal(f.$('payment-open').hidden,true);assert.equal(f.calls.open,0);assert.equal(f.calls.read,1);}
});
test('availability refresh cannot clear an unresolved claim or permit another native opening',async t=>{
 const f=fixture(t);await tick();f.$('payment-open').click();await tick();f.$('payment-claim').click();await tick();assert.equal(f.calls.claim,1);assert.equal(f.$('payment-open').hidden,true);
 f.$('payment-refresh').click();await tick();assert.match(f.$('payment-status').textContent,/must be reconciled/);assert.equal(f.$('payment-open').hidden,true);assert.equal(f.calls.open,1);assert.equal(f.calls.claim,1);
});
test('a later claim preflight rejection closes the signer despite earlier funded observation',async t=>{
 const f=fixture(t,{claim:async()=>{throw Object.assign(Error(),{code:'PAYMENT_NONCE_MISMATCH'});}});await tick();f.$('payment-open').click();await tick();f.$('payment-claim').click();await tick();assert.equal(f.calls.claim,1);assert.equal(f.calls.close,1);assert.equal(f.$('payment-open').hidden,true);assert.equal(f.$('payment-claim').hidden,true);assert.match(f.$('payment-status').textContent,/account has changed/);
});
