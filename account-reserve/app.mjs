import './starter/prism-art.css';
import './style.css';
import {prismBackdrop, prismSculpture} from './starter/prism-art.mjs';
import {getPasskeyPrfOutput, createSecp256k1SigningSession} from '@category-labs/mera';
import {toViemAccount} from '@category-labs/mera/viem';
import {createPublicClient, createWalletClient, http, formatEther, keccak256} from 'viem';
import {openPrimaryKey} from './app-session.mjs';
import {createWebAuthnScope} from './sdk/webauthn-scope.mjs';
import {createReserveCredential, recoverReserve} from './sdk/index.mjs';
import {inspectHostedDeployment, prepareOrConfirmReserve} from './app-setup.mjs';
import {createReserveProgress} from './app-progress.mjs';
import {validHandoff, randomNonce} from './handoff.mjs';
import {createClaimExecutor} from './transaction.mjs';
import {createBrowserPendingStore} from './pending-ticket.mjs';
import {createReserveHttpStore} from './release/browser-store.mjs';
import {createTestnetClaimExecutor} from './release/testnet-executor.mjs';
import {validateClientProfile} from './release/client-profile.mjs';
import {publicTestnetTransport} from './release/paced-rpc.mjs';

const $=id=>document.getElementById(id);
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
async function api(path,input,method='POST'){
  const response=await fetch(path,{method:input===undefined?'GET':method,headers:input===undefined?{}:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});
  const value=await response.json();
  if(!response.ok)throw new Error(value.error||'SERVICE_UNAVAILABLE');
  return value;
}
const env=await api('/api/config').catch(()=>{
  $('app').innerHTML='<main class="shell"><h1>This demonstration is not available.</h1><p>Its configuration or access period needs attention. Keep any existing passkeys. No new credential or transaction was requested.</p></main>';
  throw new Error('DEMONSTRATION_UNAVAILABLE');
});
const hosted=env.hosted===true;
const release=hosted?validateClientProfile(env.releaseProfile):undefined;
const primary=env.role==='primary';
const model=hosted?'iris':new URL(location.href).searchParams.get('model')==='accrue'?'accrue':'iris';
const config=Object.freeze({appId:(hosted?release.namespace:'continuity-demo')+'-'+model,originalRpId:new URL(env.primaryOrigin).hostname,recoveryRpId:new URL(env.recoveryOrigin).hostname,derivation:model==='iris'?'iris:prf-direct:v1':"accrue:worker:m/44'/60'/0'/0/1"});
const chain={id:hosted?10143:31337,name:hosted?'Monad testnet':'Disposable local chain',nativeCurrency:{name:hosted?'Test MON':'Local test unit',symbol:hosted?'MON':'TEST',decimals:18},rpcUrls:{default:{http:hosted?release.rpcUrls:[location.origin+'/rpc']}}};
const publicClient=createPublicClient({chain,ccipRead:false,cacheTime:0,transport:hosted?publicTestnetTransport(release.rpcUrls[0]):http('/rpc',{retryCount:0,fetchOptions:{redirect:'error'}})});
const webAuthnClient=env.physicalEnabled?undefined:{
  async createCredential(request){return synthetic(request,'create');},
  async getCredential(request){return synthetic(request,'get');},
};
async function synthetic(request,action){
  const r=await api('/api/synthetic/credential',{action,model,rpId:request.rp?.id??request.rpId,salt:hex(request.prfSalt),credentialId:request.allowCredential?b64(request.allowCredential.credentialId):undefined});
  return {credentialId:unb64(r.credentialId),prfEnabled:true,prfOutput:unb64(r.prfOutput)};
}
const localStore={
  async get(locator){const r=await fetch('/api/store/'+locator);if(r.status===404)return undefined;if(!r.ok)throw new Error('STORE_UNAVAILABLE');return unb64((await r.json()).bytes);},
  async putIfAbsent(locator,bytes){const r=await fetch('/api/store/'+locator,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({bytes:b64(bytes)})});if(r.status===409)return false;if(!r.ok)throw new Error('STORE_WRITE_UNKNOWN');return (await r.json()).created===true;},
};
const store=hosted?createReserveHttpStore():localStore;
let privateKey, originalSession, recovered, right, executor, handoff, operationProgress, busy=false, expiresTimer;
const abort=new AbortController();
const isEnrollment=!primary&&/^#enroll=[a-f0-9]{64}$/.test(location.hash)&&!!window.opener;
let enrollmentNonce=isEnrollment?location.hash.slice(8):null, enrollmentAttempted=false;
let enrollmentDeadline=Date.now()+5*60*1000;
const opener=window.opener;
if(isEnrollment)history.replaceState(null,'',location.pathname+location.search);

