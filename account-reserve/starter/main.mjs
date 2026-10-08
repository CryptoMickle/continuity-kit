import './prism-art.css';
import './style.css';
import { prismBackdrop, prismSculpture } from './prism-art.mjs';
import { createPasskeyWithPrfOutput, createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { verifyMessage } from 'viem';
import { recoverReserve } from '@continuitykit/account-reserve';
import { startReserveSetup, createReserveReceiver } from '@continuitykit/account-reserve/browser';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { checkReserveEnvironment } from '@continuitykit/account-reserve/preflight';
import { createSyntheticClient } from './synthetic-client.mjs';

const $ = id => document.getElementById(id);
const response = await fetch('/api/config');
if (!response.ok) { $('app').textContent = 'Original app is offline. Open the separate recovery app.'; throw new Error('CONFIG_UNAVAILABLE'); }
const env = await response.json(), primary = env.role === 'primary';
const webAuthnClient = env.synthetic ? createSyntheticClient() : undefined;
const lifetime = new AbortController();
let key, originalSession, setup, receiver, busy = false, expiry;
const readStore = createReserveHttpStore();
const stateLabels = { waiting: 'Continue in the separate reserve window. Keep this window open.', 'creating-credential': 'Creating your dedicated recovery credential…', preparing: 'Saving your reserve and checking that it opens…', ready: 'Saved, reopened and checked.', failed: 'Setup stopped. Keep any existing credential. Check the existing reserve before trying another setup.' };
function state(update) { if (stateLabels[update.state]) status(stateLabels[update.state], update.state === 'failed' ? 'error' : update.state === 'ready' ? 'success' : ''); }
if (!primary) receiver = createReserveReceiver({ config: env.config, originalOrigin: env.originalOrigin, onState: state });
const keyDrawing = `<svg viewBox="0 0 140 64" fill="none" aria-hidden="true"><circle cx="35" cy="32" r="22" stroke="currentColor" stroke-width="6"/><circle cx="35" cy="32" r="6" fill="currentColor"/><path d="M58 32h62m-13 0v16m-17-16v11" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
$('app').innerHTML = `
  <div class="page-shell prism-page">
    ${prismBackdrop}
    <header class="site-header">
      <a class="brand" href="#main" aria-label="ContinuityKit"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span>continuity<span class="brand-kit">kit</span></a>
      <nav aria-label="Page navigation"><a href="#how-it-works">How this works <span aria-hidden="true">↗</span></a></nav>
      <span class="preview-label"><span class="preview-dot" aria-hidden="true"></span>${env.synthetic ? 'Local example' : 'Physical local test'}</span>
    </header>
    <main id="main">
      <div class="workspace">
        <section class="story" aria-labelledby="page-title">
          <p class="eyebrow">Account continuity <span>/</span> ${primary ? 'Prepare' : 'Recover'}</p>
          <h1 id="page-title">${primary ? 'Keep a way <br><em>back in.</em>' : 'Back to <br><em>your account.</em>'}</h1>
          <p class="lede">${primary ? 'A little preparation now. Another way into the same account if your original app goes away.' : 'Open the reserve you prepared earlier. <br>No address to remember. No file to find.'}</p>
        </section>
        <section class="task-panel" aria-labelledby="heading">
          <div class="panel-top"><span class="panel-symbol" aria-hidden="true">${keyDrawing}</span><span class="step">${primary ? 'Start here' : receiver.isEnrollment ? 'One-time setup' : 'Your reserve'}</span><span class="panel-index">${primary ? '01' : receiver.isEnrollment ? '02' : '03'} <span>/ 03</span></span></div>
          <h2 id="heading">${primary ? 'Try it with an example.' : receiver.isEnrollment ? 'Prepare this reserve.' : 'Let’s get you back in.'}</h2>
          <p id="intro">${primary ? 'Create a disposable account, then give it a separate way back. This local example takes no funds.' : receiver.isEnrollment ? 'Keep the original app open for this step. The reserve will be checked before setup is marked complete.' : 'Use the reserve from your earlier setup. This example checks the account, then closes its signing session.'}</p>
          <div id="status" class="status" role="status" aria-live="polite" hidden></div>
          <div id="identity" class="identity" hidden><div class="identity-header"><span>Account</span><span class="identity-type">EVM</span></div><code id="owner"></code></div>
          <div class="actions" id="actions"></div>
          <p id="action-context" class="action-context">${primary ? 'For this walkthrough, use an example account only.' : receiver.isEnrollment ? 'The recovery credential gets full signing access to this account. Your original key stays valid.' : 'Opening the reserve sends no transaction.'}</p>
          <p id="proof" class="proof" hidden></p>
          <div class="session-note"><span class="note-mark" aria-hidden="true">i</span><p>${env.synthetic ? 'This is a simulation. No real passkeys or money.<br>Restarting the local server erases this example.' : 'Disposable test accounts only. Your device may ask for more than one confirmation. Restarting this server erases the reserve.'}</p></div>
        </section>
        <figure class="prism-object-wrap" aria-hidden="true">
          ${prismSculpture}
          <figcaption>A way back, prepared in advance.</figcaption>
        </figure>
      </div>
      <section class="underboard" id="how-it-works" aria-labelledby="underboard-title">
        <div class="underboard-heading"><h2 id="underboard-title">A few things to know.</h2><span>Developer preview</span></div>
        <div class="detail-list">
          <details id="checks-panel"><summary><span>Is this browser ready?</span><span id="check-summary" class="summary-note">Configuration checks</span><span class="disclosure" aria-hidden="true">+</span></summary><div class="detail-content"><p>These checks inspect the setup. They don’t try a physical passkey or prove that a reserve exists.</p><ul id="checks" class="checks"></ul></div></details>
          ${!primary ? '<details><summary><span>Try it without the original app</span><span class="summary-note">Outage walkthrough</span><span class="disclosure" aria-hidden="true">+</span></summary><div class="detail-content"><p>Turn off the original app and close its tab. Then open a fresh reserve and check the same account.</p><button id="offline" class="secondary">Take original app offline</button><p id="availability" class="availability"></p><p class="small">Both apps still run on this computer. This checks an app outage, not independent hosting.</p></div></details>' : ''}
          <details><summary><span>What am I trusting?</span><span class="summary-note">Access & limits</span><span class="disclosure" aria-hidden="true">+</span></summary><div class="detail-content"><p>The reserve holds full signing access to one account. You must trust its code. It does not disable the original key, and it still needs the recovery credential and stored encrypted data.</p><p>This example keeps data in memory and allows one setup per server run. Restarting the server deletes the reserve. It is not a permanent backup service.</p><p>A correctly kept encrypted export can recover the same account too. This approach removes the file you need to keep, but adds a separate setup and storage dependency. Real-device usability and production security are not established here.</p></div></details>
        </div>
      </section>
    </main>
    <footer><span>A project by Mikkel.</span><span>ContinuityKit <span aria-hidden="true">/</span> Experimental developer toolkit</span></footer>
  </div>`;
const report = checkReserveEnvironment({ config: env.config, role: primary ? 'primary' : 'recovery', originalOrigin: env.originalOrigin, recoveryOrigin: env.recoveryOrigin });
for (const check of report.checks) { const li = document.createElement('li'); li.dataset.status = check.status; li.textContent = `${check.status === 'pass' ? 'Checked' : check.status === 'fail' ? 'Needs attention' : 'Not tested'} — ${check.message}`; $('checks').append(li); }
const blockingChecks = report.checks.filter(check => check.status === 'fail' && !(env.synthetic && check.id === 'webauthn-api'));
$('check-summary').textContent = blockingChecks.length ? `${blockingChecks.length} need attention` : 'Basic checks passed';
if (blockingChecks.length) $('checks-panel').open = true;
if (env.synthetic) { const li = document.createElement('li'); li.dataset.status = 'unverified'; li.textContent = 'This simulation does not use native WebAuthn. Its presence check is informational here.'; $('checks').append(li); }
function status(text, kind = '') { $('status').hidden = false; $('status').className = 'status ' + kind; $('status').textContent = text; }
function scene(heading, intro, context) { $('heading').textContent = heading; $('intro').textContent = intro; if (context) $('action-context').textContent = context; }
function identity(owner) { $('identity').hidden = false; $('owner').textContent = owner; }
function clearKey() { clearTimeout(expiry); key?.fill(0); key = undefined; originalSession?.end(); originalSession = undefined; }
function failure(error) {
  const code = error.code ?? error.message ?? 'UNKNOWN';
  const interrupted = error.recordMayExist || ['STORE_WRITE_UNKNOWN', 'READBACK_FAILED', 'INDEPENDENT_CHECK_FAILED'].includes(code);
  status(interrupted ? 'Preparation is unconfirmed. Keep your existing recovery credential and check the reserve in a fresh tab; do not create another key.' : `The action stopped (${code}). Keep any existing recovery credential. No completion is assumed.`, 'error');
}
function button(label, action) { const b = document.createElement('button'); b.textContent = label; b.onclick = async () => { if (busy) return; if (blockingChecks.length) { status('Fix the failed integration checks before creating or opening an account.', 'error'); return; } busy = true; b.disabled = true; try { await action(); } catch (e) { failure(e); } finally { busy = false; if (b.isConnected) b.disabled = false; } }; $('actions').append(b); }
function fresh(label = 'Open a fresh reserve') { const a = document.createElement('a'); a.className = 'button secondary'; a.href = env.recoveryOrigin + '/'; a.textContent = label; $('actions').append(a); }
async function create() {
  const credential = await createPasskeyWithPrfOutput({ rp: { id: env.config.originalRpId, name: 'Continuity starter A' }, user: { name: 'Example account', displayName: 'Example account' }, webAuthnClient });
  try { key = new Uint8Array(credential.prfOutput); originalSession = createSecp256k1SigningSession({ privateKey: key }); } finally { credential.prfOutput.fill(0); }
  const owner = toViemAccount(originalSession).address.toLowerCase(); identity(owner);
  scene('Your account is ready.', 'Now give it a way back. The next step opens the separate reserve app.', 'Keep this tab open until setup is confirmed.'); $('actions').replaceChildren();
  status('Prepare the separate reserve while the original account is available.');
  expiry = setTimeout(() => { clearKey(); setup?.cancel(); $('actions').replaceChildren(); status('Original account session expired. Keep any recovery credential already prepared.', 'error'); }, 5 * 60 * 1000);
  button('Activate reserve', async () => {
    // Must execute in the click handler before any await, for popup permission.
    setup = startReserveSetup({ config: env.config, recoveryUrl: env.recoveryOrigin + '/', privateKey: key, expectedOwner: owner, signal: lifetime.signal, onState: state });
    clearKey(); $('actions').replaceChildren();
    try { await setup.completion; scene('Your reserve is ready.', 'The encrypted reserve was saved and successfully reopened. You can now try it from a fresh page.', 'Keep both credentials. The original key still works.'); fresh(); } catch (e) { fresh('Check existing reserve'); throw e; }
  });
}
async function prepare() {
  const store = createReserveHttpStore({ enrollmentToken: env.enrollmentToken }); delete env.enrollmentToken;
  $('actions').replaceChildren();
  try { const ready = await receiver.prepare({ store, user: { name: 'Example reserve', displayName: 'Example reserve' }, webAuthnClient, signal: lifetime.signal }); identity(ready.owner); scene('Your reserve is ready.', 'The encrypted reserve was saved and successfully reopened. You can now try it from a fresh page.', 'Keep both credentials. The original key still works.'); fresh(); }
  catch (e) { fresh('Check existing reserve'); throw e; }
  finally { store.clearEnrollmentCapability(); }
}
async function recover() {
  status('Opening the prepared reserve. Discovery and unlock are separate operations.');
  const opened = await recoverReserve({ config: env.config, store: readStore, webAuthnClient, signal: lifetime.signal });
  try {
    const challenge = 'ContinuityKit local starter verification: ' + crypto.randomUUID();
    const signature = await opened.account.signMessage({ message: challenge });
    if (!await verifyMessage({ address: opened.owner, message: challenge, signature })) throw new Error('SIGNATURE_INVALID');
    identity(opened.owner); scene('The same account. Verified.', 'Your reserve brought back the original account shown below. The local signing check passed.', 'The signing session is now closed.');
    $('proof').hidden = false; $('proof').textContent = 'Signature checked · No transaction sent';
    $('status').hidden = true; $('actions').replaceChildren(); fresh('Open a fresh reserve');
  } finally { opened.close(); }
}
window.addEventListener('pagehide', () => { lifetime.abort(); setup?.cancel(); receiver?.dispose(); clearKey(); }, { once: true });
if (primary) button('Create example account', create);
else {
  if (receiver.isEnrollment) button('Prepare this reserve', prepare); else button('Open existing reserve', recover);
  async function refresh() { const s = await (await fetch('/api/status')).json(); $('availability').textContent = s.primaryOnline ? 'Original app online.' : 'Original app and API offline. Fresh B recovery remains available.'; $('offline').textContent = s.primaryOnline ? 'Take original app offline' : 'Bring original app online'; $('offline').dataset.online = String(s.primaryOnline); }
  $('offline').onclick = async () => { await fetch('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: $('offline').dataset.online !== 'true' }) }); await refresh(); };
  await refresh();
}
