import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installedNativeFixture } from './native-installed-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// The explicit test transport cannot contact A, follow redirects, use an
// external hostname or leak a capability in a recovery read.
function transport({ port, origin, readOnly = false, calls }) {
  return async (path, init = {}) => {
    const method = init.method ?? 'GET', route = /^\/api\/replicas\/(alpha|beta)\/reserve\/[A-Za-z0-9_-]{43}$/.exec(path);
    assert.ok(route); assert.ok(method === 'GET' || !readOnly && method === 'PUT');
    const headers = new Headers(init.headers); if (method === 'GET') assert.equal(headers.has('authorization'), false);
    calls.push({ id: route[1], method }); const body = init.body === undefined ? undefined : Buffer.from(init.body); assert.ok(!body || body.length <= 87440);
    return new Promise((done, reject) => {
      let response, settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; response?.destroy(); req.destroy(); error ? reject(error) : done(value); };
      const req = request({ hostname: '127.0.0.1', port, method, path, agent: false,
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init.signal ? [init.signal] : [])]),
        headers: { host: new URL(origin).host, origin, connection: 'close', ...(body ? { 'content-type': 'application/json', 'content-length': body.length, authorization: headers.get('authorization') } : {}) } }, res => {
        response = res; let size = 0; const chunks = [];
        if (res.headers['content-encoding'] || res.statusCode >= 300 && res.statusCode < 400) return finish(Error('UNEXPECTED_RESPONSE'));
        res.on('data', chunk => { if (settled) return; size += chunk.length; if (size > 87440) finish(Error('RESPONSE_LIMIT')); else chunks.push(chunk); });
        res.once('end', () => { if (!settled) finish(undefined, new Response(Buffer.concat(chunks, size), { status: res.statusCode, headers: { 'content-type': res.headers['content-type'] ?? '' } })); });
        res.once('error', () => finish(Error('TEST_IO_FAILED'))); res.once('aborted', () => finish(Error('TEST_IO_FAILED')));
        res.once('close', () => { if (!res.complete) finish(Error('TEST_IO_FAILED')); });
      });
      req.once('error', () => finish(Error('TEST_IO_FAILED'))); req.end(body);
    });
  };
}
function synthetic({ key, credentialId, counters, outputs }) {
  const response = options => { const result = { credentialId: new Uint8Array(credentialId), prfOutput: new Uint8Array(createHmac('sha256', key).update(options.prfSalt).digest()) }; outputs.push(result); return result; };
  return {
    async createCredential(options) { counters.creates++; return { ...response(options), prfEnabled: true }; },
    async getCredential(options) { counters.assertions++; assert.equal(options.userVerification, 'required'); return response(options); },
  };
}
const hostSource = `
import { initializeDatabase } from './operator-runtime/store.mjs';
import { startOperatorHost } from './operator-runtime/host.mjs';
import { startReplicaGateway } from './operator-runtime/replica-gateway.mjs';
import { startNativeHost } from './native-host.mjs';
let host, stopping=false;
process.once('message',async message=>{try{
 if(message.kind==='store'){if(message.initialize)initializeDatabase(message.database,message.configuration);host=await startOperatorHost(message);}
 else if(message.kind==='gateway')host=await startReplicaGateway(message);
 else if(message.kind==='recovery')host=await startNativeHost({...message,role:'recovery'});
 else throw Error();
 process.send({ready:true,port:host.port});
}catch{process.send({ready:false});process.exitCode=1;process.disconnect();}});
for(const signal of ['SIGTERM','SIGINT','disconnect'])process.on(signal,async()=>{if(stopping)return;stopping=true;try{await host?.close();}finally{process.exit(0);}});
`;
const recoverySource = `
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverTextReservesFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { exportText } from './adapter.mjs';
const transport=${transport.toString()};
const synthetic=${synthetic.toString()};
process.once('message',async message=>{
 let key,credentialId;const counters={creates:0,assertions:0},outputs=[],calls=[];let nativeCalls=0,forbiddenNetwork=0;
 const native=()=>{nativeCalls++;throw Error('NATIVE_FORBIDDEN');};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{credentials:{get:native,create:native}}});
 globalThis.fetch=()=>{forbiddenNetwork++;throw Error('NETWORK_OUTSIDE_B_FORBIDDEN');};
 try{
  assert.deepEqual(Object.keys(message).sort(),['configs','credentialId','key','origin','output','port']);
  key=Buffer.from(message.key,'base64url');credentialId=Buffer.from(message.credentialId,'base64url');message.key=undefined;message.credentialId=undefined;
  globalThis.location={origin:message.origin};
  const webAuthnClient=synthetic({key,credentialId,counters,outputs});webAuthnClient.createCredential=()=>{counters.creates++;throw Error('CREATION_FORBIDDEN');};
  const fetcher=transport({port:message.port,origin:message.origin,readOnly:true,calls});
  const stores=['alpha','beta'].map(id=>({id,store:createReserveHttpStore({basePath:'/api/replicas/'+id+'/reserve',fetcher,timeoutMs:1500})}));
  const pending=recoverTextReservesFromReplicas({apps:message.configs.map(config=>({config,replicas:stores})),webAuthnClient});
  assert.equal(counters.assertions,1);const results=await pending;assert.ok(Object.isFrozen(results));
  const safe=[];
  for(const[index,result]of results.entries()){
    assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.replicas));
    if(result.status==='recovered'){
      const editor={getText:()=>result.reserve.text};
      await writeFile(join(message.output,'app-'+index+'.txt'),exportText(editor,'txt'),{flag:'wx',mode:0o600});
      await writeFile(join(message.output,'app-'+index+'.json'),exportText(editor,'json'),{flag:'wx',mode:0o600});
    }else assert.equal(Object.hasOwn(result,'reserve'),false);
    safe.push({appId:result.appId,status:result.status,...(result.code?{code:result.code}:{}),replicas:result.replicas,exported:result.status==='recovered'});
  }
  assert.ok(outputs.every(value=>value.prfOutput.every(byte=>byte===0)));
  process.send({ok:true,results:safe,counters,calls,nativeCalls,forbiddenNetwork,prfOutputsZeroed:true});
 }catch(error){process.send({ok:false,code:/^[A-Z_]+$/.test(error?.code??'')?error.code:'FRESH_COLLECTION_TEST_FAILED'});}
 finally{key?.fill(0);credentialId?.fill(0);process.disconnect();}
});
`;
function launch(directory, source, message, timeout = 20000) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { cwd: directory,
    env: { PATH: process.env.PATH ?? '', NODE_PATH: '', LANG: 'C', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(done => { const finish = (code, signal) => done({ code, signal }); child.once('exit', finish); child.once('close', finish); });
  const response = new Promise((done, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; child.kill('SIGKILL'); reject(Error('CHILD_TIMEOUT')); }, timeout);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : done(value); };
    child.once('message', value => finish(undefined, value)); child.once('error', () => finish(Error('CHILD_START_FAILED'))); child.once('exit', () => finish(Error('CHILD_NO_RESULT')));
    child.send(message, error => { if (error) finish(Error('CHILD_SEND_FAILED')); });
  });
  return { child, response, exited, async stop(signal = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    child.kill(signal); const timer = setTimeout(() => child.kill('SIGKILL'), 4000); try { return await exited; } finally { clearTimeout(timer); }
  } };
}
async function execute(directory, args) {
  return new Promise((done, reject) => {
    const env = { ...process.env, NODE_PATH: '', NODE_NO_WARNINGS: '1', FORCE_COLOR: '0' };
    // A nested test process needs its own ordinary reporter, not the parent's
    // private serialized runner channel inherited through this variable.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (output.length < 50000) output += chunk; });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); code === 0 ? done(output) : reject(Error('INSTALLED_CHECK_FAILED: ' + output)); });
  });
}
function rows(database) { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare('SELECT locator,ciphertext FROM operator_records ORDER BY locator').all().map(row => ({ locator: row.locator, bytes: Buffer.from(row.ciphertext) })); } finally { db.close(); } }
function counters(database) { const db = new DatabaseSync(database, { readOnly: true }); try { return { records: db.prepare('SELECT count(*) AS n FROM operator_records').get().n, issued: db.prepare('SELECT issued FROM operator_meta').get().issued, used: db.prepare('SELECT sum(used) AS n FROM operator_capabilities').get().n }; } finally { db.close(); } }

