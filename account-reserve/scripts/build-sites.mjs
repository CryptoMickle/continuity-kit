import {build} from 'vite';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateClientProfile} from '../release/client-profile.mjs';
import {httpsOrigin} from '../release/profile.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const profilePath=resolve(process.argv[2]??join(root,'release/disabled-profile.json'));
const supplied=JSON.parse(await readFile(profilePath,'utf8'));
const profile=supplied.enabled===false?{enabled:false}:validateClientProfile(supplied);
const redisOrigin=process.argv[3]??null;
if(profile.enabled)httpsOrigin(redisOrigin);
await build({root,configFile:join(root,'vite.config.mjs')});
const assets={};
async function collect(dir,path=''){
  for(const item of await readdir(dir,{withFileTypes:true})){
    if(item.isSymbolicLink())throw new Error('ASSET_SYMLINK_REJECTED');
    const child=path+'/'+item.name;
    if(item.isDirectory())await collect(join(dir,item.name),child);
    else {const bytes=await readFile(join(dir,item.name));if(bytes.length>2*1024*1024)throw new Error('ASSET_TOO_LARGE');assets[child]={base64:bytes.toString('base64'),contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'})[extname(item.name)]??'application/octet-stream'};}
  }
}
await collect(join(root,'dist'));
const outputs=[];
for(const role of ['primary','recovery']){
  const siteRoot=join(root,'artifacts','sites-'+role);
  await build({root,configFile:false,define:{__ACCOUNT_RELEASE_PROFILE__:JSON.stringify(profile),__ACCOUNT_CLIENT_ROLE__:JSON.stringify(role),__ACCOUNT_CLIENT_ASSETS__:JSON.stringify(assets),__ACCOUNT_REDIS_ORIGIN__:JSON.stringify(redisOrigin)},build:{ssr:join(root,'release/worker-entry.mjs'),target:'es2022',outDir:join(siteRoot,'dist/server'),emptyOutDir:true,rollupOptions:{output:{entryFileNames:'index.js'}}},ssr:{noExternal:true}});
  await writeFile(join(siteRoot,'package.json'),JSON.stringify({private:true,type:'module'},null,2)+'\n');
  const entry=join(siteRoot,'dist/server/index.js');
  const worker=(await import(entry+'?verify='+Date.now())).default;
  if(typeof worker?.fetch!=='function')throw new Error('WORKER_FETCH_MISSING');
  if(!profile.enabled&&(await worker.fetch(new Request('https://disabled.example.invalid/'))).status!==503)throw new Error('DISABLED_PROFILE_NOT_CLOSED');
  if(profile.enabled){
    // A config request constructs the B adapter but performs no storage request.
    // Catch build/runtime configuration disagreement before a real deployment.
    const origin=role==='primary'?profile.primaryOrigin:profile.recoveryOrigin;
    const bindings={RESERVE_REDIS_REST_URL:redisOrigin,RESERVE_REDIS_REST_TOKEN:'build-only-placeholder',RESERVE_ENROLLMENT_TICKET_HASHES:'[]'};
    const result=await worker.fetch(new Request(origin+'/api/config'),bindings);
    if(result.status!==200||(await result.json()).role!==role)throw new Error('BUILT_CONFIGURATION_UNAVAILABLE');
  }
  outputs.push({role,path:siteRoot,workerSha256:createHash('sha256').update(await readFile(entry)).digest('hex')});
}
await mkdir(join(root,'artifacts'),{recursive:true});
await writeFile(join(root,'artifacts/sites-candidate.json'),JSON.stringify({status:profile.enabled?'configured-local-only-unpublished':'disabled-unpublished-build',profile,outputs,hostingProjectIdsAssigned:false,redisCredentialIncluded:false,enrollmentTokenIncluded:false},null,2)+'\n');
console.log(JSON.stringify({status:profile.enabled?'configured-local-only-unpublished':'disabled-unpublished-build',outputs}));
