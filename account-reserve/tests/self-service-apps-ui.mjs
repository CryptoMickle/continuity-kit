import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, Script } from 'node:vm';
import { validateEnvironment, validateCapability } from '../self-service/apps/config.mjs';

// Execute the actual UI through narrow DOM/SDK boundary doubles. This checks
// lifecycle and routing, not authenticator support or native physical proof.
const source = await readFile(new URL('../self-service/apps/app.mjs', import.meta.url), 'utf8');
const runnable = source.replace("await import(/* @vite-ignore */ ", "await loadEditorModule(").split('\n').filter(line => !line.startsWith('import ')).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function clock() {
  let now = Date.UTC(2026, 9, 9), next = 1;
  const jobs = new Map();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const schedule = (callback, delay, repeat) => { const id = next++; jobs.set(id, { callback, at: now + delay, repeat }); return id; };
  return {
    Date: ClockDate, setTimeout: (callback, delay) => schedule(callback, delay, 0), clearTimeout: id => jobs.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, delay), clearInterval: id => jobs.delete(id),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const item = [...jobs].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!item) break;
        const [id, job] = item; now = job.at;
        if (job.repeat) job.at += job.repeat; else jobs.delete(id);
        job.callback();
      }
      now = until;
    },
  };
}
function documentFixture() {
  const ids = new Map();
  let document;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.attributes = {}; this.classList = { add() {}, remove() {} }; }
    get isConnected() { return this === body || Boolean(this.parentNode?.isConnected); }
    set innerHTML(html) {
      this.replaceChildren();
      for (const [, tag, attributes, id] of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const element = new Element(tag); element.id = id; element.hidden = /\bhidden(?:\s|>|$)/.test(attributes);
        ids.set(id, element); this.append(element);
      }
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
    async dispatch(name) { for (const listener of this.listeners.get(name) ?? []) await listener({ target: this }); if (typeof this['on' + name] === 'function') await this['on' + name]({ target: this }); }
    append(...elements) { for (const element of elements) { element.remove(); element.parentNode = this; this.children.push(element); } }
    replaceChildren(...elements) { for (const child of this.children) { if (document?.activeElement === child) document.activeElement = body; child.parentNode = undefined; } this.children = []; this.append(...elements); }
    remove() { if (document?.activeElement === this) document.activeElement = body; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = undefined; }
    querySelector() { return this.children.find(element => element.tagName === 'BUTTON' && !element.disabled || element.tagName === 'A' && element.href); }
    focus() { document.activeElement = this; document.focusCalls.push(this); } select() {} scrollIntoView() {} click() {}
  }
  const body = new Element('body'), app = new Element('div'); ids.set('app', app); body.append(app);
  document = { body, activeElement: body, focusCalls: [], visibilityState: 'visible', focused: true, hasFocus() { return this.focused; }, getElementById: id => ids.get(id), createElement: tag => new Element(tag) };
  return document;
}
function environment(now, role = 'recovery') {
  return {
    hosted: true, physicalEnabled: true, synthetic: false, selfService: true, fictionalOnly: true, operatorHosted: false, enrollmentRequiresInvitation: false, role,
    apps: [{ id: 'textarea', label: 'Textarea', config: { appId: 'continuity-textarea-v1', recoveryOrigin: 'https://judge-b.example.test', recoveryRpId: 'judge-b.example.test' } }, { id: 'markdown', label: 'Markdown Studio', config: { appId: 'continuity-markdown-v1', recoveryOrigin: 'https://judge-b.example.test', recoveryRpId: 'judge-b.example.test' } }],
    originalOrigin: 'https://judge-a.example.test', recoveryOrigin: 'https://judge-b.example.test',
    expiresAt: new Date(now + 86400000).toISOString(),
    limits: { maxRecords: 64, maxRecordBytes: 65536, maxIssuedCapabilities: 256, capabilityTtlMs: 300000 },
  };
}
async function fixture(t, { primary = false, enrolling = !primary, delayedResponse = false, delayedBody = false, capacityStatus = 201, networkFailure = false, malformedResponse = false, popupBlocked = false, app = 'textarea', operator = false, delayedEditor = false } = {}) {
  const time = clock(), document = documentFixture(), events = new Map();
  const pendingResponse = deferred(), pendingBody = deferred(), preparation = deferred(), recovery = deferred(), handoff = deferred();
  const env = environment(time.Date.now(), primary ? 'primary' : 'recovery'); env.operatorHosted = operator; env.enrollmentRequiresInvitation = operator;
  const counts = { issues: 0, prepares: 0, recovered: 0, writeStores: 0, cleared: 0, disposed: 0, contextsClosed: 0, signers: 0, sessions: 0, sessionsEnded: 0, setups: 0, editorMounts: 0, editorDestroys: 0 };
  const blobs = [], copies = [];
  let onState, keyInput, setupOptions, storeFetch, prepareOptions, recoveryOptions, editorPath, editorText = '', editorChange; const editorLoad = deferred();
  class FixtureURL extends URL { static createObjectURL(blob) { blobs.push(blob); return 'blob:example'; } static revokeObjectURL() {} }
  const capability = { enrollmentToken: 'A'.repeat(43), expiresAt: new time.Date(time.Date.now() + 300000).toISOString(), serverNow: new time.Date(time.Date.now()).toISOString() };
  const issueResponse = { status: capacityStatus, text: () => delayedBody ? pendingBody.promise : Promise.resolve(malformedResponse ? '{' : JSON.stringify(capability)) };
  const window = {
    location: new URL((primary ? env.originalOrigin : env.recoveryOrigin) + '/apps/' + app + '/'),
    addEventListener(name, callback) { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); },
  };
  const context = createContext({
    document, window, AbortController, TextEncoder, Uint8Array, Blob, atob, btoa, URL: FixtureURL, ...time,
    navigator: { clipboard: { async writeText(text) { copies.push(text); } } },
    crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } },
    prismBackdrop: '', prismSculpture: '', MAX_TEXT_BYTES: 16384,
    loadEditorModule(path) { editorPath = path; const module = { mountEditor({ initialText, onChange }) { assert.equal(document.getElementById('editor').hidden, false, 'editor panel must be visible before mount'); counts.editorMounts++; editorText = initialText; editorChange = onChange; let destroyed = false; return { getText() { assert.equal(destroyed, false); return editorText; }, setText(text) { assert.equal(destroyed, false); editorText = text; onChange(); }, destroy() { assert.equal(destroyed, false); destroyed = true; counts.editorDestroys++; } }; } }; return delayedEditor ? editorLoad.promise.then(() => module) : Promise.resolve(module); },
    validateEnvironment: (env, href) => validateEnvironment(env, href, time.Date.now()), validateCapability, performance: { now: () => time.Date.now() - Date.UTC(2026, 9, 9) },
    validateText(value) { assert.equal(typeof value, 'string'); return value; },
    startTextReserveSetup(options) {
      counts.setups++; assert.ok(!('privateKey' in options)); assert.ok(!('expectedOwner' in options)); setupOptions = options;
      if (popupBlocked) throw Object.assign(new Error('POPUP_BLOCKED'), { code: 'POPUP_BLOCKED' });
      options.onState({ state: 'waiting' });
      return { completion: handoff.promise, cancel() { handoff.reject(Object.assign(new Error('OPERATION_CANCELLED'), { code: 'OPERATION_CANCELLED' })); } };
    },
    createTextReserveReceiver(options) {
      onState = options.onState;
      return { isEnrollment: enrolling, prepare(options) { prepareOptions = options; counts.prepares++; onState({ state: options.credentialMode === 'existing' ? 'selecting-credential' : 'creating-credential' }); return preparation.promise; }, dispose() { counts.disposed++; } };
    },
    createReserveHttpStore(options) {
      storeFetch = options.fetcher;
      const writing = Boolean(options.enrollmentToken); if (writing) { counts.writeStores++; assert.equal(options.enrollmentToken, capability.enrollmentToken); }
      return { clearEnrollmentCapability() { if (writing) counts.cleared++; } };
    },
    recoverTextReserve(options) { recoveryOptions = options; counts.recovered++; return recovery.promise; },
    async fetch(url, options) {
      if (url === '/api/apps-config') return { ok: true, json: async () => env };
      assert.equal(options.referrerPolicy, 'origin');
      if (url === '/api/reserve/' + 'A'.repeat(43)) { assert.equal(options.method, 'PUT'); assert.equal(options.mode, 'same-origin'); assert.equal(options.redirect, 'error'); return { status: 403 }; }
      assert.equal(url, '/api/enrollment/start'); assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
      assert.equal(options.credentials, 'omit'); assert.equal(options.mode, 'same-origin'); assert.equal(options.headers.authorization, operator ? 'Bearer ' + 'b'.repeat(64) : undefined);
      counts.issues++; if (networkFailure) throw new TypeError('Load failed');
      return delayedResponse ? pendingResponse.promise : issueResponse;
    },
  });
  new Script(runnable, { filename: 'self-service/apps/app.mjs' }).runInContext(context);
  await tick();
  const element = id => document.getElementById(id);
  assert.ok(element('actions'), 'actual UI initialized');
  const actions = () => element('actions').children;
  const control = label => actions().find(value => value.textContent === label);
  const emit = name => { for (const callback of events.get(name) ?? []) callback({}); };
  t.after(() => { emit('pagehide'); preparation.resolve({ owner: '0x' + '1'.repeat(40) }); handoff.resolve({ owner: '0x' + '1'.repeat(40) }); });
  return {
    time, counts, env, element, actions, control, blobs, copies, emit, document,
    write(text) { editorText = text; editorChange?.(); }, read: () => editorText, editorPath: () => editorPath, prepareOptions: () => prepareOptions, recoveryOptions: () => recoveryOptions, resolveEditor: () => editorLoad.resolve(), keyInput: () => keyInput, setupOptions: () => setupOptions, storeFetch: (...args) => storeFetch(...args),
    stop: () => onState({ state: 'failed', code: 'SETUP_EXPIRED' }),
    resolveResponse: () => pendingResponse.resolve(issueResponse), resolveBody: () => pendingBody.resolve(JSON.stringify(capability)),
    rejectPreparation: () => preparation.reject(Object.assign(new Error('STORE_WRITE_UNKNOWN'), { code: 'STORE_WRITE_UNKNOWN', recordMayExist: true })),
    resolvePreparation: () => preparation.resolve({ owner: '0x' + '1'.repeat(40) }),
    resolveHandoff: () => handoff.resolve({ owner: '0x' + '1'.repeat(40) }),
    recover(text) { recovery.resolve({ text, textDigest: 'b'.repeat(64), locator: 'A'.repeat(43) }); },
  };
}