$('app').innerHTML=`
<div class="shell prism-page" data-client="${primary?'primary':'reserve'}">
  ${prismBackdrop}
  <header class="site-header">
    <a class="brand" href="/?model=${model}" aria-label="ContinuityKit home"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span><span>continuity<span class="brand-light">kit</span></span></a>
    <span class="product-label">Account reserve</span>
    <span class="mode">${env.physicalEnabled?'Physical passkeys':'Synthetic credentials'}<span class="mode-divider" aria-hidden="true"></span>${hosted?'Monad testnet':'Local chain'}</span>
  </header>
  <main id="main">
    <section class="intro" aria-labelledby="page-title">
      <div><div class="eyebrow">PREPARED ACCOUNT CONTINUITY</div>
        <h1 id="page-title">${primary?'Your account,<br><span>within reach.</span>':'Return to<br><span>your account.</span>'}</h1>
        <p class="lead">${primary?'Prepare a way back before the original app goes offline.':'Open your prepared reserve. Continue with the same account.'}</p>
      </div>
      <ol class="steps" aria-label="Demonstration steps"><li id="step1"><b>01</b><span>Account</span></li><li id="step2"><b>02</b><span>Reserve</span></li><li id="step3"><b>03</b><span>Recover</span></li></ol>
    </section>
    <div class="columns">
      <section class="card main-card" aria-labelledby="title">
        <div class="card-heading"><span class="client-symbol" aria-hidden="true">${primary?'A':'B'}</span><span class="card-kicker">${primary?'PRIMARY APP':'INDEPENDENT RESERVE'}</span><span class="card-number">${primary?'01 / 02':'02 / 02'}</span></div>
        <h2 id="title">${primary?'Prepare your way back.':isEnrollment?'Give your account a reserve.':'Open your reserve.'}</h2>
        <p id="instruction">${primary?(hosted?'Open your example account to find the test payment prepared for this demonstration.':'Start with an example account and a payment of 0.001 local test units. Then prepare its independent reserve.'):isEnrollment?'Create a separate recovery credential while the original app is still available. Keep both windows open until the reserve is confirmed.':'Use your existing recovery passkey. It finds your encrypted reserve — no address to paste or export file to find.'}</p>
        ${!primary?'<p id="passkey-guide" class="passkey-guide">'+(isEnrollment?'Create or choose a recovery passkey, then use that same key to protect and independently open the reserve.':'Recovery uses the same recovery passkey to find and unlock the reserve.')+' Your device may request several approvals; the number of prompts depends on your browser and device.</p>':''}
        <section id="passkey-progress" class="passkey-progress" aria-labelledby="passkey-progress-title" hidden><div class="progress-heading"><h3 id="passkey-progress-title"></h3><span id="passkey-stage-count"></span></div><ol id="passkey-stages"></ol></section>
        <div id="status" class="status" role="status" aria-live="polite" hidden></div>
        <div id="identity" class="identity" hidden><div class="identity-label">Original account <span>EOA</span></div><code id="owner"></code><div class="payment"><strong id="amount">${hosted?'0.10':'0.001'}</strong><span>${hosted?'test MON':'local test units'}</span></div><span id="right-status"></span></div>
        ${hosted&&isEnrollment?'<label class="setup-code">One-time demonstration setup code<input id="enrollment-code" type="password" autocomplete="off" spellcheck="false" maxlength="43"><small>Provided by the demo operator. Recovery will not need this code.</small></label>':''}
        <div class="actions" id="actions"></div>
        <p id="action-note" class="action-note">${isEnrollment?'Creates a separate recovery passkey with full signing access to this account. Your original key stays valid.':primary?'Example account only. Never use an account holding real funds.':'Your device may ask for more than one confirmation. Opening the reserve does not send a transaction.'}</p>
        ${hosted?'<p class="demo-expiry">Example reserves are deleted on '+new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC',timeZoneName:'short'}).format(new Date(release.expiresAt))+'.</p>':''}
        <div id="receipt" class="receipt" hidden><div class="receipt-heading"><span class="receipt-icon" aria-hidden="true">✓</span><span>${hosted?'Testnet payment confirmed':'Local payment confirmed'}</span></div><code id="hash"></code><p>The contract paid the original beneficiary. This payment cannot be collected twice.</p></div>
      </section>
      <aside class="reserve-aside">
        <div class="prism-object-wrap" aria-hidden="true">${prismSculpture}<span class="object-caption">A way back, prepared in advance.</span></div>
        <section class="reserve-panel" aria-labelledby="reserve-title">
          <div class="panel-topline"><span>CONTINUITY, BY DESIGN</span><span class="panel-edition">A / B</span></div>
          <div class="account-route" aria-label="Original app A and independent reserve B access the same account"><span class="route-node">A<small>Original app</small></span><span class="route-line" aria-hidden="true"><i>=</i></span><span class="route-node reserve-node">B<small>Your reserve</small></span></div>
          <h3 id="reserve-title">Same account.<br>A separate way back.</h3>
          <p>Keep access to the account that already owns your rights, even if the original app is gone.</p>
          <div class="panel-detail"><span>Prepare in advance</span><span>Open independently</span></div>
        </section>
        <div class="facts"><span class="facts-label">${hosted?'DEMONSTRATION':'LOCAL PROTOTYPE'}</span><p>${hosted?'Example accounts and test MON only. Experimental software, not a production custody service.':env.physicalEnabled?'Physical passkeys with a disposable local chain. This run does not prove public Monad use.':'Synthetic credentials and a disposable local chain. Physical passkeys and public Monad are not proved by this run.'}</p></div>
      </aside>
    </div>
    ${!hosted?`<details class="demo-controls"><summary><span>Demo controls</span><span class="summary-hint">Account models & app availability</span></summary><div class="demo-content"><section class="lab"><div><h3>Account model</h3><p>Source-derived reference fixtures. No upstream integration or endorsement.</p></div><nav aria-label="Account model"><a id="iris-model" href="/?model=iris" ${model==='iris'?'aria-current="page"':''}>Direct PRF account</a><a id="accrue-model" href="/?model=accrue" ${model==='accrue'?'aria-current="page"':''}>Derived worker account</a></nav></section>${!primary?'<section class="lab outage"><div><h3>Original app availability</h3><p id="availability">Checking original app state…</p></div><button id="outage" class="secondary">Take original app offline</button></section>':''}</div></details>`:''}
    <details class="limits"><summary>Trust & limitations</summary><p>This experiment uses example accounts and valueless test units. The reserve contains full signing authority for one account. Compromised recovery code can misuse that authority; this does not revoke the original key. Recovery still needs the recovery credential, ciphertext, recovery client and chain access. ${hosted?'This time-limited demonstration deletes its stored reserve at '+release.expiresAt+'. Do not use it for accounts or work you need to keep.':'The local demo stores ciphertext in RAM and loses it on server restart.'}</p><p>A correct encrypted key export can recover the same account too. This experiment tests whether credential-based discovery without an export file is useful enough to justify preparing a separate reserve. Recovery currently makes two WebAuthn assertions; that is not a one-prompt claim.</p></details>
  </main><footer><span>ContinuityKit <span class="footer-divider">/</span> Experimental account reserve</span><span>Example data only · No real funds</span></footer>
</div>`;
function stage(title,instruction,note){$('title').textContent=title;$('instruction').textContent=instruction;$('action-note').textContent=note;}
function status(text,kind='info'){$('status').hidden=false;$('status').className='status '+kind;$('status').textContent=text;}
function beginProgress(kind,signal,useExisting=false){
  operationProgress?.stop();
  operationProgress=createReserveProgress({kind,signal,useExisting,onChange:view=>{
    const setup=view.kind==='setup',complete=view.state==='complete';
    $('passkey-progress').hidden=false;$('passkey-progress').setAttribute('aria-busy',String(view.state==='active'));
    $('passkey-guide').hidden=complete;$('passkey-stages').hidden=complete;
    $('passkey-progress-title').textContent=complete?(setup?'Reserve setup verified':'Reserve opened'):(setup?'Reserve setup':'Opening your reserve');
    $('passkey-stage-count').textContent=view.state==='complete'?'Complete':view.state==='stopped'?'Stopped':`Stage ${view.index+1} of ${view.total}`;
    $('passkey-stages').replaceChildren(...view.steps.map((step,i)=>{
      const item=document.createElement('li');item.className=step.state;item.dataset.stage=step.id;
      if(step.state==='active')item.setAttribute('aria-current','step');
      const marker=document.createElement('span');marker.className='progress-marker';marker.setAttribute('aria-hidden','true');marker.textContent=step.state==='complete'?'✓':String(i+1);
      const label=document.createElement('span');label.className='progress-label';label.textContent=step.label;
      const state=document.createElement('small');state.textContent={active:'In progress',complete:'Complete',pending:'Waiting',stopped:'Stopped'}[step.state];
      item.append(marker,label,state);return item;
    }));
    if(view.state==='active')status(`${setup?'Setup':'Recovery'} stage ${view.index+1} of ${view.total}: ${view.steps[view.index].label}. ${view.detail}`);
    else if(view.state==='stopped')status('The action stopped before all stages completed. Keep existing passkeys; no completion is assumed.','error');
  }});
  return operationProgress;
}
function action(label,handler,secondary=false){const button=document.createElement('button');button.textContent=label;button.className=secondary?'secondary':'primary';button.addEventListener('click',()=>run(button,handler));$('actions').append(button);return button;}
function link(label,url){const a=document.createElement('a');a.className='button-link';a.textContent=label;a.href=url;$('actions').append(a);}
async function run(button,fn){if(busy)return;busy=true;button.disabled=true;try{await fn();}catch(e){operationProgress?.stop();status(friendly(e),'error');}finally{busy=false;if(button.isConnected)button.disabled=false;}}
function friendly(e){const code=e.code||e.name||e.message;const known={OPERATION_CANCELLED:'The action was stopped. Keep existing passkeys; no completion is assumed.',OPERATION_TIMED_OUT:'The passkey action timed out. Keep existing passkeys and reopen the existing account to continue.',SETUP_EXPIRED:'Setup expired. Keep existing passkeys. Check the existing reserve before deliberately continuing setup.',PASSKEY_OPERATION_FAILED:'The passkey could not open this reserve. Choose the recovery credential you prepared, and keep any existing passkeys.',NotAllowedError:'The passkey action was cancelled or not supported. Keep your existing credential; no success is assumed.',RESERVE_MISSING:'No reserve matches this credential. Choose the original recovery credential; creating another will not recover it.',STORE_WRITE_UNKNOWN:'Storage confirmation is unclear. Do not repeat setup. Try opening the existing reserve in a fresh tab.',RESERVE_PREPARATION_UNCONFIRMED:'The stored reserve was not independently confirmed. Keep the credential and try a fresh recovery.',MANIFEST_AUTH_FAILED:'The reserve failed authentication. No account was opened.',SESSION_EXPIRED:'The signing session expired. Open the existing reserve again.'};return known[code]||known[e.message]||'The action stopped ('+(e.code||e.message||'UNKNOWN')+'). No completion is assumed.';}
function identity(owner){$('identity').hidden=false;$('owner').textContent=owner;}
function clearKey(){privateKey?.fill(0);privateKey=undefined;originalSession?.end();originalSession=undefined;}
function closeRecovered(){clearTimeout(expiresTimer);executor?.close();recovered?.close();recovered=undefined;}
function activePage(){if(abort.signal.aborted)throw new Error('OPERATION_CANCELLED');}
function cleanup(){abort.abort();clearTimeout(expiresTimer);clearKey();closeRecovered();if(handoff){clearTimeout(handoff.timer);clearInterval(handoff.poll);handoff.port?.close();handoff.phase='closed';}}
window.addEventListener('pagehide',cleanup,{once:true});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});

