import { recoverTextReservesFromReplicas, validateText, TEXT_PROTOCOL } from '@continuitykit/account-reserve/text-reserve';
import { startTextReserveReplicaSetup, createTextReserveReplicaReceiver } from '@continuitykit/account-reserve/text-browser';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { textareaAdapter, captureText, restoreText, exportText } from './adapter.mjs';
import { validateNativeEnvironment, nativeApps, nativeAppProfile, parseNativeGrants } from './profile.mjs';
import { prismBackdrop, prismSculpture } from './prism-art.mjs';

const dataRecord = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Array.isArray(value) && Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
const exact = (value, keys) => dataRecord(value) && Object.getOwnPropertyNames(value).sort().join() === [...keys].sort().join();
const dataArray = (value, count) => Array.isArray(value) && value.length === count && Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).length === count + 1 && Array.from({length: count}, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).every(item => item && Object.hasOwn(item, 'value') && item.enumerable);
const problem = () => new Error('COLLECTION_RESULT_INVALID');
const copyLabels = { verified: 'Verified copy', missing: 'No copy found', unavailable: 'Unavailable', rejected: 'Failed verification' };

// Deliberately independent of a particular editor. All cryptographic work stays
// in the installed SDK; only ordinary, authenticated text reaches these adapters.
export function mountNativeCollection(document, window, options) {
  const env = validateNativeEnvironment(options.environment, window.location.href, { now: (options.now ?? Date.now)() });
  if (env.profile.version !== 2) throw new Error('NATIVE_COLLECTION_REQUIRED');
  const settings = { ...env.profile, originalOrigin: env.profile.primaryOrigin, role: env.role, apps: nativeApps(env.profile, { now: (options.now ?? Date.now)() }) };
  const page = new URL(window.location.href), selectors = [...page.searchParams.entries()];
  if (page.pathname !== '/' || selectors.length > 1 || selectors.some(([key, value]) => key !== 'app' || !settings.apps.some(app => app.id === value))) throw new Error('NATIVE_APP_SELECTOR_INVALID');
  const selected = settings.apps.find(app => app.id === page.searchParams.get('app'));
  const supported = window.isSecureContext === true && typeof window.PublicKeyCredential === 'function'
    && typeof window.navigator?.credentials?.get === 'function' && typeof window.navigator?.credentials?.create === 'function'
    && typeof window.crypto?.getRandomValues === 'function' && typeof window.crypto?.subtle?.digest === 'function';
  const root = document.getElementById('collection-root');
  if (!root) throw new Error('VIEW_MISSING');
  const now = options.now ?? (() => Date.now());
  const life = new AbortController(), timers = new Set(), downloads = new Set(), cards = new Map();
  const baseFetch = options.fetcher ?? window.fetch.bind(window);
  const fetcher = (path, init = {}) => baseFetch(path, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: init.signal ? AbortSignal.any([life.signal, init.signal]) : life.signal });
  const recover = options.recover ?? recoverTextReservesFromReplicas;
  const makeStore = options.makeStore ?? createReserveHttpStore;
  const startSetup = options.startSetup ?? startTextReserveReplicaSetup;
  const makeReceiver = options.makeReceiver ?? createTextReserveReplicaReceiver;
  const expiresAt = Date.parse(settings.expiresAt);
  let disposed = false, expired = false, operation, receiver, setup, preparationAttempted = false;
  let hasResult = false, writeStores = [], grants, permissionDeadline;
  const primary = settings.role === 'primary';
  root.innerHTML = `<a class="skip" href="#main">Skip to your drafts</a><div class="page-shell">${prismBackdrop}
    <header><a class="brand" href="/" aria-label="ContinuityKit"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span>continuity<span>kit</span></a><span class="mode">Native passkeys <span aria-hidden="true">·</span> Text reserves</span></header>
    <main id="main"><section class="hero"><div><p class="eyebrow" id="place">YOUR APPS / A SEPARATE RESERVE</p><h1>Different apps.<br><span>One way back.</span></h1><p class="lead" id="lead">Open the drafts you prepared with the same reserve key. Each app is checked against its configured encrypted copies.</p><p class="hero-note">Keep writing. Take your work with you.</p></div><div class="sculpture-wrap">${prismSculpture}<span class="art-caption">A little continuity, by design.</span></div></section>
    <section class="unlock" id="unlock" aria-labelledby="unlock-heading"><div><p class="eyebrow">B / YOUR PREPARED COLLECTION</p><h2 id="unlock-heading">Find the work you kept.</h2><p>One deliberate check for your prepared apps. Each result is shown separately.</p></div><div class="unlock-actions"><button id="recover" type="button">Open my app reserves <span aria-hidden="true">↗</span></button><button id="cancel" class="secondary" type="button" hidden>Cancel opening</button><button id="clear" class="secondary" type="button" hidden>Close these copies</button><p>Choose the same existing reserve passkey used during setup. Your device may ask for more than one confirmation.</p></div></section>
    <section id="enrollment" class="enrollment" hidden><p class="eyebrow">PREPARE THIS APP</p><h2 id="enrollment-title"></h2><p>Keep A open until every configured copy is saved and independently checked.</p><label for="upload-permission">One-time upload permission</label><textarea id="upload-permission" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="permission-status"></textarea><div class="actions"><button id="check-permission" type="button">Check upload permission</button></div><p id="permission-status" class="hint">Provided privately by the operator for this app. Opening an existing reserve needs no upload permission.</p><div class="actions" id="passkey-options" hidden><button id="receive-existing" type="button">Use my existing reserve passkey</button><button id="receive-create" class="secondary" type="button">Create my first reserve passkey</button></div><p class="hint">Use the same reserve passkey for each app. Only create a key if this is your first reserve here. A failed selection never creates a replacement.</p><button id="cancel-setup" class="quiet" type="button">Close setup</button></section>
    <p id="status" role="status" aria-live="polite">No drafts have been opened.</p>
    <button id="cancel-primary" class="secondary" type="button" hidden>Cancel setup and keep my draft</button>
    <div id="apps" class="app-grid" aria-label="Your app reserves"></div>
    <p id="edit-note" class="edit-note" hidden>These are local working copies. Export any edits before closing; the encrypted snapshots stay unchanged.</p>
    <aside class="reserve-address"><p>Keep this recovery address.</p><a id="reserve-link"></a><p id="expiry-note"></p></aside>
    <footer><div><strong>Prepared in advance.</strong><p>Each app has its own immutable encrypted snapshot. Reopening checks the available copies; it does not save edits, choose a newer version, or repair storage.</p></div><div><strong>Your setup matters.</strong><p>This reference runs separate stores under one operator. It does not establish independent providers or production security. Your passkey provider and this recovery site must remain available.</p></div></footer></main></div>`;
  const $ = id => document.getElementById(id);
  const message = (text, error = false) => { $('status').textContent = text; $('status').dataset.error = String(error); };
  const schedule = (fn, delay) => { const id = window.setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; };
  const opened = () => [...cards.values()].some(card => card.open);
  const active = op => !disposed && !expired && operation === op && !op.controller.signal.aborted && now() < expiresAt;
  const assertCurrent = op => { if (now() >= expiresAt) expire(); return active(op); };
  for (const [index, app] of settings.apps.entries()) {
    const section = document.createElement('section'); section.id = 'card-' + app.id; section.className = 'app-card'; section.dataset.appId = app.config.appId;
    // Only this trusted fixed template is HTML. App labels, diagnostics and all
    // recovered or edited content are assigned as text, never interpreted HTML.
    section.innerHTML = `<div class="card-heading"><span class="app-icon" aria-hidden="true"></span><div><p class="eyebrow"></p><h2></h2></div><span class="card-number"></span></div><p class="app-state" role="status"></p><label class="draft-label"></label><textarea rows="8" spellcheck="false" disabled hidden></textarea><div class="actions"><button class="prepare" type="button" hidden>Prepare in B ↗</button><button class="export-text secondary" type="button" hidden>Export TXT</button><button class="export-json quiet" type="button" hidden>Export JSON</button></div><div class="copy-evidence"><p class="copy-title">Encrypted copies <span>At the last check</span></p><div class="copy-pair"></div></div>`;
    section.querySelector('.app-icon').textContent = String(index + 1).padStart(2, '0');
    section.querySelector('.eyebrow').textContent = 'APP RESERVE / PLAIN TEXT';
    section.querySelector('h2').textContent = app.label; section.querySelector('.card-number').textContent = '0' + (index + 1);
    const state = section.querySelector('.app-state'); state.id = 'state-' + app.id; state.textContent = 'Not checked yet.';
    const area = section.querySelector('textarea'); area.id = 'draft-' + app.id;
    const label = section.querySelector('label'); label.htmlFor = area.id; label.textContent = 'Working draft'; label.hidden = true;
    const prepare = section.querySelector('.prepare'); prepare.id = 'prepare-' + app.id;
    const exports = ['txt', 'json'].map((format, i) => { const button = section.querySelector(i ? '.export-json' : '.export-text'); button.id = 'export-' + app.id + '-' + format; button.addEventListener('click', () => download(app.id, format)); return button; });
    const copies = new Map();
    for (const replica of settings.replicas) {
      const group = document.createElement('div'), name = document.createElement('span'), value = document.createElement('span');
      name.className = 'copy-name'; name.textContent = replica.id; value.className = 'copy-state'; value.id = 'copy-' + app.id + '-' + replica.id; value.textContent = 'Not checked';
      group.append(name, value); section.querySelector('.copy-pair').append(group); copies.set(replica.id, value);
    }
    cards.set(app.id, { app, section, state, area, label, prepare, exports, copies, adapter: textareaAdapter(area), open: false, attempted: false });
    prepare.addEventListener('click', () => prepareApp(app.id)); $('apps').append(section);
  }
  function clearDownloads() { for (const url of downloads) window.URL.revokeObjectURL(url); downloads.clear(); }
  function clearCopies() {
    clearDownloads(); hasResult = false;
    for (const card of cards.values()) { card.adapter.clear(); card.open = false; card.state.textContent = 'Not checked yet.'; delete card.section.dataset.state;
      for (const value of card.copies.values()) { value.textContent = 'Not checked'; delete value.dataset.state; } }
  }
  function clearCapabilities() { grants = undefined; permissionDeadline = undefined; $('upload-permission').value = ''; for (const entry of writeStores) entry.store.clearEnrollmentCapability(); writeStores = []; }
  function controls() {
    const busy = Boolean(operation), locked = disposed || expired || !supported;
    $('recover').hidden = primary || Boolean(receiver?.isEnrollment) || opened(); $('recover').disabled = busy || locked;
    $('cancel').hidden = operation?.kind !== 'recover'; $('clear').hidden = primary || !hasResult; $('clear').disabled = busy || disposed;
    $('cancel-primary').hidden = !primary || operation?.kind !== 'setup'; $('cancel-primary').disabled = disposed;
    $('apps').setAttribute('aria-busy', String(busy)); $('edit-note').hidden = !opened() || primary;
    for (const card of cards.values()) {
      card.area.hidden = !card.open; card.label.hidden = !card.open; card.area.disabled = !card.open || busy || disposed;
      card.prepare.hidden = !primary; card.prepare.disabled = locked || busy || card.attempted;
      for (const button of card.exports) { button.hidden = !card.open; button.disabled = disposed || busy; }
    }
    for (const id of ['receive-create', 'receive-existing']) $(id).disabled = busy || locked || preparationAttempted || !permissionOpen();
    $('passkey-options').hidden = !grants || preparationAttempted;
    $('upload-permission').disabled = busy || locked || preparationAttempted;
    $('check-permission').disabled = busy || locked || preparationAttempted;
  }
  function permissionOpen() { return grants && grants.replicas.every(value => Date.parse(value.expiresAt) > now()); }
  function checkPermission() {
    checkExpiry(); if (disposed || expired || !supported || operation || preparationAttempted || !receiver?.isEnrollment || !selected) return;
    let input = $('upload-permission').value; clearCapabilities();
    try {
      grants = parseNativeGrants(input, nativeAppProfile(env.profile, selected.id, { now: now() }), { now: now() });
      $('permission-status').textContent = 'App, copies and expiry checked. The operator will validate upload permission when the snapshot is sent.';
      message('No passkey request has started. Use your existing reserve key for this app, or create the first key only.');
      schedule(checkExpiry, Math.max(1, Math.min(...grants.replicas.map(value => Date.parse(value.expiresAt))) - now() + 1));
    } catch { $('permission-status').textContent = 'Permission was not accepted for this app. Check the operator-supplied text and expiry.'; message('No passkey request started. Upload permission must match this selected app.', true); }
    finally { input = undefined; controls(); }
  }

  function stopOperation() { const previous = operation; operation = undefined; previous?.controller.abort(); setup?.cancel(); setup = undefined; }
  function closeCopies() { if (primary || operation || disposed) return; clearCopies(); message('These working copies are closed. The encrypted snapshots remain available.'); controls(); }
  function expire() {
    if (expired || disposed) return; expired = true; stopOperation(); receiver?.dispose(); receiver = undefined; clearCapabilities(); $('enrollment').hidden = true;
    message(opened() ? 'This access window has ended. Your open drafts can still be edited and exported. No new recovery or preparation is available.' : 'This access window has ended. No new recovery or preparation is available.', true); controls();
  }
  function checkExpiry() {
    if (disposed) return;
    if (now() >= expiresAt) { expire(); return; }
    if (permissionDeadline && now() >= permissionDeadline) {
      stopOperation(); receiver?.dispose(); receiver = undefined; clearCapabilities(); $('enrollment').hidden = true;
      message('Upload permission expired before setup finished. Check the existing reserves; no new request will start automatically.', true);
    } else if (grants && !permissionOpen()) {
      clearCapabilities(); $('permission-status').textContent = 'Upload permission expired. No passkey request started. Check fresh permission if this setup is still open.';
    }
    controls();
  }
  function begin(kind) { checkExpiry(); if (disposed || expired || !supported || operation) return; const op = { kind, controller: new AbortController() }; operation = op; controls(); return op; }
  function diagnostics(values) {
    if (!dataArray(values, settings.replicas.length)) throw problem();
    return values.map((value, index) => { if (!dataRecord(value) || !exact(value, value.status === 'verified' ? ['id','stage','status'] : ['id','stage','status','code']) || value.id !== settings.replicas[index].id || value.stage !== 'verify' || !Object.hasOwn(copyLabels, value.status)
      || value.status !== 'verified' && (typeof value.code !== 'string' || !/^[A-Z_]{1,64}$/.test(value.code))) throw problem(); return { id: value.id, status: value.status }; });
  }
  function checkedCollection(results) {
    if (!dataArray(results, settings.apps.length)) throw problem();
    return results.map((result, index) => {
      const app = settings.apps[index]; if (!dataRecord(result) || !exact(result, result.status === 'recovered' ? ['appId','status','reserve','replicas'] : ['appId','status','code','replicas']) || result.appId !== app.config.appId) throw problem();
      const copies = diagnostics(result.replicas), verified = copies.filter(value => value.status === 'verified').length;
      if (result.status === 'recovered') { if (!verified || !exact(result.reserve, ['protocol','locator','textDigest','text']) || result.reserve.protocol !== TEXT_PROTOCOL || typeof result.reserve.locator !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(result.reserve.locator) || typeof result.reserve.textDigest !== 'string' || !/^[0-9a-f]{64}$/.test(result.reserve.textDigest)) throw problem(); return { app, status: result.status, text: validateText(result.reserve.text), copies }; }
      if (result.reserve !== undefined || !['missing','unavailable','rejected'].includes(result.status)) throw problem();
      if (result.status === 'missing' && (result.code !== 'RESERVE_MISSING' || !copies.every(value => value.status === 'missing'))) throw problem();
      if (result.status === 'unavailable' && (result.code !== 'REPLICA_RECOVERY_FAILED' || verified || !copies.some(value => value.status === 'unavailable') || copies.some(value => value.status === 'rejected'))) throw problem();
      if (result.status === 'rejected' && (result.code === 'REPLICA_CONFLICT' ? verified < 2 : result.code !== 'REPLICA_RECOVERY_FAILED' || verified || !copies.some(value => value.status === 'rejected'))) throw problem();
      return { app, status: result.status, conflict: result.code === 'REPLICA_CONFLICT', copies };
    });
  }
  function renderResults(results) {
    for (const result of results) {
      const card = cards.get(result.app.id); card.section.dataset.state = result.status;
      for (const copy of result.copies) { const value = card.copies.get(copy.id); value.textContent = copyLabels[copy.status]; value.dataset.state = copy.status; }
      if (result.status === 'recovered') { restoreText(result.text, card.adapter); card.open = true; card.state.textContent = result.copies.every(value => value.status === 'verified') ? 'Open · all configured copies verified at this check.' : 'Open · a surviving copy passed verification. Redundancy is reduced.'; }
      else card.state.textContent = result.conflict ? 'Copies disagree. This app stays closed; keep the conflicting copies.' : result.status === 'missing' ? 'No snapshot for this app and selected key.' : result.status === 'unavailable' ? 'No usable copy was available. This app stays closed.' : 'No trustworthy copy could be opened. This app stays closed.';
    }
    hasResult = true;
  }
  async function openCollection() {
    if (primary || opened() || receiver?.isEnrollment) return;
    const op = begin('recover'); if (!op) return; clearCopies(); controls(); message('Choose the existing reserve passkey for this site. Checking each app’s encrypted copies…');
    let results, checked;
    try {
      // Stay in this deliberate click. The SDK uses its native WebAuthn client;
      // no preliminary network request, credential probe or replacement key.
      const replicas = settings.replicas.map(replica => ({ id: replica.id, store: makeStore({ fetcher, basePath: replica.basePath }) }));
      results = await recover({ apps: settings.apps.map(app => ({ config: app.config, replicas })), signal: op.controller.signal });
      if (!assertCurrent(op)) return;
      checked = checkedCollection(results); // Validate the whole batch before opening any draft.
      renderResults(checked); const count = checked.filter(value => value.status === 'recovered').length;
      message(count === settings.apps.length ? 'All prepared drafts are open. Edit locally and export what you want to keep.' : count ? count + ' of ' + settings.apps.length + ' drafts are open. Each app’s result is shown separately.' : 'No drafts were opened. Keep the existing key and check the individual results.', !count);
    } catch { if (assertCurrent(op)) { clearCopies(); message('The collection could not be opened. No unverified text is shown. Keep the existing key; retry only when you choose.', true); } }
    finally { results = undefined; checked = undefined; if (operation === op) operation = undefined; controls(); }
  }
  function download(id, format) {
    checkExpiry(); const card = cards.get(id); if (!card?.open || operation || disposed) return;
    try {
      const blob = new window.Blob([exportText(card.adapter, format)], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json' });
      const url = window.URL.createObjectURL(blob); downloads.add(url);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'continuity-' + id + '.' + format; anchor.click();
      schedule(() => { if (downloads.delete(url)) window.URL.revokeObjectURL(url); }, 1000);
      message('Export requested for ' + card.app.label + '. Check your downloads; its stored snapshot is unchanged.');
    } catch { message('Export did not start. Keep this draft open and check its text size.', true); }
  }
  function prepareApp(id) {
    const card = cards.get(id); if (!primary || !card || card.attempted) return;
    const op = begin('setup'); if (!op) return;
    try {
      setup = startSetup({ config: card.app.config, originalOrigin: settings.originalOrigin, recoveryUrl: settings.recoveryOrigin + '/?app=' + encodeURIComponent(id), replicaIds: settings.replicas.map(value => value.id), text: captureText(card.adapter), signal: op.controller.signal, window });
      card.attempted = true; controls(); message('Finish preparing ' + card.app.label + ' in B. Keep this original tab open.');
      void setup.completion.then(result => { if (assertCurrent(op)) { if (result?.status !== 'ready' || result.independentlyVerified !== true || diagnostics(result.replicas).some(value => value.status !== 'verified')) { message('Preparation could not be confirmed. Check the existing reserve before another attempt.', true); return; } card.state.textContent = 'Prepared in B · all configured copies independently checked.'; message('This app is prepared. Use the same existing reserve key for the next app, then open the collection.'); } }).catch(() => { if (assertCurrent(op)) message('Setup stopped. Check the existing reserve before starting another setup. The draft remains here.', true); }).finally(() => { if (operation === op) { operation = undefined; setup = undefined; } controls(); });
    } catch { if (operation === op) operation = undefined; message('The reserve tab could not open. Allow the configured B tab before trying again.', true); controls(); }
  }
  async function receive(credentialMode) {
    if (!receiver?.isEnrollment || preparationAttempted || !selected) return;
    checkExpiry();
    if (!permissionOpen()) { clearCapabilities(); $('permission-status').textContent = 'Check fresh upload permission before choosing a passkey action.'; controls(); return; }
    const op = begin('prepare'); if (!op) return;
    const localReceiver = receiver; let ready;
    try {
      // Validate again at the gesture boundary. No await before native prepare.
      grants = parseNativeGrants(JSON.stringify(grants), nativeAppProfile(env.profile, selected.id, { now: now() }), { now: now() });
      permissionDeadline = Math.min(...grants.replicas.map(value => Date.parse(value.expiresAt)));
      for (const [index, value] of grants.replicas.entries()) writeStores.push({ id: value.id, store: makeStore({ fetcher, basePath: settings.replicas[index].basePath, enrollmentToken: value.enrollmentToken }) });
      if (now() >= permissionDeadline || now() >= expiresAt) throw problem();
      grants = undefined; $('upload-permission').value = ''; preparationAttempted = true; controls();
      message('Complete the passkey request for ' + selected.label + '. Keep A open until every configured copy is checked.');
      schedule(checkExpiry, Math.max(1, permissionDeadline - now() + 1));
      ready = await localReceiver.prepare({ replicas: writeStores, credentialMode, signal: op.controller.signal,
        ...(credentialMode === 'create' ? { user: { name: 'ContinuityKit app reserves', displayName: 'ContinuityKit recovery' } } : {}) });
      if (!assertCurrent(op) || now() >= permissionDeadline) return;
      if (ready?.status !== 'ready' || ready.independentlyVerified !== true || diagnostics(ready.replicas).some(value => value.status !== 'verified')) throw problem();
      validateText(ready.text); message(selected.label + ' is prepared. Return to A to prepare another app with the same key, or open the collection here.');
    } catch { if (assertCurrent(op)) message('Preparation stopped. No replacement key will be created. Check the existing collection before preparing again.', true); }
    finally {
      ready = undefined; localReceiver.dispose();
      // A cancelled setup must not clear a newer deliberate recovery operation.
      if (operation === op) { clearCapabilities(); receiver = undefined; $('enrollment').hidden = true; operation = undefined; controls(); }
    }
  }
  function dispose() {
    if (disposed) return; disposed = true; stopOperation(); life.abort(); receiver?.dispose(); receiver = undefined; clearCapabilities(); clearCopies();
    for (const timer of timers) window.clearTimeout(timer); timers.clear(); $('enrollment').hidden = true;
    window.removeEventListener('pagehide', dispose); window.removeEventListener('focus', checkExpiry); window.removeEventListener('pageshow', pageShow); document.removeEventListener('visibilitychange', checkExpiry);
    message('This view is closed. Open a fresh recovery tab to continue.'); controls();
  }
  function pageShow(event) { if (event.persisted) dispose(); else checkExpiry(); }
  $('recover').addEventListener('click', () => void openCollection()); $('clear').addEventListener('click', closeCopies);
  $('cancel').addEventListener('click', () => { if (operation?.kind !== 'recover') return; stopOperation(); clearCopies(); message('Opening cancelled. No drafts are retained. Nothing will retry automatically.'); controls(); });
  $('receive-existing').addEventListener('click', () => void receive('existing')); $('receive-create').addEventListener('click', () => void receive('create'));
  $('cancel-setup').addEventListener('click', () => { stopOperation(); receiver?.dispose(); receiver = undefined; clearCapabilities(); $('enrollment').hidden = true; message('Setup closed. Check the existing collection; this page will not restart preparation.'); controls(); });
  $('cancel-primary').addEventListener('click', () => { if (!primary || operation?.kind !== 'setup') return; stopOperation(); message('Setup cancelled. Your draft remains here. Check the existing reserve in B before another preparation attempt.'); controls(); });
  $('check-permission').addEventListener('click', checkPermission);
  $('upload-permission').addEventListener('input', () => { if (operation || disposed) return; grants = undefined; permissionDeadline = undefined; controls(); });
  window.addEventListener('pagehide', dispose); window.addEventListener('focus', checkExpiry); window.addEventListener('pageshow', pageShow); document.addEventListener('visibilitychange', checkExpiry);
  $('reserve-link').href = settings.recoveryOrigin + '/'; $('reserve-link').textContent = settings.recoveryOrigin + '/';
  $('expiry-note').textContent = 'Access window ends ' + new Date(expiresAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC. Export the work you want to keep.';
  if (primary) {
    $('unlock').hidden = true; $('place').textContent = 'A / YOUR EDITOR INTEGRATIONS';
    $('lead').textContent = 'Give your apps a shared recovery path. Prepare each snapshot in B with the same reserve passkey, then reopen the collection independently.';
    for (const card of cards.values()) { card.open = true; restoreText('A draft worth keeping.\n\nWrite an example for ' + card.app.label + ', then prepare its encrypted reserve.', card.adapter); card.state.textContent = 'Fictional draft · not yet prepared in B.'; }
    message('Prepare the first app with your reserve passkey. For every other app, choose that same existing key.');
  } else {
    if (selected) { receiver = makeReceiver({ config: selected.config, originalOrigin: settings.originalOrigin, replicaIds: settings.replicas.map(value => value.id), window, onState(value) {
        if (value.state === 'failed' && !disposed && !expired && !operation) { receiver?.dispose(); receiver = undefined; clearCapabilities(); $('enrollment').hidden = true; message('This setup window closed. Check the existing collection before starting another setup.', true); controls(); }
      } });
      if (receiver.isEnrollment) { $('enrollment').hidden = false; $('enrollment-title').textContent = selected.label + ' · ' + settings.replicas.length + ' encrypted copies'; message('Check this app’s upload permission, then choose a passkey action. Keep A open.'); } else { receiver.dispose(); receiver = undefined; } }
  }
  if (!supported) message('This browser needs a secure connection, Web Crypto and passkey support. Use a supported HTTPS browser.', true);
  checkExpiry();
  const accessTimer = () => { checkExpiry(); if (!expired && !disposed) schedule(accessTimer, Math.min(2147483647, Math.max(1, expiresAt - now() + 1))); };
  if (!expired) schedule(accessTimer, Math.min(2147483647, Math.max(1, expiresAt - now() + 1)));
  controls(); return Object.freeze({ dispose, ready: Promise.resolve() });
}

// A Node consumer can import mountNativeCollection without executing browser work.
if (typeof document !== 'undefined' && document.getElementById('collection-root')) {
  const controller = new AbortController(); const stop = () => controller.abort(); window.addEventListener('pagehide', stop, { once: true });
  try { const response = await fetch('/continuity-config.json', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) }); if (!response.ok) throw problem(); const text = await response.text(); if (text.length > 16384 || new TextEncoder().encode(text).length > 16384) throw problem(); const environment = JSON.parse(text); if (!controller.signal.aborted) mountNativeCollection(document, window, { environment }); }
  catch { if (!controller.signal.aborted) document.getElementById('collection-root').textContent = 'This app reserve could not load its configured profile. No passkey request started. Ask the operator to check the deployment.'; }
}
