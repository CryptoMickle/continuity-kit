import { startTextReserveSetup, createTextReserveReceiver, startTextReserveReplicaSetup, createTextReserveReplicaReceiver } from '@continuitykit/account-reserve/text-browser';
import { recoverTextReserve, recoverTextReserveFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { captureText, restoreText, exportText, textareaAdapter } from './adapter.mjs';
import { syntheticClient } from './synthetic-client.mjs';
import { validateEnvironment } from './config.mjs';

const $ = id => document.getElementById(id), life = new AbortController();
const editor = textareaAdapter($('draft')), urls = new Set();
let setup, receiver, enrollmentStore, settings, busy = false, disposed = false, opened = false;
let recoveryAllowed = false, admissionAttempted = false;
let replicaStores = [], processStates = [];
const isReplica = () => settings?.replicaMode === true;
const active = () => !disposed && !life.signal.aborted;
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
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
  if (isReplica()) {
    const locked = busy || disposed || opened || !recoveryAllowed;
    $('offline').disabled = locked;
    for (const id of ['alpha','beta']) {
      const state = processStates.find(value => value.id === id);
      $('toggle-' + id).disabled = locked || !state;
      $('corrupt-' + id).disabled = locked || !state || state.running || state.corrupted;
    }
    $('replica-control-hint').textContent = opened ? 'Close this copy before changing storage. Reopen afterward for a new verification.'
      : !recoveryAllowed ? 'Finish or close the setup before changing storage.' : 'Process status is not a verification result. No copy is repaired automatically.';
  } else if (disposed) for (const id of ['alpha','beta']) { $('toggle-' + id).disabled = true; $('corrupt-' + id).disabled = true; }
}
function showText(text) { restoreText(text, editor); opened = true; $('editor-heading').textContent = 'Your draft is open.'; controls(); }
function clearEvidence(message = 'Open the reserve to check the saved copies.') {
  if (!isReplica()) return;
  $('copy-summary').textContent = message;
  for (const id of ['alpha','beta']) { $('copy-' + id).textContent = 'Not checked'; $('copy-' + id).dataset.state = 'unchecked'; }
}
function evidence(diagnostics, summary) {
  if (!isReplica() || !active()) return;
  const labels = { missing: 'No copy found', unavailable: 'Unavailable at this check', rejected: 'Rejected · not trusted', unknown: 'Write outcome unknown', pending: 'Not checked', existing: 'Existing · not verified', written: 'Written · not yet verified' };
  $('copy-summary').textContent = summary;
  for (const id of ['alpha','beta']) {
    const value = Array.isArray(diagnostics) ? diagnostics.find(item => item?.id === id) : undefined;
    const verified = value?.stage === 'verify' && value?.status === 'verified';
    $('copy-' + id).textContent = verified ? 'Verified at this read' : labels[value?.status] ?? 'Not checked';
    $('copy-' + id).dataset.state = verified ? 'verified' : Object.hasOwn(labels, value?.status) ? value.status : 'unchecked';
  }
}
function verifiedCount(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length !== 2 || new Set(diagnostics.map(value => value.id)).size !== 2
    || diagnostics.some(value => !['alpha','beta'].includes(value.id))) throw fail('REPLICA_RESULT_INVALID');
  return diagnostics.filter(value => value.stage === 'verify' && value.status === 'verified').length;
}
function clearCapabilities() { enrollmentStore?.clearEnrollmentCapability(); enrollmentStore = undefined; for (const replica of replicaStores) replica.store.clearEnrollmentCapability(); replicaStores = []; }
async function perform(action) { if (busy || disposed) return; busy = true; controls(); try { await action(); } catch (error) {
  if (!disposed) {
    const code = String(error?.code ?? 'LOCAL_ACTION_FAILED').replace(/[^A-Z_]/g, '').slice(0, 64);
    if (isReplica() && error?.replicas) evidence(error.replicas, code === 'REPLICA_CONFLICT' ? 'The authenticated copies disagree. Nothing was opened.' : 'The operation did not complete. No unverified text was opened.');
    status(code === 'REPLICA_CONFLICT' ? 'The stored copies disagree. Nothing was opened. Keep both copies; do not overwrite either.'
      : code === 'REPLICA_RECOVERY_FAILED' ? 'No usable copy could be verified. Nothing was opened. If a store is stopped, start it and check again. Altered copies are never repaired automatically.'
      : `The action stopped (${code}). Check the existing reserve before preparing again.`, true);
  }
} finally { busy = false; controls(); } }
$('prepare').addEventListener('click', () => {
  if (busy || disposed) return;
  try {
    // Keep this directly inside the click handler: the SDK opens B here.
    const start = isReplica() ? startTextReserveReplicaSetup : startTextReserveSetup;
    setup = start({ config: settings.config, originalOrigin: settings.originalOrigin,
      recoveryUrl: settings.recoveryOrigin + '/', text: captureText(editor), signal: life.signal,
      ...(isReplica() ? { replicaIds: settings.replicas.map(value => value.id) } : {}),
      onState: value => { if (!disposed) status(value.state === 'ready' ? 'The snapshot was prepared and independently opened in B.' : 'Setup: ' + value.state.replaceAll('-', ' ') + '. Keep both tabs open.'); } });
    $('prepare').hidden = true;
    void perform(async () => { await setup.completion; if (active()) status('Your snapshot is ready in B. You can now test recovery without A.'); });
  } catch (error) { status('Setup could not open. Allow the local B tab and try again before any preparation.', true); }
});
$('receive').addEventListener('click', () => {
  if (busy || disposed || !receiver || admissionAttempted || (!isReplica() && !enrollmentStore)) return;
  admissionAttempted = true;
  $('receive').hidden = true;
  void perform(async () => {
    try {
      if (isReplica()) {
        clearEvidence('Preparing one immutable snapshot in both stores.');
        status('Checking local upload permission. Keep A open until both copies are verified.');
        const response = await fetcher('/api/replica-enrollment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!response.ok) throw fail('REPLICA_ADMISSION_STOPPED');
        const grants = await response.json();
        if (!active()) throw fail('VIEW_CLOSED');
        if (!exact(grants, ['replicas']) || !Array.isArray(grants.replicas) || grants.replicas.length !== 2
          || grants.replicas.some((value, index) => !exact(value, ['id','enrollmentToken']) || value.id !== settings.replicas[index].id || !/^[A-Za-z0-9_-]{43}$/.test(value.enrollmentToken))
          || grants.replicas[0].enrollmentToken === grants.replicas[1].enrollmentToken) throw fail('REPLICA_ADMISSION_INVALID');
        for (const [index, grant] of grants.replicas.entries()) {
          replicaStores.push({ id: grant.id, store: createReserveHttpStore({ fetcher, enrollmentToken: grant.enrollmentToken, basePath: settings.replicas[index].basePath }) });
          delete grant.enrollmentToken;
        }
      }
      const ready = await receiver.prepare({ ...(isReplica() ? { replicas: replicaStores } : { store: enrollmentStore }), webAuthnClient, signal: life.signal, user: { name: 'Local simulated text reserve', displayName: 'LOCAL SIMULATION' } });
      if (active()) {
        if (isReplica()) { if (verifiedCount(ready.replicas) !== 2) throw Object.assign(fail('REPLICA_PREPARATION_INCOMPLETE'), { replicas: ready.replicas }); evidence(ready.replicas, 'Both copies independently passed this preparation check.'); }
        showText(ready.text); status(isReplica() ? 'Both copies are ready. Close this copy to test a storage failure, then reopen the reserve.' : 'Snapshot encrypted, stored and independently opened. Use “Make A unavailable”, then open B in a fresh tab.');
      }
    } finally { clearCapabilities(); receiver?.dispose(); recoveryAllowed = true; }
  });
});
$('recover').addEventListener('click', () => void perform(async () => {
  if (opened || !recoveryAllowed) return;
  editor.clear(); opened = false; $('editor-heading').textContent = 'Pick up where you left off.'; controls(); status('Opening the saved snapshot using the simulated B credential…');
  if (isReplica()) {
    clearEvidence('Checking both encrypted copies. Process availability is not verification.');
    const result = await recoverTextReserveFromReplicas({ config: settings.config, replicas: settings.replicas.map(value => ({ id: value.id, store: createReserveHttpStore({ fetcher, basePath: value.basePath }) })), webAuthnClient, signal: life.signal });
    if (active()) {
      const count = verifiedCount(result.replicas); if (!count) throw fail('REPLICA_RESULT_INVALID');
      evidence(result.replicas, count === 2 ? 'Both copies passed this read. Your local edits do not update them.' : 'One verified copy was enough to open this draft. Redundancy is reduced.');
      showText(result.reserve.text); status(count === 2 ? 'Your draft is open from two matching verified copies. Edit locally and export to keep the changes.' : 'Your draft is open from the surviving verified copy. The other copy was not usable at this read.');
    }
  } else {
    const reserve = await recoverTextReserve({ config: settings.config, store: createReserveHttpStore({ fetcher }), webAuthnClient, signal: life.signal });
    if (active()) { showText(reserve.text); status('The saved snapshot is open. Edits affect this view only. Export to keep them.'); }
  }
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
  const value = await response.json(); if (!active()) return;
  if (typeof value.primaryOnline !== 'boolean') throw fail('LOCAL_STATUS_INVALID');
  $('availability').textContent = value.primaryOnline ? 'A is currently available.' : 'A is unavailable. Its page and API return HTTP 503.';
  $('offline').dataset.online = String(value.primaryOnline); $('offline').textContent = value.primaryOnline ? 'Make A unavailable' : 'Restore A';
  if (isReplica()) {
    if (!Array.isArray(value.replicas) || value.replicas.length !== 2 || value.replicas.some((item, index) => !exact(item, ['id','running','corrupted']) || item.id !== settings.replicas[index].id || typeof item.running !== 'boolean' || typeof item.corrupted !== 'boolean')) throw fail('LOCAL_STATUS_INVALID');
    processStates = value.replicas;
    for (const state of processStates) {
      $('process-' + state.id).textContent = (state.running ? 'Process running' : 'Process stopped') + (state.corrupted ? ' · intentionally corrupted' : '');
      $('toggle-' + state.id).textContent = (state.running ? 'Stop ' : 'Start ') + (state.id === 'alpha' ? 'Alpha' : 'Beta');
    }
    controls();
  }
}
$('offline').addEventListener('click', () => void perform(async () => {
  if (isReplica() && (opened || !recoveryAllowed)) return;
  const response = await fetcher('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: $('offline').dataset.online !== 'true' }) });
  if (!response.ok) throw new Error('LOCAL_CONTROL_FAILED'); await availability();
}));
for (const id of ['alpha','beta']) for (const operation of ['toggle','corrupt']) $('' + operation + '-' + id).addEventListener('click', () => {
  if (!isReplica() || busy || disposed || opened || !recoveryAllowed) return;
  const state = processStates.find(value => value.id === id); if (!state || operation === 'corrupt' && (state.running || state.corrupted)) return;
  void perform(async () => {
    clearEvidence('Storage is changing. Open the reserve again for a new verification.');
    const action = operation === 'corrupt' ? 'corrupt' : state.running ? 'stop' : 'start';
    processStates = []; // A lost control response must not leave stale actions enabled.
    const response = await fetcher('/api/replica-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action }) });
    if (!response.ok) throw fail('LOCAL_CONTROL_STOPPED');
    await availability(); if (active()) status('Local storage changed. Open the existing reserve to verify which copies remain usable.');
  });
});
window.addEventListener('pagehide', () => {
  clearEvidence(); disposed = true; life.abort(); setup?.cancel(); receiver?.dispose(); clearCapabilities(); processStates = [];
  editor.clear(); opened = false; settings = undefined; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); controls(); status('This view is closed. Reopen B to recover again.');
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
try {
  const response = await fetcher('/api/config'); if (!response.ok) throw new Error('CONFIG_UNAVAILABLE');
  const environment = await response.json();
  if (disposed || life.signal.aborted) throw new Error('VIEW_CLOSED');
  validateEnvironment(environment, location.href); settings = environment;
  if (isReplica()) {
    $('edit-hint').textContent = 'Use fictional text. This disposable local run uses two encrypted SQLite stores and a simulated credential.';
    $('simulation-note').textContent = 'Simulation only. Two local storage processes hold encrypted snapshots in separate disposable databases. The credential is simulated; this does not prove physical passkeys, independent providers or production security. B remains a shared dependency. Never deploy this server. Prepared snapshots are immutable; edits need an export.';
  }
  if (settings.role === 'primary') {
    $('role-letter').textContent = 'A'; $('place').textContent = 'YOUR EDITOR / ORIGINAL ORIGIN'; $('editor-heading').textContent = 'Make something worth keeping.';
    restoreText('A small draft, with a way back.\n\nWrite a fictional example here, then prepare its reserve.', editor); opened = true; $('prepare').hidden = false;
    status('Your text stays in this page until you deliberately prepare its encrypted reserve in B.');
  } else {
    $('role-letter').textContent = 'B'; $('place').textContent = 'YOUR RESERVE / SEPARATE ORIGIN'; $('editor-heading').textContent = 'Pick up where you left off.';
    $('recovery-tools').hidden = false; $('fresh').href = settings.recoveryOrigin + '/';
    const makeReceiver = isReplica() ? createTextReserveReplicaReceiver : createTextReserveReceiver;
    receiver = makeReceiver({ config: settings.config, originalOrigin: settings.originalOrigin, ...(isReplica() ? { replicaIds: settings.replicas.map(value => value.id) } : {}) });
    if (isReplica()) { $('replica-evidence').hidden = false; $('replica-tools').hidden = false; }
    if (receiver.isEnrollment && (isReplica() || settings.enrollmentToken)) {
      if (!isReplica()) enrollmentStore = createReserveHttpStore({ fetcher, enrollmentToken: settings.enrollmentToken });
      $('receive').hidden = false; status('A is ready to hand over the draft. Prepare this snapshot to continue. Keep A open until it finishes.');
    } else { recoveryAllowed = true; status('Open the existing snapshot. This check only reads; it does not prepare or overwrite a reserve.'); }
    delete settings.enrollmentToken; await availability();
  }
  controls();
} catch { if (!disposed) status('The local starter is unavailable or misconfigured. Run npm run doctor in its folder, then npm run dev.', true); }