function reopenPrimaryActions(){
  $('actions').replaceChildren();action('Open existing example account',openOriginal);
  link('Check existing reserve',env.recoveryOrigin+'/?model='+model);
}
async function acquirePrimary(create){
  clearKey();
  const key=await openPrimaryKey({create,model,rpId:config.originalRpId,webAuthnClient,signal:abort.signal});
  try{activePage();privateKey=new Uint8Array(key);originalSession=createSecp256k1SigningSession({privateKey});}
  catch(error){clearKey();throw error;}
  finally{key.fill(0);}
  armOriginalExpiry();return toViemAccount(originalSession).address.toLowerCase();
}
async function createOriginal(){
  status('Creating the example account…');
  try{
    const owner=await acquirePrimary(true);
    if(hosted){await findOriginalPayment(owner);return;}
    right=await api('/api/prepare-right',{owner});activePage();showOriginalPayment(owner);
  }catch(error){clearKey();if(!abort.signal.aborted)reopenPrimaryActions();throw error;}
}
function armOriginalExpiry(){
  clearTimeout(expiresTimer);expiresTimer=setTimeout(()=>{clearKey();reopenPrimaryActions();status('The signing session expired. Reopen with the existing primary passkey.','error');},10*60*1000);
}
async function openOriginal(){
  status('Opening the existing example account…');
  try{const owner=await acquirePrimary(false);await findOriginalPayment(owner);}
  catch(error){clearKey();if(!abort.signal.aborted)reopenPrimaryActions();throw error;}
}
async function findOriginalPayment(owner){
  identity(owner);$('actions').replaceChildren();
  if(hosted){
    const deployment=await inspectHostedDeployment({profile:release,clients:release.rpcUrls.map(url=>createPublicClient({chain,ccipRead:false,cacheTime:0,transport:publicTestnetTransport(url)}))});
    activePage();
    if(deployment!=='ready'){
      const detail={
        'awaiting-deployment':'The demonstration payment contract is not yet confirmed at the proposed address. The operator can use this account address to prepare the payment.',
        partial:'The approved network connections do not yet agree that the payment contract is deployed. Reserve setup waits for both to confirm it.',
        unavailable:'The demonstration deployment could not be checked on both approved network connections. Payment readiness is unconfirmed.',
        mismatch:'The network or deployed code does not match this demonstration. The operator must resolve it before reserve setup can continue.',
      }[deployment];
      stage('Your example account is ready.',detail,'Keep this passkey. Checking payment readiness is read-only; reserve setup becomes available after the deployment and payment are verified.');
      $('right-status').textContent='Awaiting verified demonstration payment.';
      status(detail,deployment==='mismatch'?'error':'info');action('Check payment readiness',()=>findOriginalPayment(owner));return;
    }
  }
  const id=await publicClient.readContract({address:env.contractAddress,abi:env.abi,functionName:'rightForOwner',args:[owner]});
  activePage();
  if(id===0n){stage('Your example account is ready.','The demo operator can now prepare the test payment for this account.','Keep this tab open and keep the existing passkey. Check again when the payment is prepared.');$('right-status').textContent='No demonstration payment has been issued for this account yet.';status('Your example account is ready. The demo operator can now prepare its test payment. Keep this tab open, then check again.');action(hosted?'Check payment readiness':'Check example payment',()=>findOriginalPayment(owner));if(!hosted)action('Prepare local example payment',async()=>{right=await api('/api/prepare-right',{owner});activePage();showOriginalPayment(owner);},true);return;}
  const r=await publicClient.readContract({address:env.contractAddress,abi:env.abi,functionName:'getRight',args:[id]});
  activePage();
  if(r.beneficiary.toLowerCase()!==owner)throw new Error('EXAMPLE_PAYMENT_NOT_AVAILABLE');
  if(r.claimed){clearKey();stage('This payment is already collected.','Your existing account was reopened. No new payment is being sent.','Keep your existing passkeys.');$('right-status').textContent='The existing payment has been collected.';link('Open existing reserve',env.recoveryOrigin+'/?model='+model);return;}
  if(hosted){
    if(id!==1n||r.amount!==100000000000000000n)throw new Error('ACCOUNT_OUTSIDE_APPROVED_DEMONSTRATION');
    await Promise.all(release.rpcUrls.map(async url=>{
      const client=createPublicClient({chain,ccipRead:false,cacheTime:0,transport:publicTestnetTransport(url)});
      const [network,code,issuer,matched]=await Promise.all([client.getChainId(),client.getCode({address:env.contractAddress,blockTag:'finalized'}),client.readContract({address:env.contractAddress,abi:env.abi,functionName:'issuer'}),client.readContract({address:env.contractAddress,abi:env.abi,functionName:'getRight',args:[1n]})]);
      if(network!==10143||!code||keccak256(code)!==release.expectedRuntimeCodeHash||issuer.toLowerCase()!==release.issuer.toLowerCase()||matched.beneficiary.toLowerCase()!==owner||matched.amount!==100000000000000000n||matched.claimed)throw new Error('ACCOUNT_OUTSIDE_APPROVED_DEMONSTRATION');
    }));
  }
  activePage();right={id,...r};$('amount').textContent=formatEther(r.amount);showOriginalPayment(owner);
}
function showOriginalPayment(owner){
  stage('Your example account is ready.','Prepare its independent reserve while this app is available.','The next step opens a separate window. Keep this one open until the reserve is confirmed.');
  identity(owner);$('right-status').textContent='Payment locked for this account before reserve preparation.';
  $('step1').classList.add('complete');$('actions').replaceChildren();
  status('The example payment is locked for this account. Prepare the reserve next.','success');
  action('Prepare independent reserve',()=>startHandoff(owner));
}
function startHandoff(owner){
  if(!privateKey)throw new Error('SESSION_EXPIRED');
  const nonce=randomNonce();
  const popup=window.open(env.recoveryOrigin+'/?model='+model+'#enroll='+nonce,'_blank');
  if(!popup)throw new Error('POPUP_BLOCKED');
  clearTimeout(expiresTimer); // The bounded handoff now owns the key lifetime.
  $('actions').replaceChildren();status('Continue in the reserve window. Keep this tab open until preparation is confirmed.');
  handoff={origin:env.recoveryOrigin,source:popup,nonce,phase:'waiting',expiresAt:Date.now()+5*60*1000};
  const stop=message=>{if(handoff.phase==='ready'||handoff.phase==='closed')return;handoff.phase='closed';clearKey();clearTimeout(expiresTimer);clearTimeout(handoff.timer);clearInterval(handoff.poll);handoff.port?.close();window.removeEventListener('message',handoff.receive);try{popup.postMessage({version:1,kind:'cancel',nonce},env.recoveryOrigin);}catch{}reopenPrimaryActions();status(message+' Reopen the original account and use your existing reserve passkey to continue.','error');};
  handoff.timer=setTimeout(()=>stop('Reserve setup expired. Keep any credential already created; no completed reserve is claimed.'),5*60*1000);
  handoff.poll=setInterval(()=>{if(popup.closed)stop('The reserve window closed before confirmation. No completed reserve is claimed.');},500);
  handoff.receive=event=>{
    if(!validHandoff(event,handoff,'receive'))return;
    if(!(privateKey instanceof Uint8Array)||privateKey.length!==32){stop('The original signing session is no longer available.');return;}
    handoff.phase='transferred';
    const channel=new MessageChannel();handoff.port=channel.port1;
    channel.port1.onmessage=event=>{
      if(handoff.phase!=='transferred'||Date.now()>=handoff.expiresAt||event.data?.kind!=='prepared'||event.data?.owner!==owner)return;
      handoff.phase='ready';window.removeEventListener('message',handoff.receive);clearTimeout(handoff.timer);clearInterval(handoff.poll);clearTimeout(expiresTimer);channel.port1.close();
      stage('Your reserve is ready.','Your encrypted reserve has been stored and independently reopened.','Keep your original and recovery passkeys. Recovery uses the separate reserve credential.');
      $('step2').classList.add('complete');status('Reserve prepared and independently checked. Open a fresh reserve, then take this app offline.','success');
      link('Open a fresh reserve',env.recoveryOrigin+'/?model='+model);
    };
    popup.postMessage({version:1,kind:'channel',nonce},env.recoveryOrigin,[channel.port2]);
    const key=new Uint8Array(privateKey);channel.port1.postMessage({kind:'account',privateKey:key,expectedOwner:owner,expiresAt:handoff.expiresAt},[key.buffer]);clearKey();
  };
  window.addEventListener('message',handoff.receive,{signal:abort.signal});
}
async function enroll(useExisting=false){
  if(Date.now()>=enrollmentDeadline||!enrollmentNonce||enrollmentAttempted)throw new Error('SETUP_EXPIRED');
  const setupStore=hosted?createReserveHttpStore({enrollmentToken:$('enrollment-code').value.trim()}):store;
  if(hosted){$('enrollment-code').value='';$('enrollment-code').disabled=true;}
  enrollmentAttempted=true;
  const enrollmentAbort=new AbortController();
  const expire=()=>enrollmentAbort.abort();
  abort.signal.addEventListener('abort',expire,{once:true});
  const expected={origin:env.primaryOrigin,source:opener,nonce:enrollmentNonce,phase:'waiting',expiresAt:enrollmentDeadline};
  const cancelled=event=>{if(validHandoff(event,{...expected,phase:'waiting'},'cancel'))expire();};
  window.addEventListener('message',cancelled);
  let deadlineTimer=setTimeout(expire,Math.max(1,enrollmentDeadline-Date.now()));
  const scope=createWebAuthnScope({webAuthnClient,signal:enrollmentAbort.signal,timeoutMs:Math.max(1,enrollmentDeadline-Date.now())});
  const active=()=>{activePage();scope.assertActive();if(Date.now()>=enrollmentDeadline)throw new Error('SETUP_EXPIRED');};
  let port, credential, payload;
  const wipePayload=()=>payload?.privateKey?.fill(0);
  enrollmentAbort.signal.addEventListener('abort',wipePayload,{once:true});
  try{
    const progress=beginProgress('setup',enrollmentAbort.signal,useExisting);
    credential=useExisting
      ?await getPasskeyPrfOutput({rpId:config.recoveryRpId,webAuthnClient:scope.client})
      :await createReserveCredential({config,user:{name:'Reserve '+model+' '+new Date().toISOString(),displayName:'Reserve '+model},webAuthnClient:scope.client,signal:enrollmentAbort.signal,timeoutMs:Math.max(1,enrollmentDeadline-Date.now())});
    credential.prfOutput?.fill(0);credential.prfSalt?.fill(0);active();
    status('The recovery passkey is ready. Waiting for the original window to provide this account; keep both windows open.');
    payload=await new Promise((resolve,reject)=>{
      let settled=false;
      function detach(){window.removeEventListener('message',receive);enrollmentAbort.signal.removeEventListener('abort',stop);}
      function stop(){if(settled)return;settled=true;detach();port?.close();reject(new Error('SETUP_EXPIRED'));}
      function receive(event){
        if(!validHandoff(event,expected,'channel')||event.ports?.length!==1)return;
        expected.phase='transferred';window.removeEventListener('message',receive);port=event.ports[0];
        port.onmessage=event=>{
          const d=event.data;
          if(settled||enrollmentAbort.signal.aborted){d?.privateKey?.fill?.(0);return;}
          if(d?.kind!=='account'||Object.keys(d).sort().join(',')!=='expectedOwner,expiresAt,kind,privateKey'||!(d.privateKey instanceof Uint8Array)||d.privateKey.length!==32||!/^0x[0-9a-f]{40}$/.test(d.expectedOwner)||!Number.isSafeInteger(d.expiresAt)||d.expiresAt<=Date.now()||d.expiresAt>Date.now()+5*60*1000){d?.privateKey?.fill?.(0);stop();return;}
          settled=true;detach();port.onmessage=event=>event.data?.privateKey?.fill?.(0);resolve(d);
        };port.start();
      }
      window.addEventListener('message',receive);enrollmentAbort.signal.addEventListener('abort',stop,{once:true});
      if(enrollmentAbort.signal.aborted){stop();return;}
      opener.postMessage({version:1,kind:'receive',nonce:enrollmentNonce},env.primaryOrigin);
    });
    active();enrollmentDeadline=Math.min(enrollmentDeadline,payload.expiresAt);clearTimeout(deadlineTimer);deadlineTimer=setTimeout(expire,Math.max(1,enrollmentDeadline-Date.now()));
    const result=await prepareOrConfirmReserve({privateKey:payload.privateKey,policy:{...config,expectedOwner:payload.expectedOwner},recoveryCredential:credential,webAuthnClient:scope.client,store:setupStore,signal:enrollmentAbort.signal,onProgress:progress.advance},useExisting);active();wipePayload();
    port.postMessage({kind:'prepared',owner:result.owner});enrollmentNonce=null;
    progress.complete();
    stage('Your reserve is ready.','Open a fresh reserve to continue without this setup window.','Keep both passkeys. The reserve has full signing authority for this same account.');
    identity(result.owner);$('right-status').textContent='Stored ciphertext was reopened and a challenge signature verified.';
    $('actions').replaceChildren();status('Reserve prepared and independently checked. The signing session is closed.','success');
    $('step1').classList.add('complete');$('step2').classList.add('complete');
    link('Open a fresh reserve',env.recoveryOrigin+'/?model='+model);
  }catch(error){
    enrollmentNonce=null;
    if(!abort.signal.aborted){$('actions').replaceChildren();link('Check existing reserve',env.recoveryOrigin+'/?model='+model);stage('Setup needs attention.','Keep any passkeys already created. First check whether the reserve was stored.','If no reserve exists, reopen the original account and deliberately continue with the existing reserve passkey. No key is replaced automatically.');}
    throw error;
  }finally{wipePayload();credential?.close?.();credential?.prfOutput?.fill(0);credential?.prfSalt?.fill(0);scope.close();port?.close();clearTimeout(deadlineTimer);window.removeEventListener('message',cancelled);abort.signal.removeEventListener('abort',expire);enrollmentAbort.abort();setupStore.clearEnrollmentCapability?.();}
}
async function readRight(){
  const id=await publicClient.readContract({address:env.contractAddress,abi:env.abi,functionName:'rightForOwner',args:[recovered.owner]});
  if(id===0n)throw new Error('NO_EXISTING_PAYMENT');
  const r=await publicClient.readContract({address:env.contractAddress,abi:env.abi,functionName:'getRight',args:[id]});
  if(r.beneficiary.toLowerCase()!==recovered.owner)throw new Error('BENEFICIARY_MISMATCH');
  activePage();right={id,...r};$('amount').textContent=formatEther(right.amount);$('right-status').textContent=right.claimed?'This payment has already been collected.':'Your existing payment is ready to collect.';
}
async function openReserve(){
  closeRecovered();const progress=beginProgress('recovery',abort.signal);
  recovered=await recoverReserve({config,webAuthnClient,store,signal:abort.signal,onProgress:progress.advance});
  try{
    activePage();progress.advance('check-account');
    await readRight();activePage();
    executor=hosted?createTestnetClaimExecutor({profile:release,recovered}):createClaimExecutor({wallet:createWalletClient({account:recovered.account,chain,transport:http('/rpc',{retryCount:0})}),publicClient,chainId:31337,address:env.contractAddress,abi:env.abi,owner:recovered.owner,pendingStore:createBrowserPendingStore({chainId:31337,address:env.contractAddress,owner:recovered.owner})});
    try{await executor.check();}catch(error){if(error.code!=='PENDING_TICKET_MISSING')throw error;}
  }catch(e){closeRecovered();throw e;}
  activePage();
  progress.complete();
  stage('Your account is open.','The recovered account matches the original beneficiary of this payment.','This signing session closes after five minutes or when the payment is confirmed.');
  identity(recovered.owner);$('step1').classList.add('complete');$('step2').classList.add('complete');$('step3').classList.add('complete');
  status('The original account is open. Its existing right was found directly on the '+(hosted?'testnet.':'local chain.'),'success');$('actions').replaceChildren();
  if(executor.hash)action('Check existing transaction',checkTransaction,true);
  else if(!right.claimed)action('Collect '+formatEther(right.amount)+(hosted?' test MON':' test units'),claim);
  action('Close signing session',()=>{closeRecovered();$('actions').replaceChildren();action('Open existing reserve',openReserve);status('Signing session closed.');},true);
  expiresTimer=setTimeout(()=>{closeRecovered();$('actions').replaceChildren();if(executor?.hash){action('Check existing transaction',checkTransaction,true);status('Signing session expired. The existing transaction can still be checked without signing.');}else{action('Open existing reserve',openReserve);status('Signing session expired. Open the reserve again to continue.');}},5*60*1000);
}
async function claim(){
  if(!recovered)throw new Error('SESSION_EXPIRED');
  if(executor.hash)return checkTransaction();
  await readRight();if(right.claimed)throw new Error('ALREADY_CLAIMED');
  status('Signing the fixed test-payment claim…');
  try{await executor.claim(right.id);}catch(error){
    if(executor.hash){$('actions').replaceChildren();action('Check existing transaction',checkTransaction,true);status(executor.deliveryStatus==='not-attempted'?'The claim was signed but stopped before delivery. Operator reconciliation is required. Keep this transaction; do not sign again.':'Delivery is uncertain. Check the existing signed transaction; another transaction will not be sent.');closeRecovered();return;}
    $('actions').replaceChildren();closeRecovered();action('Open existing reserve',openReserve);throw error;
  }
  $('actions').replaceChildren();action('Check existing transaction',checkTransaction,true);status('Claim sent. Checking this transaction; another claim will not be sent.');
  await checkTransaction();
}
async function checkTransaction(){
  if(!executor?.hash)throw new Error('NO_TRANSACTION');
  const {hash,receipt}=await executor.check();
  if(!receipt){status(executor.deliveryStatus==='not-attempted'?'The signed claim was not delivered by this session. Operator reconciliation is required; checking will not send it.':executor.deliveryStatus==='unknown'?'No receipt is available for the saved transaction. Its delivery is unconfirmed. Keep it for reconciliation; do not sign another claim.':'The existing transaction has no receipt yet. Check its status again; no new signature or transaction is created.');return;}
  if(recovered)await readRight();
  stage('Payment collected.','The same original account received its existing payment.','The signing session is closed. No new transaction is needed.');
  $('receipt').hidden=false;$('hash').textContent=hash;$('actions').replaceChildren();closeRecovered();
  status('Payment collected by the same original account. The reserve signing session is now closed.','success');
}
async function refreshAvailability(){const result=await api('/api/status');$('availability').textContent=result.primaryOnline?'Original app and its API are online.':'Original app and its API return 503. Reserve recovery uses its own endpoint.';$('outage').textContent=result.primaryOnline?'Take original app offline':'Bring original app online';$('outage').dataset.online=String(result.primaryOnline);}
if(primary){action(hosted?'Open existing example account':'Create example account',hosted?openOriginal:createOriginal);action(hosted?'Create a new example account':'Open existing example account',hosted?createOriginal:openOriginal,true);}
else{
  if(isEnrollment){action('Prepare this reserve',()=>enroll(false));action('Continue with existing reserve passkey',()=>enroll(true),true);}else action('Open existing reserve',openReserve);
  if(!hosted){$('outage').addEventListener('click',()=>run($('outage'),async()=>{await api('/control/primary',{online:$('outage').dataset.online!=='true'});await refreshAvailability();}));await refreshAvailability();}
}
