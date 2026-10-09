import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { createWorkD1Store } from '../work-release/d1-store.mjs';
import { createHostedD1WorkClient } from '../work-release/d1-host-worker.mjs';
import { workReserveConfig } from '../work-release/profile.mjs';
import { base64url, enrollmentTicketHash, SCHEMA } from '../release/profile.mjs';
import { createReserveHttpStore } from '../release/browser-store.mjs';
import { prepareWorkReserve, recoverWorkReserve, WORK_SCHEMA } from '../sdk/work-reserve.mjs';
import { makeSdkFixture } from './sdk-fixture.mjs';

let mf, db;
const a='https://work-primary.example.invalid',b='https://work-reserve.example.invalid';
const value=()=>base64url(randomBytes(32)), ticket=()=>randomBytes(32).toString('hex');
const profile=(offset=60000)=>({version:1,enabled:true,releaseId:randomBytes(16).toString('hex'),primaryOrigin:a,recoveryOrigin:b,expiresAt:new Date(Date.now()+offset).toISOString()});
const ns=p=>'accountreserve:v1:'+p.releaseId;
const store=(p,binding=db)=>createWorkD1Store({db:binding,profile:{releaseId:p.releaseId,expires:Date.parse(p.expiresAt)}});
const worker=(role,p)=>createHostedD1WorkClient({role,profile:p,assets:{'/index.html':{base64:Buffer.from('work example').toString('base64'),contentType:'text/html'}}});
const maintenance=randomBytes(32).toString('hex');
const maintenanceHash=createHash('sha256').update(maintenance).digest('hex');
const env=hashes=>({DB:db,WORK_RETENTION_AUTH_HASH:maintenanceHash,RESERVE_ENROLLMENT_TICKET_HASHES:JSON.stringify(hashes.map(hash=>({hash,locator:'*'})))});
const put=(key,token,bytes=new Uint8Array([1,2,3]))=>new Request(b+'/api/reserve/'+key,{method:'PUT',headers:{origin:b,'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({bytes:base64url(bytes)})});
const check=token=>new Request(b+'/api/enrollment/check',{method:'POST',headers:{origin:b,'content-type':'application/json',authorization:'Bearer '+token},body:'{}'});
const cleanup=()=>new Request(b+'/api/retention/cleanup',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+maintenance},body:'{}'});
const count=async p=>(await db.prepare('SELECT count(*) AS n FROM work_records WHERE namespace=?').bind(ns(p)).first()).n;
before(async()=>{
  mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local fixture")}}',compatibilityDate:'2026-07-30',d1Databases:['DB']});
  db=await mf.getD1Database('DB');
  const sql=await readFile(new URL('../work-release/drizzle/0000_fixed_mockingbird.sql',import.meta.url),'utf8');
  for(const statement of sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
});
after(async()=>{await mf?.dispose();});

test('actual local D1: read-only enrollment checks create no records or release header',async()=>{
  const p=profile(),s=store(p),hash=ticket();
  for(let i=0;i<3;i++)assert.equal(await s.checkEnrollment(hash),'ready');
  assert.equal(await count(p),0);
  assert.equal(await db.prepare('SELECT namespace FROM work_releases WHERE namespace=?').bind(ns(p)).first(),null);
});
test('actual local D1: concurrent same ticket creates exactly once and ciphertext remains immutable',async()=>{
  const p=profile(),s=store(p),key=value(),hash=ticket(),bytes=new Uint8Array([1,2,3]);
  const result=await Promise.all(Array.from({length:8},()=>s.putIfAbsent(key,bytes,hash)));
  assert.equal(result.filter(x=>x==='created').length,1);assert.equal(result.filter(x=>x==='conflict').length,7);
  assert.deepEqual(await s.get(key),bytes);
  assert.equal(await s.putIfAbsent(value(),bytes,hash),'consumed');
  assert.equal(await s.putIfAbsent(key,new Uint8Array([9]),ticket()),'conflict');
  assert.deepEqual(await s.get(key),bytes);assert.equal(await s.checkEnrollment(hash),'denied');
});
test('actual local D1: 20 concurrent creates cannot exceed 16 records; denied grant remains unused',async()=>{
  const p=profile(),s=store(p),inputs=Array.from({length:20},()=>({key:value(),hash:ticket()}));
  const result=await Promise.all(inputs.map(x=>s.putIfAbsent(x.key,new Uint8Array([1]),x.hash)));
  assert.equal(result.filter(x=>x==='created').length,16);assert.equal(result.filter(x=>x==='limit').length,4);assert.equal(await count(p),16);
  const denied=inputs[result.indexOf('limit')];assert.equal(await db.prepare('SELECT locator FROM work_records WHERE namespace=? AND ticket_hash=?').bind(ns(p),denied.hash).first(),null);
  assert.equal(await s.checkEnrollment(ticket()),'denied');
});
test('actual local D1: failed batch rolls back header and ciphertext; a lost response is not retried',async()=>{
  const p=profile(),key=value(),hash=ticket();
  const broken={prepare:sql=>db.prepare(sql),batch:statements=>db.batch([statements[0],statements[1],db.prepare('INSERT INTO absent_fixture_table VALUES (1)')])};
  await assert.rejects(store(p,broken).putIfAbsent(key,new Uint8Array([1]),hash));
  assert.equal(await count(p),0);assert.equal(await db.prepare('SELECT namespace FROM work_releases WHERE namespace=?').bind(ns(p)).first(),null);
  let calls=0;const lost={prepare:sql=>db.prepare(sql),batch:async statements=>{calls++;await db.batch(statements);throw Error('synthetic response lost');}};
  await assert.rejects(store(p,lost).putIfAbsent(key,new Uint8Array([2]),hash));assert.equal(calls,1);
  assert.deepEqual(await store(p).get(key),new Uint8Array([2]));assert.equal(await store(p).putIfAbsent(key,new Uint8Array([3]),hash),'conflict');
});
test('actual local D1: fixed expiry cannot be changed by a new handler/profile',async()=>{
  const p=profile(),key=value();await store(p).putIfAbsent(key,new Uint8Array([1]),ticket());
  const changed={...p,expiresAt:new Date(Date.parse(p.expiresAt)+1000).toISOString()};
  await assert.rejects(store(changed).get(key),/STORE_UNAVAILABLE/);
  await assert.rejects(store(changed).putIfAbsent(value(),new Uint8Array([2]),ticket()),/STORE_WRITE_UNKNOWN/);
  assert.equal(await count(p),1);
});
test('actual local D1: database clock rejects expired reads/writes and cleanup removes only expired scope',async()=>{
  const p=profile(-1000),live=profile(),key=value(),hash=ticket();
  await db.prepare('INSERT INTO work_releases(namespace,schema,expires_ms) VALUES (?,?,?)').bind(ns(p),SCHEMA,Date.parse(p.expiresAt)).run();
  await db.prepare('INSERT INTO work_records(namespace,locator,ticket_hash,ciphertext) VALUES (?,?,?,?)').bind(ns(p),key,hash,'AQ').run();
  await store(live).putIfAbsent(value(),new Uint8Array([8]),ticket());
  const s=store(p);await assert.rejects(s.get(key),/RELEASE_EXPIRED/);assert.equal(await s.checkEnrollment(hash),'expired');
  assert.equal(await s.putIfAbsent(value(),new Uint8Array([1]),ticket()),'expired');
  assert.equal((await store(live).cleanupExpired()).state,'not_due');assert.equal(await count(live),1);
  const deleted=await s.cleanupExpired();assert.equal(deleted.state,'deleted');assert.equal(deleted.removed,1);assert.equal(deleted.remaining,0);assert.ok(deleted.purgedMs>=Date.parse(p.expiresAt));
  assert.equal((await s.cleanupExpired()).removed,0);assert.equal(await count(live),1);
  assert.equal(await s.putIfAbsent(key,new Uint8Array([2]),hash),'expired');
});
test('D1 public boundaries, changed bindings, grant revocation and sanitized errors',async()=>{
  const p=profile(),w=worker('recovery',p),token=value(),hash=await enrollmentTicketHash(token),runtime=env([hash]);
  assert.equal((await w.fetch(check(token),runtime)).status,200);assert.equal(await count(p),0);
  const key=value();assert.equal((await w.fetch(put(key,token),runtime)).status,201);
  runtime.RESERVE_ENROLLMENT_TICKET_HASHES='[]';assert.equal((await w.fetch(check(token),runtime)).status,403);
  assert.equal((await w.fetch(put(value(),token),runtime)).status,403);assert.equal((await w.fetch(new Request(b+'/api/reserve/'+key),runtime)).status,200);
  for(const role of ['primary','recovery'])for(const path of ['/rpc','/control','/api/primary','/api/status','/api/synthetic']){
    const r=await worker(role,p).fetch(new Request((role==='primary'?a:b)+path),runtime);assert.equal(r.status,404);assert.match(r.headers.get('content-security-policy'),/connect-src 'self'/);
  }
  runtime.DB={};const unavailable=await w.fetch(new Request(b+'/api/config'),runtime);assert.equal(unavailable.status,503);assert.doesNotMatch(await unavailable.text(),/SQL|token|namespace/i);
  assert.equal((await w.fetch(new Request(b+'/api/enrollment/check'),env([]))).status,405);
  assert.equal((await w.fetch(new Request('https://wrong.example.invalid/api/config'),env([]))).status,421);
});
test('D1 expired-only cleanup is usable after expiry, cannot erase live data or accept arbitrary input',async()=>{
  const p=profile(),w=worker('recovery',p);await store(p).putIfAbsent(value(),new Uint8Array([1]),ticket());
  assert.equal((await w.fetch(cleanup(),env([]))).status,409);assert.equal(await count(p),1);
  for(const change of [{body:'{"all":true}'},{headers:{'content-type':'application/json',origin:'https://evil.example.invalid'}},{url:b+'/api/retention/cleanup?expiry=0'}]){
    const r=new Request(change.url??b+'/api/retention/cleanup',{method:'POST',headers:{authorization:'Bearer '+maintenance,...(change.headers??{'content-type':'application/json'})},body:change.body??'{}'});assert.equal((await w.fetch(r,env([]))).status,403);
  }
  const expired=profile(-1000),ew=worker('recovery',expired);
  assert.equal((await ew.fetch(new Request(b+'/api/config'),env([]))).status,410);
  const r=await ew.fetch(cleanup(),env([]));assert.equal(r.status,200);assert.equal((await r.json()).remaining,0);
  assert.equal(await count(p),1);
});
test('D1 maintenance authentication fails before database access and honors key revocation',async()=>{
  const p=profile(-1000),w=worker('recovery',p);let touched=0;
  const runtime={...env([]),DB:{prepare(){touched++;throw Error('unexpected database access');},batch(){touched++;throw Error('unexpected database access');}}};
  const absent=cleanup();absent.headers.delete('authorization');
  assert.equal((await w.fetch(absent,runtime)).status,403);
  for(const value of [undefined,'bad','0'.repeat(64)])assert.equal((await w.fetch(cleanup(),{...runtime,WORK_RETENTION_AUTH_HASH:value})).status,403);
  const wrong=cleanup();wrong.headers.set('authorization','Bearer '+'1'.repeat(64));assert.equal((await w.fetch(wrong,runtime)).status,403);
  assert.equal(touched,0);
  const live=env([]);assert.equal((await w.fetch(cleanup(),live)).status,200);
  live.WORK_RETENTION_AUTH_HASH='0'.repeat(64);assert.equal((await w.fetch(cleanup(),live)).status,403);
  assert.equal((await worker('primary',profile()).fetch(new Request(a+'/api/retention/cleanup'),env([]))).status,404);
});
test('D1 SDK recovery opens exact work after original session loss, without opening account signing',async()=>{
  const p=profile(),config=workReserveConfig(p),fixture=makeSdkFixture({config}),token=value(),hash=await enrollmentTicketHash(token),runtime=env([hash]),w=worker('recovery',p),requests=[];
  const browser=(target,bindings)=>(path,init={})=>{const headers=new Headers(init.headers);if(init.method==='PUT')headers.set('origin',b);headers.set('sec-fetch-site','same-origin');requests.push(init.method??'GET');return target.fetch(new Request(new URL(path,b),{...init,headers}),bindings);};
  const work={schema:WORK_SCHEMA,title:'D1 fictional work',client:'Example client',brief:'PRIVATE_D1_TEST_BRIEF',deliverable:'An unfinished draft',nextStep:'Finish and export'};
  let recovered;
  try{
    const preparing=createReserveHttpStore({enrollmentToken:token,fetcher:browser(w,runtime)});
    const ready=await fixture.prepare({work,store:preparing},prepareWorkReserve);assert.equal(ready.independentlyVerified,true);
    const stored=await db.prepare('SELECT * FROM work_records WHERE namespace=?').bind(ns(p)).all();const text=JSON.stringify(stored.results);
    for(const hidden of [work.title,work.brief,token,fixture.policy.expectedOwner,fixture.b.credentialId])assert.equal(text.includes(hidden),false);
    fixture.closeOriginal();preparing.clearEnrollmentCapability();
    assert.equal((await worker('primary',p).fetch(new Request(a+'/'),{WORK_RESERVE_PRIMARY_OFFLINE:'true'})).status,503);
    const n=requests.length,start=fixture.stats();
    recovered=await recoverWorkReserve({config,store:createReserveHttpStore({fetcher:browser(worker('recovery',p),env([]))}),webAuthnClient:fixture.newRecoveryClient()});
    assert.deepEqual(recovered.work,work);assert.equal(recovered.owner,ready.owner);assert.equal(recovered.workDigest,ready.workDigest);assert.equal('account' in recovered,false);
    assert.equal(fixture.stats().recoveryRequests-start.recoveryRequests,1);assert.ok(requests.slice(n).every(x=>x==='GET'));
    assert.deepEqual((await db.prepare('SELECT * FROM work_records WHERE namespace=?').bind(ns(p)).all()).results,stored.results);
  }finally{recovered?.close();fixture.cleanup();}
});
