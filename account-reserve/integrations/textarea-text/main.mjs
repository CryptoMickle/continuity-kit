import './style.css';
import { editor, article, readDocument } from 'virtual:textarea-upstream';
import { startTextReserveSetup, createTextReserveReceiver } from '@continuitykit/account-reserve/text-browser';
import { recoverTextReserve } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { captureText, restoreText, exportText } from './adapter.mjs';
import { syntheticClient } from './synthetic-client.mjs';

const $ = id => document.getElementById(id);
const lifetime = new AbortController();
const localFetch = (path, options = {}) => fetch(path, { ...options, cache: 'no-store', credentials: 'omit', redirect: 'error',
  ...(['POST', 'PUT'].includes(options.method) ? { referrerPolicy: 'origin' } : {}),
  signal: AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]),
});
const setStatus = (text, error = false) => { if (!lifetime.signal.aborted) { $('status').textContent = text; $('status').dataset.error = String(error); } };
const codeOf = error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'ACTION_STOPPED';
let setup, receiver, writingStore, enrollmentToken, busy = false, stopped = false;
const downloads = new Set();
function action(text, fn) {
  const button = document.createElement('button'); button.textContent = text;
  button.onclick = async () => {
    if (busy || lifetime.signal.aborted) return;
    busy = true; button.disabled = true;
    try { await fn(); } catch (error) { setStatus('Stopped (' + codeOf(error) + '). Keep any existing credential and check the reserve before a new setup.', true); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  };
  $('actions').append(button); return button;
}
async function main() {
  const response = await localFetch('/api/config'); if (!response.ok) throw Error('ORIGINAL_APP_UNAVAILABLE');
  const env = await response.json(), primary = env.role === 'primary';
  enrollmentToken = env.enrollmentToken; delete env.enrollmentToken;
  if (env.synthetic !== true || !['primary', 'recovery'].includes(env.role)
    || location.origin !== (primary ? env.originalOrigin : env.recoveryOrigin)
    || new URL(env.originalOrigin).hostname !== 'textarea-text-primary.localhost'
    || new URL(env.recoveryOrigin).hostname !== 'textarea-text-reserve.localhost'
    || env.config.recoveryOrigin !== env.recoveryOrigin) throw Error('LOCAL_ENVIRONMENT_REQUIRED');
  $('role').textContent = primary ? 'A · Original editor' : 'B · Reserve editor';
  const authenticator = syntheticClient(localFetch);
  function fresh(label = 'Open a fresh reserve') {
    const link = document.createElement('a'); link.href = env.recoveryOrigin + '/'; link.textContent = label; $('actions').append(link);
  }
  function stop(code) {
    if (stopped || lifetime.signal.aborted) return;
    stopped = true; setup?.cancel(); receiver?.dispose(); writingStore?.clearEnrollmentCapability();
    setup = undefined; receiver = undefined; enrollmentToken = undefined; article.contentEditable = 'plaintext-only';
    $('actions').replaceChildren(); fresh('Check existing reserve');
    setStatus('Preparation not confirmed (' + code + '). Keep any credential created and check the existing reserve. No retry will start here.', true);
  }
  const state = value => {
    if (value.state === 'failed') { stop(value.code); return; }
    if (!stopped) setStatus('Preparation: ' + value.state + '. Keep both windows open until the independent check completes.');
  };
  function cancel() { const button = document.createElement('button'); button.textContent = 'Cancel preparation'; button.onclick = () => stop('OPERATION_CANCELLED'); $('actions').append(button); }
  if (primary) {
    editor.set('# A note worth keeping\n\nThis is the actual Textarea editor.\n\nStill to finish: write the closing sentence.\n');
    $('exports').hidden = false;
    setStatus('Edit the document, then prepare one immutable snapshot. The complete snapshot is your text; no account or extra fields are required.');
    action('Prepare text reserve', async () => {
      setup = startTextReserveSetup({ config: env.config, originalOrigin: env.originalOrigin, text: captureText(readDocument()), recoveryUrl: env.recoveryOrigin + '/', signal: lifetime.signal, onState: state });
      article.contentEditable = 'false'; $('actions').replaceChildren(); cancel();
      try {
        await setup.completion;
        if (!stopped && !lifetime.signal.aborted) { $('actions').replaceChildren(); fresh(); setStatus('Exact text stored, independently reopened and checked. Later edits do not change the snapshot.'); }
      } catch (error) { stop(codeOf(error)); }
      finally { setup = undefined; article.contentEditable = 'plaintext-only'; }
    });
  } else {
    article.hidden = true;
    receiver = createTextReserveReceiver({ config: env.config, originalOrigin: env.originalOrigin, onState: state });
    if (receiver.isEnrollment) {
      setStatus('Keep A open. This local test uses a simulated credential; no native passkey or account is created.');
      action('Prepare received text', async () => {
        writingStore = createReserveHttpStore({ enrollmentToken, fetcher: localFetch }); enrollmentToken = undefined;
        $('actions').replaceChildren(); cancel();
        try {
          await receiver.prepare({ store: writingStore, user: { name: 'Textarea text example', displayName: 'Textarea text example' }, webAuthnClient: authenticator, signal: lifetime.signal });
          if (!stopped && !lifetime.signal.aborted) { $('actions').replaceChildren(); fresh(); setStatus('Text saved and independently checked. Take A offline, then recover in a fresh B page.'); }
        } catch (error) { stop(codeOf(error)); }
        finally { writingStore?.clearEnrollmentCapability(); writingStore = undefined; receiver = undefined; }
      });
    } else {
      enrollmentToken = undefined;
      setStatus('Fresh reserve page. No document is loaded. Open the snapshot with the existing simulated credential.');
      action('Open existing text reserve', async () => {
        const recovered = await recoverTextReserve({ config: env.config, store: createReserveHttpStore({ fetcher: localFetch }), webAuthnClient: authenticator, signal: lifetime.signal });
        if (lifetime.signal.aborted) return;
        restoreText(recovered.text, editor); article.hidden = false; $('exports').hidden = false;
        $('actions').replaceChildren(); fresh(); setStatus('Exact text recovered in Textarea. Continue editing and export. The result has no account or signing capability.');
      });
    }
    $('recovery-controls').hidden = false; $('fresh-reserve').href = env.recoveryOrigin + '/';
    async function refresh() {
      const response = await localFetch('/api/status'); if (!response.ok) throw Error('STATUS_UNAVAILABLE'); const state = await response.json();
      $('availability').textContent = state.primaryOnline ? 'A is online.' : 'A frontend and API return 503.';
      $('toggle-primary').textContent = state.primaryOnline ? 'Take original app offline' : 'Restore original app'; $('toggle-primary').dataset.online = String(state.primaryOnline);
    }
    $('toggle-primary').onclick = async () => {
      $('toggle-primary').disabled = true;
      try { const response = await localFetch('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: $('toggle-primary').dataset.online !== 'true' }) }); if (!response.ok) throw Error('OUTAGE_CONTROL_FAILED'); await refresh(); }
      catch (error) { setStatus('Outage control failed (' + codeOf(error) + ').', true); }
      finally { $('toggle-primary').disabled = false; }
    };
    await refresh();
  }
  function download(format) {
    if (article.hidden) return;
    const bytes = exportText(readDocument(), format);
    const url = URL.createObjectURL(new Blob([bytes], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' })); downloads.add(url);
    const link = document.createElement('a'); link.href = url; link.download = 'textarea-document.' + format; document.body.append(link); link.click(); link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 1500);
    setStatus('Export requested. Check the saved file; exporting does not change the reserve.');
  }
  for (const format of ['txt', 'json']) $('export-' + format).onclick = () => { try { download(format); } catch (error) { setStatus('Export stopped (' + codeOf(error) + ').', true); } };
}
window.addEventListener('pagehide', () => { lifetime.abort(); setup?.cancel(); receiver?.dispose(); writingStore?.clearEnrollmentCapability(); setup = undefined; receiver = undefined; enrollmentToken = undefined; article.textContent = ''; for (const url of downloads) URL.revokeObjectURL(url); downloads.clear(); }, { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
main().catch(error => { enrollmentToken = undefined; article.hidden = true; setStatus('This editor is unavailable (' + codeOf(error) + '). Use the separate reserve to recover an existing snapshot.', true); });