test('installed collection replicas survive a real store-process failure and isolate corrupt app ciphertext through B', { timeout: 120000 }, async t => {
  const installed = await installedNativeFixture();
  let temporary;
  try { temporary = await realpath(await mkdtemp('/tmp/collection-replicas-installed-')); } catch (error) { await installed.close(); throw error; }
  const hosts = [], key = randomBytes(32), credentialId = randomBytes(24), handles = [];
  t.after(async () => { await Promise.allSettled(hosts.map(host => host.stop())); key.fill(0); credentialId.fill(0); handles.forEach(handle => handle.close()); await rm(temporary, { recursive: true, force: true }); await installed.close(); });
  const unitSource = (await readFile(join(root, 'tests/text-collection-replicas.mjs'), 'utf8')).replace("'../sdk/text-reserve.mjs'", "'@continuitykit/account-reserve/text-reserve'");
  await writeFile(join(installed.directory, 'installed-collection-tests.mjs'), unitSource, { flag: 'wx' });
  const unitOutput = await execute(installed.directory, ['--test', '--test-reporter=tap', 'installed-collection-tests.mjs']);
  const installedUnitTests = Number(unitOutput.match(/^# tests (\d+)$/m)?.[1]); assert.ok(installedUnitTests >= 17);
  await writeFile(join(installed.directory, 'collection-types.mts'), `
import { recoverTextReservesFromReplicas, type TextReserveReplicaCollectionApp, type TextReserveReplicaCollectionResult } from '@continuitykit/account-reserve/text-reserve';
const config={appId:'typed-app',recoveryOrigin:'https://reserve.example',recoveryRpId:'reserve.example'};
const store={get:async(_locator:string):Promise<Uint8Array|undefined>=>undefined};
const apps:readonly TextReserveReplicaCollectionApp[]=[{config,replicas:[{id:'alpha',store},{id:'beta',store:{...store}}]}];
const results:readonly TextReserveReplicaCollectionResult[]=await recoverTextReservesFromReplicas({apps,signal:new AbortController().signal,onProgress(stage){const bounded:'find-text'|'open-text'=stage;void bounded;}});
for(const result of results){if(result.status==='recovered'){const text:string=result.reserve.text;void text;}else{const code:'RESERVE_MISSING'|'REPLICA_RECOVERY_FAILED'|'REPLICA_CONFLICT'=result.code;void code;
// @ts-expect-error Failed entries expose no plaintext reserve.
result.reserve;}
// @ts-expect-error Collection results are immutable.
result.appId='changed';}
// @ts-expect-error apps is required; legacy configs is not this API.
recoverTextReservesFromReplicas({configs:[config],store});
// @ts-expect-error A reader method must return bytes, missing, or a promise thereof.
recoverTextReservesFromReplicas({apps:[{config,replicas:[{id:'alpha',store:{get:()=>123}},{id:'beta',store}]}]});
`, { flag: 'wx' });
  await execute(installed.directory, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'collection-types.mts']);
  await writeFile(join(installed.directory, 'test-public-sdk.mjs'), "export * from '@continuitykit/account-reserve/text-reserve';\nexport {createReserveHttpStore} from '@continuitykit/account-reserve/http-store';\n", { flag: 'wx' });
  const sdk = await import(pathToFileURL(join(installed.directory, 'test-public-sdk.mjs')));
  const { buildNative } = await import(pathToFileURL(join(installed.directory, 'build.mjs')));
  const profile = { version: 1, appId: 'collection-textarea-v1', primaryOrigin: 'https://unavailable-a.example', recoveryOrigin: 'https://collection-b.example', recoveryRpId: 'collection-b.example', expiresAt: new Date(Date.now() + 3600000).toISOString(), replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] };
  const configs = ['collection-textarea-v1', 'collection-markdown-v1'].map(appId => ({ appId, recoveryOrigin: profile.recoveryOrigin, recoveryRpId: profile.recoveryRpId }));
  const texts = ['\ufeffFictional textarea draft.\r\nOne credential, separate apps — Å.\n', '# Fictional Markdown\n\nContinue from B — 界 and 🦊.\n'];
  const configuration = { version: 1, primaryOrigin: profile.primaryOrigin, recoveryOrigin: profile.recoveryOrigin, expiresAt: profile.expiresAt, apps: configs.map((config, index) => ({ id: index ? 'markdown' : 'textarea', label: index ? 'Markdown' : 'Textarea', appId: config.appId })) };
  const out = join(temporary, 'dist'); await buildNative({ profile, out });
  const databases = ['alpha', 'beta'].map(id => join(temporary, id + '.db'));
  const invitations = ['alpha', 'beta'].map(() => randomBytes(32).toString('hex'));
  async function start(message) { const host = launch(installed.directory, hostSource, message); hosts.push(host); const result = await host.response; assert.equal(result.ready, true); return { ...host, port: result.port }; }
  const stores = [];
  for (const [index, id] of ['alpha', 'beta'].entries()) {
    const invitationFile = join(temporary, id + '-invitation.txt'); await writeFile(invitationFile, invitations[index] + '\n', { mode: 0o600 });
    stores.push(await start({ kind: 'store', configuration, database: databases[index], invitationFile, initialize: true, port: 0 }));
  }
  const gateway = await start({ kind: 'gateway', configuration: { recoveryOrigin: profile.recoveryOrigin, replicas: stores.map((store, index) => ({ id: ['alpha', 'beta'][index], port: store.port })) }, port: 0 });
  const b = await start({ kind: 'recovery', profile, assets: join(out, 'recovery'), gatewayPort: gateway.port, port: 0 });
  const outputs = [], credentials = { creates: 0, assertions: 0 }, calls = [], client = synthetic({ key, credentialId, counters: credentials, outputs });
  const fetcher = transport({ port: b.port, origin: profile.recoveryOrigin, calls });
  const { requestLocalJson } = await import(pathToFileURL(join(installed.directory, 'native-host.mjs')));
  const prepared = [];
  for (const [index, config] of configs.entries()) {
    const replicas = [];
    for (const [replicaIndex, id] of ['alpha', 'beta'].entries()) {
      const response = await requestLocalJson({ port: stores[replicaIndex].port, origin: profile.recoveryOrigin, path: '/api/enrollment/start', method: 'POST', body: Buffer.from('{}'), authorization: 'Bearer ' + invitations[replicaIndex], signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 201); const { enrollmentToken } = JSON.parse(response.bytes);
      replicas.push({ id, store: sdk.createReserveHttpStore({ basePath: '/api/replicas/' + id + '/reserve', fetcher, enrollmentToken }) });
    }
    const handle = index ? await sdk.selectTextReserveCredential({ config, webAuthnClient: client }) : await sdk.createTextReserveCredential({ config, user: { name: 'Fictional installed test', displayName: 'Synthetic only' }, webAuthnClient: client }); handles.push(handle);
    const ready = await sdk.prepareTextReserveReplicas({ config, recoveryCredential: handle, text: texts[index], replicas, webAuthnClient: client });
    assert.ok(ready.independentlyVerified && ready.replicas.every(item => item.status === 'verified')); prepared.push(ready);
    replicas.forEach(replica => replica.store.clearEnrollmentCapability()); handle.close();
  }
  assert.equal(credentials.creates, 1); assert.equal(credentials.assertions, 3); assert.equal(calls.filter(item => item.method === 'PUT').length, 4);
  assert.ok(outputs.every(value => value.prfOutput.every(byte => byte === 0)));
  const initial = databases.map(rows); assert.equal(initial[0].length, 2); assert.deepEqual(initial[0], initial[1]); assert.notEqual(prepared[0].locator, prepared[1].locator);
  const before = await Promise.all(databases.map(path => readFile(path)));
  for (const [index, database] of databases.entries()) { assert.deepEqual(counters(database), { records: 2, issued: 2, used: 2 }); for (const forbidden of [key, credentialId, ...texts.map(text => Buffer.from(text)), ...invitations.map(value => Buffer.from(value))]) assert.equal(before[index].includes(forbidden), false); }
  const clients = new Set();
  async function recover(name, statuses) {
    const storageBefore = await Promise.all(databases.map(path => readFile(path))), countersBefore = databases.map(counters);
    const output = join(temporary, name); await mkdir(output, { mode: 0o700 });
    const child = launch(installed.directory, recoverySource, { configs, port: b.port, origin: profile.recoveryOrigin, key: key.toString('base64url'), credentialId: credentialId.toString('base64url'), output }); clients.add(child.child.pid);
    let result; try { result = await child.response; assert.equal(result.ok, true, result.code); assert.deepEqual(await child.exited, { code: 0, signal: null }); } finally { await child.stop(); }
    assert.deepEqual(result.counters, { creates: 0, assertions: 1 }); assert.equal(result.nativeCalls, 0); assert.equal(result.forbiddenNetwork, 0); assert.equal(result.prfOutputsZeroed, true);
    assert.deepEqual(result.results.map(item => item.status), statuses); assert.equal(result.calls.length, 4); assert.ok(result.calls.every(item => item.method === 'GET'));
    for (const [index, status] of statuses.entries()) {
      if (status === 'recovered') { assert.deepEqual(await readFile(join(output, 'app-' + index + '.txt')), Buffer.from(texts[index])); assert.deepEqual(JSON.parse(await readFile(join(output, 'app-' + index + '.json'), 'utf8')), { format: 'continuity-text-export/v1', text: texts[index] }); }
      else for (const extension of ['txt', 'json']) await assert.rejects(readFile(join(output, 'app-' + index + '.' + extension)), { code: 'ENOENT' });
    }
    for (const [index, database] of databases.entries()) { assert.deepEqual(await readFile(database), storageBefore[index]); assert.deepEqual(counters(database), countersBefore[index]); }
    return result;
  }
  const healthy = await recover('healthy', ['recovered', 'recovered']); assert.ok(healthy.results.every(item => item.replicas.every(replica => replica.status === 'verified')));
  assert.equal((await stores[0].stop('SIGKILL')).signal, 'SIGKILL');
  const survivor = await recover('one-store-lost', ['recovered', 'recovered']); assert.ok(survivor.results.every(item => item.replicas[0].status === 'unavailable' && item.replicas[1].status === 'verified'));
  for (const [index, database] of databases.entries()) { assert.deepEqual(await readFile(database), before[index]); assert.deepEqual(counters(database), { records: 2, issued: 2, used: 2 }); }
  const betaPort = stores[1].port; await stores[1].stop();
  const db = new DatabaseSync(databases[1]);
  try { const row = db.prepare('SELECT ciphertext FROM operator_records WHERE locator=?').get(prepared[0].locator), value = JSON.parse(Buffer.from(row.ciphertext).toString('utf8')), bytes = Buffer.from(value.ciphertext, 'base64url'); bytes[0] ^= 1; value.ciphertext = bytes.toString('base64url'); db.prepare('UPDATE operator_records SET ciphertext=? WHERE locator=?').run(Buffer.from(JSON.stringify(value)), prepared[0].locator); } finally { db.close(); }
  stores[1] = await start({ kind: 'store', configuration, database: databases[1], invitationFile: join(temporary, 'beta-invitation.txt'), initialize: false, port: betaPort });
  const corrupt = await recover('one-app-corrupt', ['rejected', 'recovered']); assert.equal(corrupt.results[0].code, 'REPLICA_RECOVERY_FAILED'); assert.equal(corrupt.results[0].replicas[1].code, 'MANIFEST_AUTH_FAILED');
  await stores[1].stop('SIGKILL'); const unavailable = await recover('all-stores-lost', ['unavailable', 'unavailable']); assert.ok(unavailable.results.every(item => item.exported === false));
  assert.equal(clients.size, 4);
  console.log(JSON.stringify({ installedCollectionReplicaProof: true, installedUnitTests, strictTypeScript: true, appNamespaces: 2, storageProcesses: 2, gatewayAndBProcesses: true, freshRecoveryProcesses: clients.size, sdkAssertionsPerCollection: 1, legacyRecordFormat: true, oneCredentialForBothApps: true, separateAuthenticatedAppKeys: true, authenticatedSurvivorExports: 2, corruptedAppIsolated: true, allUnavailableNoExports: true, noRecoveryWrites: true, primaryAccessForbidden: true, nativePasskeyInvoked: false, independentProvidersVerified: false, nativeMultiAppUiVerified: false }));
});
