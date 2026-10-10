import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import http, { request } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installedNativeFixture } from './native-installed-fixture.mjs';

const testRequire = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
const jsdomPath = testRequire.resolve('jsdom');

function transport({ port, origin, readOnly = false, calls }) {
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
function synthetic({ key, credentialId, counters, outputs }) {
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
async function fresh(directory, message) {
  const child = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', recoverySource], { cwd: directory, env: { PATH: process.env.PATH ?? '', NODE_PATH: '', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return new Promise((done, reject) => {
    let result, failed = false, escalation;
    const timer = setTimeout(() => { failed = true; child.kill(); escalation = setTimeout(() => child.kill('SIGKILL'), 2000); }, 20000);
    child.on('message', value => { result = value; }); child.once('error', () => { failed = true; });
    child.once('close', code => { clearTimeout(timer); clearTimeout(escalation); failed || code || !result ? reject(Error('FRESH_PROCESS_FAILED')) : done({ ...result, pid: child.pid }); });
    child.send(message, error => { if (error) { failed = true; child.kill('SIGKILL'); } });
  });
}
async function freePorts(count) {
  const servers = [];
  try { for (let index = 0; index < count; index++) { const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }); servers.push(server); } return servers.map(server => server.address().port); }
  finally { await Promise.all(servers.map(server => new Promise(done => server.close(done)))); }
}
function snapshot(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return { records: db.prepare('SELECT locator,ciphertext FROM operator_records ORDER BY locator').all().map(row => ({ locator: row.locator, bytes: Buffer.from(row.ciphertext) })),
    counts: { issued: db.prepare('SELECT issued FROM operator_meta').get().issued, used: db.prepare('SELECT sum(used) AS n FROM operator_capabilities').get().n, records: db.prepare('SELECT count(*) AS n FROM operator_records').get().n } }; }
  finally { db.close(); }
}
async function killOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done, reject) => { const timer = setTimeout(() => reject(Error('OWNED_CHILD_EXIT_TIMEOUT')), 5000); child.once('close', () => { clearTimeout(timer); done(); }); child.kill('SIGKILL'); });
}

