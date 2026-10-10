import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, webcrypto } from 'node:crypto';
import { validateNativeEnvironment, nativeApps, nativeAppProfile, parseNativeGrants } from '../text-native/profile.mjs';
import { prismBackdrop, prismSculpture } from '../starter/prism-art.mjs';
import { TEXT_PROTOCOL, validateText } from '../sdk/text-reserve.mjs';

const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const html = await readFile(new URL('../text-native/collection-index.html', import.meta.url), 'utf8');
const originalSource = await readFile(new URL('../text-native/collection-main.mjs', import.meta.url), 'utf8');
const adapterSource = (await readFile(new URL('../text-native/adapter.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ');
const adapter = new Function('validateText', adapterSource + '\nreturn {captureText,restoreText,exportText,textareaAdapter};')(validateText);
const source = originalSource.split('// A Node consumer')[0].replace(/^import .*;\n/gm, '').replace('export function mountNativeCollection', 'function mountNativeCollection');
const dependencies = { TEXT_PROTOCOL, validateText, validateNativeEnvironment, nativeApps, nativeAppProfile, parseNativeGrants, prismBackdrop, prismSculpture, ...adapter };
const mount = new Function(...Object.keys(dependencies), source + '\nreturn mountNativeCollection;')(...Object.values(dependencies));
const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const texts = ['\ufeffText draft — ÆØÅ 🦊\r\nPrivate line.\r\n', '# Markdown\n\n<img src=x onerror="throw 1">\n<script>window.bad=true</script>'];
const diagnostic = (id, status, code) => ({ id, stage: 'verify', status, ...(code ? { code } : {}) });

async function fixture(t, { role = 'recovery', enrollment = false, lifetime = 3600000, url = '', secure = true, mutation, count = 2, storeDelay = 0 } = {}) {
  let time = Date.now(), sequence = 0;
  const ids = ['alpha', 'beta', 'gamma'].slice(0, count);
  const profile = { version: 2, apps: [{id:'textarea',label:'Text draft',appId:'native-text-v1'}, {id:'markdown',label:'Markdown draft',appId:'native-markdown-v1'}], primaryOrigin:'https://writer.example.test', recoveryOrigin:'https://reserve.example.test', recoveryRpId:'reserve.example.test', expiresAt: new Date(time + lifetime).toISOString(), replicas:ids.map(id => ({id,basePath:'/api/replicas/'+id+'/reserve'})) };
  const environment = mutation ? mutation({profile,role}) : {profile,role};
  const dom = new JSDOM(html, { url: (role === 'primary' ? profile.primaryOrigin : profile.recoveryOrigin) + '/' + url, runScripts:'outside-only' });
  const {window}=dom, timers=new Map(), blobs=[], revoked=[], pending=[], prepared=deferred(), setupDone=deferred();
  const calls={recover:[],stores:[],fetch:[],prepare:[],setup:[],receiver:[],dispose:0,native:0,probes:0,persistence:0,clears:0,cancel:0};
  const $=id=>window.document.getElementById(id);
  Object.defineProperty(window,'isSecureContext',{value:secure}); Object.defineProperty(window,'crypto',{value:webcrypto});
  window.PublicKeyCredential=class{static isUserVerifyingPlatformAuthenticatorAvailable(){calls.probes++;throw Error('PROBE_FORBIDDEN');}};
  window.AbortController=AbortController; window.AbortSignal=AbortSignal; window.Blob=Blob;
  window.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:collection-'+blobs.length;}; window.URL.revokeObjectURL=url=>revoked.push(url);
  window.HTMLAnchorElement.prototype.click=()=>{};
  window.setTimeout=(fn,milliseconds)=>{const id=++sequence;timers.set(id,{fn,due:time+milliseconds});return id;}; window.clearTimeout=id=>timers.delete(id);
  window.Storage.prototype.setItem=()=>{calls.persistence++;throw Error('PERSISTENCE_FORBIDDEN');};
  Object.defineProperty(window.navigator,'credentials',{value:{create(){calls.native++;throw Error('NATIVE_FORBIDDEN');},get(){calls.native++;throw Error('NATIVE_FORBIDDEN');}}});
  const options={ environment, now:()=>time,
    fetcher:async(path,options)=>{calls.fetch.push({path,options});throw Error('UNEXPECTED_FETCH');},
    recover(value){calls.recover.push(value);assert.equal(Object.hasOwn(value,'webAuthnClient'),false);const item=deferred();pending.push(item);return item.promise;},
    makeStore(value){time+=storeDelay;calls.stores.push(value);return {get(){throw Error('TEST_RECOVERY_OWNS_READS');},clearEnrollmentCapability(){calls.clears++;}};},
    startSetup(value){calls.setup.push(value);return{completion:setupDone.promise,cancel(){calls.cancel++;}};},
    makeReceiver(value){calls.receiver.push(value);return{isEnrollment:enrollment,prepare(value){calls.prepare.push(value);assert.equal(Object.hasOwn(value,'webAuthnClient'),false);return prepared.promise;},dispose(){calls.dispose++;}};},
  };
  let instance;try{instance=mount(window.document,window,options);}catch(error){window.close();throw error;}
  await instance.ready;t.after(()=>{instance.dispose();window.close();});
  const diagnostics=()=>ids.map(id=>diagnostic(id,'verified'));
  const results=(statuses=['recovered','recovered'])=>profile.apps.map((app,index)=>statuses[index]==='recovered'
    ?{appId:app.appId,status:'recovered',reserve:{protocol:TEXT_PROTOCOL,locator:Buffer.alloc(32,index+1).toString('base64url'),text:texts[index],textDigest:createHash('sha256').update(texts[index]).digest('hex')},replicas:diagnostics()}
    :{appId:app.appId,status:statuses[index],code:statuses[index]==='missing'?'RESERVE_MISSING':'REPLICA_RECOVERY_FAILED',replicas:ids.map(id=>diagnostic(id,statuses[index],{missing:'RESERVE_MISSING',unavailable:'STORE_UNAVAILABLE',rejected:'RECORD_INVALID'}[statuses[index]]))});
  const grant=(app='textarea',lifetime=60000)=>({format:'continuitykit/native-replica-grants/v1',appId:profile.apps.find(value=>value.id===app).appId,recoveryOrigin:profile.recoveryOrigin,replicas:ids.map((id,index)=>({id,enrollmentToken:Buffer.alloc(32,index+1).toString('base64url'),expiresAt:new Date(Math.min(time+lifetime,Date.parse(profile.expiresAt))).toISOString()}))});
  return {$,window,calls,environment,profile,pending,prepared,setupDone,blobs,revoked,instance,results,grant,diagnostics,
    check(value=grant()){ $('upload-permission').value=typeof value==='string'?value:JSON.stringify(value);$('check-permission').click(); },
    advance(milliseconds){time+=milliseconds;for(let round=0;round<20;round++){const due=[...timers].filter(([,value])=>value.due<=time);if(!due.length)break;for(const[id,value]of due){timers.delete(id);value.fn();}}},
  };
}

test('native-only entrypoint loads without discovery, credential prompts, grants, storage, network or failure controls',async t=>{
  assert.doesNotMatch(originalSource,/syntheticClient|webAuthnClient\s*:|\/api\/(?:synthetic|replica-control|replica-enrollment|primary)|localStorage|sessionStorage/);
  for(const role of ['primary','recovery']){const f=await fixture(t,{role});assert.equal(f.calls.native+f.calls.probes+f.calls.persistence,0);assert.equal(f.calls.recover.length+f.calls.prepare.length+f.calls.fetch.length+f.calls.stores.length,0);assert.equal(f.$('tools'),null);assert.equal(f.$('enrollment').hidden,true);}
});
test('one deliberate native collection call shares read-only stores and never includes a credential override',async t=>{
 const f=await fixture(t,{count:3});f.$('recover').click();f.$('recover').dispatchEvent(new f.window.Event('click'));assert.equal(f.calls.recover.length,1);assert.equal(f.calls.stores.length,3);
 assert.equal(f.calls.recover[0].apps[0].replicas,f.calls.recover[0].apps[1].replicas);for(const store of f.calls.stores)assert.equal(Object.hasOwn(store,'enrollmentToken'),false);
 f.pending[0].resolve(f.results());await tick();assert.equal(f.$('draft-markdown').value,texts[1]);assert.equal(f.$('recover').hidden,true);
});
test('literal text and exports preserve BOM and CRLF until editing, with no save or executable markup',async t=>{
 const f=await fixture(t);f.$('recover').click();f.pending[0].resolve(f.results());await tick();assert.equal(f.window.bad,undefined);assert.equal(f.$('card-markdown').querySelector('img,script'),null);
 for(const[index,id]of ['textarea','markdown'].entries()){f.$('export-'+id+'-txt').click();assert.deepEqual(Buffer.from(await f.blobs.at(-1).arrayBuffer()),Buffer.from(texts[index]));f.$('export-'+id+'-json').click();assert.equal(JSON.parse(await f.blobs.at(-1).text()).text,texts[index]);}
 f.$('draft-textarea').value='Local correction';f.$('export-textarea-txt').click();assert.equal(await f.blobs.at(-1).text(),'Local correction');assert.equal(f.calls.fetch.length,0);
});
test('missing unavailable rejected and conflict stay app-local and never expose failed plaintext',async t=>{
 for(const status of ['missing','unavailable','rejected','conflict']){const f=await fixture(t);const values=f.results(['recovered',status==='conflict'?'recovered':status]);if(status==='conflict'){values[1]={appId:f.profile.apps[1].appId,status:'rejected',code:'REPLICA_CONFLICT',replicas:f.diagnostics()};}
 f.$('recover').click();f.pending[0].resolve(values);await tick();assert.equal(f.$('draft-markdown').value,'');assert.equal(f.$('export-markdown-txt').hidden,true);assert.equal(f.$('draft-textarea').hidden,false);if(status==='conflict')assert.match(f.$('state-markdown').textContent,/disagree/);}
});
test('invalid batch ordering, unknown replicas, impossible results and accessor payloads reject every app',async t=>{
 for(const alter of [x=>x.reverse(),x=>{x[1].replicas[0].id='foreign';return x;},x=>{x[1].reserve.protocol='other';return x;},x=>{x[1].replicas=[];return x;},x=>{Object.defineProperty(x[1],'reserve',{get(){throw Error('GETTER_INVOKED');},enumerable:true});return x;},x=>{Object.defineProperty(x,'1',{get(){throw Error('GETTER_INVOKED');},enumerable:true});return x;}]){
 const f=await fixture(t);f.$('recover').click();f.pending[0].resolve(alter(f.results()));await tick();assert.equal(f.$('draft-textarea').value,'');assert.equal(f.$('draft-markdown').value,'');assert.match(f.$('status').textContent,/could not be opened/);}
});
test('cancelled and superseded collection completions cannot restore plaintext or end a newer request',async t=>{
 const f=await fixture(t);f.$('recover').click();const first=f.calls.recover[0].signal;f.$('cancel').click();assert.equal(first.aborted,true);f.$('recover').click();f.pending[0].resolve(f.results());await tick();assert.equal(f.$('draft-textarea').value,'');assert.equal(f.$('cancel').hidden,false);f.pending[1].resolve(f.results());await tick();assert.equal(f.$('draft-markdown').value,texts[1]);
});
test('closing and pagehide erase editor backing text and revoke links; late recovery cannot resurrect',async t=>{
 const f=await fixture(t);f.$('recover').click();f.pending[0].resolve(f.results());await tick();f.$('export-textarea-txt').click();f.$('clear').click();assert.equal(f.$('draft-textarea').value,'');assert.deepEqual(f.revoked,['blob:collection-1']);f.$('recover').click();f.window.dispatchEvent(new f.window.Event('pagehide'));f.pending[1].resolve(f.results());await tick();assert.equal(f.$('draft-markdown').value,'');assert.equal(f.$('recover').disabled,true);
});
test('expiry keeps already open work exportable but blocks new reads and late authentication results',async t=>{
 const f=await fixture(t,{lifetime:1000});f.$('recover').click();f.pending[0].resolve(f.results());await tick();f.advance(1001);assert.equal(f.$('draft-textarea').disabled,false);f.$('export-textarea-txt').click();assert.deepEqual(Buffer.from(await f.blobs[0].arrayBuffer()),Buffer.from(texts[0]));f.$('clear').click();assert.equal(f.$('recover').disabled,true);
 const late=await fixture(t,{lifetime:1000});late.$('recover').click();late.advance(1001);assert.equal(late.calls.recover[0].signal.aborted,true);late.pending[0].resolve(late.results());await tick();assert.equal(late.$('draft-textarea').value,'');
});
test('unsupported browser and unknown or duplicate selectors fail before any credential activity',async t=>{
 const f=await fixture(t,{secure:false});f.$('recover').dispatchEvent(new f.window.Event('click'));assert.equal(f.calls.recover.length,0);assert.equal(f.$('recover').disabled,true);
 for(const url of ['?app=unknown','?app=textarea&app=markdown','?app=textarea&config=evil','other'])await assert.rejects(fixture(t,{url}),/NATIVE_APP_SELECTOR_INVALID/);
});
test('permission checking binds to the selected fixed app, clears input and creates no credential or store',async t=>{
 const f=await fixture(t,{enrollment:true,url:'?app=markdown',count:3});f.check(f.grant('textarea'));assert.equal(f.$('passkey-options').hidden,true);assert.equal(f.calls.prepare.length,0);f.check(f.grant('markdown'));assert.equal(f.$('upload-permission').value,'');assert.equal(f.$('passkey-options').hidden,false);assert.equal(f.calls.prepare.length+f.calls.stores.length+f.calls.fetch.length,0);assert.equal(f.calls.receiver[0].config.appId,f.profile.apps[1].appId);
});
test('existing selection stays synchronous, never creates a replacement and clears all upload capability references',async t=>{
 const f=await fixture(t,{enrollment:true,url:'?app=markdown'});f.check(f.grant('markdown'));f.$('receive-existing').click();assert.equal(f.calls.prepare.length,1);assert.equal(f.calls.prepare[0].credentialMode,'existing');assert.equal(Object.hasOwn(f.calls.prepare[0],'user'),false);f.prepared.reject(Error('CANCELLED'));await tick();assert.equal(f.calls.clears,2);assert.equal(f.$('enrollment').hidden,true);assert.equal(f.$('recover').hidden,false);f.$('receive-create').dispatchEvent(new f.window.Event('click'));assert.equal(f.calls.prepare.length,1);
});
test('first creation requires its own explicit gesture and success still requires all copies verified',async t=>{
 const f=await fixture(t,{enrollment:true,url:'?app=textarea'});f.check();assert.equal(f.calls.prepare.length,0);f.$('receive-create').click();assert.equal(f.calls.prepare[0].credentialMode,'create');assert.ok(f.calls.prepare[0].user);f.prepared.resolve({status:'ready',text:'example',independentlyVerified:true,replicas:f.diagnostics()});await tick();assert.match(f.$('status').textContent,/is prepared/);assert.equal(f.calls.clears,2);
 const bad=await fixture(t,{enrollment:true,url:'?app=textarea'});bad.check();bad.$('receive-existing').click();bad.prepared.resolve({status:'ready',text:'secret',independentlyVerified:true,replicas:[]});await tick();assert.match(bad.$('status').textContent,/stopped/);assert.equal(bad.$('draft-textarea').value,'');
});
test('changing or expiring checked permission disables both actions without touching a passkey',async t=>{
 const f=await fixture(t,{enrollment:true,url:'?app=textarea'});f.check(f.grant('textarea',1000));f.advance(1001);f.$('receive-existing').dispatchEvent(new f.window.Event('click'));assert.equal(f.calls.prepare.length,0);f.check();f.$('upload-permission').value='changed';f.$('upload-permission').dispatchEvent(new f.window.Event('input'));assert.equal(f.$('receive-existing').disabled,true);assert.equal(f.calls.native,0);
});
test('permission expiring before credential call or while pending cancels without a successful result',async t=>{
 const delayed=await fixture(t,{enrollment:true,url:'?app=textarea',storeDelay:600});delayed.check(delayed.grant('textarea',1000));delayed.$('receive-existing').click();await tick();assert.equal(delayed.calls.prepare.length,0);assert.equal(delayed.calls.clears,2);
 const f=await fixture(t,{enrollment:true,url:'?app=textarea'});f.check(f.grant('textarea',1000));f.$('receive-existing').click();f.advance(1001);assert.equal(f.calls.prepare[0].signal.aborted,true);f.prepared.resolve({status:'ready',text:'late',independentlyVerified:true,replicas:f.diagnostics()});await tick();assert.doesNotMatch(f.$('status').textContent,/is prepared/);assert.equal(f.$('draft-textarea').value,'');
});
test('cancelled preparation completion cannot interfere with a new deliberate collection read',async t=>{
 const f=await fixture(t,{enrollment:true,url:'?app=textarea'});f.check();f.$('receive-existing').click();f.$('cancel-setup').click();f.$('recover').click();assert.equal(f.calls.recover.length,1);f.prepared.resolve({status:'ready',text:'late',independentlyVerified:true,replicas:f.diagnostics()});await tick();assert.equal(f.calls.recover[0].signal.aborted,false);f.pending[0].resolve(f.results());await tick();assert.equal(f.$('draft-markdown').value,texts[1]);assert.equal(f.calls.clears,2);
});
test('setup receiver expiry closes grant entry without starting or reviving authentication',async t=>{
 const f=await fixture(t,{enrollment:true,url:'?app=textarea'});f.check();f.calls.receiver[0].onState({state:'failed'});assert.equal(f.$('enrollment').hidden,true);assert.equal(f.$('upload-permission').value,'');f.$('receive-create').dispatchEvent(new f.window.Event('click'));assert.equal(f.calls.prepare.length,0);assert.equal(f.$('recover').hidden,false);
});
test('primary handoff uses only its configured namespace and independent per-app readiness',async t=>{
 const f=await fixture(t,{role:'primary'});f.$('draft-markdown').value='Exact draft from A';f.$('prepare-markdown').click();assert.equal(f.calls.setup.length,1);assert.equal(f.calls.setup[0].text,'Exact draft from A');assert.equal(f.calls.setup[0].config.appId,f.profile.apps[1].appId);assert.equal(f.calls.setup[0].recoveryUrl,f.profile.recoveryOrigin+'/?app=markdown');f.setupDone.resolve({status:'ready',independentlyVerified:true,replicas:f.diagnostics()});await tick();assert.match(f.$('state-markdown').textContent,/independently checked/);assert.match(f.$('state-textarea').textContent,/not yet prepared/);
});


test('primary cancellation immediately restores editing and export without erasing work or accepting late readiness',async t=>{
 const f=await fixture(t,{role:'primary'});f.$('draft-markdown').value='Keep this unsaved correction';f.$('prepare-markdown').click();assert.equal(f.$('cancel-primary').hidden,false);f.$('cancel-primary').click();assert.equal(f.calls.cancel,1);assert.equal(f.calls.setup[0].signal.aborted,true);assert.equal(f.$('draft-markdown').disabled,false);assert.equal(f.$('draft-markdown').value,'Keep this unsaved correction');assert.equal(f.$('prepare-markdown').disabled,true);f.$('export-markdown-txt').click();assert.equal(await f.blobs[0].text(),'Keep this unsaved correction');f.setupDone.resolve({status:'ready',independentlyVerified:true,replicas:f.diagnostics()});await tick();assert.doesNotMatch(f.$('state-markdown').textContent,/independently checked/);assert.equal(f.calls.setup.length,1);
});
