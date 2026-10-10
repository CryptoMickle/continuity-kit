import {formatEther} from 'viem';
import {prismBackdrop,prismSculpture} from '../starter/prism-art.mjs';

export function mountPaymentPage(root,{role,profile,openAccount,createClient,createReader,createVerifier,window:win=globalThis.window,sessionMs=5*60*1000}){
  if(!['primary','recovery'].includes(role))throw new Error('PAYMENT_ROLE_INVALID');
  const rightId=role==='primary'?1n:2n,intent=profile.claims.find(c=>c.rightId===rightId);
  if(!intent)throw new Error('PAYMENT_NOT_APPROVED');
  if(!Number.isFinite(Date.parse(profile.expiresAt)))throw new Error('PAYMENT_PROFILE_INVALID');
  root.innerHTML=`${prismBackdrop}<main class="payment-shell"><header><a class="wordmark" href="/">continuitykit</a><span class="network">Monad testnet · example payments</span></header><section class="payment-layout"><div class="payment-main"><p class="eyebrow">ACCOUNT CONTINUITY / ${role==='primary'?'ORIGINAL APP':'INDEPENDENT RESERVE'}</p><h1>Your next payment.<br><span>The same account.</span></h1><p class="intro">${role==='primary'?'Collect a funded payment with the account you already use. Its prepared reserve stays ready for the next one.':'The original app can be unavailable. Your prepared reserve can still collect a new payment owed to the same account.'}</p><ol class="payment-steps"><li>First payment</li><li>Original app unavailable</li><li>Next payment in the reserve</li></ol><article class="payment-card"><p class="eyebrow">${role==='primary'?'01 / ORIGINAL ACCOUNT':'02 / EXISTING RESERVE'}</p><h2 id="payment-title">${role==='primary'?'Open your existing account.':'Return to your prepared account.'}</h2><p id="payment-description">Use the existing ${role==='primary'?'primary':'recovery'} passkey. No new credential or reserve is created.</p><dl class="payment-details"><div><dt>Payment amount</dt><dd id="payment-amount"></dd></div><div><dt>Network fee limit</dt><dd>Up to 0.06 test-MON</dd></div></dl><p class="payment-status" id="payment-status" role="status" aria-live="polite">No signing session is open.</p><div class="payment-actions"><button id="payment-open">${role==='primary'?'Open existing account':'Open existing reserve'}</button><button id="payment-claim" hidden>Collect this payment</button><button class="secondary" id="payment-check">Check existing transaction</button><button class="secondary" id="payment-close" hidden>Close signing session</button></div><p class="payment-help">Your device may ask for several confirmations. Opening the account does not send a transaction. Closing a session cannot cancel a transaction already sent.</p><div id="payment-receipt" hidden><p>Transaction reference</p><output id="payment-hash"></output></div></article><section class="payment-card reference-card" aria-labelledby="reference-heading"><p class="eyebrow">CHECK FROM ANY BROWSER</p><h2 id="reference-heading">Already collected a payment?</h2><p>Paste its transaction reference to verify the payment. No passkey is needed.</p><form id="reference-form" novalidate><label for="reference-right">Expected payment</label><select id="reference-right"></select><label for="reference-hash">Transaction reference</label><input id="reference-hash" type="text" placeholder="0x…" maxlength="66" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="reference-help"><div class="payment-actions"><button id="reference-check" type="submit">Verify transaction reference</button></div></form><p id="reference-help" class="payment-help">This checks only the reference you provide. It does not find payment history or change an unresolved attempt in this browser.</p><p id="reference-status" class="payment-status" role="status" aria-live="polite">No reference checked.</p><dl id="reference-details" class="payment-details" hidden></dl></section></div><aside class="payment-art">${prismSculpture}<div class="payment-note"><h2>Income continues.<br>Even when the app doesn't.</h2><p>Each payment is funded separately. Recovery preserves the beneficiary; it does not create or earn the payment.</p></div></aside></section><footer>Test tokens only. This demonstration shows capability, not customer activity. The reserve restores full account signing authority. An existing passkey, trusted recovery site and prepared ciphertext are required.</footer></main>`;
  const $=id=>root.querySelector('#'+id);$('payment-amount').textContent=formatEther(intent.amount)+' test-MON';
  for(const claim of profile.claims){const option=root.ownerDocument.createElement('option');option.value=String(claim.rightId);option.textContent=`Payment ${claim.rightId} · ${formatEther(claim.amount)} test-MON`;option.selected=claim.rightId===rightId;$('reference-right').append(option);}

  let client,executor,timer,busy=false,dead=false,confirmed=false,unresolved=false,operation,referenceGeneration=0,referenceChecking=false;
  const status=text=>$('payment-status').textContent=text;
  function buttons(){
    $('payment-open').hidden=!!client||confirmed||unresolved;$('payment-claim').hidden=!client||confirmed||unresolved;
    $('payment-close').hidden=!client&&!operation&&!referenceChecking;$('payment-close').textContent=referenceChecking?'Stop checking':operation&&!client?'Cancel opening':'Close signing session';
    for(const id of ['payment-open','payment-claim','payment-check','reference-check','reference-right','reference-hash'])$(id).disabled=busy||dead;
  }
  function close(message){if(referenceChecking){referenceGeneration++;referenceChecking=false;$('reference-status').textContent='Reference check stopped. No result is assumed.';}operation?.abort();operation=undefined;clearTimeout(timer);executor?.close();client?.close();executor=client=undefined;if(message)status(message);buttons();}
  function outcome(result){
    if(result.hash){unresolved=true;$('payment-receipt').hidden=false;$('payment-hash').textContent=result.hash;close();}
    if(result.receipt){confirmed=true;unresolved=false;close();$('payment-title').textContent='Payment received.';status('The payment is confirmed on Monad testnet. The signing session is closed.');}
    else status('Confirmation is pending. Check the existing transaction; do not send again.');
  }
  function failure(error){
    const code=typeof error?.code==='string'?error.code:'';
    const known={PAYMENT_TRANSACTION_MISSING:'No transaction is recorded in this browser. Use Verify transaction reference below if you have its reference.',PAYMENT_ACCOUNT_BLOCKED:'An earlier transaction is unresolved. Check it before starting a new payment.',PAYMENT_RECONCILIATION_REQUIRED:'An earlier attempt needs inspection. No automatic retry will be made.',PAYMENT_NONCE_MISMATCH:'The account has changed or a transaction is pending. No new payment was sent.',PAYMENT_PROFILE_EXPIRED:'This demonstration has ended. Existing transaction status can still be checked.',PAYMENT_SIGNER_MISMATCH:'This is a different account. Choose the existing passkey for the prepared beneficiary.',PAYMENT_RIGHT_MISMATCH:'This payment is not ready or has already been collected. Check its transaction status.',PAYMENT_SESSION_CLOSED:'The signing session is closed. An existing transaction can still be checked.'};
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
  const teardown=()=>{dead=true;close();};win.addEventListener('pagehide',teardown);
  const pageshow=e=>{if(e.persisted)win.location.reload();};win.addEventListener('pageshow',pageshow);
  buttons();return Object.freeze({close(){teardown();win.removeEventListener('pagehide',teardown);win.removeEventListener('pageshow',pageshow);}});
}
