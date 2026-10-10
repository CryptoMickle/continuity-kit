import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createNativeTextStarter } from '../scripts/create-native-text-starter.mjs';

// Exercise the real installed dependency boundary; never add a source fallback
// or a test bypass to the operator's production doctor.
export async function installedNativeFixture() {
  const root = await mkdtemp(join(tmpdir(),'native-operator-installed-'));
  const directory = join(root,'consumer');
  try {
    await createNativeTextStarter(directory);
    await new Promise((done,reject) => {
      const cli=join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
      const child=spawn(process.execPath,[cli,'ci','--offline','--ignore-scripts','--no-audit','--no-fund'],{cwd:directory,env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH,...(process.env.SDK_TEST_NPM_CACHE?{npm_config_cache:process.env.SDK_TEST_NPM_CACHE}:{}),npm_config_offline:'true'},stdio:['ignore','pipe','pipe']});
      let output='',expired=false,force;
      const timer=setTimeout(()=>{expired=true;child.kill();force=setTimeout(()=>child.kill('SIGKILL'),3000)},45000);
      const collect=bytes=>{if(output.length<20000)output+=bytes};child.stdout.on('data',collect);child.stderr.on('data',collect);
      child.once('error',error=>{clearTimeout(timer);clearTimeout(force);reject(error)});
      child.once('close',code=>{clearTimeout(timer);clearTimeout(force);if(code===0&&!expired)done();else reject(new Error('INSTALLED_NATIVE_FIXTURE_FAILED: '+output))});
    });
    return { directory, close:()=>rm(root,{recursive:true,force:true}) };
  } catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
