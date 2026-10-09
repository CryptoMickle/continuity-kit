import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, Script } from 'node:vm';
import { validateWorkClientEnvironment, validateWorkEnrollmentToken } from '../work/client-config.mjs';

// Execute the real UI with synthetic DOM/SDK boundaries. These tests prove UI
// lifecycle behavior, not native WebAuthn, browser activation, or deployed state.
const appUrl = new URL('../work/app.mjs', import.meta.url);
const appSource = (await readFile(appUrl, 'utf8')).split('\n').filter(line => !line.startsWith('import ')).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function clock() {
  let now = Date.UTC(2026, 9, 9), nextId = 1;
  const jobs = new Map();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const schedule = (callback, delay, interval) => {
    const id = nextId++;
    jobs.set(id, { callback, at: now + delay, interval });
    return id;
  };
  return {
    Date: ClockDate,
    setTimeout: (callback, delay) => schedule(callback, delay, 0),
    clearTimeout: id => jobs.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearInterval: id => jobs.delete(id),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, job] = next;
        now = job.at;
        if (job.interval) job.at += job.interval;
        else jobs.delete(id);
        job.callback();
      }
      now = until;
    },
  };
}

function documentFixture() {
  const ids = new Map();
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map();
      this.hidden = false; this.disabled = false; this.value = ''; this.textContent = '';
      this.dataset = {}; this.classList = { add() {}, remove() {} };
    }
    get isConnected() { return this === body || Boolean(this.parentNode?.isConnected); }
    set innerHTML(html) {
      this.replaceChildren();
      // Only the actual template's identified elements are needed for these UI
      // interactions. Dynamic controls use the DOM methods below, without parsing.
      for (const [, tag, attributes, id] of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const element = new Element(tag);
        element.id = id; element.hidden = /\bhidden(?:\s|>|$)/.test(attributes);
        ids.set(id, element); this.append(element);
      }
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    async dispatch(type) {
      for (const listener of this.listeners.get(type) ?? []) await listener({ type, target: this });
      if (typeof this['on' + type] === 'function') await this['on' + type]({ type, target: this });
    }
    append(...elements) {
      for (const element of elements) { element.remove(); element.parentNode = this; this.children.push(element); }
    }
    replaceChildren(...elements) {
      for (const child of this.children) child.parentNode = undefined;
      this.children = []; this.append(...elements);
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = undefined;
    }
    querySelectorAll(tag) {
      return this.children.flatMap(child => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...child.querySelectorAll(tag)]);
    }
    focus() {}
    scrollIntoView() {}
  }
  const body = new Element('body'), app = new Element('div');
  app.id = 'app'; ids.set('app', app); body.append(app);
  return {
    body,
    getElementById: id => ids.get(id) ?? null,
    createElement: tag => new Element(tag),
    createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
  };
}

async function fixture(t, { delayedCheck = false, delayedBody = false } = {}) {
  const time = clock(), document = documentFixture(), pendingCheck = deferred(), pendingBody = deferred(), pendingPreparation = deferred();
  const origin = 'https://work-reserve.example.test';
  const env = {
    hosted: true, synthetic: false, physicalEnabled: true, role: 'recovery',
    originalOrigin: 'https://work-primary.example.test', recoveryOrigin: origin,
    config: { appId: 'continuity-private-work-v1', originalRpId: 'work-primary.example.test', recoveryRpId: 'work-reserve.example.test', derivation: 'demo-existing-eoa:v1' },
    expiresAt: new Date(time.Date.now() + 86400000).toISOString(),
  };
  const counts = { checks: 0, bodies: 0, prepares: 0, disposes: 0, writeStores: 0, clearedWriteStores: 0 };
  let state;
  const events = new Map();
  const window = {
    location: new URL(origin + '/'),
    addEventListener: (name, callback) => events.set(name, callback),
  };
  const checkedBody = JSON.stringify({ ready: true, expiresAt: env.expiresAt });
  const checkResponse = { ok: true, status: 200, text: async () => { counts.bodies++; return delayedBody ? pendingBody.promise : checkedBody; } };
  const context = createContext({
    document, window, AbortController, TextEncoder, URL, Blob,
    ...time, __WORK_HOSTED_ONLY__: true, __WORK_D1_HOSTED__: true,
    prismBackdrop: '', prismSculpture: '', WORK_SCHEMA: 'continuity-work/brief-v1', MAX_WORK_BYTES: 16384,
    validateWorkClientEnvironment, validateWorkEnrollmentToken,
    createWorkReserveReceiver(options) {
      state = options.onState;
      return {
        isEnrollment: true,
        prepare() { counts.prepares++; state({ state: 'creating-credential' }); return pendingPreparation.promise; },
        dispose() { counts.disposes++; },
      };
    },
    createReserveHttpStore(options) {
      if (options?.enrollmentToken) counts.writeStores++;
      return { clearEnrollmentCapability() { if (options?.enrollmentToken) counts.clearedWriteStores++; } };
    },
    async fetch(url, options) {
      if (url === '/api/config') return { ok: true, json: async () => env };
      assert.equal(url, '/api/enrollment/check'); assert.equal(options.method, 'POST');
      counts.checks++;
      return delayedCheck ? pendingCheck.promise : checkResponse;
    },
  });
  new Script(appSource, { filename: appUrl.pathname }).runInContext(context);
  await tick();
  assert.equal(typeof state, 'function', 'the real recovery UI initialized');
  const actions = () => document.getElementById('actions').children;
  const control = label => actions().find(element => element.textContent === label);
  assert.ok(control('Check setup code'), 'the enrollment code control is initially available');
  t.after(() => {
    pendingPreparation.resolve({ owner: '0x' + '1'.repeat(40) });
    events.get('pagehide')?.();
  });
  return {
    counts, time, document, actions, control,
    stop: () => state({ state: 'failed', code: 'SETUP_EXPIRED' }),
    resolveCheck: () => pendingCheck.resolve(checkResponse),
    resolveBody: () => pendingBody.resolve(checkedBody),
    resolvePreparation: () => pendingPreparation.resolve({ owner: '0x' + '1'.repeat(40) }),
    checkCode() {
      document.getElementById('enrollment-code').value = 'A'.repeat(43); // fictional valid-shaped code
      return control('Check setup code').dispatch('click');
    },
  };
}

