import { build } from 'vite';
import { readFile, readdir, mkdir, writeFile, lstat, cp } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateSelfServiceProfile } from '../self-service/backend/profile.mjs';

// Reproducible, secret-free build. Does not issue capabilities or touch D1.
export async function buildSelfServiceSite(root, role) {
  if (!['primary','recovery'].includes(role)) throw Error('ROLE_REQUIRED');
  const profile = JSON.parse(await readFile(join(root,'self-service/profile.json'),'utf8'));
  if (!validateSelfServiceProfile(profile)) throw Error('ENABLED_PROFILE_REQUIRED');
  const manifest = JSON.parse(await readFile(join(root,'.openai/hosting.json'),'utf8'));
  if (!manifest.project_id || (role==='recovery' && manifest.d1!=='DB') || (role==='primary' && manifest.d1)) throw Error('HOSTING_MANIFEST_INVALID');
  const client = join(root,'artifacts/self-service-client');
  await build({root:join(root,'self-service/client'),configFile:false,build:{target:'es2022',outDir:client,emptyOutDir:true}});
  const assets = {};
  async function collect(dir, prefix='') {
    for (const item of await readdir(dir,{withFileTypes:true})) {
      const path=join(dir,item.name), key=prefix+'/'+item.name, stat=await lstat(path);
      if (stat.isSymbolicLink()) throw Error('ASSET_SYMLINK');
      if (stat.isDirectory()) { await collect(path,key); continue; }
      if (!stat.isFile() || stat.size>2*1024*1024) throw Error('ASSET_INVALID');
      const bytes=await readFile(path);
      if (key.endsWith('.js') && /SYNTHETIC_CREDENTIAL_UNAVAILABLE|\/api\/synthetic|createSyntheticClient/.test(bytes.toString())) throw Error('SYNTHETIC_ADAPTER_REJECTED');
      assets[key]={base64:bytes.toString('base64'),contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'})[extname(key)]??'application/octet-stream'};
    }
  }
  await collect(client);
  await build({root,configFile:false,define:{__SELF_SERVICE_PROFILE__:JSON.stringify(profile),__SELF_SERVICE_ROLE__:JSON.stringify(role),__SELF_SERVICE_ASSETS__:JSON.stringify(assets)},build:{ssr:join(root,'self-service/backend/entry.mjs'),target:'es2022',outDir:join(root,'dist/server'),emptyOutDir:true,rollupOptions:{output:{entryFileNames:'index.js'}}},ssr:{noExternal:true}});
  const entry=join(root,'dist/server/index.js'), worker=(await import(entry+'?check='+Date.now())).default;
  const env={DB:{prepare(){throw Error('BUILD_DATABASE_ACCESS');},batch(){throw Error('BUILD_DATABASE_ACCESS');}}};
  const origin=role==='primary'?profile.primaryOrigin:profile.recoveryOrigin;
  const config=await worker.fetch(new Request(origin+'/api/config'),env);
  if(config.status!==200) throw Error('CONFIG_UNAVAILABLE');
  const value=await config.json();
  if(value.role!==role || !value.selfService || value.synthetic!==false || !value.physicalEnabled || 'enrollmentToken' in value) throw Error('CONFIG_INVALID');
  const page=await worker.fetch(new Request(origin+'/'),env);
  if(page.status!==200 || !page.headers.get('content-security-policy')?.includes("connect-src 'self'")) throw Error('PAGE_INVALID');
  for(const path of ['/api/synthetic','/rpc','/api/primary','/api/status']) if((await worker.fetch(new Request(origin+path),env)).status!==404) throw Error('UNEXPECTED_ROUTE');
  await mkdir(join(root,'dist/.openai'),{recursive:true});
  await cp(join(root,'.openai/hosting.json'),join(root,'dist/.openai/hosting.json'));
  return {role,projectId:manifest.project_id,workerSha256:createHash('sha256').update(await readFile(entry)).digest('hex'),nativePasskeysCreated:false};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('..',import.meta.url));
  console.log(JSON.stringify(await buildSelfServiceSite(root,process.argv[2])));
}