test('durable native collection survives managed restart and A/store loss with app-bound grants and fresh read-only recovery', { timeout: 180000 }, async t => {
  const installed = await installedNativeFixture(); let directory;
  try { directory = await realpath(await mkdtemp(join(tmpdir(), 'native-collection-managed-'))); } catch (error) { await installed.close(); throw error; }
  let app, currentChildren = [], currentServers = []; const ownedChildren = [], handles = [], key = randomBytes(32), credentialId = randomBytes(24);
  const originalFork = childProcess.fork, originalCreateServer = http.createServer, originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(async () => { childProcess.fork = originalFork; http.createServer = originalCreateServer; syncBuiltinESMExports(); handles.forEach(handle => handle.close()); key.fill(0); credentialId.fill(0);
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else delete globalThis.location;
    try { await app?.close(); } finally { await Promise.allSettled(ownedChildren.map(killOwned)); await rm(directory, { recursive: true, force: true }); await installed.close(); } });
  const load = name => import(pathToFileURL(join(installed.directory, name)));
  await writeFile(join(installed.directory, 'test-public-sdk.mjs'), "export * from '@continuitykit/account-reserve/text-reserve';\nexport {createReserveHttpStore} from '@continuitykit/account-reserve/http-store';\n", { flag: 'wx', mode: 0o600 });
  const sdk = await load('test-public-sdk.mjs'), { buildNative } = await load('build.mjs'), { startNativeOperator } = await load('operate.mjs');
  const { initializeNativeOperator, readNativeOperatorState } = await load('operator-state.mjs'), { issueNativeGrants, runtimeProfile } = await load('operator.mjs');
  const { nativeApps, nativeAppProfile, nativeConfig, parseNativeGrants } = await load('profile.mjs');
  const [primary, recovery, gateway, alpha, beta] = await freePorts(5);
  const profile = { version: 2, apps: [{ id: 'textarea', label: 'Text draft', appId: 'native-managed-textarea-v1' }, { id: 'markdown', label: 'Markdown draft', appId: 'native-managed-markdown-v1' }],
    primaryOrigin: 'https://writer.collection.test', recoveryOrigin: 'https://reserve.collection.test', recoveryRpId: 'reserve.collection.test', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] };
  const ports = { primary, recovery, gateway, replicas: [{ id: 'alpha', port: alpha }, { id: 'beta', port: beta }] }, state = join(directory, 'private'), out = join(directory, 'dist');
  const samples = ['\ufeffFictional native collection — ÆØÅ.\r\nFirst app survives independently.\r\n', '# Fictional Markdown\n\nSecond app — 界 and 🦊.\n'];
  await buildNative({ profile, out }); initializeNativeOperator({ profile, state, ports });
  const bound = readNativeOperatorState({ profile, state }); assert.deepEqual(bound.profile, profile); assert.deepEqual(JSON.parse(await readFile(bound.operatorProfilePath, 'utf8')).apps, profile.apps);
  assert.deepEqual(runtimeProfile(profile).apps, profile.apps); assert.throws(() => nativeConfig(profile), /NATIVE_APP_SELECTION_REQUIRED/);
  assert.equal(nativeAppProfile(profile, 'textarea').version, 1); assert.deepEqual(nativeConfig(nativeAppProfile(profile, 'textarea')), nativeApps(profile)[0].config);
  const fixedPaths = [join(state, 'native-state.json'), bound.operatorProfilePath, join(state, 'gateway.json'), bound.invitationsFile, ...bound.databasePaths.map(item => item.invitationFile)];
  const fixedBytes = await Promise.all(fixedPaths.map(path => readFile(path)));
  const wrongProfile = { ...profile, apps: [...profile.apps].reverse() }; assert.throws(() => readNativeOperatorState({ profile: wrongProfile, state }), /NATIVE_STATE_/);
  assert.throws(() => readNativeOperatorState({ profile: nativeAppProfile(profile, 'textarea'), state }), /NATIVE_STATE_/);
  for (const [index, path] of fixedPaths.entries()) assert.deepEqual(await readFile(path), fixedBytes[index]);
  const workerPath = await realpath(join(installed.directory, 'operator-worker.mjs'));
  async function start() {
    currentChildren = []; currentServers = [];
    childProcess.fork = (...args) => { assert.equal(args[0], workerPath); const child = originalFork(...args); currentChildren.push(child); ownedChildren.push(child); return child; };
    http.createServer = (...args) => { const server = originalCreateServer(...args); currentServers.push(server); return server; }; syncBuiltinESMExports();
    try { app = await startNativeOperator({ profile, state, out }); } finally { childProcess.fork = originalFork; http.createServer = originalCreateServer; syncBuiltinESMExports(); }
    assert.deepEqual(app.status(), { state: 'ready', unavailableReplicas: [] }); assert.equal(currentChildren.length, 2);
  }
  async function closeA() {
    const server = currentServers.find(value => value.address()?.port === primary); assert.ok(server, 'capture only the owned A listener');
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
    await assert.rejects(transport({ port: primary, origin: profile.primaryOrigin, calls: [] })('/continuity-config.json'));
  }
  async function close() { await app.close(); assert.equal(await app.failure, undefined); app = undefined; await assert.rejects(access(join(state, 'runtime.lock')), { code: 'ENOENT' }); }
  await start();
  const emptyCounts = bound.databasePaths.map(item => snapshot(item.database).counts);
  for (const selection of [undefined, 'unknown', profile.apps[0].appId]) {
    const output = join(state, 'invalid-' + (selection ?? 'none') + '.json');
    await assert.rejects(issueNativeGrants({ profile, ...(selection === undefined ? {} : { app: selection }), invitationsFile: bound.invitationsFile, output }), /NATIVE_APP_SELECTION_REQUIRED/);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
  for (const [index, invalidProfile] of [wrongProfile, { ...profile, apps: [profile.apps[0], { ...profile.apps[1], appId: 'other-app-binding-v1' }] }].entries()) {
    const output = join(state, 'mismatched-' + index + '.json');
    await assert.rejects(issueNativeGrants({ profile: invalidProfile, app: 'textarea', invitationsFile: bound.invitationsFile, output }), error => error.code === 'OPERATOR_PROFILE_MISMATCH' && error.issuedMayExist === false);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
  assert.deepEqual(bound.databasePaths.map(item => snapshot(item.database).counts), emptyCounts);
  const counters = { create: 0, get: 0 }, outputs = [], calls = [], client = synthetic({ key, credentialId, counters, outputs }), fetcher = transport({ port: recovery, origin: profile.recoveryOrigin, calls });
  globalThis.location = { origin: profile.recoveryOrigin }; const prepared = [];
  for (const [index, selected] of nativeApps(profile).entries()) {
    const grantPath = join(state, 'grant-' + selected.id + '.json'); await issueNativeGrants({ profile, app: selected.id, invitationsFile: bound.invitationsFile, output: grantPath });
    const text = await readFile(grantPath, 'utf8'), grants = parseNativeGrants(text, nativeAppProfile(profile, selected.id)); assert.equal(grants.appId, selected.config.appId);
    assert.throws(() => parseNativeGrants(text, nativeAppProfile(profile, profile.apps[1 - index].id)), /NATIVE_GRANTS_CONTEXT_MISMATCH/);
    const replicas = profile.replicas.map(({ id, basePath }, position) => ({ id, store: sdk.createReserveHttpStore({ fetcher, basePath, enrollmentToken: grants.replicas[position].enrollmentToken }) }));
    let credential;
    try { credential = index ? await sdk.selectTextReserveCredential({ config: selected.config, webAuthnClient: client }) : await sdk.createTextReserveCredential({ config: selected.config, webAuthnClient: client, user: { name: 'Fictional collection', displayName: 'TEST ONLY' } }); handles.push(credential);
      const ready = await sdk.prepareTextReserveReplicas({ config: selected.config, text: samples[index], replicas, recoveryCredential: credential, webAuthnClient: client });
      assert.equal(ready.independentlyVerified, true); assert.equal(ready.text, samples[index]); assert.ok(ready.replicas.every(item => item.status === 'verified')); prepared.push(ready);
    } finally { credential?.close(); replicas.forEach(item => item.store.clearEnrollmentCapability()); await unlink(grantPath); }
  }
  assert.deepEqual(counters, { create: 1, get: 3 }); assert.ok(outputs.every(value => value.prfOutput.every(byte => byte === 0))); assert.equal(calls.filter(value => value.method === 'PUT').length, 4);
  const original = bound.databasePaths.map(item => snapshot(item.database)); assert.deepEqual(original[0], original[1]); assert.deepEqual(original[0].counts, { issued: 2, used: 2, records: 2 });
  for (const item of bound.databasePaths) { const bytes = await readFile(item.database); for (const forbidden of [key, credentialId, ...samples.map(value => Buffer.from(value))]) assert.equal(bytes.includes(forbidden), false); }
  const cases = [], processes = new Set();
  async function recover(name, expected, { ui = false } = {}) {
    const before = await Promise.all(bound.databasePaths.map(item => readFile(item.database))), snapshots = bound.databasePaths.map(item => snapshot(item.database)), output = join(directory, name); await mkdir(output, { mode: 0o700 });
    const result = await fresh(installed.directory, { origin: profile.recoveryOrigin, port: recovery, output, key: key.toString('base64url'), credentialId: credentialId.toString('base64url'), ...(ui ? { ui, jsdomPath } : {}) });
    assert.equal(result.ok, true, result.code); processes.add(result.pid); assert.deepEqual(result.counters, { create: 0, get: 1 }); assert.equal(result.nativeCalls, 0); assert.equal(result.forbiddenNetwork, 0); assert.equal(result.prfErased, true); assert.equal(result.persistence, 0); assert.equal(result.uiExports, ui);
    assert.deepEqual(result.results.map(item => item.status), expected); assert.deepEqual(result.results.map(item => item.appId), profile.apps.map(item => item.appId)); assert.equal(result.requests.length, ui ? 6 : 5); assert.ok(result.requests.every(item => item.method === 'GET'));
    for (const [index, status] of expected.entries()) for (const format of ['txt', 'json']) {
      const path = join(output, 'app-' + index + '.' + format);
      if (status !== 'recovered') await assert.rejects(readFile(path), { code: 'ENOENT' });
      else if (format === 'txt') assert.deepEqual(await readFile(path), Buffer.from(samples[index]));
      else assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { format: 'continuity-text-export/v1', text: samples[index] });
    }
    for (const [index, item] of bound.databasePaths.entries()) { assert.deepEqual(await readFile(item.database), before[index]); assert.deepEqual(snapshot(item.database), snapshots[index]); }
    cases.push({ name, ui, statuses: result.results.map(item => item.status), oneExistingAssertion: true, exactExports: true, noRecoveryWrites: true }); return result;
  }
  await recover('healthy', ['recovered', 'recovered']); await recover('ui-healthy', ['recovered', 'recovered'], { ui: true }); await closeA(); await killOwned(currentChildren[0]); assert.deepEqual(app.status(), { state: 'degraded', unavailableReplicas: ['alpha'] });
  const survivor = await recover('A-closed-alpha-killed', ['recovered', 'recovered']); assert.ok(survivor.results.every(item => item.replicas[0].status === 'unavailable' && item.replicas[1].status === 'verified'));
  await recover('ui-A-closed-alpha-killed', ['recovered', 'recovered'], { ui: true });
  const beforeRestart = await Promise.all(bound.databasePaths.map(item => readFile(item.database))); await close(); await start();
  for (const [index, item] of bound.databasePaths.entries()) assert.deepEqual(await readFile(item.database), beforeRestart[index]);
  await closeA(); await recover('same-state-restart', ['recovered', 'recovered']); await close();
  const betaDb = new DatabaseSync(bound.databasePaths[1].database);
  try { const row = betaDb.prepare('SELECT ciphertext FROM operator_records WHERE locator=?').get(prepared[0].locator), value = JSON.parse(Buffer.from(row.ciphertext).toString('utf8')), bytes = Buffer.from(value.ciphertext, 'base64url'); bytes[0] ^= 1; value.ciphertext = bytes.toString('base64url'); betaDb.prepare('UPDATE operator_records SET ciphertext=? WHERE locator=?').run(Buffer.from(JSON.stringify(value)), prepared[0].locator); } finally { betaDb.close(); }
  await start(); await closeA(); await killOwned(currentChildren[0]); const corrupt = await recover('one-app-corrupt', ['rejected', 'recovered']); assert.equal(corrupt.results[0].code, 'REPLICA_RECOVERY_FAILED'); await recover('ui-one-app-corrupt', ['rejected', 'recovered'], { ui: true }); await close();
  for (const [index, item] of bound.databasePaths.entries()) {
    const db = new DatabaseSync(item.database); try { db.exec('BEGIN'); db.exec('DELETE FROM operator_records'); for (const record of original[index].records) if (record.locator !== prepared[0].locator) db.prepare('INSERT INTO operator_records VALUES(?,?)').run(record.locator, record.bytes); db.exec('COMMIT'); } finally { db.close(); }
  }
  await start(); await closeA(); await recover('one-app-missing', ['missing', 'recovered']);
  await killOwned(currentChildren[0]); await killOwned(currentChildren[1]); assert.deepEqual(app.status(), { state: 'unavailable', unavailableReplicas: ['alpha', 'beta'] });
  await recover('both-stores-killed', ['unavailable', 'unavailable']); await close();
  for (const [index, path] of fixedPaths.entries()) assert.deepEqual(await readFile(path), fixedBytes[index]);
  assert.equal(processes.size, 9); assert.equal(ownedChildren.length, 8);
  console.log(JSON.stringify({ installedNativeCollectionManaged: true, appNamespaces: 2, managedStarts: 4, sameStateRestart: true, freshRecoveryProcesses: processes.size,
    selectedGrantContextValidated: true, invalidSelectionConsumesNoQuota: true, grantFilesNotNeededForRecovery: true, actualPrimaryListenerClosed: true,
    oneExistingAssertionPerCollection: true, actualStoreProcessesKilled: true, exactExports: true, perAppCorruptAndMissingIsolation: true, noRecoveryWrites: true, staticStatePreserved: true, installedUiWithRealSdk: true, freshJsdomProcesses: 3,
    physicalPasskeyProof: false, nativeBrowserEngineProof: false, publicTlsVerified: false, independentProviders: false, opaqueStoreGrantsCryptographicallyAppScoped: false, cases }));
});
