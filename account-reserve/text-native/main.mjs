import { startTextReserveReplicaSetup, createTextReserveReplicaReceiver } from '@continuitykit/account-reserve/text-browser';
import { recoverTextReserveFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { captureText, restoreText, exportText, textareaAdapter } from './adapter.mjs';
import { validateNativeEnvironment, nativeConfig, parseNativeGrants } from './profile.mjs';

const $ = id => document.getElementById(id), life = new AbortController();
const editor = textareaAdapter($('draft')), urls = new Set(), outcomes = new Map();
let profile, role, config, receiver, setup, grants, timer, operation, permissionDeadline, stores = [];
let busy = false, disposed = false, opened = false, attempted = false, enrollment = false, supported = false, ready = false;
const active = () => !disposed && !life.signal.aborted;
const fail = code => Object.assign(new Error(code), { code });
const status = (message, error = false) => { if (active()) { $('status').textContent = message; $('status').dataset.error = String(error); } };
const profileOpen = () => profile && Date.parse(profile.expiresAt) > Date.now();
const permissionOpen = () => grants && grants.replicas.every(value => Date.parse(value.expiresAt) > Date.now());
function clearCapabilities() { grants = undefined; for (const item of stores) item.store.clearEnrollmentCapability(); stores = []; $('upload-permission').value = ''; }
function beginOperation() { operation = new AbortController(); return AbortSignal.any([life.signal, operation.signal]); }
function browserReady() {
  // Static checks only. No authenticator discovery or capability probe runs
  // until a deliberate user action invokes the SDK's native default client.
  return globalThis.isSecureContext === true && typeof globalThis.PublicKeyCredential === 'function'
    && typeof globalThis.navigator?.credentials?.get === 'function' && typeof globalThis.navigator?.credentials?.create === 'function'
    && typeof globalThis.crypto?.getRandomValues === 'function' && typeof globalThis.crypto?.subtle?.digest === 'function';
}
function controls() {
  const locked = !ready || busy || disposed || !supported || !profileOpen();
  $('draft').disabled = busy || disposed || !ready || role === 'recovery' && !opened;
  $('draft-panel').hidden = role === 'recovery' && !opened;
  $('start-setup').hidden = role !== 'primary' || attempted;
  $('start-setup').disabled = locked;
  $('recover').hidden = role !== 'recovery' || enrollment && !attempted || opened;
  $('recover').disabled = locked;
  $('permission-panel').hidden = role !== 'recovery' || !enrollment || attempted;
  $('upload-permission').disabled = locked;
  $('check-permission').disabled = locked || attempted;
  $('passkey-options').hidden = !grants || attempted;
  $('prepare-new').disabled = locked || !permissionOpen() || attempted;
  $('prepare-existing').disabled = locked || !permissionOpen() || attempted;
  for (const id of ['export-txt','export-json']) { $(id).hidden = !opened; $(id).disabled = busy || disposed; }
  $('close-copy').hidden = !opened || role !== 'recovery'; $('close-copy').disabled = busy || disposed;
}
function scheduleExpiry() {
  clearTimeout(timer); if (!active() || !profile) return;
  const deadlines = [Date.parse(profile.expiresAt), permissionDeadline, ...(grants ? grants.replicas.map(value => Date.parse(value.expiresAt)) : [])].filter(value => value > Date.now());
  if (deadlines.length) timer = setTimeout(expiry, Math.min(Math.min(...deadlines) - Date.now() + 1, 2147483647));
}
function expiry() {
  if (!active()) return;
  if (grants && !permissionOpen()) { clearCapabilities(); $('permission-status').textContent = 'Upload permission expired. No new passkey request was started. Ask the operator for fresh permission if setup is still open.'; }
  if (busy && permissionDeadline && permissionDeadline <= Date.now()) { operation?.abort(); receiver?.dispose(); clearCapabilities(); }
  if (!profileOpen()) {
    operation?.abort(); setup?.cancel(); receiver?.dispose(); clearCapabilities(); $('availability').dataset.expired = 'true';
    $('availability').textContent = 'This access window has ended. Export any open copy before closing it.';
    if (!busy) status(opened ? 'The access window has ended. Your open copy can still be edited and exported.' : 'The access window has ended. New preparation and recovery are unavailable here.', true);
  }
  controls(); scheduleExpiry();
}
function requireAccess() { if (!active()) throw fail('VIEW_CLOSED'); if (!supported) throw fail('BROWSER_UNSUPPORTED'); if (!profileOpen()) throw fail('ACCESS_EXPIRED'); }
function createEvidence() {
  $('copy-list').replaceChildren(); outcomes.clear();
  for (const item of profile.replicas) {
    const card = document.createElement('div'), name = document.createElement('span'), outcome = document.createElement('span');
    name.className = 'copy-name'; name.textContent = item.id; outcome.className = 'copy-outcome'; outcome.dataset.state = 'unchecked'; outcome.textContent = 'Not checked';
    card.append(name, outcome); $('copy-list').append(card); outcomes.set(item.id, outcome);
  }
  $('copy-evidence').hidden = false;
}
function clearEvidence(message) { for (const element of outcomes.values()) { element.textContent = 'Not checked'; element.dataset.state = 'unchecked'; } if (message) $('copy-summary').textContent = message; }
function evidence(diagnostics, message) {
  if (!active()) return; $('copy-summary').textContent = message;
  const labels = { missing: 'No copy found', unavailable: 'Unavailable at this read', rejected: 'Rejected · not trusted', unknown: 'Write outcome unknown', pending: 'Not checked', existing: 'Existing · not verified', written: 'Written · not yet verified' };
  for (const [id, element] of outcomes) {
    const value = Array.isArray(diagnostics) ? diagnostics.find(item => item?.id === id) : undefined;
    const verified = value?.stage === 'verify' && value?.status === 'verified';
    element.textContent = verified ? 'Verified at this read' : labels[value?.status] ?? 'Not checked';
    element.dataset.state = verified ? 'verified' : Object.hasOwn(labels, value?.status) ? value.status : 'unchecked';
  }
}
function verifiedCount(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length !== profile.replicas.length || new Set(diagnostics.map(item => item.id)).size !== profile.replicas.length
    || diagnostics.some(item => !outcomes.has(item.id))) throw fail('REPLICA_RESULT_INVALID');
  return diagnostics.filter(item => item.stage === 'verify' && item.status === 'verified').length;
}
function showText(text) { restoreText(text, editor); opened = true; $('editor-heading').textContent = 'Your draft is open.'; $('draft-panel').hidden = false; controls(); }
function stopped(error) {
  if (!active()) return;
  const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '') ? error.code : 'ACTION_STOPPED';
  if (error?.replicas) evidence(error.replicas, code === 'REPLICA_CONFLICT' ? 'Authenticated copies disagree. No draft was opened.' : 'The operation did not finish. No unverified draft was opened.');
  status(code === 'REPLICA_CONFLICT' ? 'The authenticated copies disagree. Nothing was opened. Keep both copies; do not overwrite them.'
    : code === 'ACCESS_EXPIRED' ? 'This access window has ended. Export any draft already open.'
    : `The action stopped (${code}). Keep existing passkeys. Check the existing reserve before trying another setup.`, true);
}
function settle(promise, success, { preparation = false } = {}) {
  Promise.resolve(promise).then(value => { if (active()) { if (!profileOpen()) throw fail('ACCESS_EXPIRED'); if (permissionDeadline && permissionDeadline <= Date.now()) throw fail('UPLOAD_PERMISSION_EXPIRED'); success(value); } }).catch(stopped).finally(() => {
    if (preparation) { clearCapabilities(); receiver?.dispose(); enrollment = false; }
    operation = undefined; permissionDeadline = undefined; busy = false; controls(); scheduleExpiry();
  });
}

