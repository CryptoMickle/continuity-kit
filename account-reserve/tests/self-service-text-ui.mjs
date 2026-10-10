import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, Script } from 'node:vm';
import { validateEnvironment, validateCapability } from '../self-service/text/config.mjs';

// Execute the actual UI through narrow DOM/SDK boundary doubles. This checks
// lifecycle and routing, not authenticator support or native physical proof.
const source = await readFile(new URL('../self-service/text/app.mjs', import.meta.url), 'utf8');
const runnable = source.split('\n').filter(line => !line.startsWith('import ')).join('\n');
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
    hosted: true, physicalEnabled: true, synthetic: false, selfService: true, fictionalOnly: true, role,
    config: { appId: 'continuity-judge-text-v1', recoveryOrigin: 'https://judge-b.example.test', recoveryRpId: 'judge-b.example.test' },
    originalOrigin: 'https://judge-a.example.test', recoveryOrigin: 'https://judge-b.example.test',
    expiresAt: new Date(now + 86400000).toISOString(),
    limits: { maxRecords: 64, maxRecordBytes: 65536, maxIssuedCapabilities: 256, capabilityTtlMs: 300000 },
  };
}
async function fixture(t, { primary = false, enrolling = !primary, delayedResponse = false, delayedBody = false, capacityStatus = 201, networkFailure = false, malformedResponse = false, popupBlocked = false } = {}) {
  const time = clock(), document = documentFixture(), events = new Map();
  const pendingResponse = deferred(), pendingBody = deferred(), preparation = deferred(), recovery = deferred(), handoff = deferred();
  const env = environment(time.Date.now(), primary ? 'primary' : 'recovery');
  const counts = { issues: 0, prepares: 0, recovered: 0, writeStores: 0, cleared: 0, disposed: 0, contextsClosed: 0, signers: 0, sessions: 0, sessionsEnded: 0, setups: 0 };
  const blobs = [], copies = [];
  let onState, keyInput, setupOptions, storeFetch;
  class FixtureURL extends URL { static createObjectURL(blob) { blobs.push(blob); return 'blob:example'; } static revokeObjectURL() {} }
  const capability = { enrollmentToken: 'A'.repeat(43), expiresAt: new time.Date(time.Date.now() + 300000).toISOString(), serverNow: new time.Date(time.Date.now()).toISOString() };
  const issueResponse = { status: capacityStatus, text: () => delayedBody ? pendingBody.promise : Promise.resolve(malformedResponse ? '{' : JSON.stringify(capability)) };
  const window = {
    location: new URL((primary ? env.originalOrigin : env.recoveryOrigin) + '/'),
    addEventListener(name, callback) { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); },
  };
  const context = createContext({
    document, window, AbortController, TextEncoder, Uint8Array, Blob, atob, btoa, URL: FixtureURL, ...time,
    navigator: { clipboard: { async writeText(text) { copies.push(text); } } },
    crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } },
    prismBackdrop: '', prismSculpture: '', MAX_TEXT_BYTES: 16384,
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
      return { isEnrollment: enrolling, prepare() { counts.prepares++; onState({ state: 'creating-credential' }); return preparation.promise; }, dispose() { counts.disposed++; } };
    },
    createReserveHttpStore(options) {
      storeFetch = options.fetcher;
      const writing = Boolean(options.enrollmentToken); if (writing) { counts.writeStores++; assert.equal(options.enrollmentToken, capability.enrollmentToken); }
      return { clearEnrollmentCapability() { if (writing) counts.cleared++; } };
    },
    recoverTextReserve() { counts.recovered++; return recovery.promise; },
    async fetch(url, options) {
      if (url === '/api/text-config') return { ok: true, json: async () => env };
      assert.equal(options.referrerPolicy, 'origin');
      if (url === '/api/reserve/' + 'A'.repeat(43)) { assert.equal(options.method, 'PUT'); assert.equal(options.mode, 'same-origin'); assert.equal(options.redirect, 'error'); return { status: 403 }; }
      assert.equal(url, '/api/enrollment/start'); assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
      assert.equal(options.credentials, 'omit'); assert.equal(options.mode, 'same-origin'); assert.equal(options.headers.authorization, undefined);
      counts.issues++; if (networkFailure) throw new TypeError('Load failed');
      return delayedResponse ? pendingResponse.promise : issueResponse;
    },
  });
  new Script(runnable, { filename: 'self-service/text/app.mjs' }).runInContext(context);
  await tick();
  const element = id => document.getElementById(id);
  assert.ok(element('actions'), 'actual UI initialized');
  const actions = () => element('actions').children;
  const control = label => actions().find(value => value.textContent === label);
  const emit = name => { for (const callback of events.get(name) ?? []) callback({}); };
  t.after(() => { emit('pagehide'); preparation.resolve({ owner: '0x' + '1'.repeat(40) }); handoff.resolve({ owner: '0x' + '1'.repeat(40) }); });
  return {
    time, counts, env, element, actions, control, blobs, copies, emit, document,
    keyInput: () => keyInput, setupOptions: () => setupOptions, storeFetch: (...args) => storeFetch(...args),
    stop: () => onState({ state: 'failed', code: 'SETUP_EXPIRED' }),
    resolveResponse: () => pendingResponse.resolve(issueResponse), resolveBody: () => pendingBody.resolve(JSON.stringify(capability)),
    rejectPreparation: () => preparation.reject(Object.assign(new Error('STORE_WRITE_UNKNOWN'), { code: 'STORE_WRITE_UNKNOWN', recordMayExist: true })),
    resolvePreparation: () => preparation.resolve({ owner: '0x' + '1'.repeat(40) }),
    resolveHandoff: () => handoff.resolve({ owner: '0x' + '1'.repeat(40) }),
    recover(text) { recovery.resolve({ text, textDigest: 'b'.repeat(64), locator: 'A'.repeat(43) }); },
  };
}


