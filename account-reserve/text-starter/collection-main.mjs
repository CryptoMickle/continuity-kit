import { recoverTextReservesFromReplicas, validateText, TEXT_PROTOCOL } from '@continuitykit/account-reserve/text-reserve';
import { startTextReserveReplicaSetup, createTextReserveReplicaReceiver } from '@continuitykit/account-reserve/text-browser';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { textareaAdapter, captureText, restoreText, exportText } from './adapter.mjs';
import { syntheticClient } from './synthetic-client.mjs';
import { validateCollectionEnvironment } from './collection-config.mjs';
import { prismBackdrop, prismSculpture } from '../starter/prism-art.mjs';

const dataRecord = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
const exact = (value, keys) => dataRecord(value) && Object.getOwnPropertyNames(value).sort().join() === [...keys].sort().join();
const problem = () => new Error('COLLECTION_RESULT_INVALID');
const copyLabels = { verified: 'Verified copy', missing: 'No copy found', unavailable: 'Unavailable', rejected: 'Failed verification' };

// Deliberately independent of a particular editor. All cryptographic work stays
// in the installed SDK; only ordinary, authenticated text reaches these adapters.
export function mountCollection(document, window, options) {
  const env = validateCollectionEnvironment(options.environment, window.location.href, { now: (options.now ?? Date.now)() });
  const settings = env ?? options.environment;
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
  const client = options.webAuthnClient ?? syntheticClient(fetcher);
  const expiresAt = Date.parse(settings.expiresAt);
  let disposed = false, expired = false, operation, receiver, setup, preparationAttempted = false;
  let processStates = [], primaryOnline, hasResult = false, writeStores = [], statusGeneration = 0;
  const primary = settings.role === 'primary';
  root.innerHTML = `<a class="skip" href="#main">Skip to your drafts</a><div class="page-shell">${prismBackdrop}
    <header><a class="brand" href="/" aria-label="ContinuityKit"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span>continuity<span>kit</span></a><span class="mode">Local simulation <span aria-hidden="true">·</span> No physical passkey</span></header>
    <main id="main"><section class="hero"><div><p class="eyebrow" id="place">YOUR APPS / A SEPARATE RESERVE</p><h1>Different apps.<br><span>One way back.</span></h1><p class="lead" id="lead">Open the drafts you prepared with the same reserve key. Each app is checked against two encrypted copies.</p><p class="hero-note">Keep writing. Take your work with you.</p></div><div class="sculpture-wrap">${prismSculpture}<span class="art-caption">A little continuity, by design.</span></div></section>
    <section class="unlock" id="unlock" aria-labelledby="unlock-heading"><div><p class="eyebrow">B / YOUR PREPARED COLLECTION</p><h2 id="unlock-heading">Find the work you kept.</h2><p>One deliberate check for both apps. Nothing is written or repaired.</p></div><div class="unlock-actions"><button id="recover" type="button">Open my app reserves <span aria-hidden="true">↗</span></button><button id="cancel" class="secondary" type="button" hidden>Cancel opening</button><button id="clear" class="secondary" type="button" hidden>Close these copies</button><p>Uses this run’s existing simulated key.</p></div></section>
    <section id="enrollment" class="enrollment" hidden><p class="eyebrow">PREPARE THIS APP</p><h2 id="enrollment-title"></h2><p>Keep A open while this snapshot is saved in both stores and independently checked.</p><div class="actions"><button id="receive-existing" type="button">Prepare with the existing simulated key</button><button id="receive-create" class="secondary" type="button">Create the first simulation key</button><button id="cancel-setup" class="quiet" type="button">Close setup</button></div><p class="hint">Prepare the first app with a new simulation key, then reuse it for the second app. No device authentication is used in this local reference.</p></section>
    <p id="status" role="status" aria-live="polite">No drafts have been opened.</p>
    <div id="apps" class="app-grid" aria-label="Your app reserves"></div>
    <p id="edit-note" class="edit-note" hidden>These are local working copies. Export any edits before closing; the encrypted snapshots stay unchanged.</p>
    <details id="tools" class="tools"><summary><span>Try a failure</span><span class="summary-note">Disposable local processes only</span></summary><div class="tools-content"><p>Close the drafts first. Stop A or a storage process, then reopen the collection for a fresh check. No automatic repair or retry.</p><div class="original-control"><div><strong>Original apps / A</strong><p id="availability">Checking process status…</p></div><button id="offline" class="secondary" type="button" disabled>Make A unavailable</button><a id="fresh" href="/" target="_blank" rel="noopener">Fresh recovery tab ↗</a></div><div class="store-grid" id="store-controls"></div><button id="refresh-status" class="quiet" type="button">Refresh process status</button><p id="control-hint" class="hint">A running process is not proof that a copy can be opened.</p></div></details>
    <footer><div><strong>Built for inspection.</strong><p>Two apps, two separate local storage processes and real SDK encryption. All are on one computer; this does not establish independent providers or production security.</p></div><div><strong>Simulation only.</strong><p>The credential is simulated. Never deploy this server or use real private work. This disposable run is removed when its server stops. <span id="expiry-note"></span></p></div></footer></main></div>`;
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
    section.querySelector('.app-icon').textContent = app.id === 'markdown' ? 'M↓' : 'T';
    section.querySelector('.eyebrow').textContent = app.id === 'markdown' ? 'MARKDOWN / PLAIN SOURCE' : 'PLAIN TEXT / YOUR EDITOR';
    section.querySelector('h2').textContent = app.label; section.querySelector('.card-number').textContent = '0' + (index + 1);
    const state = section.querySelector('.app-state'); state.id = 'state-' + app.id; state.textContent = 'Not checked yet.';
    const area = section.querySelector('textarea'); area.id = 'draft-' + app.id;
    const label = section.querySelector('label'); label.htmlFor = area.id; label.textContent = 'Working draft'; label.hidden = true;
    const prepare = section.querySelector('.prepare'); prepare.id = 'prepare-' + app.id;
    const exports = ['txt', 'json'].map((format, i) => { const button = section.querySelector(i ? '.export-json' : '.export-text'); button.id = 'export-' + app.id + '-' + format; button.addEventListener('click', () => download(app.id, format)); return button; });
    const copies = new Map();
    for (const replica of settings.replicas) {
      const group = document.createElement('div'), name = document.createElement('span'), value = document.createElement('span');
      name.className = 'copy-name'; name.textContent = replica.id === 'alpha' ? 'Alpha' : 'Beta'; value.className = 'copy-state'; value.id = 'copy-' + app.id + '-' + replica.id; value.textContent = 'Not checked';
      group.append(name, value); section.querySelector('.copy-pair').append(group); copies.set(replica.id, value);
    }
    cards.set(app.id, { app, section, state, area, label, prepare, exports, copies, adapter: textareaAdapter(area), open: false, attempted: false });
    prepare.addEventListener('click', () => prepareApp(app.id)); $('apps').append(section);
  }
  for (const replica of settings.replicas) {
    const section = document.createElement('section'); section.className = 'store-control';
    section.innerHTML = `<strong></strong><p class="process-status"></p><div class="actions"><button class="toggle secondary" type="button" disabled></button></div><label></label><select></select><button class="corrupt quiet" type="button" disabled>Alter this stopped copy</button>`;
    section.querySelector('strong').textContent = replica.id === 'alpha' ? 'Storage Alpha' : 'Storage Beta';
    section.querySelector('.process-status').id = 'process-' + replica.id;
    const toggle = section.querySelector('.toggle'); toggle.id = 'toggle-' + replica.id; toggle.textContent = 'Stop ' + replica.id;
    const select = section.querySelector('select'); select.id = 'corrupt-app-' + replica.id;
    const label = section.querySelector('label'); label.htmlFor = select.id; label.textContent = 'Choose the app copy to alter';
    for (const app of settings.apps) { const option = document.createElement('option'); option.value = app.config.appId; option.textContent = app.label; select.append(option); }
    const corrupt = section.querySelector('.corrupt'); corrupt.id = 'corrupt-' + replica.id;
    toggle.addEventListener('click', () => changeStore(replica.id, 'toggle')); corrupt.addEventListener('click', () => changeStore(replica.id, 'corrupt')); select.addEventListener('change', controls);
    $('store-controls').append(section);
  }

  function clearDownloads() { for (const url of downloads) window.URL.revokeObjectURL(url); downloads.clear(); }
  function clearCopies() {
    clearDownloads(); hasResult = false;
    for (const card of cards.values()) { card.adapter.clear(); card.open = false; card.state.textContent = 'Not checked yet.'; delete card.section.dataset.state;
      for (const value of card.copies.values()) { value.textContent = 'Not checked'; delete value.dataset.state; } }
  }
  function clearCapabilities() { for (const entry of writeStores) entry.store.clearEnrollmentCapability(); writeStores = []; }
  function controls() {
    const busy = Boolean(operation), locked = disposed || expired;
    $('recover').hidden = primary || Boolean(receiver?.isEnrollment) || opened(); $('recover').disabled = busy || locked;
    $('cancel').hidden = operation?.kind !== 'recover'; $('clear').hidden = primary || !hasResult; $('clear').disabled = busy || locked;
    $('apps').setAttribute('aria-busy', String(busy)); $('edit-note').hidden = !opened() || primary;
    for (const card of cards.values()) {
      card.area.hidden = !card.open; card.label.hidden = !card.open; card.area.disabled = !card.open || busy || locked;
      card.prepare.hidden = !primary; card.prepare.disabled = locked || busy || card.attempted;
      for (const button of card.exports) { button.hidden = !card.open; button.disabled = locked || busy; }
    }
    for (const id of ['receive-create', 'receive-existing']) $(id).disabled = busy || locked || preparationAttempted;
    const controlLocked = primary || busy || locked || opened() || Boolean(receiver?.isEnrollment);
    $('offline').disabled = controlLocked || typeof primaryOnline !== 'boolean'; $('refresh-status').disabled = controlLocked;
    for (const replica of settings.replicas) {
      const state = processStates.find(item => item.id === replica.id), selected = $('corrupt-app-' + replica.id).value;
      $('toggle-' + replica.id).disabled = controlLocked || !state;
      $('corrupt-app-' + replica.id).disabled = controlLocked || !state || state.running;
      $('corrupt-' + replica.id).disabled = controlLocked || !state || state.running || state.corruptedApps.includes(selected);
    }
    $('control-hint').textContent = opened() ? 'Export your edits and close these copies before changing the local stores.' : 'A running process is not proof that a copy can be opened.';
  }
  function stopOperation() { const previous = operation; operation = undefined; previous?.controller.abort(); setup?.cancel(); setup = undefined; }
  function closeCopies() { if (primary || operation || disposed || expired) return; clearCopies(); message('These working copies are closed. The encrypted snapshots remain available.'); controls(); }
  function expire() { if (expired || disposed) return; expired = true; stopOperation(); receiver?.dispose(); receiver = undefined; clearCapabilities(); clearCopies(); $('enrollment').hidden = true; message('This local session has expired. Drafts and export links have been cleared. No recovery will start automatically.', true); controls(); }
  function checkExpiry() { if (now() >= expiresAt) expire(); }
  function begin(kind) { checkExpiry(); if (disposed || expired || operation) return; const op = { kind, controller: new AbortController() }; operation = op; controls(); return op; }
  function diagnostics(values) {
    if (!Array.isArray(values) || values.length !== settings.replicas.length) throw problem();
    return values.map((value, index) => { if (!dataRecord(value) || !exact(value, value.status === 'verified' ? ['id','stage','status'] : ['id','stage','status','code']) || value.id !== settings.replicas[index].id || value.stage !== 'verify' || !Object.hasOwn(copyLabels, value.status)
      || value.status !== 'verified' && (typeof value.code !== 'string' || !/^[A-Z_]{1,64}$/.test(value.code))) throw problem(); return { id: value.id, status: value.status }; });
  }
  function checkedCollection(results) {
    if (!Array.isArray(results) || results.length !== settings.apps.length) throw problem();
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
      if (result.status === 'recovered') { restoreText(result.text, card.adapter); card.open = true; card.state.textContent = result.copies.every(value => value.status === 'verified') ? 'Open · both copies verified at this check.' : 'Open · a surviving copy passed verification. Redundancy is reduced.'; }
      else card.state.textContent = result.conflict ? 'Copies disagree. This app stays closed; keep both copies.' : result.status === 'missing' ? 'No snapshot for this app and selected key.' : result.status === 'unavailable' ? 'No usable copy was available. This app stays closed.' : 'No trustworthy copy could be opened. This app stays closed.';
    }
    hasResult = true;
  }
  async function openCollection() {
    if (primary || opened() || receiver?.isEnrollment) return;
    const op = begin('recover'); if (!op) return; clearCopies(); controls(); message('Checking both apps with the existing simulated reserve key…');
    let results, checked;
    try {
      // No preliminary await: native integrations must preserve the deliberate
      // click boundary. This reference injects its explicitly synthetic client.
      const replicas = settings.replicas.map(replica => ({ id: replica.id, store: makeStore({ fetcher, basePath: replica.basePath }) }));
      results = await recover({ apps: settings.apps.map(app => ({ config: app.config, replicas })), webAuthnClient: client, signal: op.controller.signal });
      if (!assertCurrent(op)) return;
      checked = checkedCollection(results); // Validate the whole batch before opening any draft.
      renderResults(checked); const count = checked.filter(value => value.status === 'recovered').length;
      message(count === settings.apps.length ? 'Both drafts are open. Edit locally and export what you want to keep.' : count ? 'One draft is open. The other app’s result is shown separately.' : 'No drafts were opened. Keep the existing key and check the individual results.', !count);
    } catch { if (assertCurrent(op)) { clearCopies(); message('The collection could not be opened. No unverified text is shown. Keep the existing key; retry only when you choose.', true); } }
    finally { results = undefined; checked = undefined; if (operation === op) operation = undefined; controls(); }
  }
  function download(id, format) {
    checkExpiry(); const card = cards.get(id); if (!card?.open || operation || disposed || expired) return;
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
      setup = startSetup({ config: card.app.config, originalOrigin: settings.originalOrigin, recoveryUrl: settings.recoveryOrigin + '/?app=' + id, replicaIds: settings.replicas.map(value => value.id), text: captureText(card.adapter), signal: op.controller.signal, window });
      card.attempted = true; controls(); message('Finish preparing ' + card.app.label + ' in B. Keep this original tab open.');
      void setup.completion.then(() => { if (assertCurrent(op)) { card.state.textContent = 'Prepared in B · both stored copies were independently checked.'; message('This app is prepared. Prepare the other app using the same simulated key, then open the collection.'); } }, () => { if (assertCurrent(op)) message('Setup stopped. Check the existing reserve before starting another setup. The draft remains here.', true); }).finally(() => { if (operation === op) { operation = undefined; setup = undefined; } controls(); });
    } catch { if (operation === op) operation = undefined; message('The reserve tab could not open. Allow the local B tab before trying again.', true); controls(); }
  }
  async function receive(credentialMode) {
    if (!receiver?.isEnrollment || preparationAttempted) return;
    const op = begin('prepare'); if (!op) return; preparationAttempted = true; controls();
    const selected = settings.apps.find(app => app.id === new URL(window.location.href).searchParams.get('app'));
    let response, grant, ready;
    try {
      message('Checking one-time local upload permission for ' + selected.label + '…');
      response = await fetcher('/api/replica-enrollment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: selected.config.appId }), signal: op.controller.signal });
      if (!response.ok) throw problem(); grant = await response.json(); if (!assertCurrent(op)) return;
      if (!exact(grant, ['appId','replicas']) || grant.appId !== selected.config.appId || !Array.isArray(grant.replicas) || grant.replicas.length !== settings.replicas.length || grant.replicas.some((value, index) => !exact(value, ['id','enrollmentToken']) || value.id !== settings.replicas[index].id || !/^[A-Za-z0-9_-]{43}$/.test(value.enrollmentToken)) || new Set(grant.replicas.map(value => value.enrollmentToken)).size !== settings.replicas.length) throw problem();
      for (const [index, value] of grant.replicas.entries()) { writeStores.push({ id: value.id, store: makeStore({ fetcher, basePath: settings.replicas[index].basePath, enrollmentToken: value.enrollmentToken }) }); delete value.enrollmentToken; }
      ready = await receiver.prepare({ replicas: writeStores, credentialMode, webAuthnClient: client, signal: op.controller.signal, user: { name: 'Local collection simulation', displayName: 'LOCAL SIMULATION' } });
      if (!assertCurrent(op)) return;
      if (ready?.status !== 'ready' || ready.independentlyVerified !== true || diagnostics(ready.replicas).some(value => value.status !== 'verified')) throw problem();
      validateText(ready.text); message(selected.label + ' is prepared in both stores. Return to A to prepare the other app with the same key, or open the collection here.');
    } catch { if (assertCurrent(op)) message('Preparation stopped. This page will not retry or create another key. Check the existing collection before preparing again.', true); }
    finally { response = undefined; grant = undefined; ready = undefined; clearCapabilities(); receiver?.dispose(); receiver = undefined; $('enrollment').hidden = true; if (operation === op) operation = undefined; controls(); }
  }
  async function availability(generation = ++statusGeneration) {
    const response = await fetcher('/api/status'); if (!response.ok) throw problem(); const value = await response.json();
    if (disposed || expired || generation !== statusGeneration) return;
    if (!exact(value, ['synthetic','primaryOnline','replicas']) || value.synthetic !== true || typeof value.primaryOnline !== 'boolean' || !Array.isArray(value.replicas) || value.replicas.length !== settings.replicas.length || value.replicas.some((state, index) => !exact(state, ['id','running','corruptedApps']) || state.id !== settings.replicas[index].id || typeof state.running !== 'boolean' || !Array.isArray(state.corruptedApps) || new Set(state.corruptedApps).size !== state.corruptedApps.length || state.corruptedApps.some(id => !settings.apps.some(app => app.config.appId === id)))) throw problem();
    primaryOnline = value.primaryOnline; processStates = value.replicas;
    $('availability').textContent = primaryOnline ? 'A is available.' : 'A is unavailable · its page and API return HTTP 503.'; $('offline').textContent = primaryOnline ? 'Make A unavailable' : 'Restore A';
    for (const state of processStates) { $('process-' + state.id).textContent = (state.running ? 'Process running' : 'Process stopped') + (state.corruptedApps.length ? ' · altered example copy' : ''); $('toggle-' + state.id).textContent = (state.running ? 'Stop ' : 'Start ') + (state.id === 'alpha' ? 'Alpha' : 'Beta'); }
    controls();
  }
  async function control(path, value) {
    if (primary || opened() || receiver?.isEnrollment) return;
    const op = begin('control'); if (!op) return; const generation = ++statusGeneration; clearCopies(); processStates = []; primaryOnline = undefined; controls();
    try { if (path) { const response = await fetcher(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: op.controller.signal }); if (!response.ok) throw problem(); } await availability(generation); if (assertCurrent(op)) message('Process status refreshed. Open the collection for a new verification of the stored copies.'); }
    catch { if (assertCurrent(op)) message('The local control result is unknown. Refresh process status before changing anything else.', true); }
    finally { if (operation === op) operation = undefined; controls(); }
  }
  function changeStore(id, action) {
    const state = processStates.find(value => value.id === id), appId = $('corrupt-app-' + id).value;
    if (!state || action === 'corrupt' && (state.running || state.corruptedApps.includes(appId))) return;
    void control('/api/replica-control', { id, action: action === 'toggle' ? state.running ? 'stop' : 'start' : 'corrupt', ...(action === 'corrupt' ? { appId } : {}) });
  }
  function dispose() {
    if (disposed) return; disposed = true; stopOperation(); life.abort(); receiver?.dispose(); receiver = undefined; clearCapabilities(); clearCopies(); processStates = [];
    for (const timer of timers) window.clearTimeout(timer); timers.clear(); $('enrollment').hidden = true;
    window.removeEventListener('pagehide', dispose); window.removeEventListener('focus', checkExpiry); window.removeEventListener('pageshow', pageShow); document.removeEventListener('visibilitychange', checkExpiry);
    message('This view is closed. Open a fresh recovery tab to continue.'); controls();
  }
  function pageShow(event) { if (event.persisted) dispose(); else checkExpiry(); }
  $('recover').addEventListener('click', () => void openCollection()); $('clear').addEventListener('click', closeCopies);
  $('cancel').addEventListener('click', () => { if (operation?.kind !== 'recover') return; stopOperation(); clearCopies(); message('Opening cancelled. No drafts are retained. Nothing will retry automatically.'); controls(); });
  $('receive-existing').addEventListener('click', () => void receive('existing')); $('receive-create').addEventListener('click', () => void receive('create'));
  $('cancel-setup').addEventListener('click', () => { stopOperation(); receiver?.dispose(); receiver = undefined; clearCapabilities(); $('enrollment').hidden = true; message('Setup closed. Check the existing collection; this page will not restart preparation.'); controls(); });
  $('offline').addEventListener('click', () => { if (typeof primaryOnline === 'boolean') void control('/api/primary', { online: !primaryOnline }); });
  $('refresh-status').addEventListener('click', () => void control());
  window.addEventListener('pagehide', dispose); window.addEventListener('focus', checkExpiry); window.addEventListener('pageshow', pageShow); document.addEventListener('visibilitychange', checkExpiry);
  $('fresh').href = settings.recoveryOrigin + '/';
  $('expiry-note').textContent = 'Session ends ' + new Date(expiresAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC.';
  if (primary) {
    $('unlock').hidden = true; $('tools').hidden = true; $('place').textContent = 'A / TWO SMALL EDITOR INTEGRATIONS';
    $('lead').textContent = 'Give two fictional drafts the same way back. Prepare each app in B, then check what survives when A or storage fails.';
    for (const card of cards.values()) { card.open = true; restoreText(card.app.id === 'markdown' ? '# A calmer checkout\n\nA small plan for a simpler screen.\n\n- Keep the next step clear\n- Give the draft a way back\n' : 'Studio North\n\nA calmer checkout.\nKeep the next step clear, and the work easy to carry with you.\n', card.adapter); card.state.textContent = 'Fictional draft · not yet prepared in B.'; }
    message('Prepare the first app with a new simulated key. For the second app, use that same existing key.');
  } else {
    const selected = settings.apps.find(app => app.id === new URL(window.location.href).searchParams.get('app'));
    if (selected) { receiver = makeReceiver({ config: selected.config, originalOrigin: settings.originalOrigin, replicaIds: settings.replicas.map(value => value.id), window });
      if (receiver.isEnrollment) { $('enrollment').hidden = false; $('enrollment-title').textContent = selected.label + ' · two encrypted copies'; message('Choose how to prepare this app. Keep both A and B open until the check finishes.'); } else { receiver.dispose(); receiver = undefined; } }
  }
  checkExpiry(); if (!expired) schedule(expire, Math.min(2147483647, Math.max(0, expiresAt - now()))); controls();
  const initialStatus = ++statusGeneration;
  const ready = primary || expired ? Promise.resolve() : availability(initialStatus).catch(() => { if (!disposed && !expired && initialStatus === statusGeneration) { processStates = []; primaryOnline = undefined; controls(); message('Process status is unavailable. You can still deliberately check the prepared collection.', true); } });
  return Object.freeze({ dispose, ready });
}

// A Node consumer can import mountCollection without executing browser work.
if (typeof document !== 'undefined' && document.getElementById('collection-root')) {
  const controller = new AbortController(); const stop = () => controller.abort(); window.addEventListener('pagehide', stop, { once: true });
  try { const response = await fetch('/api/config', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal }); if (!response.ok) throw problem(); const environment = await response.json(); if (!controller.signal.aborted) mountCollection(document, window, { environment }); }
  catch { if (!controller.signal.aborted) document.getElementById('collection-root').textContent = 'The local reference is unavailable. Run its doctor, build and start commands, then reopen this page.'; }
}
