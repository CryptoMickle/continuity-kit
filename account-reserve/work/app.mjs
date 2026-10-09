import '../starter/prism-art.css';
import './style.css';
import { prismBackdrop, prismSculpture } from '../starter/prism-art.mjs';
import { createSyntheticClient } from '../starter/synthetic-client.mjs';
import { createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { verifyMessage } from 'viem';
import { recoverWorkReserve, validateWork, WORK_SCHEMA, MAX_WORK_BYTES } from '../sdk/work-reserve.mjs';
import { startWorkReserveSetup, createWorkReserveReceiver } from '../sdk/work-browser.mjs';
import { createReserveHttpStore } from '../sdk/http-store.mjs';
import { validateWorkClientEnvironment, validateWorkEnrollmentToken } from './client-config.mjs';

const SAMPLE = Object.freeze({
  schema: WORK_SCHEMA,
  title: 'A calmer checkout',
  client: 'Studio North',
  brief: 'Redesign the checkout for a small furniture studio. Keep delivery costs visible before the final step. The tone should be clear and reassuring, with no countdowns or pressure to buy.',
  deliverable: 'CHECKOUT DIRECTION · WORKING DRAFT\n\n1. Keep the order summary beside the form. Show the full delivery price as soon as the postcode is entered.\n\n2. Let customers check out as guests. Offer account creation after the order is confirmed.\n\n3. Use “Continue to payment” for the final review step. Explain what happens next in one sentence.\n\nStill to finish: write the address-error message and the confirmation-page copy.',
  nextStep: 'Finish the two missing messages, then export the draft for the client handoff.',
});
const FIELDS = ['title', 'client', 'brief', 'deliverable', 'nextStep'];
const $ = id => document.getElementById(id);
const SESSION_MS = 5 * 60 * 1000;
// Hosted release builds replace this constant and remove the synthetic adapter.
const HOSTED_ONLY = typeof __WORK_HOSTED_ONLY__ !== 'undefined' && __WORK_HOSTED_ONLY__;
const D1_HOSTED = typeof __WORK_D1_HOSTED__ !== 'undefined' && __WORK_D1_HOSTED__;
const errorCode = error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'ACTION_STOPPED';

async function main() {
  const lifetime = new AbortController();
  const response = await fetch('/api/config', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: lifetime.signal });
  if (!response.ok) throw new Error('ORIGINAL_APP_UNAVAILABLE');
  const env = await response.json();
  const { primary, hosted, expiresAtMs } = validateWorkClientEnvironment(env, window.location.href, Date.now(), HOSTED_ONLY);
  const nativeOptions = HOSTED_ONLY ? {} : hosted ? {} : { webAuthnClient: createSyntheticClient((url, init = {}) => localFetch(url, init)) };
  const expiryLabel = hosted ? new Date(expiresAtMs).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : '';
  const localFetch = (url, init = {}) => fetch(url, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: lifetime.signal });
  const readStore = createReserveHttpStore();
  let privateKey, originalOwner, setup, receiver, opened, activeSigner;
  let busy = false, hasRecovered = false, keyExpiry, contextExpiry;
  let snapshotTaken = false, baseline, writingStore, accountButton;
  let demoExpired = false, demoExpiryCheck, checkedToken, checkedUntil = 0, codeTimer;
  let setupStopped = false, setupStopCode;
  const downloads = new Set();
  const stateLabels = {
    waiting: 'Continue in the reserve window. Keep this original window open until the snapshot is checked.',
    'creating-credential': hosted ? 'Follow your device prompts to create the work reserve passkey…' : 'Preparing the simulated reserve credential…',
    preparing: 'Encrypting the snapshot, then independently checking its work and account binding…',
    ready: 'Snapshot stored, reopened and independently checked.',
    failed: 'Setup stopped. Check the existing reserve before trying another setup.',
  };
  function status(text, kind = '') {
    if (!$('status') || lifetime.signal.aborted) return;
    $('status').hidden = false; $('status').className = 'status ' + kind; $('status').textContent = text;
  }
  function state(update) {
    if (update.state === 'failed') { stopSetup(update.code); return; }
    if (!setupStopped && stateLabels[update.state]) status(stateLabels[update.state], update.state === 'ready' ? 'success' : '');
  }
  if (!primary) receiver = createWorkReserveReceiver({ config: env.config, originalOrigin: env.originalOrigin, onState: state });
  const enrolling = Boolean(receiver?.isEnrollment);
  const paper = '<svg viewBox="0 0 24 28" fill="none" aria-hidden="true"><path d="M5 2h9l6 6v18H5V2Z" stroke="currentColor" stroke-width="1.4"/><path d="M14 2v7h6M9 14h7M9 18h7M9 22h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  $('app').innerHTML = `
    <a class="skip-link" href="#main">Skip to your work</a>
    <div class="page-shell prism-page ${primary ? 'has-work' : 'recovery-start'}" id="shell">
      ${prismBackdrop}
      <header class="site-header">
        <a class="brand" href="#main" aria-label="ContinuityKit"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span>continuity<span class="brand-kit">kit</span></a>
        <span class="preview-label"><span class="preview-dot" aria-hidden="true"></span>${hosted ? 'Private work demo · Physical passkey' : 'Local synthetic demo · No real passkeys'}</span>
      </header>
      <main id="main">
        ${hosted ? '<aside class="demo-boundary" aria-label="Demonstration limits"><strong>Example data only.</strong> <span id="demo-expiry"></span> Export any recovered work you want to keep. This is an unfunded example workspace, with no blockchain transactions.</aside>' : ''}
        <section class="hero" aria-labelledby="page-title">
          <div><p class="eyebrow">Work continuity / ${primary ? 'Original workspace' : 'Independent reserve'}</p>
            <h1 id="page-title">${primary ? 'Keep the work.<br><em>Keep your place.</em>' : 'Your work has<br><em>a way back.</em>'}</h1>
            <p class="lede" id="page-lede">${primary ? 'A client brief. An unfinished draft. Prepare a separate copy you can reopen and finish if this app goes away.' : 'Open the snapshot you prepared, finish the draft and take it with you. The account can stay locked.'}</p>
          </div>
          <p class="hero-note"><strong>Work first. Account access is separate.</strong> Reading and editing a recovered draft does not unlock a signer or send a transaction.</p>
        </section>
        <div class="work-layout">
          <section class="editor-panel" id="editor" aria-labelledby="editor-title" ${primary ? '' : 'hidden'}>
            <div class="editor-heading"><div><h2 id="editor-title">The work in progress.</h2><p id="editor-subtitle">A fictional client brief. Make it your example.</p></div><span class="editor-icon">${paper}</span></div>
            <div class="fields-top">
              <label class="field"><span class="field-label">Project</span><input id="work-title" maxlength="256" autocomplete="off"></label>
              <label class="field"><span class="field-label">Client</span><input id="work-client" maxlength="256" autocomplete="off"></label>
            </div>
            <label class="field"><span class="field-label">The brief</span><textarea id="work-brief" rows="4" maxlength="12000" autocomplete="off" spellcheck="false"></textarea></label>
            <label class="field"><span class="field-label">Working draft</span><textarea id="work-deliverable" rows="10" maxlength="12000" autocomplete="off" spellcheck="false"></textarea><span class="field-helper" id="draft-helper">Leave something unfinished. The reserve is where you can pick it up again.</span></label>
            <label class="field"><span class="field-label">Next step</span><textarea id="work-nextStep" rows="2" maxlength="4000" autocomplete="off" spellcheck="false"></textarea></label>
            <div class="editor-footer"><span id="edit-state">Example content · Held in this window</span><span id="size"></span></div>
            <div class="export-actions" id="exports" hidden><button id="export-text">Export finished draft</button><button id="export-json" class="secondary">Export JSON</button></div>
          </section>
          <div class="side-column">
            <section class="control-panel" aria-labelledby="heading">
              <div class="panel-kicker"><span>${primary ? 'A' : 'B'}</span>${primary ? 'Original workspace' : 'Independent reserve'}</div>
              <h2 id="heading">${primary ? 'Give this work a reserve.' : enrolling ? 'Prepare this snapshot.' : 'Pick up where you left off.'}</h2>
              <p id="intro">${primary ? 'Start with a disposable example account. Then save one encrypted snapshot of this draft and its account binding.' : enrolling ? 'The original workspace will send its current draft. This step saves an immutable copy and independently checks that it opens.' : hosted ? 'Use your existing work reserve passkey to open the private draft. No address or export file is needed.' : 'Use your existing simulated reserve credential to open the private work. No address or export file is needed.'}</p>
              <div id="status" class="status" role="status" aria-live="polite" hidden></div>
              ${hosted && enrolling ? '<label class="field enrollment-code" id="enrollment-code-wrap"><span class="field-label">One-time demonstration setup code</span><input id="enrollment-code" type="password" maxlength="43" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="code-hint"><span class="field-helper" id="code-hint">Provided by the demo operator. Check this code before creating a passkey. Recovery will not need it.</span></label>' : ''}
              <div class="actions" id="actions"></div>
              <p class="context-note" id="action-context">${primary ? hosted ? 'Starting this example creates no passkey. The reserve passkey is created in the next window.' : 'One snapshot per local server run. No money or blockchain is involved.' : enrolling ? hosted ? 'Keep both windows open. Your device may ask for several confirmations.' : 'Keep both windows open until preparation is confirmed.' : 'This opens work only. Account signing remains locked.'}</p>
              <div class="identity" id="identity" hidden><div class="identity-title"><span>Prepared account</span><span class="lock-state" id="lock-state">Locked</span></div><code id="owner"></code><p id="account-proof" hidden></p></div>
            </section>
            <figure class="sculpture" aria-hidden="true">${prismSculpture}<figcaption>A way to keep going, prepared in advance.</figcaption></figure>
          </div>
        </div>
        <section class="underboard" aria-label="Demonstration details">
          <h2>Inside this example</h2>
          ${!primary && !hosted ? '<details id="outage-controls"><summary>Try it without the original app</summary><div class="detail-content"><p>Take the original app offline and close its tab. Open a fresh reserve page, recover the draft, finish the missing copy and export it.</p><button id="offline" class="secondary">Take original app offline</button><p id="availability" role="status"></p><p>Both clients still run on this computer. This tests an app outage, not independent hosting.</p></div></details>' : ''}
          ${!primary && hosted ? '<details><summary>Try it without the original app</summary><div class="detail-content"><p>The demo operator can temporarily take the original app offline. Then close the original tab and open a fresh reserve page to recover and continue your work.</p><p>This page cannot turn another app off and does not check its availability. A missing original tab alone does not prove that its service is offline.</p></div></details>' : ''}
          <details><summary>A snapshot, not automatic backup</summary><div class="detail-content"><p>The reserve contains the draft as it was when prepared. Later edits stay in the current window. Export your finished copy to keep them; they do not update or overwrite the reserve.</p><p>${hosted ? D1_HOSTED ? 'Access ends at the stated expiry. Active encrypted records can then be deleted by the expiry cleanup. Provider recovery history may retain deleted records for up to 30 further days. Immediate erasure of every copy is not promised. Keep the reserve passkey and export any work you need.' : 'This bounded demonstration stores encrypted snapshots until the stated expiry. Keep the reserve passkey and export any work you need. It is not a permanent backup service.' : 'This local demo keeps encrypted reserves and simulated credentials in server memory. Restarting the server deletes both.'} Use fictional example content only.</p></div></details>
          <details><summary>Work access and account authority</summary><div class="detail-content"><p>Opening the work does not decrypt the account key or create a signer. The optional “Verify same account” action unlocks it separately, signs a local verification challenge, then closes the signer. It sends no transaction.</p><p>The underlying reserve can restore full account authority. The original key is not revoked. Trust in the reserve code, credential and available storage is still required. ${hosted ? 'This example creates a new, unfunded account key in the original window. An integrating app would supply its existing account leaf; no live third-party integration is claimed here.' : 'This is not a physical-passkey test.'} This is not a production custody service.</p><p>A correctly retained encrypted export can restore content too. The experiment here is finding the prepared work through a credential and continuing without supplying a file.</p></div></details>
        </section>
      </main>
      <footer><span>A project by Mikkel / CryptoMickle.</span><span>${hosted ? 'Bounded physical-passkey demonstration' : 'Separate local prototype'} · Fictional work · No funds</span></footer>
    </div>`;

  if (hosted) $('demo-expiry').textContent = 'Demo access ends ' + expiryLabel + '. ';

  function scene(title, intro, context) {
    $('heading').textContent = title; $('intro').textContent = intro;
    if (context) $('action-context').textContent = context;
  }
  function identity(owner, label = 'Locked') {
    $('identity').hidden = false; $('owner').textContent = owner; $('lock-state').textContent = label;
  }
  function workFromEditor() {
    return validateWork({ schema: WORK_SCHEMA, ...Object.fromEntries(FIELDS.map(field => [field, $('work-' + field).value])) });
  }
  function editorBytes() {
    const value = { schema: WORK_SCHEMA, ...Object.fromEntries(FIELDS.map(field => [field, $('work-' + field).value])) };
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }
  function changed() {
    const bytes = editorBytes();
    $('size').textContent = `${(bytes / 1024).toFixed(1)} / ${MAX_WORK_BYTES / 1024} KB`;
    const current = JSON.stringify(FIELDS.map(field => $('work-' + field).value));
    if (bytes > MAX_WORK_BYTES) $('edit-state').textContent = 'Too large for this example. Shorten the text before preparing or exporting.';
    else if (hasRecovered) $('edit-state').textContent = current === baseline ? 'Recovered snapshot · Account signing locked' : 'Edited in this window · Export to keep your changes';
    else $('edit-state').textContent = snapshotTaken ? 'Later edits stay here · The prepared snapshot does not change' : 'Example content · Held in this window';
  }
  function fillEditor(work) {
    for (const field of FIELDS) $('work-' + field).value = work[field];
    baseline = JSON.stringify(FIELDS.map(field => work[field])); changed();
  }
  function editable(value) { for (const field of FIELDS) $('work-' + field).readOnly = !value; }
  for (const field of FIELDS) $('work-' + field).addEventListener('input', changed);
  if (primary) fillEditor(SAMPLE);
  function clearKey() { clearTimeout(keyExpiry); privateKey?.fill(0); privateKey = undefined; }
  function closeOpened() { clearTimeout(contextExpiry); activeSigner?.close(); activeSigner = undefined; opened?.close(); opened = undefined; }
  function expireAccountAccess() {
    closeOpened();
    if (accountButton) { accountButton.disabled = true; accountButton.dataset.unavailable = 'true'; accountButton.textContent = 'Account access expired'; }
    if (!$('identity').hidden) $('lock-state').textContent = 'Locked';
    $('account-proof').hidden = false;
    $('account-proof').textContent = 'The local draft is still editable and exportable. Export your changes before using the fresh-reserve link for another account check.';
  }
  function clearCheckedCode() { clearTimeout(codeTimer); checkedToken = undefined; checkedUntil = 0; }
  function stopSetup(code) {
    setupStopped = true; setupStopCode ??= code;
    clearCheckedCode(); writingStore?.clearEnrollmentCapability();
    if (!$('actions') || lifetime.signal.aborted) return;
    if ($('enrollment-code-wrap')) {
      $('enrollment-code-wrap').hidden = true;
      $('enrollment-code').value = ''; $('enrollment-code').disabled = true;
    }
    $('actions').replaceChildren(); fresh('Check existing reserve');
    scene('This setup window is closed.', 'Keep any passkey you created. Check the existing reserve before starting another setup.', 'This window can no longer prepare a snapshot. No new passkey or retry will start here.');
    status(setupStopCode === 'SETUP_EXPIRED'
      ? 'The setup time expired. Passkey creation and snapshot storage are not confirmed.'
      : 'Setup stopped. Passkey creation and snapshot storage are not confirmed.', 'error');
  }
  function expireDemo() {
    if (demoExpired) return;
    demoExpired = true; clearInterval(demoExpiryCheck); clearCheckedCode();
    if ($('enrollment-code')) { $('enrollment-code').value = ''; $('enrollment-code').disabled = true; }
    setup?.cancel(); receiver?.dispose(); writingStore?.clearEnrollmentCapability(); clearKey(); expireAccountAccess();
    for (const element of $('actions').querySelectorAll('button')) { element.dataset.unavailable = 'true'; element.disabled = true; }
    editable(true);
    status('This demonstration has expired. Your open draft stays in this window: keep editing and export it before you leave.', 'error');
    lifetime.abort();
  }
  function assertDemoActive() {
    if (demoExpired || hosted && Date.now() >= expiresAtMs) { expireDemo(); throw new Error('DEMO_EXPIRED'); }
  }
  function assertSetupActive() {
    assertDemoActive();
    if (setupStopped) throw new Error('SETUP_UNAVAILABLE');
  }
  function showCodeCheck() {
    if (setupStopped) return;
    clearCheckedCode();
    if ($('enrollment-code-wrap')) { $('enrollment-code-wrap').hidden = false; $('enrollment-code').value = ''; }
    $('actions').replaceChildren(); button('Check setup code', checkSetupCode);
  }
  async function checkSetupCode() {
    assertSetupActive(); clearCheckedCode();
    let token = $('enrollment-code').value;
    $('enrollment-code').value = '';
    try {
      token = validateWorkEnrollmentToken(token);
      status('Checking whether this one-time setup code is available. No passkey is being created.');
      const result = await localFetch('/api/enrollment/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
      assertSetupActive();
      if (result.status === 410) { expireDemo(); throw new Error('DEMO_EXPIRED'); }
      if (!result.ok) throw new Error('ENROLLMENT_CHECK_FAILED');
      const resultText = await result.text();
      assertSetupActive();
      if (resultText.length > 160) throw new Error('ENROLLMENT_CHECK_FAILED');
      let checked;
      try { checked = JSON.parse(resultText); } catch { throw new Error('ENROLLMENT_CHECK_FAILED'); }
      if (!checked || Object.keys(checked).sort().join(',') !== 'expiresAt,ready' || checked.ready !== true || checked.expiresAt !== env.expiresAt) throw new Error('ENROLLMENT_CHECK_FAILED');
      assertSetupActive();
      if (lifetime.signal.aborted) throw new Error('OPERATION_CANCELLED');
      checkedToken = token; checkedUntil = Math.min(expiresAtMs, Date.now() + 60000);
      $('enrollment-code-wrap').hidden = true; $('actions').replaceChildren();
      button('Prepare work snapshot', prepareReceiver);
      button('Use another setup code', showCodeCheck, 'text-button');
      status('Code checked. Prepare within one minute to create the reserve passkey. Your device may ask for several confirmations.', 'success');
      codeTimer = setTimeout(() => {
        if (!checkedToken || setupStopped || demoExpired || lifetime.signal.aborted) return;
        showCodeCheck(); status('The code check expired. Check the code again before creating a passkey.');
      }, Math.max(0, checkedUntil - Date.now()));
    } finally { token = undefined; }
  }
  function failure(error) {
    if (setupStopped && !demoExpired) { stopSetup(setupStopCode); return; }
    const code = errorCode(error);
    const unclear = error.recordMayExist || ['STORE_WRITE_UNKNOWN', 'READBACK_FAILED', 'INDEPENDENT_CHECK_FAILED'].includes(code);
    const messages = {
      WORK_TOO_LARGE: 'The snapshot is too large. Keep the example below 16 KB.',
      WORK_INVALID: 'Complete each work field with a short example before continuing.',
      POPUP_BLOCKED: 'Allow the separate reserve window, then press Prepare work reserve again.',
      RESERVE_MISSING: hosted ? 'No prepared work was found. Check that setup completed using this reserve passkey.' : 'No prepared work was found. Check that setup completed and the local server has not restarted.',
      ENROLLMENT_CODE_INVALID: 'Enter the complete one-time setup code provided by the demo operator. No passkey has been created.',
      ENROLLMENT_CHECK_FAILED: 'This setup code is unavailable, already used, or could not be checked. No passkey has been created.',
      ENROLLMENT_CHECK_EXPIRED: 'The code check expired. Check it again before preparing; no new passkey has been created.',
      DEMO_EXPIRED: 'This demonstration has expired. Export any work already open; it can still be edited in this window.',
      OPERATION_CANCELLED: 'The action was cancelled. Keep any existing reserve; check it before preparing again.',
    };
    status(unclear ? 'Preparation is unconfirmed. Keep the existing credential and check the reserve in a fresh page. Do not start another setup.' : messages[code] ?? `The action stopped (${code}). No completion is assumed.`, 'error');
  }
  function button(label, action, className = '', target = $('actions')) {
    const element = document.createElement('button'); element.textContent = label; element.className = className;
    element.addEventListener('click', async () => {
      if (busy || lifetime.signal.aborted || element.dataset.unavailable === 'true') return;
      busy = true; element.disabled = true;
      try { assertDemoActive(); await action(); } catch (error) { if (!lifetime.signal.aborted) failure(error); }
      finally { busy = false; if (element.isConnected) element.disabled = demoExpired || element.dataset.unavailable === 'true'; }
    });
    target.append(element); return element;
  }
  function fresh(label = 'Open a fresh reserve') {
    const link = document.createElement('a'); link.className = 'button secondary'; link.href = env.recoveryOrigin + '/'; link.textContent = label; $('actions').append(link);
  }
  function cancelButton(cancel) {
    const element = document.createElement('button'); element.className = 'text-button'; element.textContent = 'Cancel preparation'; element.onclick = () => cancel(); $('actions').append(element);
  }
  function ready(owner) {
    if (setupStopped) return;
    identity(owner, 'Locked'); $('actions').replaceChildren(); fresh();
    scene('Your work has a reserve.', 'The immutable snapshot was stored, reopened and checked. Try opening it after the original app is unavailable.', 'A fresh reserve opens the work first. Account access stays separate.');
    status('Prepared snapshot checked. No transaction was sent.', 'success');
  }
  function createAccount() {
    workFromEditor();
    clearKey();
    let session;
    try {
      privateKey = crypto.getRandomValues(new Uint8Array(32));
      session = createSecp256k1SigningSession({ privateKey });
      originalOwner = toViemAccount(session).address.toLowerCase();
    } catch (error) { clearKey(); throw error; }
    finally { session?.end(); }
    identity(originalOwner, 'Example ready');
    scene('Save a place to return to.', 'Prepare the current draft in the separate reserve. Keep this window open until the independent check completes.', 'The snapshot contains this work and a separately locked account key.');
    $('actions').replaceChildren(); button('Prepare work reserve', prepareOriginal);
    status('Disposable example account ready. Edit the draft first. After opening the reserve window, finish setup within five minutes.');
    keyExpiry = setTimeout(() => {
      if (!privateKey) return;
      clearKey(); $('actions').replaceChildren(); button(hosted ? 'Start example workspace' : 'Create example account', createAccount);
      status('The example account session expired. Your unsaved draft is still in this window.', 'error');
    }, SESSION_MS);
  }
  async function prepareOriginal() {
    // The popup is opened synchronously from the deliberate click.
    setup = startWorkReserveSetup({ config: env.config, recoveryUrl: env.recoveryOrigin + '/', privateKey, expectedOwner: originalOwner, work: workFromEditor(), signal: lifetime.signal, onState: state });
    clearKey(); snapshotTaken = true; editable(false); changed(); $('actions').replaceChildren(); cancelButton(() => setup.cancel());
    try { const result = await setup.completion; if (!lifetime.signal.aborted) ready(result.owner); }
    catch (error) { if (!lifetime.signal.aborted) { $('actions').replaceChildren(); fresh('Check existing reserve'); } throw error; }
    finally { editable(true); }
  }
  async function prepareReceiver() {
    assertSetupActive();
    let token;
    if (HOSTED_ONLY || hosted) {
      if (!checkedToken || Date.now() >= checkedUntil) { clearCheckedCode(); showCodeCheck(); throw new Error('ENROLLMENT_CHECK_EXPIRED'); }
      token = checkedToken; clearCheckedCode();
    } else { token = env.enrollmentToken; delete env.enrollmentToken; }
    token = validateWorkEnrollmentToken(token);
    writingStore = createReserveHttpStore({ enrollmentToken: token }); token = undefined;
    if ($('enrollment-code-wrap')) $('enrollment-code-wrap').hidden = true;
    $('actions').replaceChildren(); cancelButton(() => receiver.dispose());
    try {
      const result = await receiver.prepare({ store: writingStore, user: { name: 'Work reserve example', displayName: 'Work reserve example' }, ...nativeOptions, signal: lifetime.signal });
      if (!lifetime.signal.aborted) ready(result.owner);
    } catch (error) { if (!lifetime.signal.aborted) { $('actions').replaceChildren(); fresh('Check existing reserve'); } throw error; }
    finally { writingStore.clearEnrollmentCapability(); writingStore = undefined; }
  }
  async function recover() {
    closeOpened(); status('Finding and opening the prepared work. The account remains locked.');
    opened = await recoverWorkReserve({ config: env.config, store: readStore, ...nativeOptions, signal: lifetime.signal });
    if (lifetime.signal.aborted) { closeOpened(); return; }
    hasRecovered = true; fillEditor(opened.work);
    $('editor').hidden = false; $('exports').hidden = false;
    $('shell').classList.remove('recovery-start'); $('shell').classList.add('has-work');
    $('page-title').replaceChildren(document.createTextNode('Back to the work.'));
    $('page-lede').textContent = 'The brief and unfinished draft are back. Finish the missing copy, then export your handoff. Account signing stays locked.';
    $('editor-title').textContent = 'Your draft, ready to continue.';
    $('editor-subtitle').textContent = 'Recovered from the prepared snapshot. Changes stay in this window.';
    $('draft-helper').textContent = 'Finish the address-error message and confirmation copy, or continue with your own example.';
    identity(opened.owner); $('actions').replaceChildren();
    scene('The work is open.', 'Read the brief, finish the draft and export a usable copy. None of that requires account signing.', 'The stored snapshot stays unchanged. Export your edits before closing this page.');
    button('Continue writing ↓', () => { $('work-deliverable').focus(); $('work-deliverable').scrollIntoView({ behavior: 'auto', block: 'center' }); });
    accountButton = button('Verify same account', verifyAccount, 'secondary');
    fresh(); status('Work recovered. Account signing is locked. No transaction sent.', 'success');
    contextExpiry = setTimeout(expireAccountAccess, SESSION_MS);
  }
  async function verifyAccount() {
    if (!opened) { expireAccountAccess(); return; }
    const expectedOwner = opened.owner;
    $('lock-state').textContent = 'Verifying…'; $('account-proof').hidden = true;
    try {
      activeSigner = await opened.openAccount({ signal: lifetime.signal });
      const challenge = 'ContinuityKit work reserve: local same-account verification. No transaction or authorization. Nonce: ' + crypto.randomUUID();
      const signature = await activeSigner.account.signMessage({ message: challenge });
      if (activeSigner.owner.toLowerCase() !== expectedOwner.toLowerCase() || !await verifyMessage({ address: expectedOwner, message: challenge, signature })) throw new Error('SIGNATURE_INVALID');
      if (lifetime.signal.aborted) return;
      $('account-proof').hidden = false; $('account-proof').textContent = 'Same account verified by local signature. Signer closed. No transaction sent.';
      status('Optional account check passed. Your local draft is unchanged.', 'success');
    } finally { activeSigner?.close(); activeSigner = undefined; if (!lifetime.signal.aborted) $('lock-state').textContent = 'Locked'; }
  }
  function download(format) {
    if (!hasRecovered) return;
    const work = workFromEditor();
    const text = format === 'json' ? JSON.stringify(work, null, 2) + '\n' : `${work.title}\n${work.client}\n\nBRIEF\n${work.brief}\n\nWORKING DRAFT\n${work.deliverable}\n\nNEXT STEP\n${work.nextStep}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' })); downloads.add(url);
    const link = document.createElement('a'); link.href = url; link.download = 'continuity-work-copy.' + (format === 'json' ? 'json' : 'txt'); document.body.append(link); link.click(); link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 1500);
    status('Your export was requested. It contains the current work only; the stored reserve was not changed. Check your downloads.', 'success');
  }
  for (const [id, format] of [['export-text', 'text'], ['export-json', 'json']]) $(id).onclick = () => { try { download(format); } catch (error) { failure(error); } };
  if (primary) button(hosted ? 'Start example workspace' : 'Create example account', createAccount);
  else {
    if (enrolling) { if (hosted) showCodeCheck(); else button('Prepare work snapshot', prepareReceiver); } else button('Open existing work reserve', recover);
    if (!HOSTED_ONLY && !hosted) {
    async function refreshAvailability() {
      const result = await localFetch('/api/status'); if (!result.ok) throw new Error('STATUS_UNAVAILABLE'); const current = await result.json();
      $('availability').textContent = current.primaryOnline ? 'Original app and API are online.' : 'Original app and API are offline. This reserve uses its own endpoint.';
      $('offline').textContent = current.primaryOnline ? 'Take original app offline' : 'Bring original app online';
      $('offline').dataset.online = String(current.primaryOnline);
    }
    $('offline').onclick = async () => {
      if (busy) return; const element = $('offline'); element.disabled = true;
      try { const result = await localFetch('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: element.dataset.online !== 'true' }) }); if (!result.ok) throw new Error('OUTAGE_CONTROL_FAILED'); await refreshAvailability(); }
      catch (error) { failure(error); } finally { element.disabled = false; }
    };
    refreshAvailability().catch(failure);
    }
  }
  if (hosted) demoExpiryCheck = setInterval(() => { if (Date.now() >= expiresAtMs) expireDemo(); }, 1000);
  window.addEventListener('pagehide', () => {
    clearInterval(demoExpiryCheck); clearCheckedCode(); if ($('enrollment-code')) $('enrollment-code').value = '';
    lifetime.abort(); setup?.cancel(); receiver?.dispose(); writingStore?.clearEnrollmentCapability(); readStore.clearEnrollmentCapability(); clearKey(); closeOpened();
    for (const field of FIELDS) $('work-' + field).value = '';
    for (const url of downloads) URL.revokeObjectURL(url);
    downloads.clear(); baseline = undefined; originalOwner = undefined;
  }, { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
}
main().catch(error => {
  const box = document.createElement('div'); box.className = 'fatal';
  const heading = document.createElement('h1'); heading.textContent = 'This workspace is unavailable.'; heading.style.fontSize = '32px';
  const copy = document.createElement('p'); copy.textContent = errorCode(error) === 'ORIGINAL_APP_UNAVAILABLE' ? 'The original app may be offline. Use the separate work reserve page to open a previously prepared snapshot.' : errorCode(error) === 'DEMO_EXPIRED' ? 'This demonstration has expired. Keep your existing passkeys and any exported copies.' : 'The example could not start safely. Keep any existing reserve and ask the demo operator to check its configuration.';
  box.append(heading, copy); $('app').replaceChildren(box);
});
