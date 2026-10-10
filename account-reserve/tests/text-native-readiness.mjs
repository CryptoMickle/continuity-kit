import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcpServer } from 'node:net';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { initializeNativeOperator, readNativeOperatorState } from '../text-native/operator-state.mjs';
import { installedNativeFixture } from './native-installed-fixture.mjs';
import { startNativeHost } from '../text-native/native-host.mjs';
import { startOperatorHost } from '../text-native/operator-runtime/host.mjs';
import { startReplicaGateway } from '../text-native/operator-runtime/replica-gateway.mjs';
import { openStore } from '../text-native/operator-runtime/store.mjs';
import { runtimeProfile } from '../text-native/operator.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const installed = await installedNativeFixture();
after(()=>installed.close());
const { checkNativeOperator } = await import(pathToFileURL(join(installed.directory,'operator-readiness.mjs')));
async function freePorts(count) {
  const held = [];
  try {
    for (let index = 0; index < count; index++) { const server = tcpServer(); await new Promise((done,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',done); }); held.push(server); }
    return held.map(server => server.address().port);
  } finally { await Promise.all(held.map(server => new Promise(done => server.close(done)))); }
}
async function fixtures(t, { secondRecord = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-readiness-')), state = join(directory,'private-state'), out = join(directory,'dist');
  t.after(() => rm(directory,{recursive:true,force:true}));
  const [primary,recovery,gateway,alpha,beta] = await freePorts(5);
  const profile = { version:1, appId:'native-readiness-test-v1', primaryOrigin:'https://writer.native.test', recoveryOrigin:'https://reserve.native.test', recoveryRpId:'reserve.native.test', expiresAt:new Date(Date.now()+3600000).toISOString(), replicas:[{id:'alpha',basePath:'/api/replicas/alpha/reserve'},{id:'beta',basePath:'/api/replicas/beta/reserve'}] };
  const ports = { primary,recovery,gateway,replicas:[{id:'alpha',port:alpha},{id:'beta',port:beta}] };
  await initializeNativeOperator({profile,state,ports});
  const saved = await readNativeOperatorState({profile,state}), services = new Map();
  const paths = saved.databasePaths;
  for (const [index,item] of paths.entries()) {
    if (index === 1 && !secondRecord) continue;
    const store = openStore(item.database,runtimeProfile(profile));
    try { const token = hash('disposable-test-grant-'+index); store.issue(token); const bytes=Buffer.from(JSON.stringify({ciphertext:Buffer.alloc(48,41+index).toString('base64url'),format:'account-continuity/text-reserve-v1/index',nonce:randomBytes(12).toString('base64url')})); store.putIfAbsent(randomBytes(32).toString('base64url'),bytes,token); }
    finally { store.close(); }
  }
  const html = '<!doctype html><html><script type="module" src="/assets/index-12345678.js"></script></html>', js='export const fixture = true;';
  const assetFiles=['index.html','assets/index-12345678.js'], assetSha256={'index.html':hash(html),'assets/index-12345678.js':hash(js)};
  for (const role of ['primary','recovery']) {
    await mkdir(join(out,role,'assets'),{recursive:true});
    await writeFile(join(out,role,'index.html'),html); await writeFile(join(out,role,'assets/index-12345678.js'),js);
    await writeFile(join(out,role,'continuity-config.json'),JSON.stringify({profile,role}));
  }
  await writeFile(join(out,'build-report.json'),JSON.stringify({version:1,mode:'native',nativeAssetsOnly:true,profileSha256:hash(JSON.stringify(profile)),assetFiles,assetSha256}));
  const closeOne = async name => { const service=services.get(name); if(service){services.delete(name);await service.close();} };
  const put = (name,service) => { services.set(name,service);return service; };
  const close = async () => { for(const name of [...services.keys()].reverse())await closeOne(name); await rm(directory,{recursive:true,force:true}); };
  try {
    for(const [index,item] of paths.entries()) put(item.id,await startOperatorHost({configuration:runtimeProfile(profile),database:item.database,invitationFile:item.invitationFile,port:ports.replicas[index].port}));
    put('gateway',await startReplicaGateway({configuration:saved.gatewayConfiguration,port:gateway}));
    put('primary',await startNativeHost({profile,role:'primary',assets:join(out,'primary'),port:primary}));
    put('recovery',await startNativeHost({profile,role:'recovery',assets:join(out,'recovery'),port:recovery,gatewayPort:gateway}));
    return {profile,state,out,ports,paths,saved,put,closeOne,close};
  } catch(error){await close();throw error;}
}
async function substitute(port,handler) {
  const server=createServer(handler);
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done)});
  return {close:()=>new Promise(done=>{server.close(done);server.closeAllConnections()})};
}
function config(profile) {return {synthetic:false,operatorHosted:true,enrollmentRequiresInvitation:true,role:'recovery',originalOrigin:profile.primaryOrigin,recoveryOrigin:profile.recoveryOrigin,expiresAt:profile.expiresAt,apps:[{id:'text',label:'Text reserve',config:{appId:profile.appId,recoveryOrigin:profile.recoveryOrigin,recoveryRpId:profile.recoveryRpId}}]};}

test('readiness checks actual direct/gateway/B reads without modifying databases or proving native recovery',async t=>{
  const f=await fixtures(t);
  try {
    const before=await Promise.all(f.paths.map(x=>readFile(x.database)));
    const result=await checkNativeOperator(f);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.deepEqual(result.checks.filter(x=>x.name.endsWith('read path')).map(x=>x.result),['storedReadMatched','emptyRouteReachable']);
    assert.equal(result.readOnly,true);assert.equal(result.grantsIssued,false);assert.equal(result.targetIdentityVerified,false);assert.equal(result.physicalPasskeyVerified,false);assert.equal(result.cryptographicRecoveryVerified,false);
    for(const [i,item]of f.paths.entries())assert.deepEqual(await readFile(item.database),before[i]);
    assert.doesNotMatch(JSON.stringify(result),/ciphertext|enrollmentToken|invitationFile|databasePaths/);
  } finally {await f.close();}
});
test('wrong store profile stops before probing stored records',async t=>{
  const f=await fixtures(t),calls=[];
  try {
    await f.closeOne('alpha'); f.put('alpha',await substitute(f.ports.replicas[0].port,(req,res)=>{calls.push([req.method,req.url]);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(config({...f.profile,appId:'wrong-app'})))}));
    const result=await checkNativeOperator(f);assert.equal(result.ok,false);assert.deepEqual(calls,[['GET','/api/config']]);
    assert.ok(!result.checks.some(x=>x.name.endsWith('read path')));assert.equal(result.checks.find(x=>x.name==='alpha store profile').code,'OPERATOR_PROFILE_MISMATCH');
  } finally {await f.close();}
});
test('swapped gateway stores fail a private stored-response comparison without exposing the locator',async t=>{
  const f=await fixtures(t,{secondRecord:true});
  try {
    await f.closeOne('gateway');
    f.put('gateway',await startReplicaGateway({configuration:{recoveryOrigin:f.profile.recoveryOrigin,replicas:[{id:'alpha',port:f.ports.replicas[1].port},{id:'beta',port:f.ports.replicas[0].port}]},port:f.ports.gateway}));
    const result=await checkNativeOperator(f);assert.equal(result.ok,false);
    assert.equal(result.checks.find(x=>x.name==='alpha read path').code,'STORED_READ_MISMATCH');
    assert.ok(result.checks.filter(x=>x.name.endsWith('read path')).every(x=>!x.ok));
    assert.doesNotMatch(JSON.stringify(result),/[A-Za-z0-9_-]{43}/);
  } finally {await f.close();}
});
test('untrusted oversized, redirected, compressed, broken and secret-bearing replies stay bounded and private',async t=>{
  const f=await fixtures(t),sentinel='SECRET_FROM_UNTRUSTED_STORE_DO_NOT_PRINT';
  try {
    const cases=['declared','chunked','redirect','compressed','malformed','disconnect'];
    for(const kind of cases){
      await f.closeOne('alpha');const calls=[];
      f.put('alpha',await substitute(f.ports.replicas[0].port,(req,res)=>{
        calls.push({method:req.method,authorization:req.headers.authorization,path:req.url});
        if(req.url==='/api/config'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(config(f.profile)));return;}
        if(kind==='declared'){res.writeHead(200,{'content-type':'application/json','content-length':999999});res.end();}
        if(kind==='chunked'){res.writeHead(200,{'content-type':'application/json'});res.end(Buffer.alloc(90000,65));}
        if(kind==='redirect'){res.writeHead(302,{'content-type':'application/json',location:'https://untrusted.invalid/'+sentinel});res.end();}
        if(kind==='compressed'){res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});res.end(sentinel);}
        if(kind==='malformed'){res.writeHead(200,{'content-type':'application/json'});res.end(sentinel);}
        if(kind==='disconnect'){res.writeHead(200,{'content-type':'application/json','content-length':10000});res.write('{');setImmediate(()=>res.destroy());}
      }));
      const start=Date.now(),result=await checkNativeOperator(f);assert.equal(result.ok,false,kind);assert.ok(Date.now()-start<2000,kind);
      assert.ok(calls.every(x=>x.method==='GET'&&x.authorization===undefined));assert.doesNotMatch(JSON.stringify(result),new RegExp(sentinel));
      assert.equal(result.checks.find(x=>x.name==='alpha read path').ok,false,kind);
    }
  } finally {await f.close();}
});
test('pre-aborted readiness performs no mutation and fails with fixed safe diagnostics',async t=>{
  const f=await fixtures(t);
  try {const controller=new AbortController();controller.abort();const before=await Promise.all(f.paths.map(x=>readFile(x.database)));const result=await checkNativeOperator({...f,signal:controller.signal});assert.equal(result.ok,false);for(const[i,item]of f.paths.entries())assert.deepEqual(await readFile(item.database),before[i]);}
  finally{await f.close();}
});
