// Add /payments/ to the exact existing published workers, without rebuilding or
// modifying their legacy application/storage code. This script never publishes.
import {build} from 'vite';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildPaymentBrowser} from './build-browser.mjs';
import {validatePaymentProfile} from './guard.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const baseline={primary:'3ab3c2a9ec719d5d56f30d3152f7800841c36fd536439ecbcad20476b80e4664',recovery:'ba4318889a5856c7925b10b51b78ebb16d3c47d2059cf3046a123053e80314e7'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const input=JSON.parse(await readFile(resolve(process.argv[2]),'utf8'));
validatePaymentProfile({...input,claims:input.claims.map(c=>({...c,rightId:BigInt(c.rightId),amount:BigInt(c.amount)}))});
const browser=await buildPaymentBrowser(),assets={};
async function collect(dir,path='/payments'){
 for(const item of await readdir(dir,{withFileTypes:true})){
  if(item.isSymbolicLink())throw Error('PAYMENT_ASSET_SYMLINK');
  const p=path+'/'+item.name;
  if(item.isDirectory())await collect(join(dir,item.name),p);
  else assets[p]={base64:(await readFile(join(dir,item.name))).toString('base64'),contentType:{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(p)]};
 }
}
await collect(browser);const out=join(root,'artifacts/payment-sites');await mkdir(out,{recursive:true});const manifest=[];
for(const role of ['primary','recovery']){
 const checkout=join(root,'sites',role),legacyPath=join(out,role+'-legacy.mjs');
 let legacy;try{legacy=await readFile(legacyPath);}catch(e){if(e.code!=='ENOENT')throw e;legacy=await readFile(join(checkout,'worker.mjs'));}
 if(sha(legacy)!==baseline[role])throw Error('PAYMENT_LEGACY_WORKER_MISMATCH');
 await writeFile(legacyPath,legacy);
 const module=(await import(legacyPath)).default;
 const origin='https://continuitykit-account-'+(role==='primary'?'primary':'reserve')+'.cryptomickle.chatgpt.site';
 const fake={RESERVE_REDIS_REST_URL:'https://mutual-calf-226520.upstash.io',RESERVE_REDIS_REST_TOKEN:'build-placeholder',RESERVE_ENROLLMENT_TICKET_HASHES:'[]'};
 const oldConfig=await module.fetch(new Request(origin+'/api/config'),fake);
 // Configuration never performs a storage operation and remains bound to the
 // old profile. Read the actual old config as a build-time compatibility check.
 if(oldConfig.status!==200)throw Error('PAYMENT_LEGACY_CONFIG_UNAVAILABLE');
 const config=await oldConfig.json();if(config.role!==role||config.releaseProfile[role==='primary'?'primaryOrigin':'recoveryOrigin']!==origin)throw Error('PAYMENT_LEGACY_ORIGIN_MISMATCH');
 const entry=join(out,role+'-entry.mjs');
 await writeFile(entry,`import legacy from ${JSON.stringify(legacyPath)};\nimport {createPaymentSiteHandler} from ${JSON.stringify(join(root,'payments/site-handler.mjs'))};\nexport default createPaymentSiteHandler({legacy,origin:${JSON.stringify(origin)},role:${JSON.stringify(role)},profile:${JSON.stringify(input)},assets:${JSON.stringify(assets)}});\n`);
 await build({root,configFile:false,build:{ssr:entry,target:'es2022',outDir:join(out,role),emptyOutDir:true,rollupOptions:{output:{entryFileNames:'worker.mjs'}}},ssr:{noExternal:true}});
 const workerPath=join(out,role,'worker.mjs'),workerBytes=await readFile(workerPath),worker=(await import(workerPath+'?verify='+Date.now())).default;
 for(const path of ['/','/api/config']){
  const before=await module.fetch(new Request(origin+path),fake),after=await worker.fetch(new Request(origin+path),fake);
  if(before.status!==after.status||await before.text()!==await after.text())throw Error('PAYMENT_LEGACY_CHANGED');
 }
 if((await worker.fetch(new Request(origin+'/payments/'),fake)).status!==200||(await worker.fetch(new Request(origin+'/payments/profile.json'),fake)).status!==200)throw Error('PAYMENT_ROUTES_FAILED');
 manifest.push({role,origin,legacySha256:baseline[role],workerPath,workerSha256:sha(workerBytes),legacyConfigAndRootUnchanged:true});
}
await writeFile(join(out,'candidate.json'),JSON.stringify({profile:input,manifest,published:false},null,2)+'\n');console.log(JSON.stringify({outputs:manifest,published:false}));
