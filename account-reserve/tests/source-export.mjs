import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {link,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {packageCandidate} from '../scripts/package-candidate.mjs';

const publicProofBytes=await readFile(new URL('../evidence/public-proof.json',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD6sAAAAASUVORK5CYII=','base64');
// Header/footer bytes are sufficient for the export type guard; no image decoding is claimed.
const jpeg=Buffer.from([255,216,255,224,0,16,74,70,73,70,0,255,217]);
const workProofFiles=['evidence/work-public-proof.json','evidence/work-finished-export-2026-10-09.json'];
const workRequiredFiles=[...workProofFiles,'evidence/work-recovered-2026-10-09.jpg','delivery/examples/finished-checkout.txt','delivery/examples/finished-checkout.json'];

async function fixture(t){
  const temp=await mkdtemp(join(tmpdir(),'source-export-test-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=join(temp,'source');
  const file=async(path,content='Synthetic source-export fixture.\n')=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),content);};
  for(const directory of ['sdk','starter','work','work-release','chain','tests','scripts','release','deploy','delivery','evidence'])await mkdir(join(root,directory),{recursive:true});
  for(const path of ['LICENSE','README.md','SECURITY.md','package.json','package-lock.json','index.html','vite.config.mjs','app.mjs','app-session.mjs','app-setup.mjs','app-progress.mjs','style.css','server.mjs','handoff.mjs','transaction.mjs','pending-ticket.mjs'])await file(path);
  await file('evidence/public-proof.json',publicProofBytes);
  await file('sdk/index.mjs');
  await file('deploy/operator-journal.mjs','// Journal implementation source, not an operational journal.\n');
  return {temp,root,file};
}

async function workFixture(t){
  const f=await fixture(t);
  for(const path of workProofFiles)await f.file(path,JSON.stringify({format:'synthetic-public-proof/v1',scope:'Fictional source-export test only.',blockchainTransactions:0}));
  await f.file('evidence/work-recovered-2026-10-09.jpg',jpeg);
  await f.file('delivery/examples/finished-checkout.txt','Fictional completed draft.\n');
  await f.file('delivery/examples/finished-checkout.json',JSON.stringify({title:'Fictional completed draft'}));
  return f;
}

test('source archive contains mandatory portable proof and reviewed files without raw operational evidence',async t=>{
  const f=await fixture(t);
  await f.file('delivery/REVIEW.md',`Local record: ${f.root}/sdk/index.mjs\n`);
  await f.file('evidence/raw-cloud-response.json','Unselected operational response.\n');
  await f.file('work/index.html', '<p>Synthetic work example</p>');
  await f.file('work-release/db/schema.ts','// Public D1 schema.\n');
  await f.file('work-release/drizzle/0000_example.sql','CREATE TABLE example (id TEXT);\n');
  await f.file('work-release/drizzle/meta/_journal.json','{"version":"7","entries":[]}\n');
  await f.file('deploy/work-public-2026-10-08/secret-transfer-approval.json','Local operational record, not public source.\n');
  await f.file('node_modules/ignored.txt','Not source.\n');
  await f.file('delivery/assets/continuitykit-logo.png',png);
  await f.file('delivery/assets/unreviewed.png',png);
  const result=await packageCandidate({root:f.root});
  const manifest=JSON.parse(await readFile(join(f.root,'artifacts/manifest.json'),'utf8'));
  const listed=spawnSync('/usr/bin/tar',['-tzf',result.archive],{encoding:'utf8'});
  assert.equal(listed.status,0,listed.stderr);
  const files=listed.stdout.trim().split('\n');
  assert.ok(files.includes('evidence/public-proof.json'));
  assert.ok(files.includes('deploy/operator-journal.mjs'));
  assert.ok(files.includes('work/index.html'));
  assert.ok(files.includes('work-release/db/schema.ts'));
  assert.ok(files.includes('work-release/drizzle/0000_example.sql'));
  assert.ok(files.includes('work-release/drizzle/meta/_journal.json'));
  assert.ok(!files.some(path=>path.startsWith('deploy/work-public-2026-10-08/')));
  assert.ok(files.includes('delivery/assets/continuitykit-logo.png'));
  assert.ok(!files.includes('delivery/assets/unreviewed.png'));
  assert.ok(!files.includes('evidence/raw-cloud-response.json'));
  assert.ok(!files.some(path=>path.startsWith('node_modules/')||path.includes('..')));
  assert.deepEqual([...files].sort(),Object.keys(manifest.files).sort());
  assert.equal(manifest.archiveSha256,hash(await readFile(result.archive)));
  for(const path of files){
    const extracted=spawnSync('/usr/bin/tar',['-xOzf',result.archive,path]);
    assert.equal(extracted.status,0);
    assert.equal(hash(extracted.stdout),manifest.files[path]);
    assert.doesNotMatch(extracted.stdout.toString('utf8'),/\/Users\/[^/\s]+\/|\/var\/folders\//);
  }
  assert.deepEqual(manifest.transformed,['delivery/REVIEW.md']);
  assert.notEqual(manifest.files['delivery/REVIEW.md'],manifest.sourceHashes['delivery/REVIEW.md']);
  assert.equal(manifest.files['delivery/assets/continuitykit-logo.png'],hash(png));
  assert.match(await readFile(join(f.root,'delivery/REVIEW.md'),'utf8'),new RegExp(f.root));
});

test('Work candidate packages the complete selected implementation and portable proof without replacing Account artifacts',async t=>{
  const f=await workFixture(t);
  const implementation=[
    'work/index.html','work/app.mjs','work/public/favicon.svg',
    'sdk/work-reserve.mjs','sdk/work-reserve.d.ts','sdk/work-browser.mjs','sdk/work-browser.d.ts','sdk/WORK_PROTOCOL.txt',
    'work-release/d1-handler.mjs','work-release/d1-host-worker.mjs','work-release/d1-store.mjs','work-release/d1-worker-entry.mjs',
    'work-release/db/schema.ts','work-release/drizzle/0000_example.sql','work-release/drizzle/meta/_journal.json','work-release/RETENTION.md',
    'tests/work-d1-boundaries.mjs','tests/work-ui-lifecycle.mjs','scripts/verify-work-d1-built.mjs'
  ];
  for(const path of implementation)await f.file(path);
  await f.file('deploy/work-public-2099-01-01/environment.json','Unreviewed deployment state.\n');
  await f.file('work/.openai/hosting.json','Unreviewed project binding.\n');
  await f.file('work/.git/config','Unreviewed Git state.\n');
  await f.file('evidence/portal-many-keys.txt','Unreviewed authenticated portal capture.\n');
  await f.file('evidence/work-native-outage-proof-2026-10-09.json','Unreviewed operational proof.\n');
  const account=await packageCandidate({root:f.root});
  const originalAccountArchive=await readFile(account.archive);
  const originalAccountManifest=await readFile(account.manifestPath);
  const result=await packageCandidate({root:f.root,target:'work'});
  const manifest=JSON.parse(await readFile(result.manifestPath,'utf8'));
  assert.equal(manifest.target,'work');
  assert.equal(manifest.archive,'work-reserve-source-candidate.tgz');
  assert.match(result.manifestPath,/work-source-manifest\.json$/);
  for(const path of [...implementation,...workRequiredFiles,'evidence/public-proof.json'])assert.ok(Object.hasOwn(manifest.files,path),path);
  for(const path of ['deploy/work-public-2099-01-01/environment.json','work/.openai/hosting.json','work/.git/config','evidence/portal-many-keys.txt','evidence/work-native-outage-proof-2026-10-09.json'])assert.ok(!Object.hasOwn(manifest.files,path),path);
  const listed=spawnSync('/usr/bin/tar',['-tzf',result.archive],{encoding:'utf8'});
  assert.equal(listed.status,0,listed.stderr);
  const files=listed.stdout.trim().split('\n');
  assert.equal(files.length,new Set(files).size,'Required delivery files must not be duplicated');
  assert.deepEqual(files.sort(),Object.keys(manifest.files).sort());
  for(const path of workRequiredFiles){
    const extracted=spawnSync('/usr/bin/tar',['-xOzf',result.archive,path]);
    assert.equal(extracted.status,0);
    assert.equal(hash(extracted.stdout),manifest.files[path]);
  }
  assert.deepEqual(await readFile(account.archive),originalAccountArchive);
  assert.deepEqual(await readFile(account.manifestPath),originalAccountManifest);
});

test('Work export fails closed if any required proof, screenshot or completed example is missing',async t=>{
  const f=await workFixture(t);
  for(const path of workRequiredFiles){
    const content=await readFile(join(f.root,path));
    await rm(join(f.root,path));
    await assert.rejects(packageCandidate({root:f.root,target:'work'}),/MANDATORY_WORK_EXPORT_FILE_MISSING/);
    await assert.rejects(readFile(join(f.root,'artifacts/work-reserve-source-candidate.tgz')),{code:'ENOENT'});
    await f.file(path,content);
  }
});

test('Work screenshot must have the declared JPEG type and is exported without conversion',async t=>{
  const f=await workFixture(t);
  const path='evidence/work-recovered-2026-10-09.jpg';
  await f.file(path,png);
  await assert.rejects(packageCandidate({root:f.root,target:'work'}),/EXPECTED_JPEG_ASSET/);
  await f.file(path,jpeg);
  const result=await packageCandidate({root:f.root,target:'work'});
  const extracted=spawnSync('/usr/bin/tar',['-xOzf',result.archive,path]);
  assert.equal(extracted.status,0);
  assert.deepEqual(extracted.stdout,jpeg);
});

test('Work proof rejects operational identifiers and private references instead of silently sanitizing them',async t=>{
  const f=await workFixture(t);
  const path='evidence/work-public-proof.json';
  for(const content of [
    {nested:{project_id:'Synthetic project'}},
    {probe:{requestAuth:'Synthetic dispatch metadata'}},
    {note:'appgdep_synthetic'},
    {source:'deploy/work-public-2099-01-01/probe.json'},
    {source:'artifacts/work-native-2099-01-01/raw-dom.json'}
  ]){
    const bytes=JSON.stringify(content);
    await f.file(path,bytes);
    await assert.rejects(packageCandidate({root:f.root,target:'work'}),/OPERATIONAL_(?:FIELD|REFERENCE)_IN_PUBLIC_PROOF/);
    assert.equal(await readFile(join(f.root,path),'utf8'),bytes);
  }
  await f.file(path,'Invalid JSON fixture');
  await assert.rejects(packageCandidate({root:f.root,target:'work'}),/INVALID_PUBLIC_PROOF_JSON/);
});

test('unknown target is rejected and linked Work outputs cannot overwrite another file',async t=>{
  const f=await workFixture(t);
  await assert.rejects(packageCandidate({root:f.root,target:'unknown'}),/UNKNOWN_EXPORT_TARGET/);
  const external=join(f.temp,'keep.txt');
  await writeFile(external,'Keep this synthetic content.\n');
  await mkdir(join(f.root,'artifacts'));
  await symlink(external,join(f.root,'artifacts/work-reserve-source-candidate.tgz'));
  await assert.rejects(packageCandidate({root:f.root,target:'work'}),/SYMLINK_REJECTED/);
  assert.equal(await readFile(external,'utf8'),'Keep this synthetic content.\n');
});

test('missing mandatory public proof fails before producing an archive',async t=>{
  const f=await fixture(t);
  await rm(join(f.root,'evidence/public-proof.json'));
  await assert.rejects(packageCandidate({root:f.root}),/MANDATORY_EVIDENCE_MISSING/);
  await assert.rejects(readFile(join(f.root,'artifacts/account-reserve-source-candidate.tgz')),{code:'ENOENT'});
});

test('suspected secret data filenames fail closed without needing to read their contents',async t=>{
  const f=await fixture(t);
  for(const path of ['deploy/credentials.json','release/enrollment.secrets.json','sdk/private-key.txt','starter/.env.local','deploy/operator.journal.json','release/signing.pem']){
    await f.file(path,'Synthetic sentinel, not a credential.\n');
    await assert.rejects(packageCandidate({root:f.root}),/SUSPICIOUS_FILENAME_IN_EXPORT/);
    await rm(join(f.root,path));
  }
});

test('file, selected evidence and directory symlinks are rejected',async t=>{
  const f=await fixture(t);
  const external=join(f.temp,'outside.mjs');
  await writeFile(external,'Synthetic external file.\n');
  await symlink(external,join(f.root,'sdk/alias.mjs'));
  await assert.rejects(packageCandidate({root:f.root}),/SYMLINK_REJECTED/);
  await rm(join(f.root,'sdk/alias.mjs'));
  await rm(join(f.root,'evidence/public-proof.json'));
  await symlink(external,join(f.root,'evidence/public-proof.json'));
  await assert.rejects(packageCandidate({root:f.root}),/SYMLINK_REJECTED/);
  await rm(join(f.root,'evidence/public-proof.json'));
  await f.file('evidence/public-proof.json',publicProofBytes);
  await rm(join(f.root,'sdk'),{recursive:true});
  const externalDirectory=join(f.temp,'outside-directory');
  await mkdir(externalDirectory);
  await symlink(externalDirectory,join(f.root,'sdk'));
  await assert.rejects(packageCandidate({root:f.root}),/SYMLINK_REJECTED/);
});

test('hardlinked source files are rejected instead of copying an aliased target',async t=>{
  const f=await fixture(t);
  const external=join(f.temp,'outside.mjs');
  await writeFile(external,'Synthetic external file.\n');
  await link(external,join(f.root,'sdk/alias.mjs'));
  await assert.rejects(packageCandidate({root:f.root}),/HARDLINK_REJECTED/);
  assert.equal(await readFile(external,'utf8'),'Synthetic external file.\n');
});

test('unexpected personal paths in source are rejected rather than silently scrubbed',async t=>{
  const f=await fixture(t);
  const personalPath=['','Users','fixture-owner','private','value'].join('/');
  await f.file('sdk/index.mjs',`// ${personalPath}\n`);
  await assert.rejects(packageCandidate({root:f.root}),/PRIVATE_PATH_IN_EXPORT/);
  assert.equal(await readFile(join(f.root,'sdk/index.mjs'),'utf8'),`// ${personalPath}\n`);
});

test('existing linked output cannot overwrite another file',async t=>{
  const f=await fixture(t);
  const external=join(f.temp,'keep.txt');
  await writeFile(external,'Keep this synthetic content.\n');
  await mkdir(join(f.root,'artifacts'));
  await symlink(external,join(f.root,'artifacts/account-reserve-source-candidate.tgz'));
  await assert.rejects(packageCandidate({root:f.root}),/SYMLINK_REJECTED/);
  assert.equal(await readFile(external,'utf8'),'Keep this synthetic content.\n');
});

test('portable proof keeps historical chain observations distinct from the later unmeasured enrollment update',()=>{
  const proof=JSON.parse(publicProofBytes);
  assert.equal(proof.format,'account-reserve-public-proof/v1');
  assert.match(proof.scope,/historical.*not a fresh network check/i);
  assert.equal(proof.network.chainId,10143);
  assert.deepEqual(proof.nativeRun.versions,{primary:3,reserve:2});
  assert.equal(proof.nativeRun.exactVisiblePromptCount,null);
  assert.equal(proof.nativeRun.observations.primaryHttpStatus,503);
  assert.equal(proof.nativeRun.observations.newCredentialDuringRecovery,false);
  assert.equal(proof.nativeRun.observations.signingSessionClosed,true);
  assert.equal(proof.nativeRun.primaryRestoration.restored,true);
  assert.ok(proof.nativeRun.primaryRestoration.checks.every(check=>check.status===200));
  const claim=proof.claim;
  assert.equal(claim.beneficiary,proof.nativeRun.beneficiary);
  assert.equal(claim.hash,'0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5');
  assert.equal(claim.finalizedBlock,'69286156');
  assert.equal(claim.status,'success');
  assert.equal(claim.transactionValueWei,'0');
  assert.equal(claim.calldata,'0x379607f5'+BigInt(claim.rightId).toString(16).padStart(64,'0'));
  assert.deepEqual(claim.rpcObservations.map(o=>o.rpc),['https://testnet-rpc.monad.xyz','https://rpc-testnet.monadinfra.com']);
  for(const o of claim.rpcObservations){
    assert.equal(o.chainId,10143);
    assert.equal(o.transactionHash,claim.hash);
    assert.equal(o.receiptStatus,claim.status);
    assert.equal(o.receiptBlock,claim.finalizedBlock);
    assert.equal(o.receiptBlockHash,claim.blockHash);
    assert.equal(o.canonicalBlockHash,claim.blockHash);
    assert.ok(BigInt(o.finalizedHead)>=BigInt(o.receiptBlock));
    assert.deepEqual(o.event,{name:'RightClaimed',id:claim.rightId,beneficiary:claim.beneficiary,amountWei:claim.amountWei});
    assert.deepEqual(o.right,{beneficiary:claim.beneficiary,amountWei:claim.amountWei,claimed:true});
  }
  const update=proof.publishedEnrollmentUpdate;
  assert.deepEqual(update.sites.map(s=>[s.role,s.version]),[['primary',4],['reserve',3]]);
  assert.ok(update.sites.every(s=>s.status==='succeeded'&&/^https:\/\//.test(s.url)));
  assert.equal(update.localValidation.testCount,318);
  assert.equal(update.physicalOptimizedPathTested,false);
  assert.equal(update.visiblePromptCountMeasured,false);
  assert.equal(update.newPasskeys,false);
  assert.equal(update.extraTransactions,false);
  const bannedKeys=new Set(['credentialId','locator','privateKey','prfOutput','prfSalt','checkout_path','archive','project_id','deployment_id','env_set_revision','entries','approval','token']);
  function inspect(value){if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){assert.ok(!bannedKeys.has(key),'Unexpected operational field: '+key);inspect(item);}}
  inspect(proof);
  assert.doesNotMatch(publicProofBytes.toString('utf8'),/\/Users\/[^/\s]+\/|\/var\/folders\//);
});
