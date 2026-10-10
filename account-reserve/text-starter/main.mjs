import { startTextReserveSetup, createTextReserveReceiver } from '@continuitykit/account-reserve/text-browser';
import { recoverTextReserve } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { captureText, restoreText, exportText, textareaAdapter } from './adapter.mjs';
import { syntheticClient } from './synthetic-client.mjs';
import { validateEnvironment } from './config.mjs';

const $ = id => document.getElementById(id), life = new AbortController();
const editor = textareaAdapter($('draft')), urls = new Set();
let setup, receiver, enrollmentStore, settings, busy = false, disposed = false, opened = false;
let recoveryAllowed = false;
const status = (message, error = false) => { $('status').textContent = message; $('status').dataset.error = String(error); };
const fetcher = (path, init = {}) => fetch(path, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: init.signal ? AbortSignal.any([life.signal, init.signal]) : life.signal });
// Explicit injection is required in this local simulation. This starter never
// calls a native authenticator and its synthetic server must never be deployed.
const webAuthnClient = syntheticClient(fetcher);
function controls() {
  for (const id of ['prepare','receive','recover','offline','clear','export-txt','export-json']) $(id).disabled = busy || disposed;
  $('draft').disabled = disposed || busy || settings?.role === 'recovery' && !opened;
  for (const id of ['export-txt','export-json']) $(id).hidden = !opened;
  $('clear').hidden = !opened || settings?.role !== 'recovery';
  $('recover').hidden = !recoveryAllowed || opened;
}
function showText(text) { restoreText(text, editor); opened = true; $('editor-heading').textContent = 'Your draft is open.'; controls(); }
async function perform(action) { if (busy || disposed) return; busy = true; controls(); try { await action(); } catch (error) { if (!disposed) status(`The action stopped (${String(error?.code ?? 'LOCAL_ACTION_FAILED').replace(/[^A-Z_]/g, '').slice(0, 64)}). Check the existing reserve before preparing again.`, true); } finally { busy = false; controls(); } }
$('prepare').addEventListener('click', () => {
  if (busy || disposed) return;
  try {
    // Keep this directly inside the click handler: the SDK opens B here.
    setup = startTextReserveSetup({ config: settings.config, originalOrigin: settings.originalOrigin,
      recoveryUrl: settings.recoveryOrigin + '/', text: captureText(editor), signal: life.signal,
      onState: value => { if (!disposed) status(value.state === 'ready' ? 'The snapshot was prepared and independently opened in B.' : 'Setup: ' + value.state.replaceAll('-', ' ') + '. Keep both tabs open.'); } });
    $('prepare').hidden = true;
    void perform(async () => { await setup.completion; status('Your snapshot is ready in B. You can now make A unavailable from B.'); });
  } catch (error) { status('Setup could not open. Allow the local B tab and try again before any preparation.', true); }
});
$('receive').addEventListener('click', () => {
  if (busy || disposed || !receiver || !enrollmentStore) return;
  $('receive').hidden = true;
  void perform(async () => {
    try { const ready = await receiver.prepare({ store: enrollmentStore, webAuthnClient, signal: life.signal, user: { name: 'Local simulated text reserve', displayName: 'LOCAL SIMULATION' } });
      if (!disposed) { showText(ready.text); status('Snapshot encrypted, stored and independently opened. Use “Make A unavailable”, then open B in a fresh tab.'); $('recover').hidden = false; }
    } finally { enrollmentStore?.clearEnrollmentCapability(); enrollmentStore = undefined; recoveryAllowed = true; }
  });
});
$('recover').addEventListener('click', () => void perform(async () => {
  editor.clear(); opened = false; $('editor-heading').textContent = 'Pick up where you left off.'; controls(); status('Opening the saved snapshot using the simulated B credential…');
  const reserve = await recoverTextReserve({ config: settings.config, store: createReserveHttpStore({ fetcher }), webAuthnClient, signal: life.signal });
  if (!disposed) { showText(reserve.text); status('The saved snapshot is open. Edits affect this view only. Export to keep them.'); }
}));
for (const format of ['txt','json']) $('export-' + format).addEventListener('click', () => {
  if (!opened || busy || disposed) return;
  try { const blob = new Blob([exportText(editor, format)], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json' });
    const url = URL.createObjectURL(blob); urls.add(url); const link = document.createElement('a'); link.href = url; link.download = 'continuity-draft.' + format; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000); status('Export requested. Check your downloads; the saved snapshot is unchanged.');
  } catch { status('Export stopped. Keep the draft visible and check its size.', true); }
});
$('clear').addEventListener('click', () => { if (busy || disposed) return; editor.clear(); opened = false; $('editor-heading').textContent = 'Pick up where you left off.'; controls(); status('This view is cleared. The encrypted snapshot can still be opened in B.'); });
async function availability() {
  const response = await fetcher('/api/status'); if (!response.ok) throw new Error('LOCAL_STATUS_FAILED');
  const value = await response.json(); $('availability').textContent = value.primaryOnline ? 'A is currently available.' : 'A is unavailable. Its page and API return HTTP 503.';
  $('offline').dataset.online = String(value.primaryOnline); $('offline').textContent = value.primaryOnline ? 'Make A unavailable' : 'Restore A';
}
$('offline').addEventListener('click', () => void perform(async () => {
  const response = await fetcher('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: $('offline').dataset.online !== 'true' }) });
  if (!response.ok) throw new Error('LOCAL_CONTROL_FAILED'); await availability();
}));
window.addEventListener('pagehide', () => {
  disposed = true; life.abort(); setup?.cancel(); receiver?.dispose(); enrollmentStore?.clearEnrollmentCapability(); enrollmentStore = undefined;
  editor.clear(); opened = false; settings = undefined; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); controls(); status('This view is closed. Reopen B to recover again.');
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
try {
  const response = await fetcher('/api/config'); if (!response.ok) throw new Error('CONFIG_UNAVAILABLE');
  const environment = await response.json();
  if (disposed || life.signal.aborted) throw new Error('VIEW_CLOSED');
  validateEnvironment(environment, location.href); settings = environment;
  if (settings.role === 'primary') {
    $('role-letter').textContent = 'A'; $('place').textContent = 'YOUR EDITOR / ORIGINAL ORIGIN'; $('editor-heading').textContent = 'Make something worth keeping.';
    restoreText('A small draft, with a way back.\n\nWrite a fictional example here, then prepare its reserve.', editor); opened = true; $('prepare').hidden = false;
    status('Your text stays in this page until you deliberately prepare its encrypted reserve in B.');
  } else {
    $('role-letter').textContent = 'B'; $('place').textContent = 'YOUR RESERVE / SEPARATE ORIGIN'; $('editor-heading').textContent = 'Pick up where you left off.';
    $('recovery-tools').hidden = false; $('fresh').href = settings.recoveryOrigin + '/';
    receiver = createTextReserveReceiver({ config: settings.config, originalOrigin: settings.originalOrigin });
    if (receiver.isEnrollment && settings.enrollmentToken) {
      enrollmentStore = createReserveHttpStore({ fetcher, enrollmentToken: settings.enrollmentToken });
      $('receive').hidden = false; status('A is ready to hand over the draft. Prepare this snapshot to continue. Keep A open until it finishes.');
    } else { recoveryAllowed = true; status('Open the existing snapshot. This check only reads; it does not prepare or overwrite a reserve.'); }
    delete settings.enrollmentToken; await availability();
  }
  controls();
} catch { if (!disposed) status('The local starter is unavailable or misconfigured. Run npm run doctor in its folder, then npm run dev.', true); }
