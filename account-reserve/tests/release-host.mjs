import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHostedClient} from '../release/host-worker.mjs';
const a='https://primary.example.invalid',b='https://reserve.example.invalid';
const profile=()=>({format:'account-reserve-public/v1',enabled:true,chainId:10143,contractAddress:'0x1111111111111111111111111111111111111111',expectedRuntimeCodeHash:'0x'+'1'.repeat(64),issuer:'0x2222222222222222222222222222222222222222',primaryOrigin:a,recoveryOrigin:b,namespace:'account-reserve-'+'a'.repeat(32),expiresAt:new Date(Date.now()+60000).toISOString(),physicalPasskeysVerified:false,rpcUrls:['https://testnet-rpc.monad.xyz','https://rpc-testnet.monadinfra.com'],claim:{rightId:'1',gasLimit:'300000',maxFeePerGasWei:'200000000000',maxPriorityFeePerGasWei:'2000000000',valueWei:'0'}});
const assets={'/index.html':{base64:Buffer.from('<html>Reference app</html>').toString('base64'),contentType:'text/html; charset=utf-8'},'/assets/main.js':{base64:Buffer.from('/* static public code */').toString('base64'),contentType:'text/javascript'}};
const worker=(role,p=profile())=>createHostedClient({profile:p,role,assets,redisOrigin:'https://redis.example.invalid'});
const bindings={RESERVE_REDIS_REST_URL:'https://redis.example.invalid',RESERVE_REDIS_REST_TOKEN:'NEVER_PUBLISH_THIS',RESERVE_ENROLLMENT_TICKET_HASHES:'[]'};
test('unconfigured hosted clients fail closed without any network dependency',async()=>{
  for(const role of ['primary','recovery'])assert.equal((await worker(role,{enabled:false}).fetch(new Request(a))).status,503);
});
test('public configuration excludes runtime secrets and synthetic/admin routes',async()=>{
  const w=worker('recovery');
  assert.equal((await w.fetch(new Request(b+'/api/config'),{})).status,503);
  const result=await w.fetch(new Request(b+'/api/config'),bindings);
  const text=await result.text();assert.equal(result.status,200);assert.equal(text.includes('NEVER_PUBLISH_THIS'),false);assert.equal(text.includes('secret-test-setting'),false);assert.equal(JSON.parse(text).hosted,true);
  for(const path of ['/api/synthetic/credential','/api/prepare-right','/control/primary','/rpc'])assert.equal((await w.fetch(new Request(b+path,{method:'POST'}))).status,405);
  assert.equal((await w.fetch(new Request('https://wrong.example.invalid/api/config'))).status,421);
});
test('original-client outage blocks original assets/API while independent B stays available',async()=>{
  const p=profile(),wa=worker('primary',p),wb=worker('recovery',p),env={...bindings,ACCOUNT_RESERVE_PRIMARY_OFFLINE:'true'};
  for(const path of ['/','/assets/main.js','/api/config'])assert.equal((await wa.fetch(new Request(a+path),env)).status,503);
  for(const path of ['/','/assets/main.js','/api/config'])assert.equal((await wb.fetch(new Request(b+path),env)).status,200);
  assert.equal((await wb.fetch(new Request(b+'/api/reserve/'+'a'.repeat(43)),{})).status,503);
});
test('static responses constrain resource origins and deny traversal or unknown files',async()=>{
  const w=worker('primary');const res=await w.fetch(new Request(a));
  assert.equal(await res.text(),'<html>Reference app</html>');assert.equal(res.headers.get('cache-control'),'no-store');
  const csp=res.headers.get('content-security-policy');assert.ok(csp.includes("script-src 'self'"));assert.ok(csp.includes('https://testnet-rpc.monad.xyz'));assert.equal(csp.includes('*'),false);
  for(const path of ['/server.mjs','/.env','/assets/unknown.js'])assert.equal((await w.fetch(new Request(a+path))).status,404);
});
test('epoch-zero module startup defers profile and storage validation until request time',async t=>{
  const p=profile(),requestTime=Date.now();let clock=0,clockReads=0;
  t.mock.method(Date,'now',()=>{clockReads++;return clock;});
  const wa=worker('primary',p),wb=worker('recovery',p);
  assert.equal(clockReads,0,'Worker construction must not consult a request clock');
  clock=requestTime;
  for(const [w,origin] of [[wa,a],[wb,b]]){
    assert.equal((await w.fetch(new Request(origin+'/'),bindings)).status,200);
    const config=await w.fetch(new Request(origin+'/api/config'),bindings);
    assert.equal(config.status,200);assert.equal((await config.json()).releaseProfile.expiresAt,p.expiresAt);
  }
});
test('request validation fails closed for invalid profiles and preserves the exact45day bound',async t=>{
  const now=Date.now(),p=profile();t.mock.method(Date,'now',()=>now);
  for(const changed of [{chainId:143},{primaryOrigin:'http://primary.example.invalid'},{arbitraryField:true},{expiresAt:new Date(now+45*86400000+1).toISOString()}]){
    for(const role of ['primary','recovery']){
      const res=await worker(role,{...p,...changed}).fetch(new Request((role==='primary'?a:b)+'/api/config'),bindings);
      assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:'ACCOUNT_RESERVE_NOT_RELEASED'});
    }
  }
  const boundary={...p,expiresAt:new Date(now+45*86400000).toISOString()};
  for(const [role,origin] of [['primary',a],['recovery',b]])assert.equal((await worker(role,boundary).fetch(new Request(origin+'/api/config'),bindings)).status,200);
});
test('expiry blocks both first and later requests including a cached reserve handler',async t=>{
  const p=profile();let clock=Date.parse(p.expiresAt)-1;
  t.mock.method(Date,'now',()=>clock);
  const wa=worker('primary',p),wb=worker('recovery',p);
  assert.equal((await wa.fetch(new Request(a+'/api/config'),bindings)).status,200);
  assert.equal((await wb.fetch(new Request(b+'/api/config'),bindings)).status,200);
  clock=Date.parse(p.expiresAt);
  for(const [w,origin] of [[wa,a],[wb,b],[worker('primary',p),a],[worker('recovery',p),b]]){
    for(const path of ['/','/api/config','/api/reserve/'+'a'.repeat(43)]){
      const res=await w.fetch(new Request(origin+path),bindings);
      assert.equal(res.status,410);assert.deepEqual(await res.json(),{error:'DEMONSTRATION_ENDED'});
    }
  }
});
