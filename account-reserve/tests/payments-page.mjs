import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mountPaymentPage} from '../payments/page.mjs';
const require=createRequire(new URL('../integrations/multi-app/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r)),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(t,changes={}){
 const dom=new JSDOM('<div id="app"></div>',{url:'https://reserve.example.test/payments/'}),root=dom.window.document.getElementById('app'),calls={open:0,create:0,claim:0,check:0,close:0,sessionClose:0};
 const result={hash:'0x'+'1'.repeat(64),receipt:{status:'success'}};
 const recovered={owner:'0x'+'2'.repeat(40),close(){calls.sessionClose++;}};
 const deps={role:'recovery',profile:{chainId:10143,owner:'0x'+'2'.repeat(40),address:'0x'+'3'.repeat(40),expiresAt:'2100-01-01T00:00:00.000Z',claims:[{rightId:1n,amount:10n**16n},{rightId:2n,amount:10n**16n}]},window:dom.window,openAccount:async()=>{calls.open++;return recovered;},createClient:()=>{calls.create++;return {forRight:id=>({claim:async()=>{assert.equal(id,1n);calls.claim++;return result;},close(){}}),close(){calls.close++;recovered.close();}};},createAvailability:()=>({check:async({rightId})=>({status:'funded',chainId:10143,beneficiary:'0x'+'2'.repeat(40),contract:'0x'+'3'.repeat(40),rightId,amount:10n**16n,readOnly:true,paymentVerified:false})}),createReader:()=>({check:async()=>{calls.check++;return result;}}),...changes};
 const mounted=mountPaymentPage(root,deps);t.after(()=>{mounted.close();dom.window.close();});return {dom,root,calls,recovered,mounted,$:id=>root.querySelector('#'+id)};
}
test('page starts without credentials or transaction and recovery has no create-key action',t=>{
 const f=setup(t);assert.deepEqual(f.calls,{open:0,create:0,claim:0,check:0,close:0,sessionClose:0});assert.equal(f.$('payment-open').textContent,'Open existing reserve');assert.equal(f.$('payment-claim').hidden,true);assert.equal(f.root.textContent.includes('Create a new'),false);
});
test('opening account does not claim; explicit claim confirms and closes signer',async t=>{
 const f=setup(t);await tick();f.$('payment-open').click();await tick();assert.equal(f.calls.open,1);assert.equal(f.calls.claim,0);assert.equal(f.$('payment-claim').hidden,false);
 f.$('payment-claim').click();f.$('payment-claim').click();await tick();assert.equal(f.calls.claim,1);assert.equal(f.calls.close,1);assert.equal(f.$('payment-title').textContent,'Payment received.');assert.equal(f.$('payment-claim').hidden,true);
});
test('existing transaction can be checked without opening a credential',async t=>{
 const f=setup(t);await tick();f.$('payment-check').click();await tick();assert.equal(f.calls.check,1);assert.equal(f.calls.open,0);assert.equal(f.$('payment-hash').textContent,'0x'+'1'.repeat(64));
});
test('native cancellation discards a late recovered session and never creates a client',async t=>{
 const wait=deferred();const f=setup(t,{openAccount:()=>wait.promise});await tick();f.$('payment-open').click();await tick();f.$('payment-close').click();wait.resolve(f.recovered);await tick();assert.equal(f.calls.sessionClose,1);assert.equal(f.calls.create,0);assert.equal(f.calls.claim,0);
});
test('page exit discards late native result and disables all payment actions',async t=>{
 const wait=deferred();const f=setup(t,{openAccount:()=>wait.promise});await tick();f.$('payment-open').click();await tick();f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));wait.resolve(f.recovered);await tick();assert.equal(f.calls.sessionClose,1);assert.equal(f.calls.create,0);assert.equal(f.$('payment-open').disabled,true);
});
test('unknown broadcast status remains checkable and is not shown as success',async t=>{
 let claims=0;const f=setup(t,{createClient:()=>({forRight:()=>({hash:'0x'+'1'.repeat(64),claim:async()=>{claims++;throw Object.assign(new Error('secret raw RPC'),{code:'PAYMENT_BROADCAST_UNKNOWN'});},close(){}}),close(){}})});
 await tick();f.$('payment-open').click();await tick();f.$('payment-claim').click();await tick();assert.equal(claims,1);assert.equal(f.$('payment-title').textContent,'Your payment is available.');assert.equal(f.$('payment-status').textContent.includes('secret'),false);assert.equal(f.$('payment-check').disabled,false);assert.equal(f.$('payment-claim').hidden,true);assert.equal(f.$('payment-open').hidden,true);assert.equal(f.$('payment-hash').textContent,'0x'+'1'.repeat(64));assert.equal(f.$('payment-receipt').textContent.includes('Confirmed transaction'),false);
});
test('session expiry closes account while keeping independent receipt checking available',async t=>{
 const f=setup(t,{sessionMs:5});await tick();f.$('payment-open').click();await tick();await new Promise(r=>setTimeout(r,15));assert.equal(f.calls.close,1);assert.equal(f.$('payment-claim').hidden,true);assert.equal(f.$('payment-check').disabled,false);
});