test('app config accepts only the two fixed namespaces and exact origins/routes', () => {
  const now = Date.UTC(2026, 9, 9), env = environment(now);
  for (const [route, id] of [['/apps/textarea/', 'textarea'], ['/apps/markdown/', 'markdown']]) {
    assert.equal(validateEnvironment(env, env.recoveryOrigin + route, now).selected.id, id);
  }
  assert.equal(validateEnvironment(env, env.recoveryOrigin + '/apps/', now).selected, undefined);
  for (const suffix of ['/apps/unknown/', '/apps/textarea/?appId=other', '/apps/../text/', '/apps/textarea/extra']) {
    assert.throws(() => validateEnvironment(env, env.recoveryOrigin + suffix, now));
  }
  for (const change of [
    value => { value.apps[0].config.appId = 'continuity-judge-text-v1'; },
    value => { value.apps[0].config.owner = 'forbidden'; },
    value => { value.apps.reverse(); },
    value => { value.apps[0].id = 'custom'; },
    value => { value.apps[1].config.recoveryOrigin = value.originalOrigin; },
    value => { value.apps[1].config.recoveryRpId = 'example.test'; },
    value => { value.limits.maxRecords = 128; },
    value => { value.limits.maxIssuedCapabilities = 512; },
    value => { value.operatorHosted = true; },
  ]) { const changed = structuredClone(env); change(changed); assert.throws(() => validateEnvironment(changed, changed.recoveryOrigin + '/apps/textarea/', now)); }
  assert.throws(() => validateEnvironment(env, 'https://other.example.test/apps/textarea/', now));
  assert.doesNotMatch(source, /createSecp256k1SigningSession|toViemAccount|privateKey|expectedOwner|\.openAccount\(|localStorage|sessionStorage|webAuthnClient:/);
});

for (const [app, module, namespace] of [['textarea', 'textarea', 'continuity-textarea-v1'], ['markdown', 'easymde', 'continuity-markdown-v1']]) {
  test(`${app} loads its fixed real-editor module and sends only current text into its namespace`, async t => {
    const ui = await fixture(t, { primary: true, app });
    assert.equal(ui.editorPath(), `/apps/editors/${module}-editor.mjs`); assert.equal(ui.counts.editorMounts, 1);
    ui.write('A changed document\nLiteral <img onerror=alert(1)> ÆØÅ 🦊\n');
    const pending = ui.control('Prepare this text in B').dispatch('click');
    assert.equal(ui.counts.setups, 1, 'popup operation begins in the direct click stack');
    assert.equal(ui.setupOptions().config.appId, namespace);
    assert.equal(ui.setupOptions().text, ui.read());
    assert.equal(ui.setupOptions().recoveryUrl, ui.env.recoveryOrigin + '/apps/' + app + '/');
    assert.equal(ui.counts.issues, 0); assert.equal(ui.counts.prepares, 0);
    ui.resolveHandoff(); await pending;
    await ui.control('Discard this A window’s state').dispatch('click');
    assert.equal(ui.read(), ''); assert.equal(ui.counts.editorDestroys, 1);
    assert.equal(ui.element('editor').hidden, true);
    assert.match(ui.element('action-context').textContent, /does not prove erasure.*HTTP service remain available/);
  });
}

for (const [label, mode] of [['Use existing reserve passkey', 'existing'], ['Create my first reserve passkey', 'create']]) {
  test(`${mode} choice waits for admission then invokes native preparation synchronously once`, async t => {
    const ui = await fixture(t);
    assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 0); assert.equal(ui.counts.editorMounts, 0);
    const button = ui.control(label), pending = button.dispatch('click');
    assert.equal(ui.counts.prepares, 1, 'no asynchronous work precedes receiver.prepare');
    assert.equal(ui.prepareOptions().credentialMode, mode);
    assert.deepEqual(Object.keys(ui.prepareOptions()).sort(), mode === 'create' ? ['credentialMode', 'signal', 'store', 'user'] : ['credentialMode', 'signal', 'store']);
    await button.dispatch('click'); assert.equal(ui.counts.prepares, 1);
    assert.equal(ui.counts.writeStores, 1);
    ui.resolvePreparation(); await pending;
    assert.equal(ui.control('Open a fresh B reserve').href, ui.env.recoveryOrigin + '/apps/textarea/');
    assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 1); assert.ok(ui.counts.cleared >= 1); assert.equal(ui.counts.editorMounts, 0);
  });
}

