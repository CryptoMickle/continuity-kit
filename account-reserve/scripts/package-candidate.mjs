import {readdir,readFile,writeFile,mkdir,lstat,mkdtemp,rm,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const defaultRoot=fileURLToPath(new URL('..',import.meta.url));
const top=['LICENSE','README.md','SECURITY.md','package.json','package-lock.json','index.html','vite.config.mjs','app.mjs','app-session.mjs','app-setup.mjs','app-progress.mjs','style.css','server.mjs','handoff.mjs','transaction.mjs','pending-ticket.mjs'];
const directories=['sdk','starter','work','work-release','chain','tests','scripts','release','deploy','delivery'];
// Reviewed source-only additions. Do not recursively walk these operationally
// capable templates: private/ and arbitrary JSON can contain live grants/state.
// The two EasyMDE dist files are immutable upstream inputs with pinned hashes.
const sourceAdditions={
  'text-native':[
    '.gitignore','.npmignore','README.md','package.json','profile.mjs','profile.example.json','profile.collection.example.json','ports.example.json',
    'adapter.mjs','index.html','main.mjs','style.css','collection-index.html','collection-main.mjs','collection-style.css','prism-art.mjs',
    'build.mjs','doctor.mjs','operator.mjs','native-host.mjs','operator-state.mjs','operator-backup.mjs','operator-readiness.mjs','operator-diagnostics.mjs','operate.mjs','operator-worker.mjs',
    ...['profile.mjs','store.mjs','host.mjs','replica-gateway.mjs','cli.mjs'].map(name=>'operator-runtime/'+name),
  ],
  'text-starter':[
    'README.md','package.json','package-lock.json','adapter.mjs','index.html','main.mjs','style.css','config.mjs','server.mjs','doctor.mjs','vite.config.mjs','synthetic-client.mjs','loopback-fetch.mjs','smoke.mjs','recover-process.mjs',
    'replica-server.mjs','replica-worker.mjs','replica-transport.mjs','replica-smoke.mjs','replica-recover-process.mjs',
    'collection-config.mjs','collection-index.html','collection-main.mjs','collection-server.mjs','collection-smoke.mjs','collection-style.css',
    ...['profile.mjs','store.mjs','host.mjs','replica-gateway.mjs'].map(name=>'operator-runtime/'+name),
  ],
  operator:['README.md','package.json','profile.example.json','replicas.example.json','profile.mjs','store.mjs','host.mjs','replica-gateway.mjs','cli.mjs','create.mjs','drill-worker.mjs'],
  integrations:[
    'payment-client/actions.mjs','payment-client/README.md',
    ...['textarea','textarea-text'].flatMap(name=>['.gitignore','LICENSE','README.md','adapter.mjs','config.mjs','controls.html','create.mjs','editor-test-host.mjs','index.html','loopback-fetch.mjs','main.mjs','package-lock.json','package.json','plain-text-editing.mjs','provenance.json','server.mjs','smoke.mjs','style.css','synthetic-client.mjs','upstream-build.mjs','upstream/LICENSE','upstream/index.html','vite.config.mjs'].map(file=>name+'/'+file)),
    ...['.gitignore','README.md','THIRD_PARTY_NOTICES.txt','build.mjs','package-lock.json','package.json','provenance.json','src/easymde-editor.mjs','src/editors.css','src/plain-text-editing.mjs','src/textarea-shell.mjs','tests/editors.mjs','vendor/textarea/LICENSE','vendor/textarea/index.html','vendor/easymde/LICENSE','vendor/easymde/codemirror-LICENSE','vendor/easymde/codemirror-spell-checker-LICENSE','vendor/easymde/marked-LICENSE','vendor/easymde/typo-js-LICENSE','vendor/easymde/package.json','vendor/easymde/src/js/easymde.js','vendor/easymde/dist/easymde.min.js','vendor/easymde/dist/easymde.min.css'].map(file=>'multi-app/'+file),
  ],
  'self-service':['.gitignore','README.md','apps/config.mjs','apps/app.mjs','apps/style.css','apps/collection.mjs','apps/index.html','client/config.mjs','client/app.mjs','client/style.css','client/public/favicon.svg','client/index.html','text/config.mjs','text/app.mjs','text/style.css','text/index.html','backend/profile.mjs','backend/store.mjs','backend/host.mjs','backend/entry.mjs','backend/schema.sql','backend/db/schema.ts','backend/drizzle.config.mjs','backend/drizzle/0000_self_service_judge.sql','backend/drizzle/meta/_journal.json','backend/drizzle/meta/0000_snapshot.json'],
  payments:['index.mjs','index.d.ts','SequentialPayment.sol','SequentialPayment.artifact.json','build.mjs','harness.mjs','pending.mjs','executor.mjs','guard.mjs','testnet.mjs','proposal.mjs','operator.mjs','operator-journal.mjs','operator-runner.mjs','verify-claim.mjs','index.html','main.mjs','page.mjs','style.css','build-browser.mjs','build-sites.mjs','site-handler.mjs'],
};
const optionalSourceDocuments=['payments/README.md'];
const excludedDirectories=new Set(['cache','out','node_modules','dist','build','artifacts','private','runtime','state','journals','backups']);
const legacyDataFiles=new Set(['deploy/PaymentRight.paris.json','deploy/local-validation.json','deploy/operator-validation.json','deploy/proposal-input.template.json','release/disabled-profile.json']);

// Operational logs, cloud responses, native session IDs and personal paths stay local.
const optionalEvidence=['verification.json','native-proof-public.json','design-review.json','prism-integration.json','onboarding-browser.json','starter-design-review.json','prephysical-browser.json'];
const mandatoryEvidence=['public-proof.json'];
const workRequiredFiles=['evidence/work-public-proof.json','evidence/work-finished-export-2026-10-09.json','evidence/work-recovered-2026-10-09.jpg','delivery/examples/finished-checkout.txt','delivery/examples/finished-checkout.json'];
const publicBinaryAssets=new Set(['delivery/assets/continuitykit-logo.png','evidence/work-recovered-2026-10-09.jpg']);
const targets={account:{archive:'account-reserve-source-candidate.tgz',manifest:'manifest.json'},work:{archive:'work-reserve-source-candidate.tgz',manifest:'work-source-manifest.json'}};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,file)=>{throw new Error(code+(file?': '+file:''));};
const suspiciousName=name=>/^\.env(?:\.|$)/i.test(name)||/\.(?:secrets?|server|journal)\.json$/i.test(name)||(/\.(?:json|txt|toml|ya?ml|ini|pem|key|p12|pfx|env|bin)$/i.test(name)&&/(?:secret|credential|token|password|private[-_.]?key|journal)/i.test(name))||/\.(?:pem|key|p12|pfx)$/i.test(name);
const operationalProofKeys=new Set(['credentialId','locator','privateKey','prfOutput','prfSalt','checkout_path','project_id','deployment_id','version_id','env_set_revision','token','approval','requestAuth']);

