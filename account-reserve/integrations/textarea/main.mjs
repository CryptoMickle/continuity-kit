import './style.css';
import { editor, article, readDocument } from 'virtual:textarea-upstream';
import { startWorkReserveSetup, createWorkReserveReceiver } from '@continuitykit/account-reserve/work-browser';
import { recoverWorkReserve } from '@continuitykit/account-reserve/work-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { privateKeyToAccount } from 'viem/accounts';
import { captureWork, restoreWork, exportWork, ENVELOPE_FIELDS } from './adapter.mjs';
import { syntheticClient } from './synthetic-client.mjs';

const $ = id => document.getElementById(id);
const lifetime = new AbortController();
const localFetch = (path, options = {}) => fetch(path, { ...options, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: lifetime.signal });
const setStatus = (text, error = false) => { $('status').textContent = text; $('status').dataset.error = String(error); };
const envelope = () => Object.fromEntries(ENVELOPE_FIELDS.map(field => [field, $('field-' + field).value]));
const fillEnvelope = values => { for (const field of ENVELOPE_FIELDS) $('field-' + field).value = values[field]; };
let setup, receiver, opened, writingStore, busy = false;
const downloads = new Set();
function action(text, fn) {
  const button = document.createElement('button'); button.textContent = text;
  button.onclick = async () => {
    if (busy || lifetime.signal.aborted) return;
    busy = true; button.disabled = true;
    try { await fn(); } catch (error) { setStatus('Stopped: ' + (error.code ?? error.message) + '. Preserve the existing reserve; do not repeat an uncertain preparation.', true); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  };
  $('actions').append(button); return button;
}
function identity(owner) { $('identity').hidden = false; $('identity').textContent = 'Bound demonstration account: ' + owner + ' · Signing locked'; }
function showWork(value) {
  restoreWork(value, editor, fillEnvelope);
  article.hidden = false; $('envelope-panel').hidden = false; $('export-envelope').hidden = false;
}
async function main() {
  const response = await localFetch('/api/config');
  if (!response.ok) throw new Error('ORIGINAL_APP_UNAVAILABLE');
  const env = await response.json();
  const primary = env.role === 'primary';
  if (env.synthetic !== true || !['primary', 'recovery'].includes(env.role) ||
      location.origin !== (primary ? env.originalOrigin : env.recoveryOrigin) ||
      new URL(env.originalOrigin).hostname !== 'textarea-primary.localhost' ||
      new URL(env.recoveryOrigin).hostname !== 'textarea-reserve.localhost') throw new Error('LOCAL_ENVIRONMENT_REQUIRED');
  $('role').textContent = primary ? 'A · Original editor' : 'B · Reserve editor';
  const authenticator = syntheticClient(localFetch);
  function fresh() {
    const link = document.createElement('a'); link.href = env.recoveryOrigin + '/'; link.textContent = 'Open a fresh reserve'; $('actions').append(link);
  }
  if (primary) {
    fillEnvelope({ title: 'Editorial handoff', client: 'Fictional independent studio', brief: 'Continue the short document in Textarea after its original app becomes unavailable.', nextStep: 'Complete the last sentence, then export the document and envelope.' });
    editor.set('# A note worth keeping\n\nThis draft was edited in the upstream Textarea editor.\n\nStill to finish: write the closing sentence.');
    setStatus('Edit the document below, then prepare one immutable snapshot. The adapter supplies a disposable example account; Textarea has no account model.');
    $('export-envelope').hidden = false;
    action('Prepare work reserve', async () => {
      const work = captureWork(readDocument(), envelope());
      const key = crypto.getRandomValues(new Uint8Array(32));
      try {
        const owner = privateKeyToAccount('0x' + Array.from(key, b => b.toString(16).padStart(2, '0')).join('')).address.toLowerCase();
        setup = startWorkReserveSetup({ config: env.config, work, privateKey: key, expectedOwner: owner,
          recoveryUrl: env.recoveryOrigin + '/', signal: lifetime.signal,
          onState: value => setStatus('Preparation: ' + value.state + (value.code ? ' (' + value.code + ')' : '')) });
      } finally { key.fill(0); }
      $('actions').replaceChildren();
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel preparation';
      cancel.onclick = () => setup.cancel(); $('actions').append(cancel);
      try {
        const result = await setup.completion;
        identity(result.owner); $('actions').replaceChildren(); fresh();
        setStatus('Snapshot prepared and independently reopened. Later edits do not change it.');
      } finally { cancel.remove(); }
    });
  } else {
    article.hidden = true; $('envelope-panel').hidden = true;
    receiver = createWorkReserveReceiver({ config: env.config, originalOrigin: env.originalOrigin });
    if (receiver.isEnrollment) {
      setStatus('Keep the original editor open. This local test creates a simulated credential, not a native passkey.');
      action('Prepare received snapshot', async () => {
        writingStore = createReserveHttpStore({ enrollmentToken: env.enrollmentToken, fetcher: localFetch });
        try {
          const result = await receiver.prepare({ store: writingStore, user: { name: 'Textarea local example', displayName: 'Textarea local example' }, webAuthnClient: authenticator, signal: lifetime.signal });
          identity(result.owner); $('actions').replaceChildren(); fresh();
          setStatus('Snapshot stored, reopened and checked. Take A offline, then open a fresh reserve.');
        } finally { writingStore.clearEnrollmentCapability(); writingStore = undefined; }
      });
    } else {
      setStatus('Fresh reserve page. No document or account is loaded.');
      action('Open existing work reserve', async () => {
        opened?.close();
        opened = await recoverWorkReserve({ config: env.config, store: createReserveHttpStore({ fetcher: localFetch }), webAuthnClient: authenticator, signal: lifetime.signal });
        showWork(opened.work); identity(opened.owner);
        // Work remains editable after releasing the optional account-unlock context.
        opened.close(); opened = undefined;
        $('actions').replaceChildren(); fresh();
        setStatus('Work recovered in Textarea. Account signing stayed locked. Continue editing; export to keep changes.');
      });
    }
    $('recovery-controls').hidden = false; $('fresh-reserve').href = env.recoveryOrigin + '/';
    async function refresh() {
      const state = await (await localFetch('/api/status')).json();
      $('availability').textContent = state.primaryOnline ? 'A is online.' : 'A frontend and API return 503.';
      $('toggle-primary').textContent = state.primaryOnline ? 'Take original app offline' : 'Restore original app';
      $('toggle-primary').dataset.online = String(state.primaryOnline);
    }
    $('toggle-primary').onclick = async () => {
      $('toggle-primary').disabled = true;
      try { await localFetch('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: $('toggle-primary').dataset.online !== 'true' }) }); await refresh(); }
      catch (error) { setStatus('Outage control failed: ' + error.message, true); }
      finally { $('toggle-primary').disabled = false; }
    };
    await refresh();
  }
  $('export-envelope').onclick = () => {
    try {
      const bytes = exportWork(readDocument(), envelope());
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' })); downloads.add(url);
      const link = document.createElement('a'); link.href = url; link.download = 'textarea-work-envelope.json'; link.click();
      setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 1500);
      setStatus('Export requested. Check the saved JSON; it does not update the reserve.');
    } catch (error) { setStatus('Export stopped: ' + (error.code ?? error.message), true); }
  };
}
window.addEventListener('pagehide', () => {
  lifetime.abort(); setup?.cancel(); receiver?.dispose(); writingStore?.clearEnrollmentCapability(); opened?.close();
  article.textContent = ''; for (const field of ENVELOPE_FIELDS) $('field-' + field).value = '';
  for (const url of downloads) URL.revokeObjectURL(url);
}, { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
main().catch(error => { article.hidden = true; $('envelope-panel').hidden = true; setStatus('This workspace is unavailable: ' + error.message + '. Open the separate reserve to recover an existing snapshot.', true); });