test('operator mode waits for an explicit invitation check and does not retain its input after admission', async t => {
  const ui = await fixture(t, { operator: true });
  assert.equal(ui.counts.issues, 0); assert.equal(ui.control('Use existing reserve passkey'), undefined);
  assert.equal(ui.element('operator-invitation').hidden, false);
  ui.element('invitation').value = 'b'.repeat(64);
  await ui.control('Check invitation').dispatch('click');
  assert.equal(ui.counts.issues, 1); assert.equal(ui.element('invitation').value, ''); assert.equal(ui.element('operator-invitation').hidden, true);
  assert.ok(ui.control('Use existing reserve passkey')); assert.equal(ui.counts.prepares, 0);
});

test('failed operator admission clears invitation input and offers no implicit retry', async t => {
  const ui = await fixture(t, { operator: true, networkFailure: true });
  ui.element('invitation').value = 'b'.repeat(64);
  await ui.control('Check invitation').dispatch('click');
  assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 0);
  assert.equal(ui.element('invitation').value, ''); assert.equal(ui.element('operator-invitation').hidden, true);
  assert.ok(ui.control('Check existing reserve')); assert.equal(ui.control('Check invitation'), undefined);
});

for (const delay of ['delayedResponse', 'delayedBody']) {
  test(`cancelling late admission ${delay} prevents either credential action`, async t => {
    const ui = await fixture(t, { [delay]: true });
    await ui.control('Cancel preparation').dispatch('click');
    ui.resolveResponse(); ui.resolveBody(); await tick();
    assert.equal(ui.control('Use existing reserve passkey'), undefined); assert.equal(ui.control('Create my first reserve passkey'), undefined);
    assert.ok(ui.control('Check existing reserve')); assert.equal(ui.counts.prepares, 0); assert.equal(ui.counts.issues, 1);
  });
}