function assertStopped(ui) {
  assert.ok(ui.document.getElementById('enrollment-code-wrap').hidden, 'expired enrollment hides its code form');
  assert.equal(ui.document.getElementById('enrollment-code').value, '', 'expired enrollment clears code input');
  assert.equal(ui.document.getElementById('enrollment-code').disabled, true, 'expired enrollment disables code entry');
  assert.equal(ui.actions().filter(element => element.tagName === 'BUTTON').length, 0, 'expired enrollment offers no setup button');
  const recovery = ui.control('Check existing reserve');
  assert.equal(recovery?.tagName, 'A', 'expired enrollment offers a recovery link');
  assert.equal(recovery.href, 'https://work-reserve.example.test/');
  assert.equal(ui.counts.prepares, 0, 'expiry before the deliberate click does not start preparation');
}

test('terminal setup failure removes initial and checked enrollment controls before native preparation', async t => {
  for (const checked of [false, true]) {
    await t.test(checked ? 'checked code' : 'initial code form', async t => {
      const ui = await fixture(t);
      const oldCheck = ui.control('Check setup code');
      if (checked) await ui.checkCode();
      const oldPrepare = ui.control('Prepare work snapshot');
      const checks = ui.counts.checks;
      ui.stop(); assertStopped(ui);
      // Queued clicks on controls that were just detached must remain harmless.
      await oldCheck.dispatch('click');
      if (oldPrepare) await oldPrepare.dispatch('click');
      ui.time.advance(61000); await tick();
      assertStopped(ui);
      assert.equal(ui.counts.checks, checks, 'stale controls cannot start another code check');
      assert.equal(ui.counts.writeStores, 0, 'stale prepare cannot create a write-capable store');
    });
  }
});

test('an enrollment check response arriving after setup expiry cannot revive preparation', async t => {
  for (const delayedBody of [false, true]) {
    await t.test(delayedBody ? 'late response body' : 'late response headers', async t => {
      const ui = await fixture(t, { delayedCheck: !delayedBody, delayedBody });
      const checking = ui.checkCode();
      await tick();
      assert.equal(ui.counts.checks, 1);
      assert.equal(ui.counts.bodies, delayedBody ? 1 : 0);
      ui.stop(); assertStopped(ui);
      if (delayedBody) ui.resolveBody(); else ui.resolveCheck();
      await checking;
      assertStopped(ui);
      ui.time.advance(61000); await tick();
      assertStopped(ui);
      assert.equal(ui.counts.writeStores, 0);
    });
  }
});

test('the sixty-second code timer cannot reset an already started native preparation', async t => {
  const ui = await fixture(t);
  await ui.checkCode();
  assert.equal(ui.counts.prepares, 0, 'checking a code does not invoke native preparation');
  const preparing = ui.control('Prepare work snapshot').dispatch('click');
  assert.equal(ui.counts.prepares, 1, 'the separate deliberate click starts preparation exactly once');
  assert.equal(ui.counts.writeStores, 1);
  ui.time.advance(61000); await tick();
  assert.ok(ui.control('Cancel preparation'), 'the in-flight attempt remains active after the old code deadline');
  assert.equal(ui.control('Check setup code'), undefined);
  assert.equal(ui.control('Prepare work snapshot'), undefined);
  assert.equal(ui.counts.disposes, 0, 'the code timer does not cancel the receiver');
  assert.equal(ui.counts.clearedWriteStores, 0, 'the code timer does not clear the in-flight write capability');
  ui.resolvePreparation(); await preparing;
  assert.ok(ui.control('Open a fresh reserve'), 'the original in-flight attempt can still finish');
  assert.equal(ui.counts.prepares, 1);
  assert.equal(ui.counts.clearedWriteStores, 1, 'completion clears the one write capability');
});
