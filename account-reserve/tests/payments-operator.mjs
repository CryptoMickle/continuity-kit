import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdtemp,rm,readdir,readFile,symlink,writeFile,chmod} from 'node:fs/promises';
import {createPublicClient,http,keccak256,parseEther} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {buildSequentialPaymentProposal,sequentialProposalHash,readSequentialArtifact,SEQUENTIAL_OPERATOR_ROLES as ROLES} from '../payments/proposal.mjs';
import {createSequentialPaymentOperator,validateSequentialApproval} from '../payments/operator.mjs';
import {createSequentialOperatorJournal} from '../payments/operator-journal.mjs';
import {parseSequentialOperatorArguments,runSequentialOperator,safeSequentialDiagnostic} from '../payments/operator-runner.mjs';
import {APPROVED_TESTNET_RPCS} from '../release/client-profile.mjs';
const chain={id:10143,name:'Owned local test chain',nativeCurrency:{name:'Local',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[]}}};
const wrap=(client,overrides)=>new Proxy(client,{get:(o,k)=>Object.hasOwn(overrides,k)?overrides[k]:o[k]});
const code=expected=>e=>e.code===expected;
async function localAnvil(){
 const socket=createServer();await new Promise((r,j)=>{socket.once('error',j);socket.listen(0,'127.0.0.1',r);});const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(join(homedir(),'.foundry/bin/anvil'),['--host','127.0.0.1','--port',String(port),'--chain-id','10143','--accounts','0','--hardfork','paris','--silent'],{stdio:'ignore'});let spawnError,done=false;
 const ended=new Promise(resolve=>{child.once('error',e=>{spawnError=e;});for(const event of ['exit','close'])child.once(event,()=>{done=true;resolve();});});
 const close=async()=>{if(done)return;child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);try{await ended;}finally{clearTimeout(timer);}};
 const url=`http://127.0.0.1:${port}`;let id=0;
 async function rpc(method,params=[]){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(1500)});const b=await r.json();if(b.error)throw new Error('LOCAL_RPC_FAILED');return b.result;}
 try{for(let i=0;i<100;i++){if(spawnError)throw spawnError;try{if(await rpc('eth_chainId')==='0x279f')return {url,rpc,close};}catch{}await new Promise(r=>setTimeout(r,25));}throw new Error('LOCAL_ANVIL_UNAVAILABLE');}catch(e){await close();throw e;}
}
test('bounded sequential issuer uses actual EVM and durable once-only tickets', {timeout:60000},async t=>{
 const local=await localAnvil();t.after(local.close);const root=await mkdtemp(join(tmpdir(),'continuity-payments-operator-'));t.after(()=>rm(root,{recursive:true,force:true}));let index=0;
 async function fixture({clientOverrides=()=>({}),signerOverride,journalOverride}={}){
  await local.rpc('anvil_reset');const issuer=privateKeyToAccount(generatePrivateKey()),beneficiary=privateKeyToAccount(generatePrivateKey());
  const expiry=new Date(Date.now()+3600000).toISOString(),proposal=buildSequentialPaymentProposal({issuer:issuer.address,beneficiary:beneficiary.address,issuerNonce:'3',beneficiaryNonce:'1',expiresAt:expiry}),proposalHash=sequentialProposalHash(proposal),directory=join(root,String(++index));
  const backing=await createSequentialOperatorJournal({directory,proposalHash}),journal=journalOverride?journalOverride(backing):backing,counters={signatures:0,broadcasts:0};
  const clients=[0,1].map(i=>{const base=createPublicClient({chain,cacheTime:0,transport:http(local.url,{retryCount:0,timeout:2000})});const checked=wrap(base,{async sendRawTransaction(args){counters.broadcasts++;const entries=await Promise.all(ROLES.map(role=>backing.read(role)));assert.ok(entries.some(e=>e?.phase==='signed'&&e.hash===keccak256(args.serializedTransaction)));return base.sendRawTransaction(args);}});return wrap(checked,clientOverrides(checked,i));});
  const signer={address:issuer.address,async signTransaction(request){counters.signatures++;assert.equal((await backing.read(ROLES[request.nonce-3])).phase,'reserved');return signerOverride?signerOverride(issuer,request):issuer.signTransaction(request);}};
  const approval={format:'continuitykit/sequential-operator-approval/v1',proposalHash,network:'local-anvil',rpcUrls:[local.url,local.url],roles:[...ROLES],expiresAt:expiry,approvedByUser:true};
  const options={proposal,endpoints:clients.map(client=>({url:local.url,client})),signer,journal,network:'local-anvil'};
  for(const actor of [issuer,beneficiary])await local.rpc('anvil_setBalance',[actor.address,'0x'+parseEther('2').toString(16)]);
  await local.rpc('anvil_setNonce',[issuer.address,'0x3']);await local.rpc('anvil_setNonce',[beneficiary.address,'0x1']);await local.rpc('evm_mine');
  const operator=createSequentialPaymentOperator(options),mine=()=>local.rpc('anvil_mine',['0x42','0x0']);
  return {operator,options,proposal,proposalHash,approval,backing,directory,counters,clients,issuer,beneficiary,mine,async finalize(role){await mine();return createSequentialPaymentOperator({...options,signer:undefined}).reconcile(role);},async claim(role){const tx=proposal.transactions.find(t=>t.role===role);const raw=await beneficiary.signTransaction({type:'eip1559',chainId:10143,to:tx.to,nonce:Number(tx.nonce),data:tx.data,value:0n,gas:BigInt(tx.gasLimitCeiling),maxFeePerGas:BigInt(tx.maxFeePerGasWei),maxPriorityFeePerGas:BigInt(tx.maxPriorityFeePerGasWei)});const hash=await local.rpc('eth_sendRawTransaction',[raw]);await mine();return hash;}};
 }
 async function firstIssued(f){for(const role of ['deploy','issue-first']){await f.operator.execute({role,approval:f.approval});assert.equal((await f.finalize(role)).status,'finalized');}}
 await t.test('two genuine payouts keep original beneficiary; issuer roles cannot reorder or repeat',async()=>{
  const f=await fixture();assert.equal(f.proposal.budget.maxTransactionCount,5);assert.equal(f.proposal.budget.issuerStartingCoverageWei,'340000000000000000');
  await assert.rejects(f.operator.execute({role:'issue-first',approval:f.approval}),code('OPERATOR_PREVIOUS_STEP_NOT_FINALIZED'));
  await firstIssued(f);await assert.rejects(f.operator.execute({role:'issue-second',approval:f.approval}),code('OPERATOR_CLAIM_HASH_REQUIRED'));
  assert.equal(await f.backing.read('issue-second'),undefined);
  const claimHash=await f.claim('claim-first');assert.equal((await f.operator.checkFirstClaim(claimHash)).status,'finalized');
  await f.operator.execute({role:'issue-second',approval:f.approval,firstClaimHash:claimHash});assert.equal((await f.finalize('issue-second')).status,'finalized');
  await f.claim('claim-second');const abi=readSequentialArtifact().artifact.abi;
  for(const id of [1n,2n]){const r=await f.clients[0].readContract({address:f.proposal.contract.address,abi,functionName:'getRight',args:[id]});assert.equal(r.beneficiary.toLowerCase(),f.beneficiary.address.toLowerCase());assert.equal(r.amount,parseEther('0.01'));assert.equal(r.claimed,true);}
  assert.equal(await f.clients[0].getBalance({address:f.proposal.contract.address}),0n);assert.equal(await f.clients[0].getTransactionCount({address:f.beneficiary.address}),3);
  for(const role of ROLES)assert.equal((await f.operator.execute({role})).status,'finalized');
  assert.deepEqual(f.counters,{signatures:3,broadcasts:3});
  const all=await Promise.all((await readdir(f.directory)).map(n=>readFile(join(f.directory,n),'utf8')));assert.ok(all.every(s=>!s.includes('privateKey')&&!s.includes('serializedTransaction')));
 });
 await t.test('wrong first claim, unfinalized first claim and another issuer tx cannot authorize second issue',async()=>{
  const f=await fixture();await firstIssued(f);await assert.rejects(f.operator.execute({role:'issue-second',approval:f.approval,firstClaimHash:(await f.backing.read('issue-first')).hash}),code('OPERATOR_RECEIPT_MISMATCH'));assert.equal(await f.backing.read('issue-second'),undefined);
  const tx=f.proposal.transactions.find(t=>t.role==='claim-first'),raw=await f.beneficiary.signTransaction({type:'eip1559',chainId:10143,to:tx.to,nonce:1,data:tx.data,gas:300000n,maxFeePerGas:200000000000n,maxPriorityFeePerGas:2000000000n});const hash=await local.rpc('eth_sendRawTransaction',[raw]);
  await assert.rejects(f.operator.execute({role:'issue-second',approval:f.approval,firstClaimHash:hash}),code('OPERATOR_FIRST_CLAIM_NOT_FINALIZED'));assert.equal(await f.backing.read('issue-second'),undefined);
 });
 await t.test('approval, chain, nonce, budgets and signed-envelope guards precede broadcast',async()=>{
  for(const [override,expected]of [[{getChainId:async()=>1},'OPERATOR_CHAIN_MISMATCH'],[{getTransactionCount:async()=>99},'OPERATOR_NONCE_NOT_APPROVED'],[{getBalance:async()=>0n},'OPERATOR_ISSUER_BALANCE_INSUFFICIENT'],[{estimateMaxPriorityFeePerGas:async()=>2000000001n},'OPERATOR_FEE_CAP_EXCEEDED'],[{estimateGas:async()=>1000001n},'OPERATOR_GAS_NOT_APPROVED']]){const f=await fixture({clientOverrides:()=>override});await assert.rejects(f.operator.execute({role:'deploy',approval:f.approval}),code(expected));assert.deepEqual(f.counters,{signatures:0,broadcasts:0});assert.equal(await f.backing.read('deploy'),undefined);}
  const f=await fixture();for(const changed of [{...f.approval,approvedByUser:false},{...f.approval,roles:['deploy']},{...f.approval,proposalHash:'f'.repeat(64)}])await assert.rejects(f.operator.execute({role:'deploy',approval:changed}),code('OPERATOR_EXACT_APPROVAL_REQUIRED'));
  const bad=await fixture({signerOverride:(issuer,request)=>issuer.signTransaction({...request,value:1n})});await assert.rejects(bad.operator.execute({role:'deploy',approval:bad.approval}),code('OPERATOR_TRANSACTION_SCOPE_MISMATCH'));assert.deepEqual(bad.counters,{signatures:1,broadcasts:0});assert.equal((await bad.operator.execute({role:'deploy'})).status,'blocked-unsigned-attempt');
 });
 await t.test('lost broadcast reply retains exact hash; restart checks but never sends again',async()=>{
  const f=await fixture({clientOverrides:(client,i)=>i?{}:{async sendRawTransaction(args){await client.sendRawTransaction(args);throw new Error('PRIVATE_RPC_PAYLOAD_MUST_NOT_ESCAPE');}}});
  await assert.rejects(f.operator.execute({role:'deploy',approval:f.approval}));assert.equal((await f.backing.read('deploy')).phase,'signed');assert.equal((await f.finalize('deploy')).status,'finalized');assert.equal((await f.operator.execute({role:'deploy'})).status,'finalized');assert.deepEqual(f.counters,{signatures:1,broadcasts:1});
 });
 await t.test('pin failure and cancelled signer permanently block that role without broadcast',async()=>{
  for(const settings of [{signerOverride:async()=>{throw new Error('cancel');}},{journalOverride:j=>({...j,pin:async()=>{throw new Error('disk-full');}})}]){const f=await fixture(settings);await assert.rejects(f.operator.execute({role:'deploy',approval:f.approval}));assert.equal((await f.operator.execute({role:'deploy'})).status,'blocked-unsigned-attempt');assert.deepEqual(f.counters,{signatures:1,broadcasts:0});}
 });
 await t.test('exclusive journal rejects concurrent action and stale lock; expiry blocks new signing',async()=>{
  const f=await fixture();let release;const gate=new Promise(r=>release=r),locked=f.backing.withLock(()=>gate);await new Promise(r=>setTimeout(r,15));await assert.rejects(f.operator.execute({role:'deploy',approval:f.approval}),code('OPERATOR_JOURNAL_LOCKED'));release();await locked;
  await writeFile(join(f.directory,f.proposalHash+'.lock'),'stale',{mode:0o600});await assert.rejects(f.operator.execute({role:'deploy',approval:f.approval}),code('OPERATOR_JOURNAL_LOCKED'));assert.equal(await readFile(join(f.directory,f.proposalHash+'.lock'),'utf8'),'stale');
  const f2=await fixture();const late=createSequentialPaymentOperator({...f2.options,now:()=>Date.parse(f2.proposal.expiresAt)+1});await assert.rejects(late.preflight('deploy'),code('OPERATOR_PROPOSAL_EXPIRED'));assert.deepEqual(f2.counters,{signatures:0,broadcasts:0});
 });
 await t.test('journal symlink and loose permissions rejected, read-only inspect creates no files',async()=>{
  const f=await fixture(),link=join(root,'alias');await symlink(f.directory,link);await assert.rejects(createSequentialOperatorJournal({directory:join(link,'must-not-create'),proposalHash:f.proposalHash}));await assert.rejects(readdir(join(f.directory,'must-not-create')),e=>e.code==='ENOENT');await assert.rejects(createSequentialOperatorJournal({directory:link,proposalHash:f.proposalHash}));await chmod(f.directory,0o755);await assert.rejects(createSequentialOperatorJournal({directory:f.directory,proposalHash:f.proposalHash}));await chmod(f.directory,0o700);
  const absent=join(root,'absent'),j=await createSequentialOperatorJournal({directory:absent,proposalHash:f.proposalHash,readOnly:true});assert.equal(await j.read('deploy'),undefined);await assert.rejects(readdir(absent),e=>e.code==='ENOENT');
 });
});
test('offline proposal binds artifacts, exact scope and preserves legacy approval boundary',()=>{
 const issuer=privateKeyToAccount(generatePrivateKey()),beneficiary=privateKeyToAccount(generatePrivateKey()),p=buildSequentialPaymentProposal({issuer:issuer.address,beneficiary:beneficiary.address,issuerNonce:'3',beneficiaryNonce:'1',expiresAt:new Date(Date.now()+3600000).toISOString()});
 const hash=sequentialProposalHash(p);assert.match(hash,/^[a-f0-9]{64}$/);const changed=structuredClone(p);changed.transactions[1].valueWei='1';assert.throws(()=>sequentialProposalHash(changed),code('OPERATOR_PROPOSAL_MISMATCH'));
 assert.throws(()=>buildSequentialPaymentProposal({issuer:issuer.address,beneficiary:issuer.address,issuerNonce:'0',beneficiaryNonce:'0',expiresAt:p.expiresAt}),code('OPERATOR_DISTINCT_ACTORS_REQUIRED'));
 let touched=0;assert.throws(()=>buildSequentialPaymentProposal({get issuer(){touched++;return issuer.address;},beneficiary:beneficiary.address,issuerNonce:'0',beneficiaryNonce:'0',expiresAt:p.expiresAt}));assert.equal(touched,0);
});
test('separate CLI refuses arbitrary endpoints/resume and never opens signer for inspect or reconciliation',async()=>{
 assert.throws(()=>parseSequentialOperatorArguments(['resume-unsigned']),code('OPERATOR_COMMAND_INVALID'));
 assert.throws(()=>parseSequentialOperatorArguments(['inspect','--proposal','p','--journal-dir','j','--signer','s']),code('OPERATOR_READONLY_SIGNER_FORBIDDEN'));
 assert.throws(()=>parseSequentialOperatorArguments(['inspect','--proposal','p','--journal-dir','j','--rpc','https://evil']));
 let getter=0;assert.deepEqual(safeSequentialDiagnostic({get code(){getter++;return 'SECRET';}}),{error:'OPERATOR_RUNNER_FAILED'});assert.equal(getter,0);assert.deepEqual(safeSequentialDiagnostic({code:'PRIVATE_SECRET_123',message:'private'}),{error:'OPERATOR_RUNNER_FAILED'});
 const issuer=privateKeyToAccount(generatePrivateKey()),beneficiary=privateKeyToAccount(generatePrivateKey()),proposal=buildSequentialPaymentProposal({issuer:issuer.address,beneficiary:beneficiary.address,issuerNonce:'3',beneficiaryNonce:'1',expiresAt:new Date(Date.now()+3600000).toISOString()}),hash=sequentialProposalHash(proposal);
 const approval={format:'continuitykit/sequential-operator-approval/v1',proposalHash:hash,network:'public-testnet',rpcUrls:[...APPROVED_TESTNET_RPCS],roles:[...ROLES],expiresAt:proposal.expiresAt,approvedByUser:true};let signerReads=0,mutations=0,preflights=0,prior=false;
 const dependencies={readJson:async p=>p==='p'?proposal:approval,readSigner:async()=>{signerReads++;return issuer;},createClients:()=>[],createJournal:async o=>{if(!o.readOnly)mutations++;return {};},createOperator:()=>({inspect:async()=>[{role:'deploy',attempt:prior?{phase:'signed'}:null}],reconcile:async()=>({status:'read-only'}),preflight:async()=>{preflights++;return {};},execute:async()=>({status:'attempted'})})};
 await runSequentialOperator(['inspect','--proposal','p','--journal-dir','j'],dependencies);assert.equal(mutations,0);assert.equal(signerReads,0);
 const argv=['execute','--proposal','p','--journal-dir','j','--role','deploy','--approval','a','--signer','s','--approve-exact-proposal'];prior=true;assert.equal((await runSequentialOperator(argv,dependencies)).status,'read-only');assert.equal(signerReads,0);prior=false;await runSequentialOperator(argv,dependencies);assert.equal(signerReads,1);assert.equal(preflights,1);
 approval.approvedByUser=false;await assert.rejects(runSequentialOperator(argv,dependencies),code('OPERATOR_EXACT_APPROVAL_REQUIRED'));assert.equal(signerReads,1);
});