function inspectWorkProof(text,file){
  let proof;
  try{proof=JSON.parse(text);}catch{fail('INVALID_PUBLIC_PROOF_JSON',file);}
  function inspectValue(value){
    if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){
      if(operationalProofKeys.has(key))fail('OPERATIONAL_FIELD_IN_PUBLIC_PROOF',file+': '+key);
      inspectValue(item);
    }
    else if(typeof value==='string'&&(/\bappg(?:prj|dep|ver)_/.test(value)||/\b(?:deploy\/work-public-|artifacts\/work-native-)/.test(value)))fail('OPERATIONAL_REFERENCE_IN_PUBLIC_PROOF',file);
  }
  inspectValue(proof);
}

async function inspect(path,label,{directory=false}={}){
  const stat=await lstat(path);
  if(stat.isSymbolicLink())fail('SYMLINK_REJECTED',label);
  if(directory?!stat.isDirectory():!stat.isFile())fail('SPECIAL_FILE_REJECTED',label);
  if(!directory&&stat.nlink!==1)fail('HARDLINK_REJECTED',label);
  return stat;
}

async function readSingleFile(path,label){
  const before=await inspect(path,label);
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const after=await handle.stat();
    if(!after.isFile()||after.nlink!==1)fail('HARDLINK_OR_SPECIAL_FILE_REJECTED',label);
    if(before.dev!==after.dev||before.ino!==after.ino)fail('SOURCE_CHANGED_DURING_READ',label);
    return await handle.readFile();
  }finally{await handle.close();}
}

