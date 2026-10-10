import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mountPaymentPage} from '../payments/page.mjs';
const require=createRequire(new URL('../integrations/multi-app/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const hash=id=>'0x'+String(id).padStart(64,'0');
function fixture(t,options={}){
 const dom=new JSDOM('<div id="app"></div>',{url:'https://reserve.example.test/payments/'}),root=dom.window.document.querySelector('#app');
 const claims=options.claims??[{rightId:1n,amount:10n**16n,nonce:0},{rightId:7n,amount:2n*10n**16n,nonce:1}];
 const profile={chainId:10143,address:'0x'+'3'.repeat(40),owner:'0x'+'2'.repeat(40),expiresAt:'2100-01-01T00:00:00.000Z',claims};
 const calls={availability:[],opens:[],selected:[],claims:[],checks:[],verifies:[],closed:[],clients:0};
 const identity=id=>({chainId:10143,contract:profile.address,beneficiary:profile.owner,rightId:id,amount:claims.find(c=>c.rightId===id).amount,readOnly:true,paymentVerified:false});
 const recovered=id=>({owner:profile.owner,id,close(){calls.closed.push(id);}});
 const verified=id=>({status:'finalized',finalized:true,paymentVerified:true,...identity(id),paymentVerified:true,hash:hash(id),blockNumber:123n});
 const deps={role:options.role??'recovery',profile,window:dom.window,
  createAvailability:()=>({check:async({rightId})=>{calls.availability.push(rightId);return options.availability?options.availability(rightId,identity):{...identity(rightId),status:'funded'};}}),
  openAccount:({signal})=>{const index=calls.opens.length;calls.opens.push({signal});return options.open?options.open(index,signal):Promise.resolve(recovered(index));},
  createClient:account=>{calls.clients++;return {forRight:rightId=>{calls.selected.push(rightId);return {close(){},get hash(){return options.executorHash?.(rightId);},claim:async()=>{calls.claims.push(rightId);return options.claim?options.claim(rightId):{hash:hash(rightId),receipt:{status:'success'}};}};},close(){account.close();}};},
  createReader:()=>({check:async rightId=>{calls.checks.push(rightId);return options.read?options.read(rightId):{hash:hash(rightId)};}}),
  createVerifier:()=>({check:async input=>{calls.verifies.push(input);return options.verify?options.verify(input):verified(input.rightId);}}),
 };
 const mounted=mountPaymentPage(root,deps),$=id=>root.querySelector('#'+id);
 const choose=id=>{$('payment-right').value=String(id);$('payment-right').dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
 const submit=()=>{$('reference-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));};
 t.after(()=>{mounted.close();dom.window.close();});return {dom,root,$,calls,profile,identity,recovered,verified,choose,submit,mounted};
}
async function open(f){f.$('payment-open').click();await tick();}
async function collect(f){await open(f);f.$('payment-claim').click();await tick();}

test('B can collect its only approved first payment without an artificial right2 requirement',async t=>{
 const f=fixture(t,{claims:[{rightId:1n,amount:10n**16n,nonce:0}]});await tick();
 assert.equal(f.root.querySelector('label[for="payment-right"]').textContent,'Payment to collect');assert.deepEqual([...f.$('payment-right').options].map(o=>o.value),['1']);assert.equal(f.$('payment-right').value,'1');assert.equal(f.calls.opens.length,0);
 await collect(f);assert.deepEqual(f.calls.selected,[1n]);assert.deepEqual(f.calls.claims,[1n]);assert.equal(f.$('payment-title').textContent,'Payment received.');assert.equal(f.calls.closed.length,1);
});

test('both origins default to the first trusted arbitrary ID and can deliberately select another approved obligation',async t=>{
 for(const role of ['primary','recovery']){const f=fixture(t,{role,claims:[{rightId:11n,amount:10n**16n,nonce:0},{rightId:29n,amount:3n*10n**16n,nonce:1}]});await tick();assert.equal(f.$('payment-right').value,'11');assert.deepEqual(f.calls.availability,[11n]);
  f.choose(29n);await tick();assert.equal(f.$('payment-amount').textContent,'0.03 test-MON');assert.equal(f.$('reference-right').value,'29');assert.deepEqual(f.calls.availability,[11n,29n]);assert.equal(f.calls.opens.length,0);await collect(f);assert.deepEqual(f.calls.claims,[29n]);}
});

test('switching closes an open signer, invalidates readiness and clears reference content without auto authentication',async t=>{
 const second=deferred();const f=fixture(t,{availability:(id,identity)=>id===7n?second.promise:{...identity(id),status:'funded'}});await tick();await open(f);
 f.$('reference-hash').value=hash(1);f.$('reference-details').textContent='old receipt';f.$('reference-details').hidden=false;
 f.choose(7n);assert.equal(f.calls.closed.length,1);assert.equal(f.$('payment-claim').hidden,true);assert.equal(f.$('payment-open').hidden,true);assert.equal(f.$('reference-hash').value,'');assert.equal(f.$('reference-details').hidden,true);assert.equal(f.$('reference-details').textContent,'');assert.equal(f.$('reference-right').value,'7');assert.equal(f.calls.opens.length,1);
 second.resolve({...f.identity(7n),status:'funded'});await tick();assert.equal(f.$('payment-open').hidden,false);assert.equal(f.calls.opens.length,1);assert.equal(f.calls.claims.length,0);
});

test('late old availability cannot enable the new payment or release its busy state',async t=>{
 const first=deferred(),second=deferred();const f=fixture(t,{availability:id=>id===1n?first.promise:second.promise});assert.deepEqual(f.calls.availability,[1n]);f.choose(7n);assert.deepEqual(f.calls.availability,[1n,7n]);
 first.resolve({...f.identity(1n),status:'funded'});await tick();assert.equal(f.$('payment-right').value,'7');assert.equal(f.$('payment-open').hidden,true);assert.equal(f.$('payment-refresh').disabled,true);assert.equal(f.calls.opens.length,0);
 second.resolve({...f.identity(7n),status:'funded'});await tick();assert.equal(f.$('payment-open').hidden,false);assert.equal(f.$('payment-refresh').disabled,false);
});

test('late rejected availability cannot overwrite a newer successful selection',async t=>{
 const first=deferred();const f=fixture(t,{availability:(id,identity)=>id===1n?first.promise:{...identity(id),status:'funded'}});f.choose(7n);await tick();const title=f.$('payment-title').textContent,status=f.$('payment-status').textContent;
 first.reject(Error('OLD_PRIVATE_FAILURE'));await tick();assert.equal(f.$('payment-title').textContent,title);assert.equal(f.$('payment-status').textContent,status);assert.equal(f.$('payment-open').hidden,false);assert.equal(f.root.textContent.includes('OLD_PRIVATE_FAILURE'),false);
});

test('switching during authentication aborts and closes its late signer before allowing a second native opening',async t=>{
 const old=deferred(),current=deferred();const f=fixture(t,{open:index=>index===0?old.promise:current.promise});await tick();f.$('payment-open').click();assert.equal(f.calls.opens.length,1);f.choose(7n);assert.equal(f.calls.opens[0].signal.aborted,true);await tick();f.$('payment-open').click();assert.equal(f.calls.opens.length,1,'old native ceremony must settle before another starts');
 old.resolve(f.recovered('old'));await tick();assert.deepEqual(f.calls.closed,['old']);assert.equal(f.calls.clients,0);assert.equal(f.$('payment-claim').hidden,true);
 f.$('payment-open').click();assert.equal(f.calls.opens.length,2);current.resolve(f.recovered('current'));await tick();assert.equal(f.calls.clients,1);assert.deepEqual(f.calls.selected,[7n]);assert.equal(f.$('payment-claim').hidden,false);f.$('payment-claim').click();await tick();assert.deepEqual(f.calls.claims,[7n]);
});

test('late journal check cannot display the former payment receipt on the new selection',async t=>{
 const read=deferred(),availability=deferred();const f=fixture(t,{read:()=>read.promise,availability:(id,identity)=>id===7n?availability.promise:{...identity(id),status:'funded'}});await tick();f.$('payment-check').click();await tick();assert.deepEqual(f.calls.checks,[1n]);f.choose(7n);
 read.resolve({hash:hash(1),receipt:{status:'success'}});await tick();assert.equal(f.$('payment-receipt').hidden,true);assert.notEqual(f.$('payment-title').textContent,'Payment received.');assert.equal(f.$('payment-refresh').disabled,true);
 availability.resolve({...f.identity(7n),status:'funded'});await tick();assert.equal(f.$('payment-open').hidden,false);assert.equal(f.$('payment-hash').textContent,'');
});

test('switching during stateless verification clears its input and suppresses the old verified result',async t=>{
 const verify=deferred();const f=fixture(t,{verify:()=>verify.promise});await tick();f.$('reference-hash').value=hash(1);f.submit();await tick();assert.equal(f.calls.verifies.length,1);f.choose(7n);await tick();
 verify.resolve(f.verified(1n));await tick();assert.equal(f.$('reference-hash').value,'');assert.equal(f.$('reference-right').value,'7');assert.equal(f.$('reference-details').hidden,true);assert.equal(f.$('reference-details').textContent,'');assert.notEqual(f.$('reference-status').dataset.state,'verified');assert.equal(f.$('payment-open').hidden,false);assert.equal(f.calls.opens.length,0);
});

test('known unresolved attempts remain account-wide blockers across switching until exact journal reconciliation',async t=>{
 const f=fixture(t,{claim:async id=>({hash:hash(id)}),read:async id=>({hash:hash(id),receipt:{status:'success'}})});await tick();await collect(f);assert.equal(f.$('payment-hash').textContent,hash(1));assert.equal(f.$('payment-open').hidden,true);
 f.choose(7n);await tick();assert.equal(f.$('payment-receipt').hidden,true);assert.equal(f.$('payment-hash').textContent,'');assert.equal(f.$('payment-open').hidden,true);assert.match(f.$('payment-status').textContent,/payment 1/i);f.$('payment-open').click();await tick();assert.equal(f.calls.opens.length,1);
 f.choose(1n);await tick();assert.equal(f.$('payment-receipt').hidden,false);assert.equal(f.$('payment-hash').textContent,hash(1));assert.equal(f.$('payment-open').hidden,true);assert.equal(f.$('payment-claim').hidden,true);f.$('payment-open').click();await tick();assert.equal(f.calls.opens.length,1);assert.deepEqual(f.calls.claims,[1n]);
 f.$('payment-check').click();await tick();assert.deepEqual(f.calls.checks,[1n]);assert.equal(f.$('payment-title').textContent,'Payment received.');f.choose(7n);await tick();assert.equal(f.$('payment-open').hidden,false);assert.equal(f.$('payment-receipt').hidden,true);
});

test('per-payment confirmed state stays confirmed while a different selected right has separate readiness',async t=>{
 const f=fixture(t);await tick();await collect(f);assert.equal(f.$('payment-title').textContent,'Payment received.');f.choose(7n);await tick();assert.equal(f.$('payment-open').hidden,false);assert.equal(f.$('payment-receipt').hidden,true);
 f.choose(1n);await tick();assert.equal(f.$('payment-title').textContent,'Payment received.');assert.equal(f.$('payment-open').hidden,true);assert.equal(f.$('payment-hash').textContent,hash(1));assert.equal(f.calls.claims.length,1);
});

test('claim in flight disables and guards programmatic selection so its result remains bound to the sent right',async t=>{
 const claim=deferred();const f=fixture(t,{claim:()=>claim.promise});await tick();await open(f);f.$('payment-claim').click();assert.equal(f.$('payment-right').disabled,true);assert.deepEqual(f.calls.claims,[1n]);
 f.choose(7n);assert.equal(f.$('payment-right').value,'1');assert.deepEqual(f.calls.availability,[1n]);assert.equal(f.calls.closed.length,0);
 claim.resolve({hash:hash(1),receipt:{status:'success'}});await tick();assert.equal(f.$('payment-hash').textContent,hash(1));assert.equal(f.$('payment-title').textContent,'Payment received.');assert.equal(f.$('payment-right').disabled,false);assert.deepEqual(f.calls.claims,[1n]);
});

test('an injected unapproved selector option cannot trigger availability, authentication or signing',async t=>{
 const f=fixture(t);await tick();const option=f.dom.window.document.createElement('option');option.value='99';option.textContent='untrusted';f.$('payment-right').append(option);f.choose(99n);await tick();assert.equal(f.$('payment-right').value,'1');assert.deepEqual(f.calls.availability,[1n]);assert.equal(f.calls.opens.length,0);assert.equal(f.calls.claims.length,0);
});

test('a stateless verified reference cannot clear the known unresolved blocker for another selected payment',async t=>{
 const f=fixture(t,{claim:async id=>({hash:hash(id)})});await tick();await collect(f);f.choose(7n);await tick();assert.equal(f.$('payment-open').hidden,true);
 f.$('reference-right').value='1';f.$('reference-hash').value=hash(1);f.submit();await tick();assert.equal(f.$('reference-status').dataset.state,'verified');assert.equal(f.$('payment-open').hidden,true);assert.equal(f.calls.checks.length,0);assert.equal(f.calls.opens.length,1);assert.deepEqual(f.calls.claims,[1n]);
});

test('an explicitly unresolved reserved attempt without a hash blocks the account across selections',async t=>{
 const f=fixture(t,{claim:async()=>{throw Object.assign(Error('private reservation detail'),{code:'PAYMENT_RECONCILIATION_REQUIRED'});}});await tick();await collect(f);assert.equal(f.$('payment-receipt').hidden,true);assert.equal(f.$('payment-open').hidden,true);assert.ok(!f.root.textContent.includes('private reservation detail'));
 f.choose(7n);await tick();assert.equal(f.$('payment-open').hidden,true);assert.match(f.$('payment-status').textContent,/reconcil|inspect|existing attempt/i);f.$('payment-open').click();await tick();assert.equal(f.calls.opens.length,1);assert.deepEqual(f.calls.claims,[1n]);
});

test('rechecking an older confirmed right does not clear a newer different unresolved payment',async t=>{
 const claims=[{rightId:1n,amount:10n**16n,nonce:0},{rightId:7n,amount:2n*10n**16n,nonce:1},{rightId:9n,amount:3n*10n**16n,nonce:2}];
 const f=fixture(t,{claims,claim:async id=>id===1n?{hash:hash(id),receipt:{status:'success'}}:{hash:hash(id)},read:async id=>({hash:hash(id),receipt:{status:'success'}})});await tick();await collect(f);f.choose(7n);await tick();await collect(f);assert.deepEqual(f.calls.claims,[1n,7n]);
 f.choose(1n);await tick();f.$('payment-check').click();await tick();assert.deepEqual(f.calls.checks,[1n]);assert.equal(f.$('payment-title').textContent,'Payment received.');
 f.choose(9n);await tick();assert.equal(f.$('payment-open').hidden,true);assert.match(f.$('payment-status').textContent,/payment 7/i);assert.equal(f.calls.opens.length,2);f.choose(7n);await tick();assert.equal(f.$('payment-hash').textContent,hash(7));assert.equal(f.$('payment-receipt').hidden,false);
});

test('post-reservation failures without a hash retain conservative account blocking across selection',async t=>{
 const codes=['PAYMENT_PREPARATION_FAILED','PAYMENT_SIGNING_FAILED','PAYMENT_TRANSACTION_MISMATCH','PAYMENT_SIGNED_TRANSACTION_INVALID','PAYMENT_SIGNED_OWNER_MISMATCH','PAYMENT_STORE_READBACK_FAILED','PAYMENT_STORE_UNAVAILABLE','PAYMENT_SESSION_CLOSED'];
 for(const code of codes){const f=fixture(t,{claim:async()=>{throw Object.assign(Error('private failure'),{code});}});await tick();await collect(f);assert.equal(f.$('payment-receipt').hidden,true,code);f.choose(7n);await tick();assert.equal(f.$('payment-open').hidden,true,code);f.$('payment-open').click();await tick();assert.equal(f.calls.opens.length,1,code);assert.deepEqual(f.calls.claims,[1n],code);}
});

test('an unknown account-wide journal blocker is not assigned to an invented payment or cleared by another receipt',async t=>{
 const f=fixture(t,{claim:async()=>{throw Object.assign(Error(),{code:'PAYMENT_ACCOUNT_BLOCKED'});},read:async id=>({hash:hash(id),receipt:{status:'success'}})});await tick();await collect(f);assert.equal(f.$('payment-receipt').hidden,true);assert.equal(f.$('payment-hash').textContent,'');
 f.choose(7n);await tick();assert.equal(f.$('payment-open').hidden,true);assert.doesNotMatch(f.$('payment-status').textContent,/attempt for Payment 1/);f.$('payment-check').click();await tick();assert.deepEqual(f.calls.checks,[7n]);
 f.choose(1n);await tick();assert.equal(f.$('payment-open').hidden,true);assert.equal(f.$('payment-receipt').hidden,true);assert.equal(f.$('payment-hash').textContent,'');f.$('payment-open').click();await tick();assert.equal(f.calls.opens.length,1);
});