test('unknown existing-mode upload exposes read-only reconciliation and no creation fallback', async t => {
  const ui = await fixture(t), pending = ui.control('Use existing reserve passkey').dispatch('click');
  ui.rejectPreparation(); await pending;
  assert.ok(ui.control('Check existing reserve'));
  assert.equal(ui.actions().filter(element => element.tagName === 'BUTTON').length, 0);
  assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 1); assert.equal(ui.prepareOptions().credentialMode, 'existing');
});

test('expired capacity and failed admission never request a credential', async t => {
  const ui = await fixture(t); ui.time.advance(300000); await tick();
  assert.ok(ui.control('Check existing reserve')); assert.equal(ui.counts.prepares, 0); assert.equal(ui.counts.issues, 1);
  for (const options of [{ networkFailure: true }, { capacityStatus: 403 }, { capacityStatus: 429 }, { malformedResponse: true }]) {
    const failed = await fixture(t, options);
    assert.ok(failed.control('Check existing reserve')); assert.equal(failed.counts.prepares, 0); assert.equal(failed.counts.issues, 1);
    assert.doesNotMatch(failed.element('status').textContent, /AAAA|enrollmentToken/);
  }
});

test('fresh B recovers only its chosen app and exports edited text even after access expires', async t => {
  const ui = await fixture(t, { enrolling: false, app: 'markdown' });
  assert.equal(ui.counts.editorMounts, 0); assert.equal(ui.element('editor').hidden, true);
  const pending = ui.control('Open my existing reserve').dispatch('click');
  assert.equal(ui.counts.recovered, 1); assert.equal(ui.recoveryOptions().config.appId, 'continuity-markdown-v1');
  ui.recover('# A recovered release note\n'); await pending;
  assert.equal(ui.read(), '# A recovered release note\n'); assert.equal(ui.counts.issues, 0); assert.equal(ui.counts.writeStores, 0);
  assert.equal(ui.counts.editorMounts, 1); assert.equal(ui.element('editor').hidden, false);
  ui.write('# Finished\n\nLiteral <script>text only</script>\n');
  await ui.element('export-text').dispatch('click'); assert.equal(await ui.blobs[0].text(), ui.read());
  ui.time.advance(86400000); await tick(); ui.write('After expiry\n');
  await ui.element('export-json').dispatch('click');
  assert.deepEqual(JSON.parse(await ui.blobs[1].text()), { format: 'continuity-text-export/v1', text: 'After expiry\n' });
  assert.equal(ui.counts.prepares, 0); assert.equal(ui.counts.issues, 0);
});

