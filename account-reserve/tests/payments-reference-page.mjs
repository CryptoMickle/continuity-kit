import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mountPaymentPage} from '../payments/page.mjs';
const require=createRequire(new URL('../integrations/multi-app/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const hash='0x'+'1'.repeat(64);
function fixture(t,{verify,role='recovery'}={}){
 const dom=new JSDOM('<div id="app"></div>',{url:'https://fresh.example.test/payments/'}),root=dom.window.document.querySelector('#app');
 const calls={open:0,client:0,reader:0,verify:0,close:0,claim:0};
 const profile={expiresAt:'2100-01-01T00:00:00.000Z',claims:[{rightId:1n,amount:10n**16n},{rightId:2n,amount:10n**16n}]};
 const result={status:'finalized',paymentVerified:true,finalized:true,rightId:2n,amount:10n**16n,beneficiary:'0x'+'2'.repeat(40),contract:'0x'+'3'.repeat(40),blockNumber:123n,hash};
 const mounted=mountPaymentPage(root,{role,profile,window:dom.window,openAccount:async()=>{calls.open++;return {};},createClient:()=>{calls.client++;return {forRight:()=>({hash,close(){},claim:async()=>{calls.claim++;throw Object.assign(Error(),{code:'PAYMENT_BROADCAST_UNKNOWN'});}}),close(){calls.close++;}};},createReader:()=>{calls.reader++;throw Error('JOURNAL_MUST_NOT_BE_USED');},createVerifier:()=>({check:async input=>{calls.verify++;return verify?verify(input):result;}})});
 const $=id=>root.querySelector('#'+id);
 const submit=()=>{$('reference-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));};
 t.after(()=>{mounted.close();dom.window.close();});
 return {dom,root,$,submit,calls,result,mounted};
}
test('fresh page verifies explicit hash without credentials, journal or implicit checking',async t=>{
 const f=fixture(t);assert.deepEqual(f.calls,{open:0,client:0,reader:0,verify:0,close:0,claim:0});
 f.dom.window.localStorage.setItem('untouched-journal','unresolved');
 f.$('reference-hash').value=hash;f.submit();f.submit();await tick();
 assert.deepEqual(f.calls,{open:0,client:0,reader:0,verify:1,close:0,claim:0});
 assert.match(f.$('reference-status').textContent,/Payment verified/);assert.equal(f.$('reference-details').hidden,false);assert.match(f.$('reference-details').textContent,/0\.01 test-MON/);
 assert.equal(f.dom.window.localStorage.getItem('untouched-journal'),'unresolved');
 assert.equal(f.$('payment-title').textContent,'Return to your prepared account.');assert.equal(f.$('payment-claim').hidden,true);
});
test('invalid reference is rejected before any verifier or account call',async t=>{
 const f=fixture(t);for(const input of ['', '0x123', '<img src=x onerror=alert(1)>']){f.$('reference-hash').value=input;f.submit();await tick();assert.match(f.$('reference-status').textContent,/full transaction reference/);}
 assert.equal(f.calls.verify,0);assert.equal(f.calls.open,0);assert.equal(f.root.querySelector('img'),null);
});
test('reference checks allow either approved payment on either origin',async t=>{
 for(const role of ['primary','recovery']){let seen;const f=fixture(t,{role,verify:async input=>{seen=input;return {status:'pending-or-unknown',finalized:false,paymentVerified:false};}});f.$('reference-right').value='1';f.$('reference-hash').value=hash;f.submit();await tick();assert.deepEqual(seen,{rightId:1n,hash});assert.equal(f.calls.reader,0);}
});
test('pending reference never establishes payment identity or success',async t=>{
 const f=fixture(t,{verify:async()=>({status:'pending-or-unknown',finalized:false,paymentVerified:false})});f.$('reference-hash').value=hash;f.submit();await tick();assert.match(f.$('reference-status').textContent,/has not been linked/);assert.equal(f.$('reference-details').hidden,true);assert.equal(f.$('reference-status').dataset.state,'pending');
});
test('reverted reference is explicitly not a delivered payment',async t=>{
 const f=fixture(t,{verify:async()=>({status:'reverted',finalized:true,paymentVerified:false})});f.$('reference-hash').value=hash;f.submit();await tick();assert.match(f.$('reference-status').textContent,/did not deliver/);assert.equal(f.$('reference-details').hidden,true);assert.equal(f.$('reference-status').dataset.state,'reverted');
});
test('mismatch and unavailable reads discard earlier receipt and hide raw network errors',async t=>{
 let failure;const f=fixture(t,{verify:async()=>{if(failure)throw failure;return f.result;}});f.$('reference-hash').value=hash;f.submit();await tick();assert.equal(f.$('reference-details').hidden,false);
 failure=Object.assign(Error('sensitive RPC raw body'),{code:'PAYMENT_TRANSACTION_MISMATCH'});f.submit();await tick();assert.match(f.$('reference-status').textContent,/does not match/);assert.equal(f.$('reference-details').hidden,true);assert.equal(f.$('reference-details').textContent,'');assert.ok(!f.root.textContent.includes('sensitive'));
 failure=Error('private diagnostic');f.submit();await tick();assert.match(f.$('reference-status').textContent,/unavailable/);assert.ok(!f.root.textContent.includes('private diagnostic'));
});
test('verified reference never unblocks a locally unresolved signing attempt',async t=>{
 const f=fixture(t);f.$('payment-open').click();await tick();f.$('payment-claim').click();await tick();assert.equal(f.$('payment-open').hidden,true);assert.equal(f.calls.claim,1);
 f.$('reference-hash').value=hash;f.submit();await tick();assert.match(f.$('reference-status').textContent,/Payment verified/);assert.equal(f.$('payment-open').hidden,true);assert.equal(f.$('payment-claim').hidden,true);assert.equal(f.calls.claim,1);assert.equal(f.calls.reader,0);
});
test('reference check closes an already open signer and suppresses late results after page exit',async t=>{
 let resolve;const f=fixture(t,{verify:()=>new Promise(r=>resolve=r)});f.$('payment-open').click();await tick();f.$('reference-hash').value=hash;f.submit();await tick();assert.equal(f.calls.close,1);f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));const previous=f.$('reference-status').textContent;resolve(f.result);await tick();assert.equal(f.$('reference-status').textContent,previous);assert.equal(f.$('reference-details').hidden,true);assert.equal(f.$('reference-check').disabled,true);
});

test('editing hash or expected payment clears the earlier verified result',async t=>{
 const f=fixture(t);f.$('reference-hash').value=hash;
 for(const [id,event]of [['reference-hash','input'],['reference-right','change']]){f.submit();await tick();assert.equal(f.$('reference-status').dataset.state,'verified');f.$(id).dispatchEvent(new f.dom.window.Event(event));assert.match(f.$('reference-status').textContent,/Verify again/);assert.equal(f.$('reference-details').hidden,true);assert.equal(f.$('reference-details').textContent,'');assert.equal(f.$('reference-status').dataset.state,undefined);}
});
test('stopping a reference check suppresses a late verified result',async t=>{
 let resolve;const f=fixture(t,{verify:()=>new Promise(r=>resolve=r)});f.$('reference-hash').value=hash;f.submit();await tick();assert.equal(f.$('payment-close').textContent,'Stop checking');f.$('payment-close').click();resolve(f.result);await tick();assert.match(f.$('reference-status').textContent,/stopped/);assert.equal(f.$('reference-details').hidden,true);assert.equal(f.$('reference-status').dataset.state,undefined);
});
