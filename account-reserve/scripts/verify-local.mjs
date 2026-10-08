import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const npmCli=join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
const files=['sdk/index.mjs','sdk/PROTOCOL.txt','app.mjs','app-session.mjs','app-setup.mjs','app-progress.mjs','handoff.mjs','transaction.mjs','pending-ticket.mjs','server.mjs','chain/PaymentRight.sol','chain/PaymentRight.artifact.json','chain/harness.mjs','package.json','package-lock.json','style.css'];
for(const directory of ['sdk','starter','release','deploy','scripts','tests'])for(const file of await readdir(join(root,directory))){if(/\.(mjs|ts|json|sol|sb|toml|html|css)$/.test(file))files.push(directory+'/'+file);}
const stages=[];
await mkdir(join(root,'evidence'),{recursive:true});
for(const [name,arguments_] of [
  ['build',[npmCli,'run','build']],
  ['tests',[npmCli,'test']],
  ['onboarding',[npmCli,'run','test:onboarding']],
  ['http-boundaries',[npmCli,'run','test:http']],
  ['release-tests',[npmCli,'run','test:release']],
  ['sites-build',[npmCli,'run','build:sites']],
]){
  // On macOS child processes inherit an explicit OS network policy: loopback only.
  const command=process.platform==='darwin'?'/usr/bin/sandbox-exec':process.execPath;
  const args=process.platform==='darwin'?['-f',join(root,'scripts/loopback-only.sb'),process.execPath,...arguments_]:arguments_;
  const result=spawnSync(command,args,{cwd:root,encoding:'utf8',env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH,SDK_TEST_NPM_CACHE:process.env.SDK_TEST_NPM_CACHE??'/tmp/continuity-reserve-npm'},maxBuffer:8*1024*1024});
  const output=(result.stdout??'')+(result.stderr??'');
  await writeFile(join(root,'evidence',name+'.txt'),output);
  stages.push({name,exitCode:result.status,passed:result.status===0});
  console.log(name+': '+(result.status===0?'passed':'FAILED'));
  if(result.status!==0){console.error(output.slice(-7000));break;}
}
const sourceHashes={};for(const file of files)sourceHashes[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
const evidence={generatedAt:new Date().toISOString(),scope:'synthetic-local-only',networkBoundary:process.platform==='darwin'?'OS-enforced loopback only':'not OS-enforced on this platform',stages,sourceHashes,physicalPasskeys:false,publicMonad:false,externalIntegrations:false};
await writeFile(join(root,'evidence/verification.json'),JSON.stringify(evidence,null,2)+'\n');
if(stages.length!==6||stages.some(s=>!s.passed))process.exitCode=1;
