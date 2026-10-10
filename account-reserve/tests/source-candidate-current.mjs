import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,rename,symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {packageCandidate} from '../scripts/package-candidate.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
async function execute(command,args,cwd,{timeout=60000,env={}}={}){
 const childEnv={...process.env,...env};delete childEnv.NODE_TEST_CONTEXT;
 const child=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe'],env:childEnv});let stdout='',stderr='',settled=false,kill;
 const timer=setTimeout(()=>{child.kill('SIGTERM');kill=setTimeout(()=>child.kill('SIGKILL'),2000);},timeout);
 child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1024*1024)child.kill('SIGTERM');});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>1024*1024)child.kill('SIGTERM');});
 return new Promise((resolve,reject)=>{child.once('error',e=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}});child.once('close',code=>{clearTimeout(timer);clearTimeout(kill);if(settled)return;settled=true;code===0?resolve(stdout):reject(new Error(`CHILD_EXIT_${code}: ${stderr.slice(-4000)} ${stdout.slice(-4000)}`));});});
}
const required=[
 'text-native/collection-main.mjs','text-native/operator-backup.mjs','text-native/operator-diagnostics.mjs','text-native/operator-runtime/cli.mjs','text-native/.npmignore','text-starter/collection-server.mjs','text-starter/replica-server.mjs','operator/replica-gateway.mjs',
 'integrations/multi-app/vendor/easymde/dist/easymde.min.js','integrations/multi-app/vendor/easymde/dist/easymde.min.css','integrations/multi-app/vendor/easymde/LICENSE','integrations/multi-app/vendor/easymde/marked-LICENSE','integrations/textarea-text/upstream/LICENSE',
 'self-service/apps/app.mjs','self-service/apps/collection.mjs','self-service/client/config.mjs','self-service/backend/store.mjs','self-service/backend/db/schema.ts',
 'payments/SequentialPayment.sol','payments/SequentialPayment.artifact.json','payments/operator-runner.mjs','payments/operator-journal.mjs','payments/page.mjs','payments/site-handler.mjs','tests/payments-operator.mjs','deploy/operator-runner.mjs','release/paced-rpc.mjs','starter/prism-art.mjs','sdk/COLLECTION_REPLICAS.md',
];
async function candidate(t){const base=await mkdtemp(join(tmpdir(),'continuity-current-candidate-'));t.after(()=>rm(base,{recursive:true,force:true}));const packed=await packageCandidate({artifactDirectory:join(base,'output')});const root=join(base,'source');await mkdir(root);await execute('/usr/bin/tar',['-xzf',packed.archive,'-C',root],base);return {base,root,packed};}

