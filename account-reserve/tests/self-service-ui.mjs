import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, Script } from 'node:vm';
import { validateEnvironment, validateCapability } from '../self-service/client/config.mjs';

// Execute the actual UI through narrow DOM/SDK boundary doubles. This checks
// lifecycle and routing, not authenticator support or native physical proof.
const source = await readFile(new URL('../self-service/client/app.mjs', import.meta.url), 'utf8');
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
    config: { appId: 'continuity-judge-work-v1', derivation: 'demo-existing-eoa:v1', originalRpId: 'judge-a.example.test', recoveryRpId: 'judge-b.example.test' },
    originalOrigin: 'https://judge-a.example.test', recoveryOrigin: 'https://judge-b.example.test',
    expiresAt: new Date(now + 86400000).toISOString(),
    limits: { maxRecords: 64, maxRecordBytes: 65536, maxIssuedCapabilities: 256, capabilityTtlMs: 300000 },
  };
}
async function fixture(t, { primary = false, enrolling = !primary, delayedResponse = false, delayedBody = false, capacityStatus = 201, popupBlocked = false } = {}) {
  const time = clock(), document = documentFixture(), events = new Map();
  const pendingResponse = deferred(), pendingBody = deferred(), preparation = deferred(), recovery = deferred(), handoff = deferred();
  const env = environment(time.Date.now(), primary ? 'primary' : 'recovery');
  const counts = { issues: 0, prepares: 0, recovered: 0, writeStores: 0, cleared: 0, disposed: 0, contextsClosed: 0, signers: 0, sessions: 0, sessionsEnded: 0, setups: 0 };
  const blobs = [], copies = [];
  let onState, keyInput, setupOptions;
  class FixtureURL extends URL { static createObjectURL(blob) { blobs.push(blob); return 'blob:example'; } static revokeObjectURL() {} }
  const capability = { enrollmentToken: 'A'.repeat(43), expiresAt: new time.Date(time.Date.now() + 300000).toISOString() };
  const issueResponse = { status: capacityStatus, text: () => delayedBody ? pendingBody.promise : Promise.resolve(JSON.stringify(capability)) };
  const window = {
    location: new URL((primary ? env.originalOrigin : env.recoveryOrigin) + '/'),
    addEventListener(name, callback) { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); },
  };
  const context = createContext({
    document, window, AbortController, TextEncoder, Uint8Array, Blob, atob, btoa, URL: FixtureURL, ...time,
    navigator: { clipboard: { async writeText(text) { copies.push(text); } } },
    crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } },
    prismBackdrop: '', prismSculpture: '', WORK_SCHEMA: 'continuity-work/brief-v1', MAX_WORK_BYTES: 16384,
    validateEnvironment, validateCapability: (value, until) => validateCapability(value, until, time.Date.now()),
    validateWork(value) { assert.ok(['title', 'client', 'brief', 'deliverable', 'nextStep'].every(key => typeof value[key] === 'string' && value[key].length)); return Object.freeze({ ...value }); },
    createSecp256k1SigningSession({ privateKey }) { counts.sessions++; assert.ok(privateKey.some(value => value)); return { end() { counts.sessionsEnded++; } }; },
    toViemAccount() { return { address: '0x' + '1'.repeat(40) }; },
    startWorkReserveSetup(options) {
      counts.setups++; keyInput = options.privateKey; setupOptions = options;
      if (popupBlocked) throw Object.assign(new Error('POPUP_BLOCKED'), { code: 'POPUP_BLOCKED' });
      options.onState({ state: 'waiting' });
      return { completion: handoff.promise, cancel() { handoff.reject(Object.assign(new Error('OPERATION_CANCELLED'), { code: 'OPERATION_CANCELLED' })); } };
    },
    createWorkReserveReceiver(options) {
      onState = options.onState;
      return { isEnrollment: enrolling, prepare() { counts.prepares++; onState({ state: 'creating-credential' }); return preparation.promise; }, dispose() { counts.disposed++; } };
    },
    createReserveHttpStore(options) {
      const writing = Boolean(options.enrollmentToken); if (writing) { counts.writeStores++; assert.equal(options.enrollmentToken, capability.enrollmentToken); }
      return { clearEnrollmentCapability() { if (writing) counts.cleared++; } };
    },
    recoverWorkReserve() { counts.recovered++; return recovery.promise; },
    async fetch(url, options) {
      if (url === '/api/config') return { ok: true, json: async () => env };
      assert.equal(url, '/api/enrollment/start'); assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
      assert.equal(options.credentials, 'omit'); assert.equal(options.mode, 'same-origin'); assert.equal(options.headers.authorization, undefined);
      counts.issues++; return delayedResponse ? pendingResponse.promise : issueResponse;
    },
  });
  new Script(runnable, { filename: 'self-service/client/app.mjs' }).runInContext(context);
  await tick();
  const element = id => document.getElementById(id);
  assert.ok(element('actions'), 'actual UI initialized');
  const actions = () => element('actions').children;
  const control = label => actions().find(value => value.textContent === label);
  const emit = name => { for (const callback of events.get(name) ?? []) callback({}); };
  t.after(() => { emit('pagehide'); preparation.resolve({ owner: '0x' + '1'.repeat(40) }); handoff.resolve({ owner: '0x' + '1'.repeat(40) }); });
  return {
    time, counts, env, element, actions, control, blobs, copies, emit, document,
    keyInput: () => keyInput, setupOptions: () => setupOptions,
    stop: () => onState({ state: 'failed', code: 'SETUP_EXPIRED' }),
    resolveResponse: () => pendingResponse.resolve(issueResponse), resolveBody: () => pendingBody.resolve(JSON.stringify(capability)),
    rejectPreparation: () => preparation.reject(Object.assign(new Error('STORE_WRITE_UNKNOWN'), { code: 'STORE_WRITE_UNKNOWN', recordMayExist: true })),
    resolvePreparation: () => preparation.resolve({ owner: '0x' + '1'.repeat(40) }),
    resolveHandoff: () => handoff.resolve({ owner: '0x' + '1'.repeat(40) }),
    recover(work) { recovery.resolve({ owner: '0x' + '1'.repeat(40), work, close() { counts.contextsClosed++; }, openAccount() { counts.signers++; throw new Error('must not open signer'); } }); },
  };
}