test('leaving B during recovery prevents a late result from mounting an editor', async t => {
  const ui = await fixture(t, { enrolling: false, app: 'markdown' });
  const pending = ui.control('Open my existing reserve').dispatch('click');
  assert.equal(ui.counts.editorMounts, 0); ui.emit('pagehide'); ui.recover('Late private text'); await pending;
  assert.equal(ui.counts.editorMounts, 0); assert.equal(ui.counts.editorDestroys, 0); assert.equal(ui.element('editor').hidden, true);
});

test('public app link contains only its fixed path and never a query or enrollment nonce', async t => {
  const ui = await fixture(t, { enrolling: false, app: 'markdown' });
  await ui.element('copy-reserve').dispatch('click');
  assert.deepEqual(ui.copies, ['https://judge-b.example.test/apps/markdown/']);
});

test('a late editor module cannot mount or start setup after leaving the page', async t => {
  const ui = await fixture(t, { delayedEditor: true });
  ui.emit('pagehide'); ui.resolveEditor(); await tick();
  assert.equal(ui.counts.editorMounts, 0); assert.equal(ui.counts.issues, 0); assert.equal(ui.counts.prepares, 0);
});

test('a late editor module cannot reopen expired or already stopped preparation', async t => {
  const expired = await fixture(t, { delayedEditor: true });
  expired.time.advance(86400000); expired.resolveEditor(); await tick();
  assert.equal(expired.counts.editorMounts, 0); assert.equal(expired.counts.issues, 0); assert.match(expired.element('heading').textContent, /expired/);
  const stopped = await fixture(t, { delayedEditor: true });
  stopped.stop(); stopped.resolveEditor(); await tick();
  assert.equal(stopped.counts.editorMounts, 0); assert.equal(stopped.counts.issues, 0); assert.ok(stopped.control('Check existing reserve'));
});

test('popup denial preserves the real editor draft and makes no upload permission request', async t => {
  const ui = await fixture(t, { primary: true, popupBlocked: true }); ui.write('Keep this document');
  await ui.control('Prepare this text in B').dispatch('click');
  assert.equal(ui.read(), 'Keep this document'); assert.ok(ui.control('Prepare this text in B')); assert.equal(ui.counts.issues, 0);
});