test('native text UI rejects altered config and accidental wallet fields', () => {
  const now = Date.UTC(2026, 9, 9), env = environment(now);
  assert.equal(validateEnvironment(env, env.recoveryOrigin + '/text/', now).primary, false);
  for (const config of [{ ...env.config, expectedOwner: '0x1' }, { ...env.config, appId: 'continuity-judge-work-v1' }, { ...env.config, recoveryOrigin: env.originalOrigin }]) {
    assert.throws(() => validateEnvironment({ ...env, config }, env.recoveryOrigin + '/text/', now));
  }
  assert.doesNotMatch(source, /createSecp256k1SigningSession|toViemAccount|privateKey|expectedOwner|.openAccount\(|localStorage|sessionStorage|webAuthnClient:/);
});
test('A sends only edited text and config to the popup, then discards its local text', async t => {
  const ui = await fixture(t, { primary: true });
  ui.element('work-deliverable').value = 'An exact draft\nwith a trailing newline\n';
  const pending = ui.control('Prepare this text in B').dispatch('click');
  assert.equal(ui.setupOptions().text, 'An exact draft\nwith a trailing newline\n');
  assert.equal(ui.setupOptions().recoveryUrl, ui.env.recoveryOrigin + '/text/');
  assert.equal(ui.counts.setups, 1);
  ui.resolveHandoff(); await pending;
  await ui.control('Discard this A window’s state').dispatch('click');
  assert.equal(ui.element('work-deliverable').value, '');
  assert.match(ui.element('action-context').textContent, /HTTP service remain available/);
});
test('popup denial preserves the draft and allows a deliberate retry', async t => {
  const ui = await fixture(t, { primary: true, popupBlocked: true });
  ui.element('work-deliverable').value = 'Keep this draft';
  await ui.control('Prepare this text in B').dispatch('click');
  assert.equal(ui.element('work-deliverable').value, 'Keep this draft');
  assert.ok(ui.control('Prepare this text in B'));
  assert.match(ui.element('status').textContent, /Allow the separate reserve window/);
});
test('B obtains admission once and waits for explicit native action', async t => {
  const ui = await fixture(t);
  assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 0);
  const pending = ui.control('Create reserve passkey').dispatch('click');
  assert.equal(ui.counts.prepares, 1);
  ui.resolvePreparation(); await pending;
  assert.equal(ui.control('Open a fresh B reserve').href, ui.env.recoveryOrigin + '/text/');
});
for (const delay of ['delayedResponse', 'delayedBody']) {
  test('late ' + delay + ' cannot reopen cancelled setup', async t => {
    const ui = await fixture(t, { [delay]: true });
    await ui.control('Cancel preparation').dispatch('click');
    ui.resolveResponse(); ui.resolveBody(); await tick();
    assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 0);
    assert.equal(ui.control('Create reserve passkey'), undefined);
    assert.ok(ui.control('Check existing reserve'));
  });
}
test('unknown upload offers existing reserve only and does not retry', async t => {
  const ui = await fixture(t);
  const pending = ui.control('Create reserve passkey').dispatch('click');
  ui.rejectPreparation(); await pending;
  assert.ok(ui.control('Check existing reserve'));
  assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 1);
  assert.equal(ui.actions().filter(x => x.tagName === 'BUTTON').length, 0);
});
test('expired capacity cannot create native credentials', async t => {
  const ui = await fixture(t); ui.time.advance(300000); await tick();
  assert.equal(ui.counts.prepares, 0); assert.equal(ui.counts.issues, 1);
  assert.ok(ui.control('Check existing reserve'));
});
test('leaving B aborts late admission without adding a native button', async t => {
  const ui = await fixture(t, { delayedResponse: true });
  ui.emit('pagehide'); ui.resolveResponse(); await tick();
  assert.equal(ui.control('Create reserve passkey'), undefined); assert.equal(ui.counts.writeStores, 0);
});
test('recover, edit and export preserve exact text; expiry still allows local export', async t => {
  const ui = await fixture(t, { enrolling: false });
  const pending = ui.control('Open my existing reserve').dispatch('click');
  ui.recover('Original\n'); await pending;
  assert.equal(ui.counts.issues, 0); assert.equal(ui.element('work-deliverable').value, 'Original\n');
  ui.element('work-deliverable').value = 'Finished\n\n';
  await ui.element('export-text').dispatch('click');
  assert.equal(await ui.blobs[0].text(), 'Finished\n\n');
  ui.time.advance(86400000); await tick();
  ui.element('work-deliverable').value = 'After expiry';
  await ui.element('export-json').dispatch('click');
  assert.deepEqual(JSON.parse(await ui.blobs[1].text()), { format:'continuity-text-export/v1', text:'After expiry' });
});
test('public text link contains only the stable text path', async t => {
  const ui=await fixture(t,{enrolling:false});await ui.element('copy-reserve').dispatch('click');
  assert.deepEqual(ui.copies,['https://judge-b.example.test/text/']);
});
for (const [options, code] of [[{ networkFailure:true },'CAPABILITY_NETWORK'],[{ capacityStatus:403 },'CAPABILITY_HTTP_403'],[{ malformedResponse:true },'CAPABILITY_RESPONSE_JSON']]) {
  test('admission ' + code + ' has no native action or automatic retry', async t => {
    const ui=await fixture(t,options);
    assert.match(ui.element('status').textContent,new RegExp(code));
    assert.equal(ui.counts.issues,1); assert.equal(ui.counts.prepares,0);
    assert.doesNotMatch(ui.element('status').textContent,/AAAA|enrollmentToken/);
  });
}
