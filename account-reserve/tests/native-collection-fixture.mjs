// Test-only installed collection client. Never copied into native deployable assets.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';

export function transport({ port, origin, readOnly = false, calls }) {
  return async (path, init = {}) => {
    const method = init.method ?? 'GET', route = /^\/api\/replicas\/(alpha|beta)\/reserve\/[A-Za-z0-9_-]{43}$/.exec(path);
    assert.ok(route || path === '/continuity-config.json' || path === '/'); assert.ok(method === 'GET' || !readOnly && method === 'PUT' && route);
    const headers = new Headers(init.headers); if (method === 'GET') assert.equal(headers.has('authorization'), false);
    calls.push({ id: route?.[1] ?? (path === '/' ? 'html' : 'configuration'), method }); const body = init.body === undefined ? undefined : Buffer.from(init.body);
    return new Promise((done, reject) => {
      let response, settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; response?.destroy(); req.destroy(); error ? reject(error) : done(value); };
      const req = request({ hostname: '127.0.0.1', port, path, method, agent: false,
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init.signal ? [init.signal] : [])]),
        headers: { host: new URL(origin).host, origin, connection: 'close', ...(body ? { 'content-type': 'application/json', 'content-length': body.length, authorization: headers.get('authorization') } : {}) } }, res => {
        response = res; let size = 0; const chunks = [];
        if (res.headers['content-encoding'] || res.statusCode >= 300 && res.statusCode < 400) return finish(Error('RESPONSE_REJECTED'));
        res.on('data', bytes => { if (settled) return; size += bytes.length; if (size > 87440) finish(Error('RESPONSE_LIMIT')); else chunks.push(bytes); });
        res.once('end', () => { if (!settled) finish(undefined, new Response(Buffer.concat(chunks, size), { status: res.statusCode, headers: { 'content-type': res.headers['content-type'] ?? '' } })); });
        res.once('error', () => finish(Error('TEST_IO_FAILED'))); res.once('aborted', () => finish(Error('TEST_IO_FAILED'))); res.once('close', () => { if (!res.complete) finish(Error('TEST_IO_FAILED')); });
      });
      req.once('error', () => finish(Error('TEST_IO_FAILED'))); req.end(body);
    });
  };
}
export function synthetic({ key, credentialId, counters, outputs }) {
  const response = options => { const value = { credentialId: new Uint8Array(credentialId), prfOutput: new Uint8Array(createHmac('sha256', key).update(options.prfSalt).digest()) }; outputs.push(value); return value; };
  return { async createCredential(options) { counters.create++; return { ...response(options), prfEnabled: true }; },
    async getCredential(options) { counters.get++; assert.equal(options.userVerification, 'required'); return response(options); } };
}
const recoverySource = `
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createHmac,webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {recoverTextReservesFromReplicas} from '@continuitykit/account-reserve/text-reserve';
import {createReserveHttpStore} from '@continuitykit/account-reserve/http-store';
import {validateNativeEnvironment,nativeApps} from './profile.mjs';
import {exportText} from './adapter.mjs';
import {mountNativeCollection} from './collection-main.mjs';
const transport=${transport.toString()},synthetic=${synthetic.toString()};
process.once('message',async message=>{
 let key,credentialId,view,window;const counters={create:0,get:0},outputs=[],requests=[];let nativeCalls=0,forbiddenNetwork=0,persistence=0,uiExports=false;
 const native=()=>{nativeCalls++;throw Error('NATIVE_FORBIDDEN');};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{credentials:{get:native,create:native}}});
 globalThis.fetch=()=>{forbiddenNetwork++;throw Error('NETWORK_OUTSIDE_B_FORBIDDEN');};
 try{
  assert.deepEqual(Object.keys(message).sort(),['credentialId','key','origin','output','port',...(message.ui?['ui','jsdomPath']:[])].sort());
  key=Buffer.from(message.key,'base64url');credentialId=Buffer.from(message.credentialId,'base64url');message.key=undefined;message.credentialId=undefined;
  const fetcher=transport({port:message.port,origin:message.origin,readOnly:true,calls:requests});
  const response=await fetcher('/continuity-config.json');assert.equal(response.status,200);
  const env=validateNativeEnvironment(await response.json(),message.origin);assert.equal(env.role,'recovery');assert.equal(env.profile.version,2);
  globalThis.location={origin:message.origin};
  const client=synthetic({key,credentialId,counters,outputs});client.createCredential=()=>{counters.create++;throw Error('NEW_KEY_FORBIDDEN');};
  let results;
  if(message.ui){
   const {JSDOM}=createRequire(import.meta.url)(message.jsdomPath);
   const html=await fetcher('/');assert.equal(html.status,200);
   const dom=new JSDOM(await html.text(),{url:message.origin,runScripts:'outside-only'});window=dom.window;
   Object.defineProperty(window,'isSecureContext',{value:true});Object.defineProperty(window,'crypto',{value:webcrypto});window.PublicKeyCredential=class{};
   Object.defineProperty(window.navigator,'credentials',{value:{get:native,create:native}});
   window.AbortController=AbortController;window.AbortSignal=AbortSignal;window.Blob=Blob;
   window.Storage.prototype.setItem=()=>{persistence++;throw Error('PERSISTENCE_FORBIDDEN');};
   const urls=new Set(),blobs=[],promises=[],$=id=>window.document.getElementById(id);
   window.URL.createObjectURL=blob=>{blobs.push(blob);const url='blob:test-'+blobs.length;urls.add(url);return url;};window.URL.revokeObjectURL=url=>urls.delete(url);window.HTMLAnchorElement.prototype.click=()=>{};
   view=mountNativeCollection(window.document,window,{environment:env,fetcher,recover(options){assert.equal(Object.hasOwn(options,'webAuthnClient'),false);const value=recoverTextReservesFromReplicas({...options,webAuthnClient:client});promises.push(value);return value;}});
   await view.ready;assert.equal(counters.get,0);$('recover').click();assert.equal(promises.length,1);assert.equal(counters.get,1);results=await promises[0];await new Promise(done=>setImmediate(done));
   for(const [index,result]of results.entries()){
    const id=env.profile.apps[index].id;assert.equal($('card-'+id).dataset.state,result.status);
    if(result.status==='recovered'){
     assert.equal($('draft-'+id).value,result.reserve.text.replaceAll('\\r\\n','\\n').replaceAll('\\r','\\n'));
     for(const format of ['txt','json']){$('export-'+id+'-'+format).click();await writeFile(join(message.output,'app-'+index+'.'+format),Buffer.from(await blobs.at(-1).arrayBuffer()),{flag:'wx',mode:0o600});}
    }else{
     assert.equal($('draft-'+id).value,'');const length=blobs.length;
     for(const format of ['txt','json']){assert.equal($('export-'+id+'-'+format).hidden,true);$('export-'+id+'-'+format).dispatchEvent(new window.Event('click'));}assert.equal(blobs.length,length);
    }
   }
   view.dispose();assert.equal(urls.size,0);for(const app of env.profile.apps)assert.equal($('draft-'+app.id).value,'');uiExports=true;
  }else{
   const replicas=env.profile.replicas.map(({id,basePath})=>({id,store:createReserveHttpStore({fetcher,basePath,timeoutMs:1500})}));
   const pending=recoverTextReservesFromReplicas({apps:nativeApps(env.profile).map(({config})=>({config,replicas})),webAuthnClient:client});
   assert.equal(counters.get,1);results=await pending;
   for(const [index,result]of results.entries())if(result.status==='recovered')for(const format of ['txt','json'])await writeFile(join(message.output,'app-'+index+'.'+format),exportText({getText:()=>result.reserve.text},format),{flag:'wx',mode:0o600});
  }
  assert.ok(outputs.every(output=>output.prfOutput.every(byte=>byte===0)));
  process.send({ok:true,results:results.map(({appId,status,code,replicas})=>({appId,status,...(code?{code}:{}),replicas})),counters,requests,nativeCalls,forbiddenNetwork,persistence,prfErased:true,uiExports});
 }catch(error){process.send({ok:false,code:/^[A-Z_]+$/.test(error?.code??'')?error.code:'FRESH_NATIVE_COLLECTION_TEST_FAILED'});}
 finally{view?.dispose();window?.close();key?.fill(0);credentialId?.fill(0);process.disconnect();}
});
`;
export async function fresh(directory, message) {
  const child = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', recoverySource], { cwd: directory, env: { PATH: process.env.PATH ?? '', NODE_PATH: '', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return new Promise((done, reject) => {
    let result, failed = false, escalation;
    const timer = setTimeout(() => { failed = true; child.kill(); escalation = setTimeout(() => child.kill('SIGKILL'), 2000); }, 20000);
    child.on('message', value => { result = value; }); child.once('error', () => { failed = true; });
    child.once('close', code => { clearTimeout(timer); clearTimeout(escalation); failed || code || !result ? reject(Error('FRESH_PROCESS_FAILED')) : done({ ...result, pid: child.pid }); });
    child.send(message, error => { if (error) { failed = true; child.kill('SIGKILL'); } });
  });
}
export async function freePorts(count) {
  const servers = [];
  try { for (let index = 0; index < count; index++) { const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }); servers.push(server); } return servers.map(server => server.address().port); }
  finally { await Promise.all(servers.map(server => new Promise(done => server.close(done)))); }
}
export async function killOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done, reject) => { const timer = setTimeout(() => reject(Error('OWNED_CHILD_EXIT_TIMEOUT')), 5000); child.once('close', () => { clearTimeout(timer); done(); }); child.kill('SIGKILL'); });
}
