import { build } from 'vite';
import { readFile, readdir, mkdir, writeFile, lstat, cp } from 'node:fs/promises';
import { resolve, join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateWorkReleaseProfile } from '../work-release/profile.mjs';
import { httpsOrigin } from '../release/profile.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Compiles public, secret-free Workers only. No Site registration, upload,
// deployment, credential issuance, database access or native passkey operation.
export async function buildWorkSites({profilePath=join(root,'work-release/disabled-profile.json'),redisOrigin=null,storage='redis'}={}) {
  if (!['redis','d1'].includes(storage) || (storage==='d1' && redisOrigin!==null)) throw new Error('WORK_STORAGE_INVALID');
  const d1=storage==='d1', prefix=d1?'work-d1':'work';
  const path=resolve(profilePath), info=await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink!==1 || info.size>16384) throw new Error('WORK_PROFILE_FILE_INVALID');
  const supplied=JSON.parse(await readFile(path,'utf8'));
  const profile=validateWorkReleaseProfile(supplied)??{enabled:false};
  if (profile.enabled && !d1) httpsOrigin(redisOrigin);
  else if (redisOrigin!==null) throw new Error('WORK_DISABLED_STORE_REJECTED');
  const clientRoot=join(root,'artifacts/'+prefix+'-hosted-client');
  await build({root:join(root,'work'),configFile:join(root,'work/vite.config.mjs'),define:{__WORK_HOSTED_ONLY__:'true',__WORK_D1_HOSTED__:JSON.stringify(d1)},build:{outDir:clientRoot,emptyOutDir:true}});
  const assets={};
  async function collect(directory, prefix='') {
    for (const item of await readdir(directory,{withFileTypes:true})) {
      const path=join(directory,item.name), key=prefix+'/'+item.name;
      if (item.isSymbolicLink()) throw new Error('WORK_ASSET_SYMLINK');
      if (item.isDirectory()) await collect(path,key);
      else {
        const info=await lstat(path);
        if (!info.isFile() || info.nlink!==1 || info.size>2*1024*1024) throw new Error('WORK_ASSET_INVALID');
        const bytes=await readFile(path);
        if (/\.js$/.test(key) && /\/api\/synthetic|SYNTHETIC_CREDENTIAL_UNAVAILABLE/.test(bytes.toString())) throw new Error('WORK_SYNTHETIC_ADAPTER_IN_HOSTED_BUILD');
        assets[key]={base64:bytes.toString('base64'),contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'})[extname(item.name)]??'application/octet-stream'};
      }
    }
  }
  await collect(clientRoot);
  const outputs=[];
  for (const role of ['primary','recovery']) {
    const siteRoot=join(root,'artifacts/'+prefix+'-sites-'+role);
    await build({root,configFile:false,define:{__WORK_RELEASE_PROFILE__:JSON.stringify(profile),__WORK_CLIENT_ROLE__:JSON.stringify(role),__WORK_CLIENT_ASSETS__:JSON.stringify(assets),__WORK_REDIS_ORIGIN__:JSON.stringify(redisOrigin)},build:{ssr:join(root,d1?'work-release/d1-worker-entry.mjs':'work-release/worker-entry.mjs'),target:'es2022',outDir:join(siteRoot,'dist/server'),emptyOutDir:true,rollupOptions:{output:{entryFileNames:'index.js'}}},ssr:{noExternal:true}});
    await writeFile(join(siteRoot,'package.json'),JSON.stringify({private:true,type:'module'},null,2)+'\n');
    if(d1 && role==='recovery') {
      await cp(join(root,'work-release/db'),join(siteRoot,'db'),{recursive:true});
      await cp(join(root,'work-release/drizzle'),join(siteRoot,'drizzle'),{recursive:true});
    }
    const entry=join(siteRoot,'dist/server/index.js');
    const worker=(await import(entry+'?verify='+Date.now())).default;
    if (typeof worker?.fetch!=='function') throw new Error('WORK_FETCH_MISSING');
    if (!profile.enabled) {
      if ((await worker.fetch(new Request('https://disabled.example.invalid/'))).status!==503) throw new Error('WORK_DISABLED_NOT_CLOSED');
    } else {
      const origin=role==='primary'?profile.primaryOrigin:profile.recoveryOrigin;
      const env=d1?{DB:{prepare(){throw new Error('BUILD_DATABASE_ACCESS');},batch(){throw new Error('BUILD_DATABASE_ACCESS');}},RESERVE_ENROLLMENT_TICKET_HASHES:'[]'}:{RESERVE_REDIS_REST_URL:redisOrigin,RESERVE_REDIS_REST_TOKEN:'build-only-placeholder',RESERVE_ENROLLMENT_TICKET_HASHES:'[]'};
      const response=await worker.fetch(new Request(origin+'/api/config'),env);
      if (response.status!==200) throw new Error('WORK_BUILT_CONFIG_UNAVAILABLE');
      const config=await response.json();
      if (config.role!==role || config.synthetic!==false || config.physicalEnabled!==true || 'enrollmentToken' in config) throw new Error('WORK_BUILT_CONFIG_INVALID');
      for (const route of ['/api/synthetic','/rpc','/api/primary','/api/status']) {
        if ((await worker.fetch(new Request(origin+route),env)).status!==404) throw new Error('WORK_LOCAL_ROUTE_EXPOSED');
      }
      const page=await worker.fetch(new Request(origin+'/'),env);
      if (page.status!==200 || !page.headers.get('content-security-policy')?.includes("connect-src 'self'")) throw new Error('WORK_ASSETS_UNAVAILABLE');
    }
    outputs.push({role,path:relative(root,siteRoot),workerSha256:hash(await readFile(entry))});
  }
  const candidate={format:'continuity-work-sites-candidate/v1',generatedAt:new Date().toISOString(),status:profile.enabled?'configured-local-unpublished':'disabled-local-unpublished',storage,profile,redisOrigin,outputs,hostingProjectIdsAssigned:false,serverSecretsIncluded:false,enrollmentCodesIssued:false,nativePasskeysCreated:false,deployed:false};
  await mkdir(join(root,'artifacts'),{recursive:true});
  await writeFile(join(root,'artifacts/'+prefix+'-sites-candidate.json'),JSON.stringify(candidate,null,2)+'\n');
  return candidate;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if (process.argv.length>4) throw new Error('USE_PUBLIC_PROFILE_AND_REDIS_ORIGIN_ONLY');
  console.log(JSON.stringify(await buildWorkSites({profilePath:process.argv[2],redisOrigin:process.argv[3]??null})));
  if(process.argv.length===2) console.log(JSON.stringify(await buildWorkSites({storage:'d1'})));
}
