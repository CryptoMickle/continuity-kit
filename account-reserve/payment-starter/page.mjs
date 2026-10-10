import { prismBackdrop, prismSculpture } from './prism-art.mjs';

function formatAmount(value) {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return whole.toString() + (fraction ? '.' + fraction : '');
}

const reasons = Object.freeze({
  'not-issued': 'This payment has not been issued.', expired: 'The signing window has ended.',
  'nonce-mismatch': 'The account has changed or has a pending transaction.',
  'insufficient-gas': 'The account needs more test-MON to cover the approved network fee.',
  'fee-cap-exceeded': 'The network fee is above the approved limit.',
  'gas-limit-exceeded': 'The required gas is above the approved limit.',
  'state-changed': 'The payment state changed during the check.',
});
const errorMessages = Object.freeze({
  PAYMENT_AVAILABILITY_REQUIRED: 'Check availability again before opening your existing reserve.',
  PAYMENT_ACCOUNT_BLOCKED: 'An earlier attempt is unresolved. Select that payment and check its existing transaction.',
  PAYMENT_RECONCILIATION_REQUIRED: 'An earlier attempt needs inspection. Do not create another key or retry the payment.',
  PAYMENT_TRANSACTION_MISSING: 'No transaction is recorded for this payment in this browser.',
  PAYMENT_SESSION_CLOSED: 'The session or check has ended. No new result is assumed.',
  PAYMENT_SIGNER_MISMATCH: 'This is a different account. Use the existing key for the prepared beneficiary.',
  PAYMENT_PROFILE_EXPIRED: 'The signing window has ended. Existing transactions can still be checked.',
  PAYMENT_SELECTION_MISMATCH: 'The selected payment changed. Check availability before reopening the reserve.',
  PAYMENT_BROADCAST_UNKNOWN: 'Delivery is uncertain. Check the existing transaction; do not send again.',
});

export function showPaymentStarterError(root) {
  root.innerHTML = '<main class="payment-shell"><article class="payment-card payment-error"><p class="eyebrow">PAYMENT RESERVE / SETUP</p><h1>This reserve is not configured here.</h1><p>The public configuration is missing, invalid, or does not match this browser and address. No passkey or transaction was requested.</p><p>Build with your approved payment profile, serve the output at its exact recovery origin, and provide the existing same-origin reserve reader. Use the generated README to check the configuration and browser requirements.</p><p>Keep your existing passkeys. A new key will not open an earlier reserve.</p></article></main>';
}