$('start-setup').addEventListener('click', () => {
  if (busy || disposed || attempted) return;
  try {
    requireAccess(); const text = captureText(editor);
    // Opening B stays synchronous with this user action.
    setup = startTextReserveReplicaSetup({ config, replicaIds: profile.replicas.map(item => item.id), originalOrigin: profile.primaryOrigin,
      recoveryUrl: profile.recoveryOrigin + '/', text, signal: beginOperation(),
      onState: value => { if (value.state !== 'ready' && value.state !== 'failed') status('Preparing your reserve: ' + value.state.replaceAll('-', ' ') + '. Keep both pages open.'); } });
    attempted = true; busy = true; controls();
    settle(setup.completion, result => { if (verifiedCount(result.replicas) !== profile.replicas.length) throw fail('PREPARATION_INCOMPLETE'); evidence(result.replicas, 'Every intended copy independently passed preparation.'); status('Your snapshot is ready in B. Keep its address and your recovery passkey.'); });
  } catch (error) { operation?.abort(); operation = undefined; stopped(error); controls(); }
});
$('check-permission').addEventListener('click', () => {
  if (busy || disposed || attempted || !enrollment) return;
  let input = $('upload-permission').value; $('upload-permission').value = ''; clearCapabilities();
  try {
    requireAccess(); grants = parseNativeGrants(input, profile);
    $('permission-status').textContent = 'Permission scope and expiry checked. Choose how to prepare the snapshot below. The operator still checks permission at upload.';
    status('No passkey request has started. Choose a new or existing recovery passkey to prepare your snapshot.');
  } catch (error) { $('permission-status').textContent = 'Permission was not accepted. Check the operator-supplied text and its expiry.'; stopped(error); }
  finally { input = undefined; controls(); scheduleExpiry(); }
});
function prepare(credentialMode) {
  if (busy || disposed || attempted || !enrollment) return;
  try {
    requireAccess();
    if (!permissionOpen()) { clearCapabilities(); $('permission-status').textContent = 'Upload permission expired or is missing. Check fresh operator-supplied permission before continuing.'; throw fail('UPLOAD_PERMISSION_EXPIRED'); }
    permissionDeadline = Math.min(...grants.replicas.map(item => Date.parse(item.expiresAt)));
    for (const [index, grant] of grants.replicas.entries()) stores.push({ id: grant.id, store: createReserveHttpStore({ basePath: profile.replicas[index].basePath, enrollmentToken: grant.enrollmentToken }) });
    requireAccess(); if (permissionDeadline <= Date.now()) throw fail('UPLOAD_PERMISSION_EXPIRED');
    grants = undefined; $('upload-permission').value = ''; attempted = true; busy = true; controls();
    clearEvidence('Preparing one immutable snapshot across all configured copies.');
    status('Complete the passkey request. Keep A open until every intended copy is verified.');
    // No injected credential client and no await before this call. The SDK's
    // native default owns creation/selection, cancellation and verification.
    const pending = receiver.prepare({ replicas: stores, signal: beginOperation(),
      ...(credentialMode === 'existing' ? { credentialMode: 'existing' } : { user: { name: 'ContinuityKit text reserve', displayName: 'ContinuityKit recovery' } }) });
    settle(pending, result => {
      if (verifiedCount(result.replicas) !== profile.replicas.length) throw Object.assign(fail('PREPARATION_INCOMPLETE'), { replicas: result.replicas });
      evidence(result.replicas, 'Every intended copy independently passed this preparation check.'); showText(result.text);
      status('Your snapshot is ready. Keep this recovery address and its passkey. Edit locally and export to keep any changes.');
    }, { preparation: true });
  } catch (error) { operation?.abort(); operation = undefined; permissionDeadline = undefined; clearCapabilities(); if (attempted) { receiver?.dispose(); enrollment = false; } busy = false; stopped(error); controls(); scheduleExpiry(); }
}
$('prepare-new').addEventListener('click', () => prepare('create'));
$('prepare-existing').addEventListener('click', () => prepare('existing'));
$('recover').addEventListener('click', () => {
  if (busy || disposed || opened || enrollment && !attempted) return;
  try {
    requireAccess(); editor.clear(); clearEvidence('Checking the saved copies. No new passkey is created.'); busy = true; controls();
    const replicas = profile.replicas.map(item => ({ id: item.id, store: createReserveHttpStore({ basePath: item.basePath }) }));
    status('Choose the existing recovery passkey for this site.');
    const pending = recoverTextReserveFromReplicas({ config, replicas, signal: beginOperation() });
    settle(pending, result => {
      const count = verifiedCount(result.replicas); if (count < 1) throw fail('REPLICA_RESULT_INVALID');
      evidence(result.replicas, count === profile.replicas.length ? 'All copies matched and passed this read.' : `${count} of ${profile.replicas.length} copies passed this read. Redundancy is reduced.`);
      showText(result.reserve.text); status('Your saved draft is open. Changes affect only this local copy. Export before closing it.');
    });
  } catch (error) { operation?.abort(); operation = undefined; busy = false; stopped(error); controls(); }
});
for (const format of ['txt','json']) $('export-' + format).addEventListener('click', () => {
  if (!opened || busy || disposed) return;
  try {
    const blob = new Blob([exportText(editor, format)], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json' });
    const url = URL.createObjectURL(blob); urls.add(url); const link = document.createElement('a'); link.href = url; link.download = 'continuity-draft.' + format; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000); status('Export requested. Check your downloads; the stored snapshot is unchanged.');
  } catch { status('Export stopped. Keep the draft open and check its size.', true); }
});
$('close-copy').addEventListener('click', () => {
  if (busy || disposed || !opened) return;
  editor.clear(); opened = false; $('editor-heading').textContent = 'Open your existing reserve.';
  clearEvidence('The local copy is closed. Reopen for a fresh verification.'); controls(); status('This local copy is closed. Your encrypted snapshot is unchanged.');
});
window.addEventListener('pagehide', () => {
  if (disposed) return;
  disposed = true; life.abort(); operation?.abort(); operation = undefined; permissionDeadline = undefined; clearTimeout(timer); setup?.cancel(); receiver?.dispose(); clearCapabilities();
  editor.clear(); opened = false; enrollment = false; ready = false; clearEvidence('This view is closed.');
  for (const url of urls) URL.revokeObjectURL(url); urls.clear(); profile = undefined; config = undefined;
  controls(); $('status').textContent = 'This view is closed. Reopen the recovery site to continue.';
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

async function readConfiguration() {
  const response = await fetch('/continuity-config.json', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([life.signal, AbortSignal.timeout(10000)]) });
  if (!response.ok) throw fail('CONFIG_UNAVAILABLE');
  const bytes = await response.text(); if (bytes.length > 8192) throw fail('CONFIG_INVALID');
  return JSON.parse(bytes);
}
try {
  const supplied = await readConfiguration(); if (!active()) throw fail('VIEW_CLOSED');
  ({ profile, role } = validateNativeEnvironment(supplied, location.href)); config = nativeConfig(profile); supported = browserReady();
  createEvidence(); $('reserve-link').href = profile.recoveryOrigin + '/'; $('reserve-link').textContent = profile.recoveryOrigin; $('reserve-link').hidden = false;
  $('availability').textContent = 'Access window ends ' + new Date(profile.expiresAt).toLocaleString() + '. Export anything you want to keep before then.';
  if (role === 'primary') {
    $('place').textContent = 'YOUR EDITOR / ORIGINAL SITE'; $('editor-heading').textContent = 'Make something worth keeping.';
    restoreText('A draft worth keeping.\n\nWrite an example here, then prepare its encrypted reserve.', editor); opened = true;
    status('Your text stays on this page until you deliberately prepare its reserve in B.');
  } else {
    $('role-letter').textContent = 'B'; $('place').textContent = 'YOUR RESERVE / RECOVERY SITE';
    $('headline-first').textContent = 'Your work.'; $('headline-second').textContent = 'Within reach.';
    $('lead').textContent = 'Open the snapshot you prepared in advance. Keep working here, even when the original app is unavailable.';
    $('editor-heading').textContent = 'Open your existing reserve.';
    receiver = createTextReserveReplicaReceiver({ config, replicaIds: profile.replicas.map(item => item.id), originalOrigin: profile.primaryOrigin,
      onState: value => { if (value.state === 'failed' && active() && !busy) { enrollment = false; clearCapabilities(); status('This setup window closed. Keep existing passkeys and check the reserve.', true); controls(); } } });
    enrollment = receiver.isEnrollment;
    if (enrollment) { $('editor-heading').textContent = 'Prepare your text reserve.'; status('Check your operator-supplied upload permission, then choose a passkey action. Keep A open.'); }
    else status('Use the existing recovery passkey for this site. Opening the reserve only reads stored copies.');
  }
  ready = true;
  if (!supported) status('This browser needs a secure connection, Web Crypto and passkey support. Open this site in a current HTTPS browser.', true);
  controls(); scheduleExpiry();
} catch (error) { if (active()) { stopped(error); controls(); } }