test('current source candidate includes complete reviewed additions and excludes operational sentinels',async t=>{
 const f=await candidate(t),manifest=JSON.parse(await readFile(f.packed.manifestPath));
 for(const file of required){assert.ok(Object.hasOwn(manifest.files,file),file);assert.equal(digest(await readFile(join(f.root,file))),manifest.files[file]);assert.equal(manifest.files[file],manifest.sourceHashes[file],'source bytes preserved: '+file);}
 const originals=new Map(),sentinel='SYNTHETIC_PRIVATE_SENTINEL_NEVER_PUBLISH_42';
 for(const file of ['text-native/private/state.json','text-native/private/grants.json','text-native/dist/worker.mjs','text-native/runtime.lock','text-native/operator-profile.json','text-native/reserve.sqlite','text-native/backup.json','text-native/approval.json','text-native/.env','text-native/invitations.json','text-native/operator-runtime/private.json','text-starter/node_modules/module/index.js','text-starter/private/alpha.sqlite-wal','operator/database.sqlite','operator/runtime/manifest.json','payments/proposal.json','payments/approval.json','payments/issuer.secrets.json','payments/payments.journal.json','payments/deployed/worker.mjs','integrations/multi-app/vendor/easymde/dist/unknown.js','integrations/multi-app/private/token.json','release/profile.json','deploy/proposal.json','deploy/approval.json','deploy/live/worker.mjs','scripts/build/private.json','sites/recovery/worker.mjs','self-service/profile.json','self-service/sites/recovery/worker.mjs','self-service/backend/private.db','self-service/backend/db/state.json']){
  await mkdir(dirname(join(f.root,file)),{recursive:true});await writeFile(join(f.root,file),sentinel);originals.set(file,digest(await readFile(join(f.root,file))));
 }
 const packed=await packageCandidate({root:f.root,artifactDirectory:join(f.base,'filtered')}),after=JSON.parse(await readFile(packed.manifestPath));
 for(const [file,hash]of originals){assert.ok(!Object.hasOwn(after.files,file),file);assert.equal(digest(await readFile(join(f.root,file))),hash,'must not alter private source file');}
 for(const file of required)assert.ok(Object.hasOwn(after.files,file),file);
 const listing=(await execute('/usr/bin/tar',['-tzf',packed.archive],f.base)).trim().split('\n');assert.equal(new Set(listing).size,listing.length);assert.deepEqual([...listing].sort(),Object.keys(after.files).sort());
 for(const file of ['payments/guard.mjs','text-native/collection-main.mjs'])assert.equal(await execute('/usr/bin/tar',['-xOzf',packed.archive,file],f.base),await readFile(join(f.root,file),'utf8'));
 const source=join(f.root,'payments/harness.mjs'),saved=await readFile(source);const privatePath=['','Users','fixture-owner','private','value'].join('/');await writeFile(source,'// '+privatePath+'\n');await assert.rejects(packageCandidate({root:f.root,artifactDirectory:join(f.base,'refused')}),/PRIVATE_PATH_IN_EXPORT/);assert.equal(await readFile(source,'utf8'),'// '+privatePath+'\n');await writeFile(source,saved);
 const vendor=join(f.root,'integrations/multi-app/vendor/easymde/dist'),moved=join(f.base,'vendor-dist');await rename(vendor,moved);await symlink(moved,vendor);await assert.rejects(packageCandidate({root:f.root,artifactDirectory:join(f.base,'linked')}),/SYMLINK_REJECTED/);
});

test('unpacked candidate clean offline install runs current local payment proof and browser build', {timeout:120000},async t=>{
 const f=await candidate(t),cache=process.env.SDK_TEST_NPM_CACHE??'/tmp/continuity-reserve-npm';
 const env={PATH:dirname(process.execPath)+':'+process.env.PATH,npm_config_cache:cache,npm_config_audit:'false',npm_config_fund:'false',NO_COLOR:'1'};
 await execute(join(dirname(process.execPath),'npm'),['ci','--offline','--ignore-scripts'],f.root,{env,timeout:60000});
 const output=await execute(process.execPath,['--test','--test-reporter=tap','tests/payments-chain.mjs','tests/payments-guard.mjs','tests/payments-pending.mjs','tests/payments-transaction.mjs','tests/payments-operator.mjs'],f.root,{env:{...env,NODE_TEST_CONTEXT:''},timeout:60000});
 assert.match(output,/# fail 0/);assert.match(output,/# skipped 0/);assert.ok(Number(output.match(/# tests (\d+)/)?.[1])>=55);assert.match(output,/two genuine payouts keep original beneficiary/);assert.match(output,/actual viem wallet executes two guarded sequential obligations/);
 await execute(process.execPath,['payments/build-browser.mjs'],f.root,{env});
 await execute(process.execPath,['scripts/build-app-reserves.mjs'],f.root,{env});
 const module=await import(pathToFileURL(join(f.root,'integrations/multi-app/build.mjs')).href);await module.verifyEditorSources();await module.buildEditorAssets({outDir:join(f.base,'editor-built')});
 assert.match(await readFile(join(f.base,'editor-built/easymde-runtime.mjs'),'utf8'),/EasyMDE 2\.20\.0/);
});
