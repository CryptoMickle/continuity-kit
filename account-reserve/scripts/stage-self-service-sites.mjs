import { readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSelfServiceSite } from './build-self-service-site.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const outputs=[];
for(const role of ['primary','recovery']) {
  const site=join(root,'self-service/sites',role);
  // Identity must already exist; never register a Site from a build.
  const identity=JSON.parse(await readFile(join(site,'.openai/hosting.json'),'utf8'));
  if(!identity.project_id) throw Error('SITE_ID_REQUIRED');
  for(const path of ['self-service/client','self-service/text','self-service/apps','self-service/backend','integrations/multi-app','sdk','starter/prism-art.mjs','starter/prism-art.css','work/style.css','release/profile.mjs','self-service/profile.json','scripts/build-self-service-site.mjs','scripts/build-app-reserves.mjs','package.json','package-lock.json','LICENSE']) {
    await mkdir(join(site,path,'..'),{recursive:true});
    await cp(join(root,path),join(site,path),{recursive:true,filter:source=>!source.split('/').includes('node_modules') && !source.startsWith(join(root,'integrations/multi-app/dist'))});
  }
  if(role==='recovery') {
    await cp(join(root,'self-service/backend/db'),join(site,'db'),{recursive:true});
    await cp(join(root,'self-service/backend/drizzle'),join(site,'drizzle'),{recursive:true});
  }
  await writeFile(join(site,'.gitignore'),'node_modules/\ndist/\nartifacts/\n.sites/\n.sites-checkout/\n');
  await writeFile(join(site,'README.md'),`# ContinuityKit self-service ${role}\n\nFictional native-passkey demo. Account-free text mode at /text/; earlier Work mode at /. No chain transactions.\n\nBuild: npm ci, then node scripts/build-self-service-site.mjs ${role}.\n\nAccess ends 10 November 2026, 00:00 UTC. This deadline does not itself delete ciphertext. Both modes share a limit of 64 snapshots and 256 issued enrollment capabilities. These are storage/admission bounds, not a traffic or billing guarantee.\n\nSource: https://github.com/CryptoMickle/continuity-kit\n`);
  outputs.push(await buildSelfServiceSite(site,role));
}
await mkdir(join(root,'evidence'),{recursive:true});
await writeFile(join(root,'evidence/apps-sites-build-2026-10-10.json'),JSON.stringify({builtAt:new Date().toISOString(),published:false,outputs},null,2)+'\n');
console.log(JSON.stringify(outputs));
