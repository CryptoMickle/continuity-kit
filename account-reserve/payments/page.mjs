import {formatEther} from 'viem';
import {prismBackdrop,prismSculpture} from '../starter/prism-art.mjs';

export function mountPaymentPage(root,{role,profile,openAccount,createClient,createReader,window:win=globalThis.window,sessionMs=5*60*1000}){
  if(!['primary','recovery'].includes(role))throw new Error('PAYMENT_ROLE_INVALID');
  const rightId=role==='primary'?1n:2n,intent=profile.claims.find(c=>c.rightId===rightId);
  if(!intent)throw new Error('PAYMENT_NOT_APPROVED');
  if(!Number.isFinite(Date.parse(profile.expiresAt)))throw new Error('PAYMENT_PROFILE_INVALID');
  root.innerHTML=`${prismBackdrop}<main class="payment-shell"><header><a class="wordmark" href="/">continuitykit</a><span class="network">Monad testnet · example payments</span></header><section class="payment-layout"><div class="payment-main"><p class="eyebrow">ACCOUNT CONTINUITY / ${role==='primary'?'ORIGINAL APP':'INDEPENDENT RESERVE'}</p><h1>Your next payment.<br><span>The same account.</span></h1><p class="intro">${role==='primary'?'Collect a funded payment with the account you already use. Its prepared reserve stays ready for the next one.':'The original app can be unavailable. Your prepared reserve can still collect a new payment owed to the same account.'}</p><ol class="payment-steps"><li>First payment</li><li>Original app unavailable</li><li>Next payment in the reserve</li></ol><article class="payment-card"><p class="eyebrow">${role==='primary'?'01 / ORIGINAL ACCOUNT':'02 / EXISTING RESERVE'}</p><h2 id="payment-title">${role==='primary'?'Open your existing account.':'Return to your prepared account.'}</h2><p id="payment-description">Use the existing ${role==='primary'?'primary':'recovery'} passkey. No new credential or reserve is created.</p><dl class="payment-details"><div><dt>Payment amount</dt><dd id="payment-amount"></dd></div><div><dt>Network fee limit</dt><dd>Up to 0.06 test-MON</dd></div></dl><p class="payment-status" id="payment-status" role="status" aria-live="polite">No signing session is open.</p><div class="payment-actions"><button id="payment-open">${role==='primary'?'Open existing account':'Open existing reserve'}</button><button id="payment-claim" hidden>Collect this payment</button><button class="secondary" id="payment-check">Check existing transaction</button><button class="secondary" id="payment-close" hidden>Close signing session</button></div><p class="payment-help">Your device may ask for several confirmations. Opening the account does not send a transaction. Closing a session cannot cancel a transaction already sent.</p><div id="payment-receipt" hidden><p>Transaction reference</p><output id="payment-hash"></output></div></article></div><aside class="payment-art">${prismSculpture}<div class="payment-note"><h2>Income continues.<br>Even when the app doesn't.</h2><p>Each payment is funded separately. Recovery preserves the beneficiary; it does not create or earn the payment.</p></div></aside></section><footer>Test tokens only. This demonstration shows capability, not customer activity. The reserve restores full account signing authority. An existing passkey, trusted recovery site and prepared ciphertext are required.</footer></main>`;
  const $=id=>root.querySelector('#'+id);$('payment-amount').textContent=formatEther(intent.amount)+' test-MON';
  let client,executor,timer,busy=false,dead=false,confirmed=false,unresolved=false,operation;
  const status=text=>$('payment-status').textContent=text;
  function buttons(){
    $('payment-open').hidden=!!client||confirmed||unresolved;$('payment-claim').hidden=!client||confirmed||unresolved;
    $('payment-close').hidden=!client&&!busy;
    for(const id of ['payment-open','payment-claim','payment-check'])$(id).disabled=busy||dead;
  }
  function close(message){operation?.abort();operation=undefined;clearTimeout(timer);executor?.close();client?.close();executor=client=undefined;if(message)status(message);buttons();}
  function outcome(result){
    if(result.hash){unresolved=true;$('payment-receipt').hidden=false;$('payment-hash').textContent=result.hash;close();}
    if(result.receipt){confirmed=true;unresolved=false;close();$('payment-title').textContent='Payment received.';status('The payment is confirmed on Monad testnet. The signing session is closed.');}
    else status('Confirmation is pending. Check the existing transaction; do not send again.');
  }
  function failure(error){
    const code=typeof error?.code==='string'?error.code:'';
    const known={PAYMENT_TRANSACTION_MISSING:'No transaction is recorded in this browser. Opening the account does not send a payment.',PAYMENT_ACCOUNT_BLOCKED:'An earlier transaction is unresolved. Check it before starting a new payment.',PAYMENT_RECONCILIATION_REQUIRED:'An earlier attempt needs inspection. No automatic retry will be made.',PAYMENT_NONCE_MISMATCH:'The account has changed or a transaction is pending. No new payment was sent.',PAYMENT_PROFILE_EXPIRED:'This demonstration has ended. Existing transaction status can still be checked.',PAYMENT_SIGNER_MISMATCH:'This is a different account. Choose the existing passkey for the prepared beneficiary.',PAYMENT_RIGHT_MISMATCH:'This payment is not ready or has already been collected. Check its transaction status.',PAYMENT_SESSION_CLOSED:'The signing session is closed. An existing transaction can still be checked.'};
    status(known[code]??'The action did not finish. Keep the existing passkey. Check transaction status before starting another attempt.');
  }
  async function run(action){if(busy||dead)return;busy=true;buttons();try{await action();}catch(e){if(!dead){if(executor?.hash)outcome({hash:executor.hash});failure(e);}}finally{busy=false;if(!dead)buttons();}}
  $('payment-open').onclick=()=>run(async()=>{
    close();operation=new AbortController();const current=operation;
    status('Open the existing passkey when your device asks.');
    const recovered=await openAccount({signal:current.signal});
    if(dead||current.signal.aborted||operation!==current){recovered.close();return;}
    try{client=createClient(recovered);executor=client.forRight(rightId);}catch(e){recovered.close();client=undefined;throw e;}
    timer=setTimeout(()=>close('The signing session expired. You can still check an existing transaction.'),Math.min(sessionMs,Math.max(0,Date.parse(profile.expiresAt)-Date.now())));
    status('Existing account opened. Collect this payment only when you are ready.');buttons();
  });
  $('payment-claim').onclick=()=>run(async()=>{if(!executor)return;status('Checking the funded payment and sending this exact claim once…');const result=await executor.claim();if(!dead)outcome(result);});
  $('payment-check').onclick=()=>run(async()=>{status('Checking the existing transaction without signing…');const result=await createReader().check(rightId);if(!dead)outcome(result);});
  $('payment-close').onclick=()=>close('Signing session closed. Existing transactions are still checkable.');
  const teardown=()=>{dead=true;close();};win.addEventListener('pagehide',teardown);
  const pageshow=e=>{if(e.persisted)win.location.reload();};win.addEventListener('pageshow',pageshow);
  buttons();return Object.freeze({close(){teardown();win.removeEventListener('pagehide',teardown);win.removeEventListener('pageshow',pageshow);}});
}