test('native-only environment and capability checks reject altered bounds and malformed tokens', () => {
  const now = Date.UTC(2026, 9, 9), env = environment(now);
  assert.equal(validateEnvironment(env, env.recoveryOrigin + '/', now).primary, false);
  for (const patch of [{ synthetic: true }, { selfService: false }, { fictionalOnly: false }, { enrollmentToken: 'A'.repeat(43) }, { limits: { ...env.limits, maxRecords: 65 } }]) {
    assert.throws(() => validateEnvironment({ ...env, ...patch }, env.recoveryOrigin + '/', now));
  }
  const capability = { enrollmentToken: 'A'.repeat(43), expiresAt: new Date(now + 300000).toISOString() };
  assert.equal(validateCapability(capability, now + 86400000, now).token, capability.enrollmentToken);
  assert.throws(() => validateCapability({ ...capability, enrollmentToken: 'A'.repeat(42) + 'B' }, now + 86400000, now));
  assert.throws(() => validateCapability(capability, now + 86400000, now + 300000));
});
test('published source imports actual SDK, never exposes account opening or a simulated adapter', () => {
  assert.match(source, /from '\.\.\/\.\.\/sdk\/work-reserve\.mjs'/);
  assert.match(source, /from '\.\.\/\.\.\/sdk\/work-browser\.mjs'/);
  assert.doesNotMatch(source, /createSyntheticClient|webAuthnClient:|\.openAccount\(|localStorage|sessionStorage|enrollment-code/);
});
test('B automatically obtains capability before any explicit native passkey action', async t => {
  const ui = await fixture(t);
  assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 0); assert.equal(ui.counts.writeStores, 0);
  const action = ui.control('Create reserve passkey').dispatch('click');
  assert.equal(ui.counts.prepares, 1); assert.equal(ui.counts.writeStores, 1);
  ui.resolvePreparation(); await action;
  assert.ok(ui.control('Open a fresh B reserve')); assert.ok(ui.counts.cleared >= 1);
});
for (const delayed of ['delayedResponse', 'delayedBody']) {
  test(`late ${delayed} cannot reopen a cancelled setup or retain a writing token`, async t => {
    const ui = await fixture(t, { [delayed]: true });
    await ui.control('Cancel preparation').dispatch('click');
    ui.resolveResponse(); ui.resolveBody(); await tick();
    assert.ok(ui.control('Check existing reserve')); assert.equal(ui.counts.prepares, 0); assert.equal(ui.counts.writeStores, 0);
    assert.equal(ui.control('Create reserve passkey'), undefined); assert.equal(ui.counts.issues, 1);
  });
}
test('unknown upload stops setup and only offers existing-reserve recovery', async t => {
  const ui = await fixture(t);
  const action = ui.control('Create reserve passkey').dispatch('click'); ui.rejectPreparation(); await action;
  assert.ok(ui.control('Check existing reserve')); assert.ok(ui.counts.cleared >= 1);
  assert.equal(ui.actions().filter(element => element.tagName === 'BUTTON').length, 0);
  assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 1);
});
test('expired capability cannot create a passkey or request a replacement automatically', async t => {
  const ui = await fixture(t); ui.time.advance(300000); await tick();
  assert.ok(ui.control('Check existing reserve')); assert.equal(ui.counts.issues, 1); assert.equal(ui.counts.prepares, 0);
});
test('quota exhaustion never creates a passkey or retries admission', async t => {
  const ui = await fixture(t, { capacityStatus: 429 });
  assert.match(ui.element('status').textContent, /full or temporarily rate limited/);
  assert.match(ui.element('intro').textContent, /No passkey was requested and no snapshot was uploaded/);
  assert.doesNotMatch(ui.element('intro').textContent, /snapshot may already exist/);
  assert.equal(ui.counts.prepares, 0); assert.equal(ui.counts.writeStores, 0); assert.equal(ui.counts.issues, 1);
});
test('pagehide prevents late capability completion from creating controls or stores', async t => {
  const ui = await fixture(t, { delayedResponse: true }); ui.emit('pagehide'); ui.resolveResponse(); await tick();
  assert.equal(ui.control('Create reserve passkey'), undefined); assert.equal(ui.counts.writeStores, 0); assert.equal(ui.counts.prepares, 0);
});
test('A snapshots edited fields, relinquishes the key, then distinguishes state discard from outage', async t => {
  const ui = await fixture(t, { primary: true });
  await ui.control('Start my example account').dispatch('click');
  ui.element('work-title').value = 'My imaginary studio';
  const pending = ui.control('Prepare in B').dispatch('click');
  assert.equal(ui.setupOptions().work.title, 'My imaginary studio'); assert.ok(ui.keyInput().every(value => value === 0));
  assert.equal(ui.counts.sessions, 1); assert.equal(ui.counts.sessionsEnded, 1);
  ui.resolveHandoff(); await pending;
  await ui.control('Discard this A window’s state').dispatch('click');
  assert.equal(ui.element('work-title').value, ''); assert.equal(ui.element('editor').hidden, true);
  assert.match(ui.element('action-context').textContent, /HTTP service remain available/);
  assert.ok(ui.control('Recover in a fresh B page'));
});
test('popup blocking keeps the unused local key and permits a deliberate retry', async t => {
  const ui = await fixture(t, { primary: true, popupBlocked: true });
  await ui.control('Start my example account').dispatch('click'); await ui.control('Prepare in B').dispatch('click');
  assert.ok(ui.keyInput().some(value => value !== 0)); assert.ok(ui.control('Prepare in B'));
  assert.match(ui.element('status').textContent, /Allow the separate reserve window/);
  ui.emit('pagehide'); assert.ok(ui.keyInput().every(value => value === 0));
});
test('recovery immediately closes its context while editing and both exports keep working after expiry', async t => {
  const ui = await fixture(t, { enrolling: false });
  assert.equal(ui.counts.issues, 0);
  const work = { schema: 'continuity-work/brief-v1', title: 'Recovered title', client: 'Imaginary client', brief: 'Example brief', deliverable: 'Unfinished copy', nextStep: 'Finish it' };
  const pending = ui.control('Open my existing reserve').dispatch('click'); ui.recover(work); await pending;
  assert.equal(ui.counts.contextsClosed, 1); assert.equal(ui.counts.signers, 0); assert.equal(ui.element('editor').hidden, false);
  ui.element('work-deliverable').value = 'Finished in the reserve'; await ui.element('work-deliverable').dispatch('input');
  await ui.element('export-text').dispatch('click');
  assert.match(await ui.blobs[0].text(), /Finished in the reserve/);
  ui.time.advance(86400000); await tick();
  ui.element('work-nextStep').value = 'Another edit after expiry'; await ui.element('work-nextStep').dispatch('input');
  await ui.element('export-json').dispatch('click');
  assert.equal(JSON.parse(await ui.blobs[1].text()).nextStep, 'Another edit after expiry');
  assert.equal(ui.counts.contextsClosed, 1); assert.equal(ui.counts.signers, 0);
});
test('copied B link has no hash, token, locator, account or work content', async t => {
  const ui = await fixture(t, { enrolling: false }); await ui.element('copy-reserve').dispatch('click');
  assert.deepEqual(ui.copies, ['https://judge-b.example.test/']);
});
test('initial render, automatic preflight and its expiry never claim keyboard focus', async t => {
  const ui = await fixture(t);
  assert.equal(ui.document.focusCalls.length, 0);
  ui.time.advance(300000); await tick();
  assert.equal(ui.document.focusCalls.length, 0);
  assert.match(ui.element('intro').textContent, /No passkey was requested/);
});
test('a deliberate completed action restores focus after replacing its own button', async t => {
  const ui = await fixture(t, { primary: true });
  const start = ui.control('Start my example account'); start.focus(); await start.dispatch('click');
  assert.equal(ui.document.activeElement, ui.control('Prepare in B'));
  assert.equal(ui.document.focusCalls.length, 2);
});
test('a deliberate pre-native cancel focuses the recovery link and gives truthful state', async t => {
  const ui = await fixture(t);
  const cancel = ui.control('Cancel preparation'); cancel.focus(); await cancel.dispatch('click');
  assert.equal(ui.document.activeElement, ui.control('Check existing reserve'));
  assert.match(ui.element('intro').textContent, /No passkey was requested and no snapshot was uploaded/);
  assert.doesNotMatch(ui.element('intro').textContent, /snapshot may already exist/);
});
test('a background completion does not take focus from another tab or window', async t => {
  const ui = await fixture(t, { primary: true });
  await ui.control('Start my example account').dispatch('click');
  const prepare = ui.control('Prepare in B'); prepare.focus(); const pending = prepare.dispatch('click');
  const before = ui.document.focusCalls.length; ui.document.visibilityState = 'hidden'; ui.document.focused = false;
  ui.resolveHandoff(); await pending;
  assert.equal(ui.document.focusCalls.length, before);
});
test('recovery completion preserves a newer deliberate focus choice', async t => {
  const ui = await fixture(t, { enrolling: false });
  const open = ui.control('Open my existing reserve'); open.focus(); const pending = open.dispatch('click');
  ui.element('reserve-url').focus(); const before = ui.document.focusCalls.length;
  ui.recover({ schema: 'continuity-work/brief-v1', title: 'Title', client: 'Example', brief: 'Brief', deliverable: 'Draft', nextStep: 'Finish' }); await pending;
  assert.equal(ui.document.activeElement, ui.element('reserve-url')); assert.equal(ui.document.focusCalls.length, before);
});
test('mobile editor preparation uses the same edited snapshot and disappears when the key is relinquished', async t => {
  const ui = await fixture(t, { primary: true });
  assert.equal(ui.element('editor-prepare').hidden, true);
  await ui.control('Start my example account').dispatch('click');
  const footer = ui.element('editor-prepare'); assert.equal(footer.hidden, false);
  const prepare = footer.children.find(element => element.textContent === 'Prepare current draft in B'); assert.ok(prepare);
  ui.element('work-nextStep').value = 'An edit made at the end of the mobile form';
  const pending = prepare.dispatch('click');
  assert.equal(ui.setupOptions().work.nextStep, 'An edit made at the end of the mobile form');
  assert.equal(footer.hidden, true); assert.equal(footer.children.length, 0); assert.equal(ui.counts.setups, 1);
  ui.resolveHandoff(); await pending;
});
test('unconfirmed capability issuance describes no native attempt without an automatic retry', async t => {
  const ui = await fixture(t, { capacityStatus: 503 });
  assert.match(ui.element('intro').textContent, /No passkey was requested and no snapshot was uploaded/);
  assert.match(ui.element('status').textContent, /will not retry automatically/);
  assert.equal(ui.counts.prepares, 0); assert.equal(ui.counts.issues, 1);
});
