import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPaymentSiteHandler} from '../payments/site-handler.mjs';
const origin='https://primary.example.test';
const profile={chainId:10143,address:'0x1111111111111111111111111111111111111111',owner:'0x2222222222222222222222222222222222222222',issuer:'0x3333333333333333333333333333333333333333',expectedRuntimeCodeHash:'0x'+'ab'.repeat(32),expiresAt:'2026-10-12T06:00:00.000Z',claims:[{rightId:'1',amount:'10000000000000000',nonce:1},{rightId:'2',amount:'10000000000000000',nonce:2}]};
const assets={'/payments/index.html':{contentType:'text/html; charset=utf-8',base64:Buffer.from('<main>Payments</main>').toString('base64')}};
test('additive payment route leaves every legacy request and environment untouched',async()=>{
 let seen;const env={sentinel:'preserved'},ctx={};const legacy={fetch(...args){seen=args;return new Response('legacy');}};
 const worker=createPaymentSiteHandler({legacy,origin,role:'primary',profile,assets});
 for(const path of ['/','/api/config','/api/reserve','/assets/old.js','/payments-unrelated']){const req=new Request(origin+path,{method:path==='/api/reserve'?'POST':'GET'});assert.equal(await(await worker.fetch(req,env,ctx)).text(),'legacy');assert.deepEqual(seen,[req,env,ctx]);}
});
test('payments are same-origin read-only and honor original-app outage',async()=>{
 const worker=createPaymentSiteHandler({legacy:{fetch(){throw Error('unexpected');}},origin,role:'primary',profile,assets});
 assert.equal((await worker.fetch(new Request(origin+'/payments/'),{ACCOUNT_RESERVE_PRIMARY_OFFLINE:'true'})).status,503);
 assert.equal((await worker.fetch(new Request('https://other.example.test/payments/'))).status,404);
 assert.equal((await worker.fetch(new Request(origin+'/payments/',{method:'POST'}))).status,405);
 const r=await worker.fetch(new Request(origin+'/payments/'));assert.equal(r.status,200);assert.equal(await r.text(),'<main>Payments</main>');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal(await(await worker.fetch(new Request(origin+'/payments/',{method:'HEAD'}))).text(),'');
 assert.equal((await worker.fetch(new Request(origin+'/payments/assets/missing.js'))).status,404);
 const p=await(await worker.fetch(new Request(origin+'/payments/profile.json'))).json();assert.equal(p.claims[1].rightId,'2');assert.equal(p.owner,profile.owner);
});
test('recovery stays available with primary outage flag; unknown asset routes rejected',async()=>{
 const worker=createPaymentSiteHandler({legacy:{fetch(){}},origin,role:'recovery',profile,assets});
 assert.equal((await worker.fetch(new Request(origin+'/payments/'),{ACCOUNT_RESERVE_PRIMARY_OFFLINE:'true'})).status,200);
 assert.throws(()=>createPaymentSiteHandler({legacy:{fetch(){}},origin,role:'primary',profile,assets:{'/api/config':assets['/payments/index.html']}}),/PAYMENT_ASSET_INVALID/);
});
