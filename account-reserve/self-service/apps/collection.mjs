import { recoverTextReserves, validateText, MAX_TEXT_BYTES } from '../../sdk/text-reserve.mjs';
import { createReserveHttpStore } from '../../sdk/http-store.mjs';
import { prismBackdrop } from '../../starter/prism-art.mjs';

const code = error => error?.code ?? error?.message;
const utc = value => new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
const loadEditor = id => import(/* @vite-ignore */ '/apps/editors/' + (id === 'textarea' ? 'textarea' : 'easymde') + '-editor.mjs');

/** One read-only recovery action. Only ordinary draft strings survive it; no
 * credential handle or cryptographic session is retained by this view. The
 * optional dependencies exercise UI lifecycle without invoking native prompts. */
export function mountTextReserveCollection({ root, env, expiresAtMs, lifetime, dependencies = {} }) {
  const document = root.ownerDocument, view = document.defaultView;
  const recover = dependencies.recover ?? recoverTextReserves;
  const makeStore = dependencies.makeStore ?? createReserveHttpStore;
  const editorModule = dependencies.loadEditor ?? loadEditor;
  const fetcher = dependencies.fetch ?? ((...args) => view.fetch(...args));
  const now = dependencies.now ?? (() => Date.now());
  const urls = dependencies.urls ?? view.URL;
  const BlobClass = dependencies.Blob ?? view.Blob;
  const drafts = new Map(), downloads = new Set(), cards = new Map();
  let disposed = false, expired = false, operation, editor, activeId, selecting = false, generation = 0;
  let editorInitialView, editorInitialSource;
  root.innerHTML = `<a class="skip-link" href="#collection-main">Skip to your reserves</a>
    <div class="page-shell prism-page apps-hub collection-hub">
      ${prismBackdrop}
      <header class="site-header"><a class="brand" href="/apps/" aria-label="ContinuityKit"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span>continuity<span class="brand-kit">kit</span></a><span class="preview-label">Two apps · One reserve passkey</span></header>
      <main id="collection-main">
        <aside class="demo-boundary"><strong>Fictional examples only.</strong> <span id="collection-expiry"></span> No funds or blockchain transactions.</aside>
        <section class="collection-intro" aria-labelledby="collection-title"><p class="eyebrow">Work continuity / Your independent reserve</p><h1 id="collection-title">All your drafts.<br><em>One way back.</em></h1><p class="lede">Open the drafts you prepared in these two apps with your existing reserve passkey. Choose a draft, keep writing and take it with you.</p></section>
        <section class="collection-unlock" aria-label="Open your prepared reserves"><div><p class="eyebrow">A single recovery action</p><h2>Find the work you kept.</h2><p>This checks both apps with the key you choose. It does not create a passkey or save anything.</p></div><div class="collection-unlock-actions"><button class="button" id="collection-open" type="button">Open my app reserves</button><button class="secondary" id="collection-cancel" type="button" hidden>Cancel opening</button><p class="context-note">Your device may show more than one confirmation.</p></div></section>
        <p id="collection-status" class="status" role="status" aria-live="polite" tabindex="-1">Choose the existing key you used to prepare these app reserves.</p>
        <div id="collection-cards" class="app-grid collection-grid" aria-label="Your app reserves"></div>
        <section id="collection-editor-panel" class="editor-panel collection-editor" aria-labelledby="collection-editor-title" hidden>
          <div class="editor-heading"><div><p class="eyebrow" id="collection-editor-app"></p><h2 id="collection-editor-title" tabindex="-1">Continue your draft.</h2><p>Changes stay in this window. Export to keep them; the stored snapshot stays unchanged.</p></div></div>
          <div id="collection-editor" class="integration-editor" aria-label="Recovered working draft"></div>
          <div class="collection-editor-state"><span id="collection-edit-state"></span><span id="collection-size"></span></div>
          <div class="collection-exports"><button class="button" id="collection-export-text" type="button">Export TXT</button><button class="secondary" id="collection-export-json" type="button">Export JSON</button></div>
        </section>
        <div class="collection-close" id="collection-close-area" hidden><p>Export any edits you want to keep before closing these copies.</p><button class="text-button" id="collection-close" type="button">Close these copies</button></div>
        <details class="collection-limits"><summary>What this reserve can open</summary><p>Only snapshots prepared for Textarea and Markdown Studio on this reserve site are checked. Both use the key you select, with separate encryption for each app. A different passkey may open different snapshots or none.</p><p>One immutable snapshot per app and passkey. The recovery site and stored copies remain under the same operator. This is a limited demonstration, not an audited backup service. Losing the reserve domain or passkey can prevent recovery.</p><p>Access expiry is not deletion of every stored or exported copy. Keep a local export of work you want to retain.</p></details>
        <nav class="app-nav" aria-label="Other reserve pages"><a href="/apps/textarea/">Textarea only</a><a href="/apps/markdown/">Markdown Studio only</a><a href="/text/">Earlier text reserve</a></nav>
      </main><footer><span>A project by Mikkel / CryptoMickle.</span><span>Two component integrations · Experimental</span></footer>
    </div>`;
  const $ = id => root.querySelector('#' + id);
  $('collection-expiry').textContent = 'Stored-reserve access ends ' + utc(expiresAtMs) + '.';

  function message(text, kind = '') {
    if (disposed) return;
    $('collection-status').className = 'status ' + kind;
    $('collection-status').textContent = text;
  }
  for (const app of env.apps) {
    const card = document.createElement('section'); card.className = 'app-card collection-card'; card.dataset.app = app.id;
    const label = document.createElement('p'); label.className = 'eyebrow'; label.textContent = app.id === 'textarea' ? '01 / Plain text' : '02 / Markdown';
    const title = document.createElement('h2'); title.textContent = app.label;
    const state = document.createElement('p'); state.className = 'collection-card-state'; state.textContent = 'Not checked yet.';
    const control = document.createElement('button'); control.type = 'button'; control.className = 'secondary'; control.textContent = 'Open draft'; control.hidden = true;
    control.addEventListener('click', () => { void choose(app.id); });
    card.append(label, title, state, control); $('collection-cards').append(card);
    cards.set(app.id, { app, card, state, control });
  }
  function updateControls() {
    if (disposed) return;
    $('collection-open').disabled = expired || Boolean(operation) || drafts.size > 0;
    $('collection-open').hidden = drafts.size > 0;
    $('collection-cancel').hidden = !operation;
    $('collection-close-area').hidden = drafts.size === 0;
    $('collection-cards').setAttribute('aria-busy', String(Boolean(operation)));
    for (const [id, card] of cards) {
      card.control.disabled = selecting;
      card.control.setAttribute('aria-pressed', String(id === activeId));
    }
  }
  function discardEditor() {
    if (editor) { editor.destroy(); editor = undefined; }
    editorInitialView = undefined; editorInitialSource = undefined;
    activeId = undefined;
    $('collection-editor').replaceChildren();
    $('collection-editor-panel').hidden = true;
    $('collection-edit-state').textContent = ''; $('collection-size').textContent = '';
  }
  function clearCopies() {
    generation++; selecting = false;
    discardEditor(); drafts.clear();
    for (const url of downloads) urls.revokeObjectURL(url);
    downloads.clear();
    for (const card of cards.values()) {
      card.control.hidden = true; card.control.textContent = 'Open draft';
      card.state.textContent = 'Not checked yet.'; card.card.removeAttribute('data-state');
    }
  }
  function stopOpening() { operation?.controller.abort(); }
  function expire() {
    if (expired || disposed) return;
    expired = true; stopOpening();
    message(drafts.size ? 'Stored-reserve access has ended. The copies already open here can still be edited and exported.' : 'This demonstration has expired. No stored reserves can be opened here.');
    updateControls();
  }
  function assertActive() {
    if (disposed || lifetime?.signal.aborted) throw Object.assign(new Error('OPERATION_CANCELLED'), { code: 'OPERATION_CANCELLED' });
    if (now() >= expiresAtMs) { expire(); throw Object.assign(new Error('DEMO_EXPIRED'), { code: 'DEMO_EXPIRED' }); }
  }
  async function open() {
    if (disposed || operation || drafts.size) return;
    try { assertActive(); } catch { return; }
    clearCopies();
    const controller = new AbortController(), cleanups = [];
    const current = { controller }; operation = current; updateControls();
    message('Choose your existing reserve passkey. Checking both apps for that key.');
    let store;
    try {
      store = makeStore({ fetcher(url, init = {}) {
        const transport = new AbortController();
        const signals = [controller.signal, init.signal].filter(Boolean);
        const abort = () => transport.abort();
        for (const signal of signals) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
        cleanups.push(() => { for (const signal of signals) signal.removeEventListener('abort', abort); });
        return fetcher(url, { ...init, signal: transport.signal });
      } });
      // No await precedes this call: discoverable WebAuthn starts in the click.
      const results = await recover({ configs: env.apps.map(app => app.config), store, signal: controller.signal });
      assertActive();
      if (controller.signal.aborted || operation !== current) {
        message('Opening stopped. No new key was created and no snapshot was changed.');
        return;
      }
      if (!Array.isArray(results) || results.length !== env.apps.length) throw new Error('RESULT_INVALID');
      const checked = results.map((result, index) => {
        if (result.appId !== env.apps[index].config.appId || !['recovered','missing','unavailable','rejected'].includes(result.status)) throw new Error('RESULT_INVALID');
        return result.status === 'recovered' ? { ...result, text: validateText(result.reserve.text) } : result;
      });
      // Commit presentation only after the complete batch passed validation.
      for (let index = 0; index < checked.length; index++) {
        const result = checked[index], app = env.apps[index], card = cards.get(app.id);
        card.card.dataset.state = result.status;
        if (result.status === 'recovered') {
          drafts.set(app.id, { text: result.text, baseline: result.text });
          card.state.textContent = 'Snapshot opened and verified.'; card.control.hidden = false;
          card.control.textContent = 'Continue in ' + app.label;
        } else if (result.status === 'missing') card.state.textContent = 'No snapshot for this app and selected key. Nothing was created.';
        else if (result.status === 'unavailable') card.state.textContent = 'Could not read this app’s reserve. Availability could not be confirmed.';
        else card.state.textContent = 'This copy failed verification and was not opened. Keep your existing key.';
      }
      const unresolved = checked.some(result => result.status === 'unavailable' || result.status === 'rejected');
      message(drafts.size === env.apps.length ? 'Both app reserves opened and verified. Choose the draft you want to continue.'
        : drafts.size ? 'One app reserve opened. The other app’s result is shown below.'
        : unresolved ? 'No drafts opened. Check the result for each app below.'
        : 'No snapshots were found for this key in either app. Choose the key used during preparation, or check the earlier text reserve.', unresolved ? 'error' : drafts.size ? 'success' : '');
      $('collection-status').focus();
    } catch (error) {
      if (!disposed && !expired) message(controller.signal.aborted || code(error) === 'OPERATION_CANCELLED' || error?.name === 'AbortError' || error?.name === 'NotAllowedError'
        ? 'Opening stopped. No new key was created and no snapshot was changed.'
        : 'The reserves could not be opened. Keep your existing key and try again when ready.', 'error');
    } finally {
      for (const cleanup of cleanups) cleanup();
      store?.clearEnrollmentCapability?.();
      if (operation === current) operation = undefined;
      updateControls();
      if (!disposed && !expired && !drafts.size && document.activeElement === $('collection-cancel')) $('collection-open').focus();
    }
  }
  function currentText() {
    const rendered = editor.getText();
    // Some editor components normalize CRLF during mounting. Merely viewing or
    // switching a verified copy must not silently change its export bytes.
    return rendered === editorInitialView ? editorInitialSource : rendered;
  }
  function changed() {
    if (disposed || !editor || !activeId) return;
    const draft = drafts.get(activeId), text = currentText(), bytes = new TextEncoder().encode(text).length;
    draft.text = text;
    $('collection-size').textContent = (bytes / 1024).toFixed(1) + ' / ' + MAX_TEXT_BYTES / 1024 + ' KB';
    $('collection-edit-state').textContent = bytes > MAX_TEXT_BYTES ? 'Too large to export. Shorten this draft first.' : text === draft.baseline ? 'Recovered snapshot' : 'Edited here · Export to keep changes';
  }
  async function choose(id) {
    if (disposed || selecting || !drafts.has(id)) return;
    const generationAtStart = generation;
    if (activeId === id) { $('collection-editor').querySelector('textarea,[contenteditable]')?.focus(); return; }
    if (editor && activeId) drafts.get(activeId).text = currentText();
    selecting = true; updateControls();
    try {
      const module = await editorModule(id);
      if (disposed || generation !== generationAtStart) return;
      discardEditor(); activeId = id;
      $('collection-editor-panel').hidden = false;
      $('collection-editor-app').textContent = cards.get(id).app.label;
      editor = module.mountEditor({ element: $('collection-editor'), initialText: drafts.get(id).text, onChange: changed });
      editorInitialSource = drafts.get(id).text; editorInitialView = editor.getText();
      changed();
      $('collection-editor-title').focus();
      $('collection-editor-panel').scrollIntoView?.({ behavior: 'auto', block: 'start' });
    } catch {
      if (!disposed && generation === generationAtStart) {
        discardEditor(); message('The editor could not open. Your verified copies remain available in this page. Try selecting the draft again.', 'error');
      }
    } finally { if (generation === generationAtStart) selecting = false; updateControls(); }
  }
  function download(format) {
    if (disposed || !editor || !activeId) return;
    try {
      const text = validateText(currentText());
      const bytes = format === 'json' ? JSON.stringify({ format: 'continuity-text-export/v1', text }, null, 2) + '\n' : text;
      const url = urls.createObjectURL(new BlobClass([bytes], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }));
      downloads.add(url);
      const link = document.createElement('a'); link.href = url; link.download = activeId + '-reserve.' + (format === 'json' ? 'json' : 'txt');
      document.body.append(link); link.click(); link.remove();
      view.setTimeout(() => { if (downloads.delete(url)) urls.revokeObjectURL(url); }, 1500);
      message('Export requested. Check your downloads. This contains your current draft; the stored snapshot is unchanged.', 'success');
    } catch { message('This draft could not be exported. Keep the page open and check its size before trying again.', 'error'); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; stopOpening(); clearCopies();
    view.clearInterval(timer);
    lifetime?.signal.removeEventListener('abort', dispose);
    view.removeEventListener('pagehide', dispose);
    // pagehide may park this page in BFCache. Keep restoration guarded even
    // after disposal; the cleared, inactive page must reload before reuse.
    $('collection-open').disabled = true;
    $('collection-cancel').hidden = true;
    $('collection-close-area').hidden = true;
  }
  function restore(event) { if (event.persisted) (dependencies.reload ?? (() => view.location.reload()))(); }
  $('collection-open').addEventListener('click', () => { void open(); });
  $('collection-cancel').addEventListener('click', stopOpening);
  $('collection-close').addEventListener('click', () => { clearCopies(); message(expired ? 'These copies are closed. Stored-reserve access has ended.' : 'These copies are closed. Your stored snapshots are unchanged.'); updateControls(); if (!expired) $('collection-open').focus(); });
  $('collection-export-text').addEventListener('click', () => download('text'));
  $('collection-export-json').addEventListener('click', () => download('json'));
  view.addEventListener('pagehide', dispose, { once: true });
  view.addEventListener('pageshow', restore);
  lifetime?.signal.addEventListener('abort', dispose, { once: true });
  const timer = view.setInterval(() => { if (now() >= expiresAtMs) expire(); }, 1000);
  if (lifetime?.signal.aborted) dispose();
  else if (now() >= expiresAtMs) expire();
  updateControls();
  return Object.freeze({ dispose });
}