// Renderer receives an already constructed helper. Production main always uses
// the public SDK and real helper; deterministic test doubles live in tests only.
export function mountPaymentStarter(root, { profile, actions, window: win = globalThis.window }) {
  const payment = profile.payment;
  root.innerHTML = `${prismBackdrop}<main class="payment-shell"><header class="payment-header"><a class="wordmark" href="./">continuitykit</a><span class="network">Monad testnet · example payments</span></header><section class="payment-layout"><div class="payment-main"><p class="eyebrow">PAYMENT CONTINUITY / INDEPENDENT RESERVE</p><h1>Your payment.<br><span>Your way back.</span></h1><p class="intro">The original app can be unavailable. Open the reserve you prepared and collect a payment owed to the same account.</p><article class="payment-card"><label for="payment-right">Payment to collect</label><select id="payment-right"></select><h2 id="payment-title">Start with a check.</h2><p>No passkey is needed to check availability. Opening your existing reserve is a separate step.</p><dl class="payment-details"><div><dt>Payment amount</dt><dd id="payment-amount"></dd></div><div><dt>Maximum network fee</dt><dd id="payment-fee">0.06 test-MON</dd></div><div><dt>Beneficiary</dt><dd id="payment-owner" class="address"></dd></div><div><dt>Payment contract</dt><dd id="payment-contract" class="address"></dd></div></dl><p id="payment-status" class="payment-status" role="status" aria-live="polite" tabindex="-1"></p><div class="payment-actions"><button id="availability">Check availability</button><button id="open" class="secondary">Open existing reserve</button><button id="collect">Collect payment</button><button id="check" class="secondary">Check existing transaction</button><button id="close" class="secondary">Close session</button></div><p class="payment-help">Your device may request several confirmations. Opening the reserve sends no transaction. Closing a session cannot cancel a transaction already sent.</p><section id="payment-receipt" hidden><h3>Transaction reference</h3><output id="payment-hash" class="address"></output></section><p id="unresolved" class="payment-help" hidden></p></article></div><aside class="payment-art">${prismSculpture}<div class="payment-note"><h2>The same account.<br>A separate way back.</h2><p>The prepared reserve preserves the beneficiary. Each payment must already be funded; recovery does not create income.</p></div></aside></section><footer class="payment-footer">Test tokens only. This page opens full account signing authority for a short session. It requires an existing passkey, a trusted recovery origin and prepared ciphertext. No reserve is created here.</footer></main>`;
  const $ = id => root.querySelector('#' + id);
  for (const approved of actions.approvedPayments) {
    const option = root.ownerDocument.createElement('option');
    option.value = String(approved.rightId);
    option.textContent = `Payment ${approved.rightId} · ${formatAmount(approved.amount)} test-MON`;
    $('payment-right').append(option);
  }
  $('payment-owner').textContent = payment.owner;
  $('payment-contract').textContent = payment.address;
  let dead = false, generation = 0, operation, claimInFlight = false, failure, expiryClosed = false;

  function status(state) {
    if (dead) return ['Session closed.', 'This view has ended. Reload the page before continuing.', 'closed'];
    if (state.accountBlocked) return ['An earlier attempt needs attention.', 'Select the unresolved payment and check its existing transaction. No new payment can start yet.', 'pending'];
    if (claimInFlight) return ['Collecting this payment.', 'The approved claim is being checked and sent at most once. Do not start another attempt.', 'pending'];
    if (state.authenticationPending) return ['Opening your existing reserve.', 'Finish or cancel the prompt on your device. No transaction is sent by opening.', 'opening'];
    if (state.isOpen) return ['Your account is open.', 'Review the amount, beneficiary and contract above. Collect only when you are ready.', 'open'];
    if (operation?.kind === 'availability') return ['Checking availability.', 'Reading the approved payment without opening a passkey.', 'checking'];
    if (operation?.kind === 'check') return ['Checking the existing transaction.', 'This reads the recorded attempt without signing or sending again.', 'checking'];
    if (state.payment?.confirmed) return ['Payment received.', 'The exact payment is confirmed. The signing session is closed.', 'confirmed'];
    if (state.payment?.unresolved) return ['Confirmation is pending.', 'Check the existing transaction. Do not send another attempt.', 'pending'];
    if (failure) return ['The action did not finish.', failure, 'error'];
    if (Date.now() >= Date.parse(payment.expiresAt)) return ['The signing window has ended.', 'Existing transactions can still be checked without a passkey.', 'expired'];
    if (state.availability?.status === 'funded') return state.canOpen
      ? ['Your payment is available.', 'Open your existing reserve when you are ready. Final checks run again before sending.', 'funded']
      : ['Check availability again.', 'The last availability check has expired. No account is open.', 'stale'];
    if (state.availability?.status === 'already-collected') return ['This payment is already collected.', 'No passkey is needed. Check an existing transaction recorded in this browser.', 'collected'];
    if (state.availability?.status === 'not-available') return ['This payment is not available.', (reasons[state.availability.reason] ?? 'This payment cannot be collected now.') + ' No passkey was requested.', 'unavailable'];
    return ['Start with a check.', 'Check payment availability first. Nothing opens or sends automatically.', 'idle'];
  }
  function render() {
    const state = actions.state, approved = actions.approvedPayments.find(item => item.rightId === state.selectedRightId);
    $('payment-right').value = String(state.selectedRightId);
    $('payment-amount').textContent = approved ? formatAmount(approved.amount) + ' test-MON' : 'Unavailable';
    const [title, message, kind] = status(state);
    if ($('payment-title').textContent !== title) $('payment-title').textContent = title;
    if ($('payment-status').textContent !== message) $('payment-status').textContent = message;
    $('payment-status').dataset.state = kind;
    $('payment-right').disabled = dead || claimInFlight;
    $('availability').disabled = dead || claimInFlight || state.isBusy;
    $('open').disabled = dead || !state.canOpen;
    $('collect').disabled = dead || claimInFlight || !state.isOpen || state.isBusy || state.accountBlocked;
    $('check').disabled = dead || claimInFlight || state.isBusy;
    $('close').disabled = dead || !(state.isOpen || state.isBusy || operation);
    $('close').textContent = state.authenticationPending ? 'Cancel opening' : operation && !claimInFlight ? 'Stop checking' : 'Close session';
    $('payment-receipt').hidden = !state.payment?.hash;
    $('payment-hash').textContent = state.payment?.hash ?? '';
    $('unresolved').hidden = !state.accountBlocked;
    $('unresolved').textContent = state.unresolvedPayments.length
      ? 'Unresolved payment: ' + state.unresolvedPayments.map(String).join(', ') + '. Keep this browser’s transaction record.'
      : 'The account’s local transaction record needs inspection. A different payment or passkey will not clear it.';
  }
  function synchronize() {
    if (dead) return;
    if (!expiryClosed && Date.now() >= Date.parse(payment.expiresAt)) { expiryClosed = true; actions.close(); }
    render();
  }
  function invoke(kind, action) {
    if (dead || claimInFlight) return;
    const token = { generation, kind }; operation = token; failure = undefined;
    if (kind === 'collect') claimInFlight = true;
    let promise;
    try { promise = action(); } catch (error) { promise = Promise.reject(error); }
    render();
    void Promise.resolve(promise).then(() => {
      if (dead || token.generation !== generation || operation !== token) return;
      render();
      if (kind === 'open' && actions.state.isOpen) $('collect').focus();
    }, error => {
      if (dead || token.generation !== generation || operation !== token) return;
      let value;
      try { value = Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value; } catch { /* Fixed public message below. */ }
      failure = errorMessages[value] ?? 'Keep the existing passkey. Check the existing transaction before another attempt; no successful payment is assumed.';
    }).finally(() => {
      if (kind === 'collect') claimInFlight = false;
      if (operation === token) operation = undefined;
      // A stale journal reply can add a defensive account block. Render current
      // helper state, never the resolved value of an earlier selection.
      if (!dead) render();
    });
  }
  const handlers = {
    availability: () => invoke('availability', () => actions.refreshAvailability()),
    open: () => invoke('open', () => actions.open()),
    collect: () => invoke('collect', () => actions.collect()),
    check: () => invoke('check', () => actions.check()),
    close: () => { if (dead) return; generation++; operation = undefined; failure = undefined; actions.close(); render(); },
  };
  for (const [id, handler] of Object.entries(handlers)) $(id).onclick = () => { if (!$(id).disabled) handler(); };
  $('payment-right').onchange = () => {
    if (dead || claimInFlight) { render(); return; }
    const selected = actions.approvedPayments.find(item => String(item.rightId) === $('payment-right').value);
    if (!selected) { render(); return; }
    try { actions.select(selected.rightId); generation++; operation = undefined; failure = undefined; }
    catch { failure = 'The payment cannot change while a claim is in progress.'; }
    render();
  };
  const timer = win.setInterval(synchronize, 250);
  function dispose() {
    if (dead) return;
    dead = true; generation++; operation = undefined; win.clearInterval(timer);
    win.removeEventListener('pagehide', dispose); win.removeEventListener('focus', synchronize);
    root.ownerDocument.removeEventListener('visibilitychange', synchronize);
    actions.dispose(); render();
  }
  win.addEventListener('pagehide', dispose); win.addEventListener('focus', synchronize);
  root.ownerDocument.addEventListener('visibilitychange', synchronize);
  synchronize();
  return Object.freeze({ dispose });
}
