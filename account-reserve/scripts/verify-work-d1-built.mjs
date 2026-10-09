import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {randomBytes,createHash} from 'node:crypto';

// Executes the compiled application Worker, including its D1 binding, locally.
// No public endpoint, passkey, enrollment grant or deployment is involved.
const root=fileURLToPath(new URL('..',import.meta.url));
const candidate=JSON.parse(await readFile(join(root,'artifacts/work-d1-sites-candidate.json'),'utf8'));
assert.equal(candidate.storage,'d1');assert.equal(candidate.profile.enabled,true);
const checks=[];
const maintenance=randomBytes(32).toString('hex'),maintenanceHash=createHash('sha256').update(maintenance).digest('hex');
for(const output of candidate.outputs){
  const recovery=output.role==='recovery';
  const mf=new Miniflare({modules:true,scriptPath:join(root,output.path,'dist/server/index.js'),compatibilityDate:'2026-07-30',d1Databases:recovery?['DB']:[],bindings:{RESERVE_ENROLLMENT_TICKET_HASHES:'[]',WORK_RETENTION_AUTH_HASH:maintenanceHash}});
  try{
    if(recovery){
      const db=await mf.getD1Database('DB');
      const sql=await readFile(join(root,output.path,'drizzle/0000_fixed_mockingbird.sql'),'utf8');
      for(const statement of sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    }
    const origin=recovery?candidate.profile.recoveryOrigin:candidate.profile.primaryOrigin;
    const config=await mf.dispatchFetch(origin+'/api/config');assert.equal(config.status,200);assert.equal((await config.json()).role,output.role);
    const page=await mf.dispatchFetch(origin+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
    for(const path of ['/api/synthetic','/rpc','/api/primary','/api/status'])assert.equal((await mf.dispatchFetch(origin+path)).status,404);
    if(recovery){
      assert.equal((await mf.dispatchFetch(origin+'/api/retention/cleanup',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
      const cleanup=await mf.dispatchFetch(origin+'/api/retention/cleanup',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+maintenance},body:'{}'});
      assert.equal(cleanup.status,409);assert.equal((await cleanup.json()).error,'RETENTION_NOT_DUE');
      assert.equal((await mf.dispatchFetch(origin+'/api/reserve/'+'A'.repeat(43))).status,404);
      const db=await mf.getD1Database('DB');assert.equal((await db.prepare('SELECT count(*) AS n FROM work_records').first()).n,0);
    }
    checks.push({role:output.role,workerSha256:output.workerSha256,compiledWorker:true,d1MigrationAppliedLocally:recovery,passed:true});
  }finally{await mf.dispose();}
}
console.log(JSON.stringify({scope:'compiled-workers-local-workerd-only',checks,publicDeployment:false,physicalPasskeys:false}));
