import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw new Error(code);};
const json=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
const relative=path=>typeof path==='string'&&path.length>0&&!path.startsWith('/')&&path.split('/').every(p=>p!=='.'&&p!=='..'&&p!==''&&!p.startsWith('.'));

// Files-only handoff: never creates cloud resources, secrets, accounts or wallets.
// Freeze the exact passed build/source. Approval and execution remain separate.
export async function prepareApproval(directory){
  if(typeof directory!=='string'||!directory)fail('NEW_OUTPUT_DIRECTORY_REQUIRED');
  const verification=await json('evidence/verification.json');
  const expected=['build','tests','onboarding','http-boundaries','release-tests','sites-build'];
  if(verification.stages?.length!==expected.length||expected.some((name,i)=>verification.stages[i].name!==name||verification.stages[i].passed!==true||verification.stages[i].exitCode!==0))fail('VERIFICATION_NOT_PASSED');
  for(const [path,digest] of Object.entries(verification.sourceHashes??{})){
    if(!relative(path)||hash(await readFile(join(root,path)))!==digest)fail('VERIFICATION_SOURCE_CHANGED');
  }
  if(Object.keys(verification.sourceHashes??{}).length<15)fail('VERIFICATION_INCOMPLETE');
  const manifest=await json('artifacts/manifest.json');
  if(manifest.archive!=='account-reserve-source-candidate.tgz'||manifest.fileCount!==Object.keys(manifest.files).length)fail('SOURCE_MANIFEST_INVALID');
  for(const [path,digest] of Object.entries(manifest.sourceHashes??{})){
    if(!relative(path)||hash(await readFile(join(root,path)))!==digest)fail('SOURCE_EXPORT_STALE');
  }
  if(Object.keys(manifest.sourceHashes??{}).length!==manifest.fileCount)fail('SOURCE_HASHES_MISSING');
  const source=await readFile(join(root,'artifacts',manifest.archive));
  if(hash(source)!==manifest.archiveSha256)fail('SOURCE_ARCHIVE_CHANGED');
  const sites=await json('artifacts/sites-candidate.json');
  if(sites.status!=='disabled-unpublished-build'||sites.profile?.enabled!==false||sites.outputs?.length!==2)fail('DISABLED_CANDIDATE_REQUIRED');
  const bundle={['source.tgz']:source,['source-manifest.json']:Buffer.from(JSON.stringify(manifest,null,2)+'\n')};
  for(const role of ['primary','recovery']){
    const item=sites.outputs.find(item=>item.role===role);
    const path=join(root,'artifacts','sites-'+role,'dist/server/index.js');
    if(!item||(await lstat(path)).isSymbolicLink())fail('WORKER_INVALID');
    const bytes=await readFile(path);
    if(hash(bytes)!==item.workerSha256)fail('WORKER_CHANGED');
    bundle[role+'-disabled-worker.mjs']=bytes;
  }
  const packet={
    format:'account-reserve-review-packet/v1',generatedAt:new Date().toISOString(),status:'local-review-only',
    publicExecutionReady:false,approved:false,verificationAt:verification.generatedAt,
    files:Object.fromEntries(Object.entries(bundle).map(([name,bytes])=>[name,{sha256:hash(bytes),bytes:bytes.length}])),
    proposedSites:[{title:'ContinuityKit Account Primary',slug:'continuitykit-account-primary',projectId:null,origin:null},{title:'ContinuityKit Account Reserve',slug:'continuitykit-account-reserve',projectId:null,origin:null}],
    storage:{existingResource:'continuity-kit-metropolis',newResource:false,newNamespace:true,maxRecords:16,maxRecordBytes:65536,expiresAt:null},
    licenseRecommendation:'MIT for owned source only; selection pending',
    transactions:{network:'Monad testnet',chainId:10143,count:4,maxTotalFeeTestMon:'0.326',issuerStartingCoverageTestMon:'0.426',actorsAssigned:false,proposalApproved:false},
    remaining:['Approve registration of exactly two separate Sites; assign actual returned origins/IDs','Choose source license and review exact export before publishing','Bind current database endpoint/secret through server configuration, namespace and absolute expiry','Assign actual disposable issuer and beneficiary, build exact proposal and approve bounded testnet ceremony','Build enabled artifact from frozen actual profile; repeat hosted checks before public release'],
    limits:'Disabled workers are not a live demo. Native local proof is separate. No secret, approval, hosting identity or public transaction is created by this packet.'
  };
  const output=resolve(directory);await mkdir(output,{mode:0o700});
  for(const [name,bytes] of Object.entries(bundle))await writeFile(join(output,name),bytes,{flag:'wx',mode:0o600});
  await writeFile(join(output,'review.json'),JSON.stringify(packet,null,2)+'\n',{flag:'wx',mode:0o600});
  return {directory:output,status:packet.status,publicExecutionReady:false,files:packet.files};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3)fail('USE_NEW_OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await prepareApproval(process.argv[2])));
}