export async function packageCandidate({root=defaultRoot,artifactDirectory,target='account'}={}){
  if(!Object.hasOwn(targets,target))fail('UNKNOWN_EXPORT_TARGET',target);
  const output=targets[target];
  root=resolve(root);
  const artifacts=resolve(artifactDirectory??join(root,'artifacts'));
  await inspect(root,'source root',{directory:true});
  const files=[...top];
  async function collect(relative){
    await inspect(join(root,relative),relative,{directory:true});
    for(const item of await readdir(join(root,relative),{withFileTypes:true})){
      const file=relative+'/'+item.name;
      if(relative==='deploy'&&(item.isDirectory()||item.name.startsWith('work-public-')))continue;
      if(suspiciousName(item.name)&&file!=='work-release/drizzle/meta/_journal.json')fail('SUSPICIOUS_FILENAME_IN_EXPORT',file);
      if(item.name.startsWith('.')||excludedDirectories.has(item.name)||item.name.startsWith('dist-'))continue;
      if(relative==='work-release/db'&&item.name!=='schema.ts')continue;
      if((relative==='deploy'||relative==='release')&&item.name.endsWith('.json')&&!legacyDataFiles.has(file))continue;
      if(item.isSymbolicLink())fail('SYMLINK_REJECTED',file);
      if(item.isDirectory())await collect(file);
      else if(publicBinaryAssets.has(file)||file==='work/public/favicon.svg'||/\.(mjs|ts|json|sol|sql|sb|txt|md|html|css|toml)$/.test(item.name))files.push(file);
    }
  }
  for(const directory of directories)await collect(directory);
  for(const [directory,selected] of Object.entries(sourceAdditions)){
    try{await inspect(join(root,directory),directory,{directory:true});}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const name of selected){
      const file=directory+'/'+name;
      // Each selected ancestor is checked as well as the final file. A symlink
      // to an outside vendor/runtime directory must not bypass source guards.
      let parent=directory;
      for(const component of name.split('/').slice(0,-1)){
        parent+='/'+component;await inspect(join(root,parent),parent,{directory:true});
      }
      await inspect(join(root,file),file);files.push(file);
    }
  }
  for(const file of optionalSourceDocuments){
    try{await inspect(join(root,file),file);files.push(file);}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  await inspect(join(root,'evidence'),'evidence',{directory:true});
  for(const name of mandatoryEvidence){
    try{await inspect(join(root,'evidence',name),'evidence/'+name);}
    catch(error){if(error.code==='ENOENT')fail('MANDATORY_EVIDENCE_MISSING','evidence/'+name);throw error;}
    files.push('evidence/'+name);
  }
  for(const name of optionalEvidence){
    try{await inspect(join(root,'evidence',name),'evidence/'+name);files.push('evidence/'+name);}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(target==='work')for(const file of workRequiredFiles){
    try{await inspect(join(root,file),file);}
    catch(error){if(error.code==='ENOENT')fail('MANDATORY_WORK_EXPORT_FILE_MISSING',file);throw error;}
    if(!files.includes(file))files.push(file);
  }
  files.sort();
  const hashes={},sourceHashes={},transformed=[];
  const staging=await mkdtemp(join(tmpdir(),'account-reserve-export-'));
  try{
    for(const file of files){
      const original=await readSingleFile(join(root,file),file);sourceHashes[file]=sha256(original);
      let bytes=original;
      if(publicBinaryAssets.has(file)){
        if(file.endsWith('.jpg')){
          if(!original.subarray(0,3).equals(Buffer.from([255,216,255]))||!original.subarray(-2).equals(Buffer.from([255,217])))fail('EXPECTED_JPEG_ASSET',file);
        }else if(!original.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('EXPECTED_PNG_ASSET',file);
      }else{
        let text=original.toString('utf8');
        if(file.startsWith('delivery/'))text=text.replaceAll(root,'<project>').replace(/\/private\/tmp\/continuity-physical-[\w-]+/g,'<local-physical-snapshot>');
        // Never silently scrub source code. Refuse unexpected workstation details.
        if(/\/Users\/[^/\s]+\/|\/var\/folders\//.test(text))fail('PRIVATE_PATH_IN_EXPORT',file);
        if(target==='work'&&file.startsWith('evidence/work-')&&file.endsWith('.json'))inspectWorkProof(text,file);
        bytes=Buffer.from(text);
      }
      if(!bytes.equals(original))transformed.push(file);
      hashes[file]=sha256(bytes);await mkdir(dirname(join(staging,file)),{recursive:true});await writeFile(join(staging,file),bytes);
    }
    await mkdir(artifacts,{recursive:true});
    await inspect(artifacts,'artifact directory',{directory:true});
    const archive=join(artifacts,output.archive);
    const manifestPath=join(artifacts,output.manifest);
    // Refuse existing output aliases rather than overwrite their linked targets.
    for(const path of [archive,manifestPath])try{await inspect(path,'artifact output');}catch(error){if(error.code!=='ENOENT')throw error;}
    const packed=spawnSync('/usr/bin/tar',['-czf',archive,'-C',staging,...files],{encoding:'utf8',env:{...process.env,COPYFILE_DISABLE:'1'}});
    if(packed.status!==0)fail(packed.stderr||'ARCHIVE_FAILED');
    const archiveSha256=sha256(await readFile(archive));
    const manifest={generatedAt:new Date().toISOString(),status:'local-unpublished-candidate',target,archive:output.archive,archiveSha256,fileCount:files.length,files:hashes,sourceHashes,transformed,transform:'Only delivery-document workstation paths are replaced in export copies; originals preserved.',excluded:['node_modules','generated dist/build outputs (except two pinned EasyMDE vendor inputs)','unselected files in reviewed new source trees','private operator state/backups/grants/databases/runtime locks','Site deployment workers and live proposal/approval/journal files','private credentials','operator journals','deploy/work-public-* operational deployments','raw operational evidence/logs and authenticated portal captures','old data-only demo','user attachments'],secretAudit:'Reviewed legacy input directories and exact source additions, mandatory public proof, suspicious data-filename rejection, no symbolic/hard links, a private-path guard and operational-field rejection in selected Work proof JSON; not a guarantee that arbitrary source is secret-free. Review before publication.'};
    await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
    return {archive,manifestPath,target,fileCount:files.length,sha256:archiveSha256,transformed};
  }finally{await rm(staging,{recursive:true,force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const options={};
  for(const argument of process.argv.slice(2)){
    if(argument.startsWith('--target='))options.target=argument.slice('--target='.length);
    else if(argument.startsWith('--artifact-directory='))options.artifactDirectory=argument.slice('--artifact-directory='.length);
    else fail('UNKNOWN_EXPORT_ARGUMENT',argument);
  }
  console.log(JSON.stringify(await packageCandidate(options)));
}
