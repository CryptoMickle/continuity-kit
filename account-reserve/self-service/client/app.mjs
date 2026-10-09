import './style.css';
import { prismBackdrop, prismSculpture } from '../../starter/prism-art.mjs';
import { createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { recoverWorkReserve, validateWork, WORK_SCHEMA, MAX_WORK_BYTES } from '../../sdk/work-reserve.mjs';
import { startWorkReserveSetup, createWorkReserveReceiver } from '../../sdk/work-browser.mjs';
import { createReserveHttpStore } from '../../sdk/http-store.mjs';
import { validateEnvironment, validateCapability } from './config.mjs';

const FIELDS = ['title', 'client', 'brief', 'deliverable', 'nextStep'];
const SESSION_MS = 5 * 60000;
const SAMPLE = Object.freeze({
  schema: WORK_SCHEMA,
  title: 'A calmer checkout',
  client: 'Studio North · fictional',
  brief: 'Redesign the checkout for a small furniture studio. Keep delivery costs visible before the final step. Use clear language, with no countdowns or pressure to buy.',
  deliverable: 'CHECKOUT DIRECTION · WORKING DRAFT\n\n1. Keep the order summary beside the form. Show delivery costs as soon as the postcode is entered.\n\n2. Let customers check out as guests. Offer account creation after the order is confirmed.\n\n3. Use “Continue to payment” for the final review step.\n\nStill to finish: write the address-error message and the confirmation-page copy.',
  nextStep: 'Write the two missing messages, then export a copy for the fictional client.',
});
const $ = id => document.getElementById(id);
const errorCode = error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'ACTION_STOPPED';
const fail = code => Object.assign(new Error(code), { code });
const utc = value => new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

async function main() {
  const lifetime = new AbortController();
  let leaving = false;
  // Register before fetching configuration so leaving a loading page also aborts.
  window.addEventListener('pagehide', () => { leaving = true; lifetime.abort(); }, { once: true });
  const response = await fetch('/api/config', { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: lifetime.signal });
  if (!response.ok) throw fail(response.status === 410 ? 'DEMO_EXPIRED' : 'WORKSPACE_UNAVAILABLE');
  const env = await response.json();
  if (lifetime.signal.aborted) return;
  const { primary, expiresAtMs } = validateEnvironment(env, window.location.href);
  let privateKey, originalOwner, setup, receiver, opened, writingStore;
  let busy = false, stopped = false, demoExpired = false, snapshotTaken = false, hasRecovered = false, discarded = false;
  let setupAttempted = false, token, tokenUntil = 0, keyTimer, capTimer, capRequest, demoTimer, deadlineTimer;
  let setupDeadline = 0, baseline;
  const downloads = new Set();

  // Each HTTP store request already has a bounded transport signal. Joining the
  // page lifetime keeps its body reads abortable when this window is discarded.
  function scopedFetch(url, init = {}) {
    const controller = new AbortController();
    const signals = [lifetime.signal, init.signal].filter(Boolean);
    const abort = () => {
      controller.abort();
      for (const signal of signals) signal.removeEventListener('abort', abort);
    };
    for (const signal of signals) {
      if (signal.aborted) { abort(); break; }
      signal.addEventListener('abort', abort, { once: true });
    }
    // Fetch serializes Origin as null for same-origin POST/PUT with no-referrer.
    // Send only the public origin, never a path/query, and keep strict server
    // Origin validation and the SDK's same-origin/no-redirect transport policy.
    const mutation = ['POST', 'PUT'].includes(init.method?.toUpperCase());
    return fetch(url, { ...init, ...(mutation ? { referrerPolicy: 'origin' } : {}), signal: controller.signal });
  }
  const readStore = createReserveHttpStore({ fetcher: scopedFetch });
  function status(text, kind = '') {
    if (leaving || !$('status')) return;
    $('status').hidden = false; $('status').className = 'status ' + kind; $('status').textContent = text;
  }
  function state(update) {
    if (update.state === 'failed') { stopSetup(update.code); return; }
    if (stopped || demoExpired || leaving) return;
    const messages = {
      waiting: 'Continue in window B. Keep this window open until B confirms that the snapshot was independently checked.',
      'creating-credential': 'Follow your device prompts to create the reserve passkey. More prompts may follow to protect and independently reopen the work.',
      preparing: primary ? 'B is protecting and independently checking the snapshot. Keep both windows open.' : 'Protecting the snapshot, then independently reopening it to check the work and account binding. Follow any further device prompts.',
    };
    if (messages[update.state]) status(messages[update.state]);
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
        <span class="preview-label"><span class="preview-dot" aria-hidden="true"></span>Fictional work · Real passkey</span>
      </header>
      <main id="main">
        <aside class="demo-boundary" aria-label="Demonstration limits"><strong>Fictional examples only.</strong> No personal, confidential or valuable work. <span id="demo-expiry"></span> Limited public capacity; setup may become full. No funds or blockchain transactions.</aside>
        <section class="hero" aria-labelledby="page-title">
          <div><p class="eyebrow">Work continuity / ${primary ? 'Your original workspace' : 'Your independent reserve'}</p>
            <h1 id="page-title">${primary ? 'Keep the work.<br><em>Keep your place.</em>' : 'Your work has<br><em>a way back.</em>'}</h1>
            <p class="lede" id="page-lede">${primary ? 'Make a fictional brief your own. Save a private snapshot on a separate site, then reopen it and finish the draft with your reserve passkey.' : enrolling ? 'Prepare your snapshot here. Keep the original window open until the work has been saved and independently checked.' : 'Use the reserve passkey you already created. Reopen the brief, finish the draft and export a copy you can keep.'}</p>
          </div>
          <p class="hero-note"><strong>Your work. A separate way back.</strong> The reserve opens the prepared work while the account stays locked. No wallet, funds or operator setup code is needed.</p>
        </section>
        <ol class="steps" aria-label="Your progress">
          <li id="step-1"><span class="step-number">01</span>Make your example</li>
          <li id="step-2"><span class="step-number">02</span>Prepare in B</li>
          <li id="step-3"><span class="step-number">03</span>Reopen the reserve</li>
          <li id="step-4"><span class="step-number">04</span>Continue & export</li>
        </ol>
        <div class="work-layout">
          <section class="editor-panel" id="editor" aria-labelledby="editor-title" ${primary ? '' : 'hidden'}>
            <div class="editor-heading"><div><h2 id="editor-title">Make it your example.</h2><p id="editor-subtitle">Replace any of the five fields with fictional work. Leave something to finish.</p></div><span class="editor-icon">${paper}</span></div>
            <div class="fields-top">
              <label class="field"><span class="field-label">Project</span><input id="work-title" maxlength="256" autocomplete="off"></label>
              <label class="field"><span class="field-label">Fictional client</span><input id="work-client" maxlength="256" autocomplete="off"></label>
            </div>
            <label class="field"><span class="field-label">The brief</span><textarea id="work-brief" rows="4" maxlength="12000" autocomplete="off"></textarea></label>
            <label class="field"><span class="field-label">Working draft</span><textarea id="work-deliverable" rows="10" maxlength="12000" autocomplete="off" aria-describedby="draft-helper"></textarea><span class="field-helper" id="draft-helper">The reserve will keep the version you prepare. Later edits stay in the current window.</span></label>
            <label class="field"><span class="field-label">Next step</span><textarea id="work-nextStep" rows="2" maxlength="4000" autocomplete="off"></textarea></label>
            <div class="editor-footer"><span id="edit-state">Example content · Held in this window</span><span id="size"></span></div>
            <div class="editor-prepare" id="editor-prepare" hidden></div>
            <div class="export-actions" id="exports"><button id="export-text">Export TXT</button><button id="export-json" class="secondary">Export JSON</button></div>
          </section>
          <div class="side-column">
            <section class="control-panel" aria-labelledby="heading">
              <div class="panel-kicker"><span>${primary ? 'A' : 'B'}</span>${primary ? 'Original workspace' : 'Independent reserve'}</div>
              <h2 id="heading">${primary ? 'Start with your own example.' : enrolling ? 'Prepare this snapshot.' : 'Pick up where you left off.'}</h2>
              <p id="intro">${primary ? 'Edit the fictional draft, then start a new, unfunded example account in this window. Your reserve will bind this work to that account.' : enrolling ? 'Checking whether this demonstration can accept a snapshot. No passkey is created during this check.' : 'Choose your existing reserve passkey when your device asks. Use the passkey made for this B site.'}</p>
              <div id="status" class="status" role="status" aria-live="polite" aria-atomic="true" hidden></div>
              <div class="actions" id="actions"></div>
              <p class="context-note" id="action-context">${primary ? 'Starting the account creates no passkey. The next step opens this separate reserve site in window B.' : enrolling ? 'Your browser and authenticator must support passkey PRF. Keep both windows open; the full preparation may need several device confirmations.' : 'Recovery may need more than one device confirmation. It opens work only; account signing stays locked.'}</p>
              <p class="deadline" id="deadline" hidden></p>
              <div class="identity" id="identity" hidden><div class="identity-title"><span>Example account binding</span><span class="lock-state" id="lock-state">Locked</span></div><code id="owner"></code></div>
              <div class="public-link" id="public-link" ${enrolling ? 'hidden' : ''}>
                <label for="reserve-url">Public reserve address — keep this link</label><input id="reserve-url" readonly autocomplete="off" aria-describedby="reserve-link-note">
                <button id="copy-reserve" class="text-button">Copy public reserve link</button>
                <p id="reserve-link-note">The link contains no work, key or setup code. Opening it still requires your existing reserve passkey.</p>
              </div>
            </section>
            <figure class="sculpture" aria-hidden="true">${prismSculpture}<figcaption>A way to keep going, prepared in advance.</figcaption></figure>
          </div>
        </div>
        <section class="underboard" aria-label="Demonstration details">
          <h2>Know what this test shows</h2>
          <details><summary>Close A, then recover in a fresh B page</summary><div class="detail-content"><p>After preparation is confirmed, discard the state in the original window or close that tab. Open the public B link in a fresh page, select your existing passkey and recover your work.</p><p>Discarding or closing A tests recovery without that window’s state. It does not take the A website or its HTTP service offline. A real service-outage test requires separate evidence. This page does not claim that A is offline.</p></div></details>
          <details><summary>Passkeys, other devices and interrupted setup</summary><div class="detail-content"><p>Your browser and authenticator must support the PRF extension used by this reserve. The number of device prompts varies. If your provider makes the same passkey available on another compatible device, you can try recovery there; cross-device success is not guaranteed.</p><p>Keep any passkey created during setup, even if a later step fails. A snapshot may already have been stored. Use “Check existing reserve” first. This page never automatically creates another passkey or retries an uncertain upload.</p></div></details>
          <details><summary>One snapshot, with a fixed expiry</summary><div class="detail-content"><p>The saved snapshot is immutable. Edits made after preparation or recovery stay in that window; export TXT or JSON to keep them. Exporting does not update the stored snapshot.</p><p id="retention-copy"></p><p>Public setup is limited and may fill up. An upload permission is short lived and single use. Capacity checks do not create a passkey. Keep a local export of any fictional draft you want to retain.</p></div></details>
          <details><summary>What the account binding means</summary><div class="detail-content"><p>A creates a new, unfunded account key locally for your example. The SDK saves the work with a separately locked account vault and independently reopens the stored snapshot before reporting success. This example is not a live integration with an existing app.</p><p>Recovery here opens the work, then closes the recovery context. Editing and export remain available. There is no account-unlock action or transaction control in this interface. The underlying reserve can restore full account authority; the original key is not revoked. This is an experimental demonstration, not a permanent backup or custody service.</p></div></details>
        </section>
      </main>
      <footer><span>A project by Mikkel / CryptoMickle.</span><span>Self-service passkey demonstration · Fictional work · No funds</span></footer>
    </div>`;
  $('demo-expiry').textContent = 'Access ends ' + utc(expiresAtMs) + '.';
  $('retention-copy').textContent = 'Access ends ' + utc(expiresAtMs) + '. Active encrypted records become eligible for expiry cleanup at that time. Cleanup is separate from access expiry; deletion is not confirmed by this page. Provider recovery history may retain deleted records for up to 30 further days. Immediate erasure of every copy is not promised.';
  $('reserve-url').value = env.recoveryOrigin + '/';
  function step(number) {
    for (let i = 1; i <= 4; i++) {
      const element = $('step-' + i); element.className = i < number ? 'complete' : '';
      if (i === number) element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current');
    }
  }
  step(primary ? 1 : enrolling ? 2 : 3);
  function scene(title, intro, context) {
    $('heading').textContent = title; $('intro').textContent = intro; $('action-context').textContent = context;
  }
  function identity(owner) { $('identity').hidden = false; $('owner').textContent = owner; $('lock-state').textContent = 'Signing locked'; }
  function workFromEditor() { return validateWork({ schema: WORK_SCHEMA, ...Object.fromEntries(FIELDS.map(field => [field, $('work-' + field).value])) }); }
  function changed() {
    if (discarded) return;
    const raw = { schema: WORK_SCHEMA, ...Object.fromEntries(FIELDS.map(field => [field, $('work-' + field).value])) };
    const bytes = new TextEncoder().encode(JSON.stringify(raw)).length;
    $('size').textContent = `${(bytes / 1024).toFixed(1)} / ${MAX_WORK_BYTES / 1024} KB`;
    const current = JSON.stringify(FIELDS.map(field => raw[field]));
    $('edit-state').textContent = bytes > MAX_WORK_BYTES ? 'Too large. Shorten the example before preparing or exporting.'
      : hasRecovered ? current === baseline ? 'Recovered snapshot · Account context closed' : 'Edited in this window · Export to keep your changes'
      : snapshotTaken ? 'Later edits stay here · The stored snapshot does not change' : 'Example content · Held in this window';
  }
  function fillEditor(work) {
    for (const field of FIELDS) $('work-' + field).value = work[field];
    baseline = JSON.stringify(FIELDS.map(field => work[field])); changed();
  }
  function editable(value) { for (const field of FIELDS) $('work-' + field).readOnly = !value; }
  for (const field of FIELDS) $('work-' + field).addEventListener('input', changed);
  if (primary) fillEditor(SAMPLE);
  function clearKey() {
    clearTimeout(keyTimer); privateKey?.fill(0); privateKey = undefined;
    $('editor-prepare').hidden = true; $('editor-prepare').replaceChildren();
  }
  function clearCapability() { clearTimeout(capTimer); token = undefined; tokenUntil = 0; writingStore?.clearEnrollmentCapability(); }
  function closeOpened() { opened?.close(); opened = undefined; }
  function active() {
    if (leaving || lifetime.signal.aborted) throw fail('OPERATION_CANCELLED');
    if (demoExpired || Date.now() >= expiresAtMs) { expireDemo(); throw fail('DEMO_EXPIRED'); }
  }
  function setupActive() { active(); if (stopped) throw fail('SETUP_CLOSED'); }
  function deadline() {
    if (!setupDeadline || stopped || demoExpired) { $('deadline').hidden = true; return; }
    const seconds = Math.max(0, Math.ceil((setupDeadline - performance.now()) / 1000));
    $('deadline').hidden = false;
    $('deadline').textContent = `Complete setup within ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}. Device prompts and independent checks are included.`;
  }
  function setDeadline(until) { setupDeadline = until; clearInterval(deadlineTimer); deadline(); deadlineTimer = setInterval(deadline, 1000); }
  function restoreActionFocus(previous) {
    // Restore focus only after a deliberate action removed its own control.
    // Background checks/timers do not call this, and a user's newer focus wins.
    if (leaving || previous.isConnected || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const current = document.activeElement;
    if (current && current !== previous && current !== document.body && current !== document.documentElement && current.isConnected) return;
    const next = $('actions').querySelector('button:not([disabled]), a[href]') ?? $('heading');
    if (next === $('heading')) next.setAttribute('tabindex', '-1');
    next.focus({ preventScroll: true });
  }
  function button(label, action, className = '', target = $('actions')) {
    const element = document.createElement('button'); element.textContent = label; element.className = className;
    element.addEventListener('click', async () => {
      if (busy || leaving || element.disabled) return;
      busy = true; element.disabled = true;
      try { active(); await action(); } catch (error) { if (!leaving) failure(error); }
      finally { busy = false; if (element.isConnected) element.disabled = demoExpired; restoreActionFocus(element); }
    });
    target.append(element); return element;
  }
  function fresh(label = 'Open a fresh B reserve') {
    const link = document.createElement('a'); link.className = 'button secondary'; link.href = env.recoveryOrigin + '/';
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label;
    link.setAttribute('aria-label', label + ' (opens a new tab)'); $('actions').append(link);
  }
  function cancelButton(label = 'Cancel preparation') {
    const element = document.createElement('button'); element.className = 'text-button'; element.textContent = label;
    element.onclick = () => { stopSetup('OPERATION_CANCELLED'); restoreActionFocus(element); }; $('actions').append(element);
  }
  function stopSetup(code = 'SETUP_STOPPED') {
    if (stopped || demoExpired || leaving) return;
    stopped = true;
    clearCapability(); clearKey(); capRequest?.abort(); setup?.cancel(); receiver?.dispose(); setup = undefined; receiver = undefined;
    clearInterval(deadlineTimer); deadline(); editable(true);
    $('actions').replaceChildren(); fresh('Check existing reserve'); $('public-link').hidden = false;
    const nativeMayHaveStarted = primary || setupAttempted;
    scene('This setup is closed.', nativeMayHaveStarted
      ? 'Keep any passkey you created. A snapshot may already exist. Check it in a fresh B page before considering another setup.'
      : 'No passkey was requested and no snapshot was uploaded by this setup. Your fictional draft remains in A.',
    nativeMayHaveStarted ? 'No new passkey or upload will start in this setup window. Your current draft can still be exported.'
      : 'Return to A to export your draft. This B page will not restart setup automatically. You can still check a reserve you prepared earlier.');
    status(!nativeMayHaveStarted ? code === 'SETUP_EXPIRED' || code === 'CAPABILITY_EXPIRED'
      ? 'The setup time expired before any passkey was requested. Return to A to keep or export your draft.'
      : 'Setup stopped before any passkey was requested. Return to A to keep or export your draft.'
      : code === 'SETUP_EXPIRED' || code === 'CAPABILITY_EXPIRED'
        ? 'The setup time expired. Completion is not confirmed. Check the existing reserve with the same passkey.'
        : 'Preparation is not confirmed. Keep the same passkey and check the existing reserve.', 'error');
  }
  function expireDemo() {
    if (demoExpired || leaving) return;
    demoExpired = true; clearInterval(demoTimer); clearInterval(deadlineTimer);
    clearCapability(); clearKey(); capRequest?.abort(); setup?.cancel(); receiver?.dispose(); setup = undefined; receiver = undefined; closeOpened(); lifetime.abort();
    $('actions').replaceChildren(); $('deadline').hidden = true; editable(true);
    scene('This demonstration has expired.', 'Any draft already open remains editable here. Export it before leaving this window.', 'New setup and stored-reserve access have ended. Exporting this open copy does not need account access.');
    status('Access expired. You can still edit and export the draft already open in this window.', 'error');
  }
  function failure(error) {
    if (demoExpired) return;
    const code = errorCode(error);
    if (code === 'DEMO_EXPIRED' || code === 'STORE_EXPIRED') { expireDemo(); return; }
    if (stopped) return;
    const messages = {
      WORK_INVALID: 'Complete every field with a fictional example before continuing.',
      WORK_TOO_LARGE: 'Shorten the draft to keep the complete snapshot below 16 KB.',
      POPUP_BLOCKED: 'Allow the separate reserve window, then press Prepare in B again. Your example account remains in this window.',
      RESERVE_MISSING: 'No snapshot was found for the selected passkey. Keep it and check that setup completed on this B site. No new passkey has been created.',
      OPERATION_CANCELLED: 'Recovery was cancelled. You can try opening the same existing reserve again.',
      STORE_UNAVAILABLE: 'The reserve could not be read. Keep your existing passkey and try recovery again later.',
    };
    status(messages[code] ?? `The action stopped (${code}). Completion is not assumed. Keep your existing passkey.`, 'error');
  }
  function ready(owner) {
    if (stopped || demoExpired || leaving) return;
    clearCapability(); clearKey(); clearInterval(deadlineTimer); setupDeadline = 0; deadline();
    snapshotTaken = true; identity(owner); changed(); step(3);
    $('actions').replaceChildren(); fresh(); $('public-link').hidden = false;
    if (primary) button('Discard this A window’s state', discardOriginal, 'text-button');
    scene('Your snapshot is ready.', 'The saved work was reopened and independently checked against its account binding. Now open a fresh B page and recover with this passkey.', 'Keep the reserve passkey and public B link. You may close the original A tab after this confirmation.');
    status('Stored, reopened and independently checked. No transaction was sent.', 'success');
  }
  function createAccount() {
    workFromEditor(); clearKey();
    let session;
    try {
      privateKey = crypto.getRandomValues(new Uint8Array(32));
      session = createSecp256k1SigningSession({ privateKey });
      originalOwner = toViemAccount(session).address.toLowerCase();
    } catch (error) { clearKey(); throw error; }
    finally { session?.end(); }
    identity(originalOwner); $('actions').replaceChildren(); button('Prepare in B', prepareOriginal);
    $('editor-prepare').hidden = false; button('Prepare current draft in B', prepareOriginal, '', $('editor-prepare'));
    scene('Ready for the separate reserve.', 'Finish editing your fictional draft, then open B to save this snapshot. Keep both windows open until the independent check completes.', 'Your new example account is unfunded. The key is held in this window for at most five minutes before setup.');
    status('Example account ready. The next step opens B; only B asks you to create the reserve passkey.');
    keyTimer = setTimeout(() => {
      if (!privateKey || stopped || demoExpired || leaving) return;
      clearKey(); originalOwner = undefined; $('identity').hidden = true;
      $('actions').replaceChildren(); button('Start a new example account', createAccount);
      status('The unused example account expired. Your draft remains editable. No reserve passkey was requested.', 'error');
    }, SESSION_MS);
  }
  async function prepareOriginal() {
    setupActive();
    // The SDK opens B synchronously during this deliberate click. If the popup
    // is blocked, it throws before the caller relinquishes its key.
    setup = startWorkReserveSetup({ config: env.config, recoveryUrl: env.recoveryOrigin + '/', privateKey, expectedOwner: originalOwner, work: workFromEditor(), signal: lifetime.signal, onState: state });
    clearKey(); step(2); setDeadline(performance.now() + Math.min(expiresAtMs - Date.now(), SESSION_MS));
    editable(false); $('actions').replaceChildren(); cancelButton();
    try {
      const result = await setup.completion;
      if (!leaving && !demoExpired && !stopped) ready(result.owner);
    } catch (error) { stopSetup(errorCode(error)); }
    finally { setup = undefined; editable(true); }
  }
  async function requestCapability() {
    setupActive();
    capRequest = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; capRequest?.abort(); }, 10000);
    const requestStartedMs = performance.now();
    let payload, phase = 'CAPABILITY_NETWORK';
    try {
      const response = await scopedFetch('/api/enrollment/start', { method: 'POST', mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'content-type': 'application/json' }, body: '{}', signal: capRequest.signal });
      setupActive();
      if (response.status === 410) { expireDemo(); return; }
      if (response.status !== 201) throw fail(response.status === 429 ? 'CAPACITY_UNAVAILABLE' : `CAPABILITY_HTTP_${response.status}`);
      phase = 'CAPABILITY_RESPONSE_BODY';
      const text = await response.text();
      setupActive();
      if (text.length > 256) throw fail('CAPABILITY_INVALID');
      try { payload = JSON.parse(text); } catch { throw fail('CAPABILITY_RESPONSE_JSON'); }
      const checked = validateCapability(payload, expiresAtMs, { requestStartedMs, responseReceivedMs: performance.now() });
      setupActive(); token = checked.token; tokenUntil = checked.until; payload = undefined;
      setDeadline(Math.min(setupDeadline, tokenUntil));
      capTimer = setTimeout(() => stopSetup('CAPABILITY_EXPIRED'), Math.max(0, tokenUntil - performance.now()));
      $('actions').replaceChildren(); button('Create reserve passkey', prepareReceiver); cancelButton();
      scene('Ready to create your passkey.', 'A short-lived upload permission is ready. Create the reserve passkey, then follow any further prompts while the snapshot is protected and checked.', 'Keep both windows open. Native passkey creation begins only when you press the button below.');
      status('Setup is available. Save the passkey with your chosen provider; keep it even if a later check is interrupted.', 'success');
    } catch (error) {
      if (leaving || demoExpired || stopped) return;
      const caught = errorCode(error), code = timedOut ? 'CAPABILITY_TIMEOUT' : caught === 'ACTION_STOPPED' ? phase : caught;
      stopSetup(code);
      status(code === 'CAPACITY_UNAVAILABLE'
        ? 'This public demonstration is full or temporarily rate limited. No passkey was requested. Export your draft from A and try a fresh setup later.'
        : `Upload permission could not be confirmed (${code}). No passkey was requested. This page will not retry automatically. Export your draft from A; existing reserves can still be checked.`, 'error');
    } finally { clearTimeout(timeout); capRequest = undefined; payload = undefined; }
  }
  async function prepareReceiver() {
    setupActive();
    if (setupAttempted || !token || performance.now() >= tokenUntil) { stopSetup('CAPABILITY_EXPIRED'); return; }
    setupAttempted = true;
    writingStore = createReserveHttpStore({ enrollmentToken: token, fetcher: scopedFetch });
    token = undefined;
    $('actions').replaceChildren(); cancelButton();
    try {
      // No network await precedes this call: native user activation is preserved.
      const result = await receiver.prepare({ store: writingStore, user: { name: 'My fictional work reserve', displayName: 'My fictional work reserve' }, signal: lifetime.signal });
      if (!leaving && !demoExpired && !stopped) ready(result.owner);
    } catch (error) { stopSetup(errorCode(error)); }
    finally { clearCapability(); writingStore = undefined; receiver = undefined; }
  }
  function discardOriginal() {
    if (!primary || !snapshotTaken) return;
    clearKey(); setup?.cancel(); setup = undefined; closeOpened(); clearCapability(); originalOwner = undefined; baseline = undefined; discarded = true;
    for (const field of FIELDS) $('work-' + field).value = '';
    $('editor').hidden = true; $('identity').hidden = true; $('owner').textContent = '';
    $('shell').classList.remove('has-work'); $('shell').classList.add('recovery-start');
    $('actions').replaceChildren(); fresh('Recover in a fresh B page');
    scene('A’s local state is discarded.', 'This window no longer holds your draft or example account key. Use the saved reserve passkey in a fresh B page to reopen the prepared snapshot.', 'This only discards this window’s state. The A website and HTTP service remain available; no service outage has been tested.');
    status('A window state discarded. The stored snapshot and your reserve passkey are unchanged.', 'success');
  }
  async function recover() {
    closeOpened();
    status('Choose your existing reserve passkey. Looking for the prepared work; account signing remains locked.');
    try {
      opened = await recoverWorkReserve({ config: env.config, store: readStore, signal: lifetime.signal, onProgress: stage => {
        if (stage === 'open-work') status('Snapshot found. Follow any further device prompt to decrypt the work. Account signing stays locked.');
      } });
      active();
      hasRecovered = true; fillEditor(opened.work); identity(opened.owner);
      // Only plaintext work survives this action. No account-opening capability
      // is retained by the UI, and no signer is ever requested.
      closeOpened();
      $('editor').hidden = false; $('exports').hidden = false;
      $('shell').classList.remove('recovery-start'); $('shell').classList.add('has-work');
      $('page-title').textContent = 'Back to your work.';
      $('page-lede').textContent = 'Your prepared brief and draft are back. Finish the next step, then export a copy you can keep.';
      $('editor-title').textContent = 'Your draft, ready to continue.';
      $('editor-subtitle').textContent = 'Recovered from your prepared snapshot. Changes stay in this window.';
      $('draft-helper').textContent = 'Keep writing, then export the current version. The saved reserve stays unchanged.';
      $('actions').replaceChildren();
      button('Continue writing ↓', () => { $('work-deliverable').focus(); $('work-deliverable').scrollIntoView({ behavior: 'auto', block: 'center' }); });
      fresh(); step(4);
      scene('The work is open.', 'Continue the draft and export TXT or JSON. The recovery context has already been closed; your work remains editable.', 'Edits and exports contain the work only. Account signing stays locked.');
      status('Work recovered. Recovery context closed. No signer opened and no transaction sent.', 'success');
    } finally { closeOpened(); }
  }
  function download(format) {
    if (discarded || $('editor').hidden || leaving) return;
    const work = workFromEditor();
    const text = format === 'json' ? JSON.stringify(work, null, 2) + '\n' : `${work.title}\n${work.client}\n\nBRIEF\n${work.brief}\n\nWORKING DRAFT\n${work.deliverable}\n\nNEXT STEP\n${work.nextStep}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }));
    downloads.add(url);
    const link = document.createElement('a'); link.href = url; link.download = 'my-fictional-work.' + (format === 'json' ? 'json' : 'txt');
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 1500);
    status('Export requested. Check your downloads. This copy contains the current work only; the stored snapshot is unchanged.', 'success');
  }
  for (const [id, format] of [['export-text', 'text'], ['export-json', 'json']]) $(id).onclick = () => {
    try { download(format); } catch (error) { failure(error); }
  };
  $('copy-reserve').onclick = async () => {
    try { await navigator.clipboard.writeText(env.recoveryOrigin + '/'); status('Public B link copied. It contains no secrets; recovery still needs your existing reserve passkey.', 'success'); }
    catch { $('reserve-url').focus(); $('reserve-url').select(); status('Copy is unavailable in this browser. The public link is selected; copy it manually.'); }
  };
  if (primary) button('Start my example account', createAccount);
  else if (enrolling) { setDeadline(performance.now() + Math.min(expiresAtMs - Date.now(), SESSION_MS)); cancelButton(); void requestCapability(); }
  else button('Open my existing reserve', recover);
  demoTimer = setInterval(() => { if (Date.now() >= expiresAtMs) expireDemo(); }, 1000);
  window.addEventListener('pagehide', () => {
    clearInterval(demoTimer); clearInterval(deadlineTimer); clearCapability(); clearKey(); capRequest?.abort();
    setup?.cancel(); receiver?.dispose(); setup = undefined; receiver = undefined; closeOpened(); readStore.clearEnrollmentCapability();
    for (const field of FIELDS) $('work-' + field).value = '';
    for (const url of downloads) URL.revokeObjectURL(url);
    downloads.clear(); originalOwner = undefined; baseline = undefined;
  }, { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
}
main().catch(error => {
  if (error?.name === 'AbortError') return;
  const box = document.createElement('div'); box.className = 'fatal';
  const heading = document.createElement('h1'); heading.textContent = 'This workspace is unavailable.';
  const copy = document.createElement('p'); copy.textContent = errorCode(error) === 'DEMO_EXPIRED'
    ? 'This demonstration has expired. Keep your existing passkey and any copies you exported.'
    : 'The example could not open safely. Keep any existing passkey. If you saved the public B link, use it to check your prepared reserve.';
  box.append(heading, copy); $('app').replaceChildren(box);
});
