import {formatEther} from 'viem';
import {prismBackdrop,prismSculpture} from '../starter/prism-art.mjs';

export function mountPaymentPage(root,{role,profile,openAccount,createClient,createReader,createVerifier,createAvailability,window:win=globalThis.window,sessionMs=5*60*1000,readinessMs=30000,monotonicNow=()=>win.performance.now()}){
  if(!['primary','recovery'].includes(role))throw new Error('PAYMENT_ROLE_INVALID');
  // The host validates the full signing profile. Capture its bounded display choices
  // so neither a changed DOM value nor later caller mutation can widen this view.
  if(!Array.isArray(profile.claims)||profile.claims.length<1||profile.claims.length>8)throw new Error('PAYMENT_NOT_APPROVED');
  const claims=Object.freeze(Array.from(profile.claims,c=>{
    if(!c||typeof c.rightId!=='bigint'||c.rightId<=0n||c.rightId>=2n**256n||typeof c.amount!=='bigint'||c.amount<=0n)throw new Error('PAYMENT_NOT_APPROVED');
    return Object.freeze({...c});
  }));
  if(new Set(claims.map(c=>c.rightId)).size!==claims.length)throw new Error('PAYMENT_NOT_APPROVED');
  profile=Object.freeze({...profile,claims});
  let intent=claims[0],rightId=intent.rightId;
  if(!Number.isFinite(Date.parse(profile.expiresAt)))throw new Error('PAYMENT_PROFILE_INVALID');
  if(!Number.isFinite(readinessMs)||readinessMs<=0||readinessMs>30000||typeof monotonicNow!=='function')throw new Error('PAYMENT_READINESS_OPTIONS_INVALID');
  root.innerHTML=`${prismBackdrop}<main class="payment-shell"><header><a class="wordmark" href="/">continuitykit</a><span class="network">Monad testnet · example payments</span></header><section class="payment-layout"><div class="payment-main"><p class="eyebrow">ACCOUNT CONTINUITY / ${role==='primary'?'ORIGINAL APP':'INDEPENDENT RESERVE'}</p><h1>Your next payment.<br><span>The same account.</span></h1><p class="intro">${role==='primary'?'Collect a funded payment with the account you already use. Its prepared reserve stays ready for the next one.':'The original app can be unavailable. Your prepared reserve can still collect a new payment owed to the same account.'}</p><ol class="payment-steps"><li>First payment</li><li>Original app unavailable</li><li>Next payment in the reserve</li></ol><article class="payment-card"><p class="eyebrow">${role==='primary'?'01 / ORIGINAL ACCOUNT':'02 / EXISTING RESERVE'}</p><h2 id="payment-title">Check before you open.</h2><p id="payment-description">Payment availability is checked without a passkey. You open your existing account only if this payment is available.</p><div class="payment-choice"><label for="payment-right">Payment to collect</label><select id="payment-right" aria-describedby="payment-choice-help"></select><p id="payment-choice-help" class="payment-help">Choose an approved payment. Changing it closes the signing session and checks availability again.</p></div><dl class="payment-details"><div><dt>Payment amount</dt><dd id="payment-amount"></dd></div><div><dt>Network fee limit</dt><dd>Up to 0.06 test-MON</dd></div></dl><p class="payment-status" id="payment-status" role="status" aria-live="polite">Checking payment availability…</p><div class="payment-actions"><button id="payment-refresh" class="secondary">Check payment availability</button><button id="payment-open" hidden>${role==='primary'?'Open existing account':'Open existing reserve'}</button><button id="payment-claim" hidden>Collect this payment</button><button class="secondary" id="payment-check">Check existing transaction</button><button class="secondary" id="payment-close" hidden>Close signing session</button></div><p class="payment-help">Your device may ask for several confirmations. Opening the account does not send a transaction. Closing a session cannot cancel a transaction already sent.</p><div id="payment-receipt" hidden><p>Transaction reference</p><output id="payment-hash"></output></div></article><section class="payment-card reference-card" aria-labelledby="reference-heading"><p class="eyebrow">CHECK FROM ANY BROWSER</p><h2 id="reference-heading">Already collected a payment?</h2><p>Paste its transaction reference to verify the payment. No passkey is needed.</p><form id="reference-form" novalidate><label for="reference-right">Expected payment</label><select id="reference-right"></select><label for="reference-hash">Transaction reference</label><input id="reference-hash" type="text" placeholder="0x…" maxlength="66" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="reference-help"><div class="payment-actions"><button id="reference-check" type="submit">Verify transaction reference</button></div></form><p id="reference-help" class="payment-help">This checks only the reference you provide. It does not find payment history or change an unresolved attempt in this browser.</p><p id="reference-status" class="payment-status" role="status" aria-live="polite">No reference checked.</p><dl id="reference-details" class="payment-details" hidden></dl></section></div><aside class="payment-art">${prismSculpture}<div class="payment-note"><h2>Income continues.<br>Even when the app doesn't.</h2><p>Each payment is funded separately. Recovery preserves the beneficiary; it does not create or earn the payment.</p></div></aside></section><footer>Test tokens only. This demonstration shows capability, not customer activity. The reserve restores full account signing authority. An existing passkey, trusted recovery site and prepared ciphertext are required.</footer></main>`;
  const $=id=>root.querySelector('#'+id);$('payment-amount').textContent=formatEther(intent.amount)+' test-MON';
  for(const id of ['payment-right','reference-right'])for(const claim of claims){const option=root.ownerDocument.createElement('option');option.value=String(claim.rightId);option.textContent=`Payment ${claim.rightId} · ${formatEther(claim.amount)} test-MON`;option.selected=claim.rightId===rightId;$(id).append(option);}

  let client,executor,timer,busy=false,dead=false,confirmed=false,unresolved=false,operation,referenceGeneration=0,referenceChecking=false,availabilityGeneration=0,availabilityChecking=false,availableUntil=0,availabilityTimer,runGeneration=0,claimInFlight=false,authenticationPending,unscopedAccountBlock=false;
  const paymentStates=new Map();
  const remember=()=>paymentStates.set(rightId,{confirmed,unresolved,hash:$('payment-hash').textContent});
  const pendingRight=()=>[...paymentStates].find(([,state])=>state.unresolved)?.[0];
  const accountUnresolved=()=>unscopedAccountBlock||unresolved||pendingRight()!==undefined;
  function rememberUncertainty(error,claimAttempt=false){
    const code=Object.getOwnPropertyDescriptor(error??{},'code')?.value;
    if(code==='PAYMENT_ACCOUNT_BLOCKED')unscopedAccountBlock=true;
    if(code==='PAYMENT_RECONCILIATION_REQUIRED'||claimAttempt&&['PAYMENT_PREPARATION_FAILED','PAYMENT_SIGNING_FAILED','PAYMENT_TRANSACTION_MISMATCH','PAYMENT_SIGNED_TRANSACTION_INVALID','PAYMENT_SIGNED_OWNER_MISMATCH','PAYMENT_STORE_READBACK_FAILED','PAYMENT_STORE_UNAVAILABLE','PAYMENT_SESSION_CLOSED'].includes(code)){unresolved=true;remember();}
  }
  const status=text=>$('payment-status').textContent=text;
  const available=()=>availableUntil>0&&monotonicNow()<availableUntil&&Date.now()<Date.parse(profile.expiresAt);
  function invalidateAvailability(){availabilityGeneration++;availableUntil=0;clearTimeout(availabilityTimer);if(availabilityChecking){availabilityChecking=false;status('Availability check stopped. Check again before opening an account.');}}
  function buttons(){
    $('payment-open').hidden=!!client||!!authenticationPending||confirmed||accountUnresolved()||!available();$('payment-claim').hidden=!client||confirmed||accountUnresolved();
    $('payment-right').disabled=claimInFlight||dead;
    $('payment-close').hidden=!client&&!operation&&!referenceChecking&&!availabilityChecking;$('payment-close').textContent=referenceChecking||availabilityChecking?'Stop checking':operation&&!client?'Cancel opening':'Close signing session';
    for(const id of ['payment-open','payment-claim','payment-check','payment-refresh','reference-check','reference-right','reference-hash'])$(id).disabled=busy||dead;
  }
  function close(message){invalidateAvailability();if(referenceChecking){referenceGeneration++;referenceChecking=false;$('reference-status').textContent='Reference check stopped. No result is assumed.';}operation?.abort();operation=undefined;clearTimeout(timer);executor?.close();client?.close();executor=client=undefined;if(message)status(message);buttons();}
  function outcome(result){
    if(result.hash){unresolved=true;$('payment-receipt').hidden=false;$('payment-hash').textContent=result.hash;close();}
    if(result.receipt){confirmed=true;unresolved=false;close();$('payment-title').textContent='Payment received.';status('The payment is confirmed on Monad testnet. The signing session is closed.');}
    else status('Confirmation is pending. Check the existing transaction; do not send again.');
    remember();buttons();
  }
  function failure(error){
    rememberUncertainty(error);
    const code=typeof error?.code==='string'?error.code:'';
    const known={PAYMENT_TRANSACTION_MISSING:'No transaction is recorded in this browser. Use Verify transaction reference below if you have its reference.',PAYMENT_ACCOUNT_BLOCKED:'An earlier transaction is unresolved. Check it before starting a new payment.',PAYMENT_RECONCILIATION_REQUIRED:'An earlier attempt needs inspection. No automatic retry will be made.',PAYMENT_NONCE_MISMATCH:'The account has changed or a transaction is pending. No new payment was sent.',PAYMENT_PROFILE_EXPIRED:'This demonstration has ended. Existing transaction status can still be checked.',PAYMENT_SIGNER_MISMATCH:'This is a different account. Choose the existing passkey for the prepared beneficiary.',PAYMENT_RIGHT_MISMATCH:'This payment is not ready or has already been collected. Check its transaction status.',PAYMENT_SESSION_CLOSED:'The signing session is closed. An existing transaction can still be checked.'};
    status(known[code]??'The action did not finish. Keep the existing passkey. Check transaction status before starting another attempt.');
  }
  async function run(action){
    if(busy||dead)return;
    const generation=++runGeneration,selectedId=rightId;
    const current=()=>!dead&&generation===runGeneration&&selectedId===rightId;
    busy=true;buttons();
    try{await action(current);}catch(e){if(current()){if(executor?.hash)outcome({hash:executor.hash});failure(e);}}
    finally{if(generation===runGeneration){busy=false;if(!dead)buttons();}}
  }
  function checkAvailability(){return run(async()=>{
    close();const generation=++availabilityGeneration,selectedId=rightId,selectedIntent=intent;availabilityChecking=true;
    if(!confirmed&&!unresolved)$('payment-title').textContent='Checking this payment.';
    status('Checking payment availability without opening a passkey…');buttons();
    try{
      const result=await createAvailability().check({rightId:selectedId});
      if(dead||generation!==availabilityGeneration)return;
      const matches=result&&result.rightId===selectedId&&result.amount===selectedIntent.amount&&result.beneficiary===profile.owner&&result.contract===profile.address&&result.chainId===profile.chainId&&result.readOnly===true&&result.paymentVerified===false;
      if(!matches)throw new Error('PAYMENT_AVAILABILITY_RESULT_INVALID');
      if(result.status==='funded'){
        if(Date.now()>=Date.parse(profile.expiresAt)){status('This demonstration has ended. Existing receipts can still be checked.');return;}
        availableUntil=monotonicNow()+readinessMs;
        if(!confirmed&&!accountUnresolved()){$('payment-title').textContent='Your payment is available.';status('The approved payment is funded. Open your existing passkey when you are ready. Final checks run again before sending.');}
        else if(confirmed&&!accountUnresolved())status('This payment was already confirmed in this browser. Its receipt remains available below.');
        else if(unscopedAccountBlock)status('An earlier account transaction must be reconciled in this browser. Check its original payment before reloading this page. No new signing session is permitted here.');
        else status(`The payment appears funded, but an existing attempt for Payment ${pendingRight()??rightId} must be reconciled in this browser. Select that payment and check its existing transaction before another send.`);
        availabilityTimer=setTimeout(()=>{availableUntil=0;if(!dead){if(!client&&!operation&&!confirmed&&!accountUnresolved()){$('payment-title').textContent='Check availability again.';status('The availability check has expired. Check again before opening your passkey.');}buttons();}},Math.min(readinessMs,Math.max(0,Date.parse(profile.expiresAt)-Date.now())));
      }else if(result.status==='already-collected'){
        if(!confirmed&&!unresolved)$('payment-title').textContent='This payment is already collected.';
        status('The contract records this payment as collected. No passkey is needed. Use a transaction reference below to verify its exact receipt.');
      }else if(result.status==='not-available'){
        if(!confirmed&&!unresolved)$('payment-title').textContent='This payment is not available.';
        const reasons={'not-issued':'This payment has not been issued.','expired':'The demonstration signing window has ended.','nonce-mismatch':'The account has changed or has a pending transaction.','insufficient-gas':'The account does not have enough test-MON for the bounded network fee.','fee-cap-exceeded':'The network fee is above this demonstration’s limit.','gas-limit-exceeded':'The required network resources exceed this demonstration’s limit.','state-changed':'The payment state changed during the check.'};
        status((reasons[result.reason]??'The approved payment cannot be collected now.')+' No passkey was requested. Existing receipts can still be checked.');
      }else throw new Error('PAYMENT_AVAILABILITY_RESULT_INVALID');
    }catch{if(!dead&&generation===availabilityGeneration){availableUntil=0;if(!confirmed&&!unresolved)$('payment-title').textContent='Availability could not be verified.';status('Payment availability could not be verified. No passkey was requested. Try the read-only availability check again later, or check an existing receipt.');}}
    finally{if(generation===availabilityGeneration)availabilityChecking=false;}
  });}
  $('payment-refresh').onclick=checkAvailability;
  $('payment-open').onclick=()=>run(async isCurrent=>{
    if(authenticationPending)return;
    if(!available()||confirmed||accountUnresolved()){invalidateAvailability();status('Check current payment availability before opening your passkey.');return;}
    close();operation=new AbortController();const current=operation,selectedId=rightId;authenticationPending=current;
    status('Open the existing passkey when your device asks.');
    try{
      const recovered=await openAccount({signal:current.signal});
      if(!isCurrent()||current.signal.aborted||operation!==current){recovered.close();return;}
      try{client=createClient(recovered);executor=client.forRight(selectedId);}catch(e){recovered.close();client=undefined;throw e;}
      timer=setTimeout(()=>close('The signing session expired. You can still check an existing transaction.'),Math.min(sessionMs,Math.max(0,Date.parse(profile.expiresAt)-Date.now())));
      status('Existing account opened. Collect this payment only when you are ready.');buttons();
    }finally{if(authenticationPending===current)authenticationPending=undefined;if(!dead)buttons();}
  });
  $('payment-claim').onclick=()=>run(async isCurrent=>{
    if(!executor||accountUnresolved())return;
    const selectedExecutor=executor;claimInFlight=true;buttons();status('Checking the funded payment and sending this exact claim once…');
    try{const result=await selectedExecutor.claim();if(isCurrent())outcome(result);}
    catch(error){if(isCurrent()){if(selectedExecutor.hash)outcome({hash:selectedExecutor.hash});rememberUncertainty(error,true);}throw error;}
    finally{claimInFlight=false;if(isCurrent())close();}
  });
  $('payment-check').onclick=()=>run(async isCurrent=>{const selectedId=rightId;status('Checking the existing transaction without signing…');const result=await createReader().check(selectedId);if(isCurrent())outcome(result);});
  const resetReference=()=>{referenceGeneration++;$('reference-details').hidden=true;$('reference-details').replaceChildren();$('reference-status').removeAttribute('data-state');$('reference-status').textContent='Reference changed. Verify again to check this payment.';};
  $('reference-hash').addEventListener('input',resetReference);$('reference-right').addEventListener('change',resetReference);
  $('reference-form').onsubmit=event=>{event.preventDefault();return run(async()=>{
    close();
    const hash=$('reference-hash').value.trim(),selected=profile.claims.find(c=>String(c.rightId)===$('reference-right').value);
    const message=text=>$('reference-status').textContent=text;
    $('reference-details').hidden=true;$('reference-details').replaceChildren();$('reference-status').removeAttribute('data-state');
    if(!selected||!/^0x[0-9a-f]{64}$/i.test(hash)){message('Enter the full transaction reference: 0x followed by 64 hexadecimal characters.');return;}
    message('Checking the reference against this payment on Monad testnet…');
    const referenceToken=++referenceGeneration;referenceChecking=true;buttons();
    try{
      const result=await createVerifier().check({rightId:selected.rightId,hash});
      if(dead||referenceToken!==referenceGeneration)return;
      if(result.status==='finalized'&&result.paymentVerified===true&&result.finalized===true){
        message('Payment verified. The exact payment to the expected account is finalized on Monad testnet.');$('reference-status').dataset.state='verified';
        const details=[['Payment',String(result.rightId)],['Amount',formatEther(result.amount)+' test-MON'],['Beneficiary',result.beneficiary],['Contract',result.contract],['Finalized block',String(result.blockNumber)],['Transaction',result.hash]];
        for(const [label,value]of details){const row=root.ownerDocument.createElement('div'),dt=root.ownerDocument.createElement('dt'),dd=root.ownerDocument.createElement('dd');dt.textContent=label;dd.textContent=value;row.append(dt,dd);$('reference-details').append(row);}
        $('reference-details').hidden=false;
      }else if(result.status==='reverted'&&result.paymentVerified===false&&result.finalized===true){message('Transaction reverted. This claim did not deliver the payment. The local attempt is unchanged.');$('reference-status').dataset.state='reverted';}
      else if(result.status==='pending-or-unknown'&&result.paymentVerified===false&&result.finalized===false){message('Not yet verified. The reference is pending or unknown; it has not been linked to this payment. Do not send again based on this result.');$('reference-status').dataset.state='pending';}
      else throw new Error('PAYMENT_REFERENCE_RESULT_INVALID');
    }catch(error){if(dead||referenceToken!==referenceGeneration)return;const mismatch=new Set(['PAYMENT_RECEIPT_MISMATCH','PAYMENT_RECEIPT_DISAGREEMENT','PAYMENT_EVENT_MISMATCH','PAYMENT_CHAIN_MISMATCH','PAYMENT_RUNTIME_MISMATCH','PAYMENT_ISSUER_MISMATCH','PAYMENT_CANONICAL_BLOCK_MISMATCH','PAYMENT_TRANSACTION_MISMATCH','PAYMENT_TRANSACTION_SIGNATURE_INVALID','PAYMENT_TRANSACTION_HASH_MISMATCH','PAYMENT_SIGNED_OWNER_MISMATCH','PAYMENT_RIGHT_MISMATCH']);
      const code=Object.getOwnPropertyDescriptor(error??{},'code')?.value;
      message(mismatch.has(code)?'Verification failed. The reference or network evidence does not match the expected payment. No payment is confirmed here.':'Verification unavailable. Check the reference and try this read-only check again later. No payment is confirmed here.');$('reference-status').dataset.state='error';
    }finally{if(referenceToken===referenceGeneration)referenceChecking=false;}
  });};
  $('payment-close').onclick=()=>close('Signing session closed. Existing transactions are still checkable.');
  $('payment-right').onchange=()=>{
    const selected=claims.find(c=>String(c.rightId)===$('payment-right').value);
    if(dead||claimInFlight||!selected||selected.rightId===rightId){$('payment-right').value=String(rightId);return;}
    remember();close();runGeneration++;busy=false;
    intent=selected;rightId=selected.rightId;
    const state=paymentStates.get(rightId);
    confirmed=state?.confirmed??false;unresolved=state?.unresolved??false;
    $('payment-hash').textContent=state?.hash??'';$('payment-receipt').hidden=!state?.hash;
    $('payment-title').textContent=confirmed?'Payment received.':unresolved?'Check the existing transaction.':'Check before you open.';
    $('payment-amount').textContent=formatEther(intent.amount)+' test-MON';
    $('reference-right').value=String(rightId);$('reference-hash').value='';resetReference();
    buttons();void checkAvailability();
  };
  const teardown=()=>{dead=true;runGeneration++;close();};win.addEventListener('pagehide',teardown);
  const pageshow=e=>{if(e.persisted)win.location.reload();};win.addEventListener('pageshow',pageshow);
  buttons();void checkAvailability();return Object.freeze({close(){teardown();win.removeEventListener('pagehide',teardown);win.removeEventListener('pageshow',pageshow);}});
}
