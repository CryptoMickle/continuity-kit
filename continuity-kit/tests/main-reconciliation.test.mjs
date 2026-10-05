import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createReleaseRuntime } from "../src/release/runtime.ts";
import { releasePolicy } from "../src/release/profile.ts";
import { HandoffChannel } from "../src/handoff.ts";
import {
  contextFor,
  LOCAL_POLICY,
  metadataFingerprint,
  validateContext,
} from "../src/sdk/policy.ts";
import {
  CONTROL_URL,
  TESTNET_RUNTIME_CODE_HASH,
  createRuntime,
} from "../src/runtime.ts";

// Execute the real UI entry point and handlers in a minimal DOM. Every SDK
// action, fetch, popup and timer is intercepted; no browser or chain is used.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(
  source.replaceAll(
    "import.meta.env.VITE_ENABLE_PHYSICAL_PASSKEYS",
    "globalThis.physicalEnv",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText;

function config() {
  const { registryUrl: _unused, ...common } = LOCAL_POLICY;
  return {
    kind: "monad-testnet",
    controlUrl: CONTROL_URL,
    policy: {
      ...common,
      deploymentId: "OFFLINE-UI-TEST",
      bootstrapNamespace: "continuity-kit/OFFLINE-UI-TEST/v1",
      chainId: "10143",
      registryAddress: "0x2222222222222222222222222222222222222222",
      registryCodeHash: TESTNET_RUNTIME_CODE_HASH,
      trustMode: "trusted-rpc-quorum",
      rpcUrls: [
        "https://testnet-rpc.monad.xyz",
        "https://monad-testnet.drpc.org",
      ],
      finality: "finalized",
      maxResponseBytes: 65536,
    },
    sessionLimits: {
      lifetimeMs: 600000,
      maxTransactions: 3,
      maxGas: "300000",
      maxFeePerGas: "200000000000",
      maxPriorityFeePerGas: "2000000000",
      maxTotalFeeWei: "180000000000000000",
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function boot(options = {}) {
  const { search = "", recovery = false, opener = false } = options;
  const explicitConfig = Object.hasOwn(options, "explicitConfig")
    ? options.explicitConfig
    : config();
  const uiPolicy = options.releaseConfig
    ? releasePolicy(options.releaseConfig)
    : LOCAL_POLICY;
  const nodes = new Map();
  const listeners = new Map();
  const intervals = new Set();
  const timeouts = new Map();
  const calls = [];
  const sent = [];
  const opened = [];
  const popup = {
    closed: false,
    postMessage(data, origin) {
      assert.equal(origin, recovery ? uiPolicy.aOrigin : uiPolicy.bOrigin);
      sent.push(data);
    },
  };
  let now = 1000;
  let html = "";
  let passkeyClient;
  let outcome;
  let readFailure;
  let saveFailure;
  let deferredRead;
  let writerClosed = false;
  const ticket = { command: { operation: "create" } };
  const capsuleDigest = `0x${"3".repeat(64)}`;
  const account = {
    context: {
      owner: "0x4444444444444444444444444444444444444444",
    },
    dataKey: new Uint8Array(32),
    manifestDigest: `0x${"5".repeat(64)}`,
    enrollment: { capsuleDigest },
    writer: {
      pendingTicket: undefined,
      expiresAt: 601000,
      assertActive() {
        if (writerClosed || now >= this.expiresAt) throw new Error("Expired");
      },
      close() {
        writerClosed = true;
        calls.push("close-writer");
      },
    },
    close() {
      writerClosed = true;
      calls.push("close-account");
    },
  };
  const app = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      nodes.clear();
      for (const [tag, id] of value.matchAll(
        /<[a-z][^>]*\bid="([^"]+)"[^>]*>/g,
      )) {
        assert.ok(!nodes.has(`#${id}`), `Duplicate action/element id: ${id}`);
        nodes.set(`#${id}`, {
          disabled: /\sdisabled(?:\s|>)/.test(tag),
          handlers: new Map(),
          addEventListener(event, fn) {
            this.handlers.set(event, fn);
          },
        });
      }
    },
  };
  const sdkResult = async (action) => {
    calls.push(action);
    if (action.startsWith("reconcile") && deferredRead) {
      const wait = deferredRead;
      deferredRead = undefined;
      await wait;
    }
    assert.ok(outcome, "A synthetic SDK outcome must be supplied");
    const result = options.cloneTickets
      ? {
          ...outcome,
          ...(outcome.ticket
            ? { ticket: structuredClone(outcome.ticket) }
            : {}),
          ...(outcome.unresolvedTicket
            ? { unresolvedTicket: structuredClone(outcome.unresolvedTicket) }
            : {}),
        }
      : outcome;
    account.writer.pendingTicket = options.cloneTickets
      ? structuredClone(
          result.status === "pending" ? result.ticket : result.unresolvedTicket,
        )
      : result.status === "pending"
        ? ticket
        : result.unresolvedTicket;
    return result;
  };
  class FixtureClient {}
  const blockedAdapter = new Proxy(
    {},
    {
      get(_target, method) {
        return () => {
          assert.fail(`Unexpected live adapter call: ${String(method)}`);
        };
      },
    },
  );
  const stubs = {
    "./style.css": {},
    "./release/runtime.ts": {
      createReleaseRuntime(input, token) {
        const runtime = createReleaseRuntime(input, token);
        return {
          ...runtime,
          adapters: {
            ...runtime.adapters,
            registry: blockedAdapter,
            transactions: blockedAdapter,
            mirrors: [blockedAdapter, blockedAdapter],
          },
        };
      },
    },
    "./runtime.ts": {
      createRuntime(input) {
        const runtime = createRuntime(input);
        return {
          ...runtime,
          adapters: {
            ...runtime.adapters,
            registry: blockedAdapter,
            localWriter: blockedAdapter,
            transactions: blockedAdapter,
            mirrors: [blockedAdapter, blockedAdapter],
          },
        };
      },
    },
    "./sdk/policy.ts": { validateContext, metadataFingerprint },
    "./sdk/passkeys.ts": {
      MeraPasskeyAdapter: class {
        constructor(client) {
          passkeyClient = client;
        }
      },
    },
    "./sdk/demo-fixture.ts": { SyntheticWebAuthnClient: FixtureClient },
    "./sdk/account.ts": {
      async createPrimary() {
        calls.push("create-primary");
        return account;
      },
    },
    "./sdk/setup-draft.ts": {
      SetupDraft: class {
        phase = "ready";
        static async create() {
          return new this();
        }
        get resumable() {
          return this.phase === "ready" || this.phase === "paused";
        }
        get paused() {
          return this.phase === "paused";
        }
        pause() {
          if (this.phase !== "ready") return false;
          this.phase = "paused";
          account.close();
          return true;
        }
        async resume() {
          assert.equal(this.phase, "paused");
          calls.push("resume-primary");
          this.phase = "ready";
          writerClosed = false;
          account.writer.expiresAt = now + 600000;
          return account;
        }
        beginBackup() {
          assert.equal(this.phase, "ready");
          this.phase = "spent";
        }
        close() {
          this.phase = "spent";
        }
      },
    },
    "./sdk/index.ts": {
      async restorePrimary() {
        calls.push("restore-primary");
        assert.ok(options.restoreResult);
        return options.restoreResult(account);
      },
      async prepareBackup() {
        calls.push("create-backup");
        if (options.backupResult) return options.backupResult();
        throw Object.assign(
          new Error("Synthetic native cancellation after creation"),
          { code: "AUTH_CANCELLED" },
        );
      },
      async finalizeEnrollment() {
        if (options.beforeFinalize) await options.beforeFinalize(account);
        return sdkResult("finalize-enrollment");
      },
      async reconcileEnrollment() {
        return sdkResult("reconcile-enrollment");
      },
      async saveCheckpoint() {
        if (saveFailure) {
          const error = saveFailure;
          saveFailure = undefined;
          calls.push("save-conflict");
          throw error;
        }
        return sdkResult("save-checkpoint");
      },
      async reconcileCheckpoint() {
        if (readFailure) {
          const error = readFailure;
          readFailure = undefined;
          calls.push("failed-status-read");
          throw error;
        }
        return sdkResult("reconcile-checkpoint");
      },
    },
    "./handoff.ts": {
      HandoffChannel: class extends HandoffChannel {
        constructor(options) {
          super({ ...options, now: () => now });
        }
      },
    },
  };
  const context = vm.createContext({
    exports: {},
    require(path) {
      assert.ok(Object.hasOwn(stubs, path), `Unexpected UI import: ${path}`);
      return stubs[path];
    },
    __CONTINUITY_TESTNET_CONFIG__: explicitConfig,
    __CONTINUITY_RELEASE_PROFILE__: options.releaseConfig,
    physicalEnv: "false",
    location: {
      origin: recovery ? uiPolicy.bOrigin : uiPolicy.aOrigin,
      search,
      replace() {
        calls.push("replace-page");
      },
    },
    URLSearchParams,
    URL,
    AbortSignal,
    structuredClone,
    Uint8Array,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    window: {
      opener: opener ? popup : null,
      addEventListener(event, fn) {
        listeners.set(event, fn);
      },
      open(url, target, features) {
        assert.equal(url, `${LOCAL_POLICY.bOrigin}/?enroll=1&mode=physical`);
        opened.push({ url, target, features });
        return popup;
      },
    },
    document: {
      querySelector(selector) {
        return selector === "#app" ? app : (nodes.get(selector) ?? null);
      },
      querySelectorAll: () => [],
    },
    async fetch(url) {
      if (
        options.releaseConfig &&
        url === `${options.releaseConfig.storeOrigin}/v1/presenter-access`
      ) {
        calls.push("presenter-access");
        return { status: options.rejectPresenter ? 401 : 204 };
      }
      assert.equal(url, `${CONTROL_URL}/v1/status`);
      calls.push("local-status");
      return {
        json: async () => ({ primaryOnline: true, scenario: "healthy" }),
      };
    },
    setTimeout(fn, delay) {
      const timer = {};
      timeouts.set(timer, { fn, at: now + delay });
      return timer;
    },
    clearTimeout(timer) {
      timeouts.delete(timer);
    },
    setInterval(fn) {
      intervals.add(fn);
      return fn;
    },
    clearInterval(fn) {
      intervals.delete(fn);
    },
  });
  vm.runInContext(compiled, context);
  await settle();
  assert.deepEqual(calls, options.releaseConfig ? [] : ["local-status"]);
  const click = async (selector) => {
    const handler = nodes.get(selector)?.handlers.get("click");
    assert.ok(handler, `${selector} must be visible and wired`);
    handler();
    await settle();
  };
  const message = async (data, overrides = {}) => {
    listeners.get("message")({
      origin: recovery ? uiPolicy.aOrigin : uiPolicy.bOrigin,
      source: popup,
      data,
      ...overrides,
    });
    await settle();
  };
  return {
    calls,
    sent,
    opened,
    click,
    setValue(selector, value) {
      nodes.get(selector).value = value;
    },
    input(selector, value) {
      const handler = nodes.get(selector)?.handlers.get("input");
      assert.ok(handler);
      handler({ target: { value } });
    },
    message,
    pagehide() {
      listeners.get("pagehide")();
    },
    pageshow() {
      listeners.get("pageshow")();
    },
    nodeText(selector) {
      return nodes.get(selector)?.textContent;
    },
    disabled(selector) {
      assert.ok(nodes.has(selector));
      return nodes.get(selector).disabled;
    },
    closePeer() {
      popup.closed = true;
      for (const tick of [...intervals]) tick();
    },
    tick(ms = 500) {
      now += ms;
      for (const tick of [...intervals]) tick();
      for (const [timer, item] of [...timeouts]) {
        if (item.at > now || !timeouts.has(timer)) continue;
        timeouts.delete(timer);
        item.fn();
      }
    },
    get html() {
      return html;
    },
    synthetic: passkeyClient instanceof FixtureClient,
    pending(operation = "create") {
      ticket.command.operation = operation;
      outcome = { status: "pending", ticket };
    },
    deferNextRead() {
      let resolve;
      deferredRead = new Promise((done) => {
        resolve = done;
      });
      return resolve;
    },
    failNextRead(code = "FRESHNESS_UNAVAILABLE") {
      readFailure = Object.assign(new Error("Synthetic read failure"), {
        code,
      });
    },
    failNextSave() {
      saveFailure = Object.assign(new Error("Synthetic competing write"), {
        code: "WRITE_CONFLICT",
      });
    },
    saved(content, unresolved = false) {
      outcome = {
        status: "saved",
        recovered: { content: structuredClone(content), version: "2" },
        proof: { kind: unresolved ? "finalized-state" : "finalized-receipt" },
        ...(unresolved ? { unresolvedTicket: ticket } : {}),
      };
    },
    prepared(unresolved = false) {
      outcome = {
        status: "prepared",
        state: account,
        proof: {
          kind: unresolved ? "finalized-state" : "finalized-transaction",
        },
        currentHead: { version: "1", capsuleDigest, evidence: {} },
        ...(unresolved ? { unresolvedTicket: ticket } : {}),
      };
    },
    async enroll() {
      await click("#prepare");
      await click("#prepare");
      await message({
        protocol: "continuity-handoff/v2",
        kind: "ready",
        step: 0,
        bNonce: "b".repeat(64),
      });
      const offer = sent.find((m) => m.kind === "offer");
      assert.ok(offer, "The real handoff must send its bound offer");
      await message({
        protocol: "continuity-handoff/v2",
        kind: "begin",
        step: 2,
        aNonce: offer.aNonce,
        bNonce: offer.bNonce,
      });
      await message({
        protocol: "continuity-handoff/v2",
        kind: "backup",
        step: 4,
        aNonce: offer.aNonce,
        bNonce: offer.bNonce,
        payload: { synthetic: true },
      });
    },
    check: () => click("#check-transaction"),
    expire() {
      now += 300001;
      for (const tick of [...intervals]) tick();
    },
    confirmed() {
      assert.match(html, /Reserve prepared and transaction confirmed\./);
      assert.doesNotMatch(html, /id="check-transaction"|ACTION_FAILED/);
      assert.equal(
        calls.filter((c) => c === "finalize-enrollment").length,
        1,
        "Status checks must never resubmit enrollment",
      );
    },
  };
}

test("UI launch only reads local status and cannot select synthetic passkeys in chain mode", async () => {
  for (const search of ["", "?mode=simulation", "?mode=physical"]) {
    const ui = await boot({ search });
    assert.equal(ui.synthetic, false);
    assert.match(ui.html, /MONAD TESTNET/);
  }
  const local = await boot({
    explicitConfig: undefined,
    search: "?mode=physical",
  });
  assert.equal(local.synthetic, true);
  assert.match(local.html, /LOCAL SIMULATION/);
});

test("initial finalized state with unresolved attribution can reconcile its receipt once", async () => {
  const ui = await boot();
  ui.prepared(true);
  await ui.enroll();
  assert.match(ui.html, /id="check-transaction"/);
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 1);
  ui.prepared();
  await ui.check();
  ui.confirmed();
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 1);
});

test("pending create then finalized state then receipt preserves one handoff notification", async () => {
  const ui = await boot();
  ui.pending();
  await ui.enroll();
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 0);
  ui.prepared(true);
  await ui.check();
  assert.match(ui.html, /id="check-transaction"/);
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 1);
  ui.prepared();
  await ui.check();
  ui.confirmed();
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 1);
});

test("expired enrollment popup cannot invalidate a later confirmed registry result", async () => {
  const ui = await boot();
  ui.pending();
  await ui.enroll();
  ui.expire();
  assert.match(ui.html, /Setup connection ended; confirmation is pending\./);
  assert.doesNotMatch(ui.html, /Reserve preparation expired/);
  ui.prepared();
  await ui.check();
  ui.confirmed();
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 0);
});

test("primary setup opens a fresh window with an opener, never a reusable named target", async () => {
  const ui = await boot();
  await ui.click("#prepare");
  await ui.click("#prepare");
  assert.equal(ui.opened.length, 1);
  assert.equal(ui.opened[0].target, "_blank");
  assert.equal(
    ui.opened[0].features,
    undefined,
    "The bound handoff requires window.opener",
  );
  assert.deepEqual(ui.calls, ["local-status", "create-primary"]);
});

test("an enrollment link without an opener offers no creation or recovery action", async () => {
  const ui = await boot({ recovery: true, search: "?enroll=1" });
  assert.match(ui.html, /This setup window has no active primary connection/);
  assert.doesNotMatch(ui.html, /id="(?:enroll|recover)"/);
  assert.deepEqual(ui.calls, ["local-status"]);
  ui.tick();
  assert.equal(ui.sent.length, 0);
});

test("B waits for the exact opener and origin before offering credential creation", async () => {
  const ui = await boot({ recovery: true, opener: true, search: "?enroll=1" });
  assert.match(ui.html, /Connecting to the primary app/);
  assert.doesNotMatch(ui.html, /id="(?:enroll|recover)"/);
  ui.tick();
  const ready = ui.sent.find((m) => m.kind === "ready");
  assert.ok(ready);
  const offer = {
    protocol: "continuity-handoff/v2",
    kind: "offer",
    step: 1,
    aNonce: "a".repeat(64),
    bNonce: ready.bNonce,
    payload: {
      context: contextFor(
        createRuntime(config()).policy,
        "0x4444444444444444444444444444444444444444",
        `0x${"6".repeat(64)}`,
      ),
    },
  };
  await ui.message(offer, { origin: "https://untrusted.example" });
  await ui.message(offer, { source: {} });
  assert.doesNotMatch(ui.html, /id="(?:enroll|recover)"/);
  await ui.message(offer);
  assert.match(ui.html, /id="enroll"/);
  assert.doesNotMatch(ui.html, /id="recover"/);
  assert.deepEqual(ui.calls, ["local-status"]);
  const count = ui.sent.length;
  ui.tick();
  assert.equal(
    ui.sent.length,
    count,
    "Ready polling ends once the offer arrives",
  );
  ui.tick(15000);
  assert.match(ui.html, /id="enroll"/);
  assert.match(ui.nodeText("#setup-clock"), /Setup time remaining/);
  ui.closePeer();
  assert.doesNotMatch(ui.html, /id="(?:enroll|recover)"/);
});

test("normal B recovery still offers the existing-passkey flow", async () => {
  const ui = await boot({ recovery: true });
  assert.match(ui.html, /id="recover"/);
  assert.doesNotMatch(ui.html, /id="enroll"/);
});

test("pre-B expiry pauses instead of creating another account; resume requires the existing key", async () => {
  for (const close of [false, true]) {
    const ui = await boot();
    await ui.click("#prepare");
    await ui.click("#prepare");
    if (close) ui.closePeer();
    else ui.expire();
    assert.match(ui.html, /Continue setup with passkey/);
    assert.equal(ui.calls.filter((c) => c === "close-account").length, 1);
    await ui.message({
      protocol: "continuity-handoff/v2",
      kind: "ready",
      step: 0,
      bNonce: "b".repeat(64),
    });
    assert.equal(ui.sent.length, 0);
    await ui.click("#prepare");
    assert.equal(
      ui.opened.length,
      1,
      "Reauthentication does not silently open another popup",
    );
    assert.equal(ui.calls.filter((c) => c === "resume-primary").length, 1);
    assert.equal(ui.calls.filter((c) => c === "create-primary").length, 1);
    assert.match(ui.html, /Same setup reopened/);
  }
});

test("B loses all setup actions and stops polling when its opener closes", async () => {
  const ui = await boot({ recovery: true, opener: true, search: "?enroll=1" });
  ui.tick();
  const count = ui.sent.length;
  ui.closePeer();
  assert.match(ui.html, /The other enrollment window closed/);
  assert.doesNotMatch(ui.html, /id="(?:enroll|recover)"/);
  ui.tick();
  assert.equal(ui.sent.length, count);
  assert.deepEqual(ui.calls, ["local-status"]);
});

test("B stops misleading connection guidance when its opener never supplies an offer", async () => {
  const ui = await boot({ recovery: true, opener: true, search: "?enroll=1" });
  assert.match(ui.html, /Waiting for setup request: 0:15/);
  ui.tick(14999);
  assert.match(ui.html, /Connecting to the primary app/);
  assert.match(ui.nodeText("#setup-clock"), /Waiting for setup request: 0:01/);
  const ready = ui.sent.find((m) => m.kind === "ready");
  const count = ui.sent.length;
  ui.tick(1);
  assert.match(ui.html, /No setup request arrived from the primary app/);
  assert.doesNotMatch(
    ui.html,
    /Finish any open prompt before starting another action/,
  );
  assert.doesNotMatch(
    ui.html,
    /Connecting to the primary app|id="(?:enroll|recover|setup-clock)"/,
  );
  await ui.message({
    protocol: "continuity-handoff/v2",
    kind: "offer",
    step: 1,
    aNonce: "a".repeat(64),
    bNonce: ready.bNonce,
    payload: {
      context: contextFor(
        createRuntime(config()).policy,
        "0x4444444444444444444444444444444444444444",
        `0x${"6".repeat(64)}`,
      ),
    },
  });
  ui.tick();
  assert.equal(ui.sent.length, count);
  assert.deepEqual(ui.calls, ["local-status"]);
  assert.doesNotMatch(ui.html, /id="(?:enroll|recover)"/);
});

test("setup time is disclosed before creating a primary key and does not extend on ticks", async () => {
  const ui = await boot();
  assert.match(ui.html, /You can pause before recovery-key creation starts/);
  await ui.click("#prepare");
  await ui.click("#prepare");
  assert.match(ui.html, /Setup time remaining: 5:00/);
  ui.tick(60000);
  assert.match(ui.nodeText("#setup-clock"), /Setup time remaining: 4:00/);
  ui.tick(239999);
  assert.match(ui.nodeText("#setup-clock"), /Setup time remaining: 0:01/);
  ui.tick(1);
  assert.match(ui.html, /Setup paused/);
  assert.doesNotMatch(ui.html, /id="setup-clock"/);
  assert.equal(ui.calls.filter((c) => c === "close-account").length, 1);
});

async function recoveryOffer(ui) {
  ui.tick();
  const ready = ui.sent.find((m) => m.kind === "ready");
  const offer = {
    protocol: "continuity-handoff/v2",
    kind: "offer",
    step: 1,
    aNonce: "a".repeat(64),
    bNonce: ready.bNonce,
    payload: {
      context: contextFor(
        createRuntime(config()).policy,
        "0x4444444444444444444444444444444444444444",
        `0x${"6".repeat(64)}`,
      ),
    },
  };
  await ui.message(offer);
  return offer;
}
test("public offer sends no key; an old begin request cannot cross a pause and renewed handshake", async () => {
  const ui = await boot();
  await ui.click("#prepare");
  await ui.click("#prepare");
  const ready = {
    protocol: "continuity-handoff/v2",
    kind: "ready",
    step: 0,
    bNonce: "b".repeat(64),
  };
  await ui.message(ready);
  const offer = ui.sent.find((m) => m.kind === "offer");
  assert.deepEqual(Object.keys(offer.payload), ["context"]);
  const oldBegin = { ...ready, kind: "begin", step: 2, aNonce: offer.aNonce };
  await ui.click("#pause-setup");
  await ui.message(oldBegin);
  await ui.click("#prepare");
  await ui.click("#prepare");
  await ui.message(ready);
  await ui.message(oldBegin);
  assert.equal(ui.sent.filter((m) => m.kind === "grant").length, 0);
  const fresh = ui.sent.filter((m) => m.kind === "offer").at(-1);
  assert.notEqual(fresh.aNonce, offer.aNonce);
  await ui.message({ ...oldBegin, aNonce: fresh.aNonce });
  assert.equal(ui.sent.filter((m) => m.kind === "grant").length, 1);
  ui.expire();
  assert.match(ui.html, /id="prepare" disabled>Setup ended/);
  assert.doesNotMatch(ui.html, /Continue setup with passkey/);
});
test("cancelled B ceremony cannot create another credential after a grant", async () => {
  const ui = await boot({ recovery: true, opener: true, search: "?enroll=1" });
  const offer = await recoveryOffer(ui);
  await ui.click("#enroll");
  assert.equal(ui.calls.filter((c) => c === "create-backup").length, 0);
  const grant = {
    ...offer,
    kind: "grant",
    step: 3,
    payload: { ...offer.payload, dataKey: new Uint8Array(32).fill(7) },
  };
  await ui.message(grant);
  assert.equal(ui.calls.filter((c) => c === "create-backup").length, 1);
  assert.match(ui.html, /Setup needs review/);
  assert.doesNotMatch(ui.html, /id="enroll"/);
  await ui.message(grant);
  assert.equal(ui.calls.filter((c) => c === "create-backup").length, 1);
  assert.equal(ui.sent.filter((m) => m.kind === "backup").length, 0);
});
test("a late B native result after expiry cannot publish backup bytes", async () => {
  let finish;
  const ui = await boot({
    recovery: true,
    opener: true,
    search: "?enroll=1",
    backupResult: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const offer = await recoveryOffer(ui);
  await ui.click("#enroll");
  await ui.message({
    ...offer,
    kind: "grant",
    step: 3,
    payload: { ...offer.payload, dataKey: new Uint8Array(32).fill(7) },
  });
  assert.equal(ui.calls.filter((c) => c === "create-backup").length, 1);
  ui.expire();
  finish({ synthetic: true });
  await settle();
  assert.equal(ui.sent.filter((m) => m.kind === "backup").length, 0);
  assert.doesNotMatch(ui.html, /id="enroll"/);
});
test("idle signer expiry pauses before any popup and pagehide permanently retires the RAM draft", async () => {
  const ui = await boot();
  await ui.click("#prepare");
  ui.tick(600000);
  assert.match(ui.html, /Continue setup with passkey/);
  assert.equal(ui.opened.length, 0);
  ui.pagehide();
  ui.pageshow();
  assert.match(ui.html, /This page session has ended/);
  await ui.click("#prepare");
  assert.equal(ui.calls.filter((c) => c === "resume-primary").length, 0);
  assert.equal(ui.opened.length, 0);
});
test("primary restoration finishing after pagehide closes its new signer instead of installing it", async () => {
  let finish, restoredAccount;
  const ui = await boot({
    restoreResult: (account) => {
      restoredAccount = account;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await ui.click("#restore");
  ui.pagehide();
  ui.pageshow();
  finish({
    state: restoredAccount,
    recovered: { content: { title: "Must not be installed" } },
  });
  await settle();
  assert.equal(ui.calls.filter((c) => c === "close-account").length, 1);
  assert.doesNotMatch(
    ui.html,
    /Same account\. Same private workspace|Must not be installed/,
  );
  assert.match(ui.html, /This page session has ended/);
});

const checkpointFixture = {
  title: "SYNTHETIC reconciliation draft",
  plan: "No physical credentials or real chain calls",
  tasks: [],
  draft: "v1",
};
async function openCheckpoint() {
  const ui = await boot({
    restoreResult: (account) => ({
      state: account,
      recovered: { content: structuredClone(checkpointFixture), version: "1" },
    }),
  });
  await ui.click("#restore");
  return ui;
}
test("unchanged restored content and edit-then-revert never call the writer", async () => {
  const ui = await openCheckpoint();
  assert.equal(ui.disabled("#save"), true);
  assert.match(ui.html, /No unsaved changes/);
  const before = [...ui.calls];
  // Deliberately invoke the disabled handler: markup alone is not the guard.
  await ui.click("#save");
  for (const field of ["title", "plan", "draft"]) {
    ui.input(`#${field}`, `${checkpointFixture[field]} `);
    assert.equal(ui.disabled("#save"), false, "Whitespace is content here");
    assert.equal(ui.nodeText("#save"), "Save checkpoint");
    ui.input(`#${field}`, checkpointFixture[field]);
    assert.equal(ui.disabled("#save"), true);
    assert.equal(ui.nodeText("#save"), "No unsaved changes");
    await ui.click("#save");
  }
  assert.deepEqual(ui.calls, before);
});
test("changed content saves once and its confirmed snapshot blocks a duplicate", async () => {
  const ui = await openCheckpoint();
  ui.input("#draft", "v1 ");
  ui.saved({ ...checkpointFixture, draft: "v1 " });
  await ui.click("#save");
  assert.match(ui.html, /Verified checkpoint v2/);
  assert.equal(ui.disabled("#save"), true);
  await ui.click("#save");
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 1);
});
test("enrollment reconciliation requires verified content before another save", async () => {
  const ui = await boot();
  ui.pending();
  await ui.enroll();
  ui.prepared();
  await ui.check();
  assert.match(nextStep(ui.html), /Open the confirmed checkpoint/i);
  assert.match(nextStep(ui.html), /id="restore"/);
  ui.input("#draft", "Unverified local draft after enrollment");
  assert.equal(ui.disabled("#save"), true);
  await ui.click("#save");
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 0);
  assert.match(ui.html, /Unverified local draft after enrollment/);
});
test("confirmed initial enrollment accepts the edited setup snapshot without a duplicate save", async () => {
  const ui = await boot();
  ui.input("#draft", "Synthetic edited first checkpoint");
  ui.prepared();
  await ui.enroll();
  assert.match(ui.html, /Synthetic edited first checkpoint/);
  assert.match(ui.html, /Verified checkpoint v1/);
  assert.doesNotMatch(ui.html, /Unsaved local changes/);
  assert.equal(ui.disabled("#save"), true);
  await ui.click("#save");
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 0);
});
test("a conflicting changed save preserves the draft without retrying", async () => {
  const ui = await openCheckpoint();
  ui.input("#draft", "Local work after a competing save");
  ui.failNextSave();
  await ui.click("#save");
  assert.match(ui.html, /WRITE_CONFLICT/);
  assert.match(ui.html, /Local work after a competing save/);
  assert.match(ui.html, /Unsaved local changes/);
  assert.equal(ui.calls.filter((c) => c === "save-conflict").length, 1);
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 0);
});
async function pendingCheckpoint() {
  const ui = await boot({
    restoreResult: (account) => ({
      state: account,
      recovered: { content: structuredClone(checkpointFixture), version: "1" },
    }),
  });
  await ui.click("#restore");
  ui.input("#draft", "saved v2");
  ui.pending("commit");
  await ui.click("#save");
  return ui;
}

test("confirmed checkpoint marks the matching draft saved without another write", async () => {
  const ui = await pendingCheckpoint();
  ui.saved({ ...checkpointFixture, draft: "saved v2" });
  await ui.check();
  assert.match(ui.html, /id="edit-state">Verified checkpoint v2</);
  assert.doesNotMatch(
    ui.html,
    /Local changes · not committed|Unsaved local changes/,
  );
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 1);
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 1);
  assert.equal(ui.disabled("#save"), true);
  await ui.click("#save");
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 1);
});

test("receipt confirmation preserves and labels edits made after the pending save", async () => {
  const ui = await pendingCheckpoint();
  ui.input("#draft", "saved v2 plus later unsaved work");
  ui.saved({ ...checkpointFixture, draft: "saved v2" });
  await ui.check();
  assert.match(ui.html, /saved v2 plus later unsaved work/);
  assert.match(ui.html, /id="edit-state">Unsaved local changes</);
  assert.doesNotMatch(ui.html, /id="edit-state">Verified checkpoint/);
  assert.equal(ui.disabled("#save"), false);
});

test("pending confirmation blocks save, restore and reset without losing its ticket", async () => {
  const ui = await pendingCheckpoint();
  for (const id of ["save", "restore", "fresh"]) {
    assert.match(ui.html, new RegExp(`id="${id}" disabled`));
  }
  assert.match(ui.html, /id="edit-state">Transaction confirmation pending</);
  const callsBefore = [...ui.calls];
  // Invoke even the disabled handlers to check their guards, not just markup.
  for (const id of ["save", "restore", "fresh"]) await ui.click(`#${id}`);
  assert.deepEqual(ui.calls, callsBefore);
  ui.saved({ ...checkpointFixture, draft: "saved v2" }, true);
  await ui.check();
  assert.match(ui.html, /id="check-transaction"/);
  assert.match(ui.html, /id="save" disabled/);
  assert.match(ui.html, /Transaction confirmation pending/);
  ui.saved({ ...checkpointFixture, draft: "saved v2" });
  await ui.check();
  assert.doesNotMatch(ui.html, /id="check-transaction"/);
  assert.match(ui.html, /id="edit-state">Verified checkpoint v2</);
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 1);
});

function nextStep(html) {
  const guide = html.match(
    /<section class="step-guide"[^>]*>([\s\S]*?)<\/section>/,
  )?.[1];
  assert.ok(guide, "The next-step region must exist");
  assert.ok(
    html.indexOf('class="step-guide"') < html.indexOf('class="content-grid"'),
  );
  return guide;
}

test("existing-workspace action is discoverable before the editor and never creates a key", async () => {
  const ui = await boot({
    restoreResult: (account) => ({
      state: account,
      recovered: { content: structuredClone(checkpointFixture), version: "1" },
    }),
  });
  assert.match(nextStep(ui.html), /id="restore"/);
  assert.match(nextStep(ui.html), /id="prepare"/);
  await ui.click("#restore");
  assert.equal(ui.calls.filter((call) => call === "restore-primary").length, 1);
  assert.equal(ui.calls.filter((call) => call === "create-primary").length, 0);
  assert.equal(ui.opened.length, 0);
  assert.doesNotMatch(nextStep(ui.html), /id="prepare"/);
  assert.match(nextStep(ui.html), /href="#workspace"/);
});

test("recovery setup exposes its action beside guidance only while its bound offer is usable", async () => {
  const ui = await boot({ recovery: true, opener: true, search: "?enroll=1" });
  assert.doesNotMatch(nextStep(ui.html), /id="(?:enroll|recover)"/);
  await recoveryOffer(ui);
  assert.match(nextStep(ui.html), /id="enroll"/);
  assert.doesNotMatch(nextStep(ui.html), /id="recover"/);
  ui.closePeer();
  assert.doesNotMatch(ui.html, /id="(?:enroll|recover)"/);
  assert.deepEqual(ui.calls, ["local-status"]);
  const existing = await boot({ recovery: true });
  assert.match(nextStep(existing.html), /id="recover"/);
  assert.doesNotMatch(existing.html, /id="enroll"/);
});

test("a failed status read retains a prominent read-only action and never reopens enrollment", async () => {
  const ui = await pendingCheckpoint();
  ui.failNextRead();
  await ui.check();
  assert.match(ui.html, /FRESHNESS_UNAVAILABLE/);
  assert.match(nextStep(ui.html), /WAITING FOR CONFIRMATION/);
  assert.match(nextStep(ui.html), /id="check-transaction"/);
  assert.doesNotMatch(ui.html, /id="prepare"/);
  assert.match(ui.html, /id="save" disabled/);
  ui.saved({ ...checkpointFixture, draft: "saved v2" });
  await ui.check();
  assert.match(ui.html, /Transaction confirmed/);
  assert.equal(ui.calls.filter((call) => call === "save-checkpoint").length, 1);
  assert.equal(
    ui.calls.filter((call) => call === "reconcile-checkpoint").length,
    1,
  );
  assert.equal(ui.calls.filter((call) => call === "create-primary").length, 0);
});

const publicProfile = {
  format: "continuity-demo-release/v1",
  deploymentId: "public-demo-ui-fixture",
  aOrigin: "https://a.fixture.invalid",
  bOrigin: "https://b.fixture.invalid",
  storeOrigin: "https://store.fixture.invalid",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
test("release client forces physical mode, reads no local controls and locks enrollment without a capability", async () => {
  const ui = await boot({ releaseConfig: publicProfile });
  assert.equal(ui.synthetic, false);
  assert.deepEqual(ui.calls, []);
  assert.doesNotMatch(ui.html, /id="(?:outage|scenario|test-tools)"/);
  assert.match(ui.html, /Demo upload code/);
  assert.equal(ui.disabled("#prepare"), true);
  await ui.click("#prepare");
  assert.deepEqual(ui.calls, []);
  ui.setValue("#upload-code", "a".repeat(64));
  await ui.click("#unlock-uploads");
  assert.equal(ui.disabled("#prepare"), false);
  assert.doesNotMatch(ui.html, /a{64}/);
  assert.deepEqual(ui.calls, ["presenter-access"]);
});
test("release recovery has no upload code or primary availability claim and makes no initial request", async () => {
  const ui = await boot({ releaseConfig: publicProfile, recovery: true });
  assert.deepEqual(ui.calls, []);
  assert.doesNotMatch(
    ui.html,
    /id="(?:upload-code|unlock-uploads|prepare|outage|scenario)"/,
  );
  assert.doesNotMatch(ui.html, /Primary available/);
  assert.match(ui.html, /id="recover"/);
});

test("invalid presenter capability cannot trigger native enrollment", async () => {
  const ui = await boot({
    releaseConfig: publicProfile,
    rejectPresenter: true,
  });
  ui.setValue("#upload-code", "incomplete");
  await ui.click("#unlock-uploads");
  assert.match(ui.html, /The demo code is incomplete or invalid/);
  assert.deepEqual(ui.calls, []);
  ui.setValue("#upload-code", "a".repeat(64));
  await ui.click("#unlock-uploads");
  assert.match(ui.html, /Demo access was not accepted/);
  assert.equal(ui.disabled("#prepare"), true);
  await ui.click("#prepare");
  assert.deepEqual(ui.calls, ["presenter-access"]);
});

// These checks execute the real UI scheduler with a controlled clock and SDK
// outcomes. They make no network requests and never create native credentials.
test("automatic enrollment checks resolve the existing ticket once without signing again", async () => {
  const ui = await boot();
  ui.pending();
  await ui.enroll();
  assert.match(nextStep(ui.html), /checks confirmation automatically/);
  ui.tick(1999);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "reconcile-enrollment").length, 0);
  ui.tick(1);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "reconcile-enrollment").length, 1);
  ui.prepared();
  ui.tick(5000);
  await settle();
  ui.confirmed();
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 1);
  ui.tick(300000);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "reconcile-enrollment").length, 2);
  assert.equal(ui.calls.filter((c) => c === "create-primary").length, 1);
});

test("automatic checkpoint checks preserve later edits and perform no second save", async () => {
  const ui = await pendingCheckpoint();
  ui.input("#draft", "Saved v2 plus a later edit");
  ui.saved({ ...checkpointFixture, draft: "saved v2" });
  ui.tick(2000);
  await settle();
  assert.match(ui.html, /Saved v2 plus a later edit/);
  assert.match(ui.html, /id="edit-state">Unsaved local changes</);
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 1);
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 1);
  ui.tick(300000);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 1);
});

test("five bounded automatic checks stop honestly and leave manual status and export available", async () => {
  const ui = await pendingCheckpoint();
  for (const delay of [2000, 5000, 10000, 20000, 30000]) {
    ui.tick(delay);
    await settle();
  }
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 5);
  assert.match(ui.html, /Confirmation is taking longer than expected/);
  assert.match(ui.html, /Automatic checks have stopped/);
  assert.match(ui.html, /id="check-transaction"/);
  assert.match(ui.html, /id="export-ticket"/);
  assert.doesNotMatch(ui.html, /Transaction confirmed\./);
  ui.tick(300000);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 5);
  ui.saved({ ...checkpointFixture, draft: "saved v2" });
  await ui.check();
  assert.match(ui.html, /Transaction confirmed\./);
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 1);
});

test("a background-tab delay past the two-minute window makes no overdue network check", async () => {
  const ui = await pendingCheckpoint();
  ui.tick(120001);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 0);
  assert.match(ui.html, /Automatic checks have stopped/);
  assert.match(ui.html, /id="export-ticket"/);
});

test("a failed automatic status read stops its retries and keeps the exact pending action", async () => {
  const ui = await pendingCheckpoint();
  ui.failNextRead();
  ui.tick(2000);
  await settle();
  assert.match(ui.html, /FRESHNESS_UNAVAILABLE/);
  assert.match(nextStep(ui.html), /Check the existing transaction/);
  assert.match(ui.html, /id="check-transaction"/);
  assert.match(ui.html, /id="save" disabled/);
  ui.tick(10000);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "failed-status-read").length, 1);
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 0);
  ui.saved({ ...checkpointFixture, draft: "saved v2" });
  await ui.check();
  assert.match(ui.html, /Transaction confirmed\./);
});

test("a manual status check takes over from scheduled checks without restarting their budget", async () => {
  const ui = await pendingCheckpoint();
  await ui.check();
  ui.tick(10000);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 1);
  assert.match(ui.html, /id="export-ticket"/);
});

test("an in-flight automatic check cannot overlap manual checks or publish a late pagehide result", async () => {
  const ui = await pendingCheckpoint();
  const finish = ui.deferNextRead();
  ui.tick(2000);
  await settle();
  assert.match(nextStep(ui.html), /Checking the existing transaction/);
  assert.doesNotMatch(nextStep(ui.html), /Follow any device prompt/);
  assert.equal(ui.disabled("#check-transaction"), true);
  await ui.check(); // Deliberately invoke a disabled handler to test its guard.
  ui.tick(30000);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 1);
  ui.pagehide();
  ui.pageshow();
  ui.saved({ ...checkpointFixture, draft: "saved v2" });
  finish();
  await settle();
  ui.tick(30000);
  await settle();
  assert.match(ui.html, /This page session has ended/);
  assert.doesNotMatch(ui.html, /Transaction confirmed\./);
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 1);
});

test("expiry waits for an in-flight enrollment status read and cannot overwrite a confirmed result", async () => {
  const ui = await boot();
  ui.pending();
  await ui.enroll();
  const finish = ui.deferNextRead();
  ui.tick(2000);
  await settle();
  ui.expire();
  assert.equal(ui.calls.filter((c) => c === "close-account").length, 0);
  ui.prepared();
  finish();
  await settle();
  ui.confirmed();
  assert.equal(ui.calls.filter((c) => c === "close-account").length, 0);
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 0);
  assert.doesNotMatch(ui.html, /Reserve preparation expired/);
});

test("a wrapped B with an expired channel offers fresh existing-key recovery without claiming success", async () => {
  const ui = await boot({
    recovery: true,
    opener: true,
    search: "?enroll=1&mode=physical",
    backupResult: () => ({ synthetic: true }),
  });
  const offer = await recoveryOffer(ui);
  await ui.click("#enroll");
  await ui.message({
    ...offer,
    kind: "grant",
    step: 3,
    payload: { ...offer.payload, dataKey: new Uint8Array(32).fill(7) },
  });
  assert.match(ui.html, /Reserve wrapped/);
  ui.expire();
  await settle();
  assert.match(nextStep(ui.html), /The setup connection ended/);
  assert.match(nextStep(ui.html), /id="fresh-recovery"/);
  assert.match(
    nextStep(ui.html),
    /href="http:\/\/recovery.localhost:4174\/\?mode=physical" target="_blank" rel="noopener noreferrer"/,
  );
  assert.doesNotMatch(
    ui.html,
    /id="(?:enroll|recover)"|Reserve preparation expired|Reserve prepared and independently checked/,
  );
  const before = ui.sent.length;
  await ui.message({ ...offer, kind: "committed", step: 5, payload: {} });
  ui.tick();
  assert.equal(ui.sent.length, before, "Expired handoff remains closed");
  assert.equal(ui.calls.filter((c) => c === "create-backup").length, 1);
});

test("cloned unresolved tickets and a finalized head share the original automatic retry budget", async () => {
  const ui = await boot({ cloneTickets: true });
  ui.pending();
  await ui.enroll();
  ui.tick(2000);
  await settle();
  ui.prepared(true);
  for (const delay of [5000, 10000, 20000, 30000]) {
    ui.tick(delay);
    await settle();
  }
  assert.equal(ui.calls.filter((c) => c === "reconcile-enrollment").length, 5);
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 1);
  assert.match(ui.html, /Automatic checks have stopped/);
  assert.match(ui.html, /id="check-transaction"/);
  ui.tick(300000);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "reconcile-enrollment").length, 5);
  ui.prepared();
  await ui.check();
  ui.confirmed();
});

test("a reverted transaction halts automatic checking and never resends the save", async () => {
  const ui = await pendingCheckpoint();
  ui.failNextRead("TRANSACTION_REVERTED");
  ui.tick(2000);
  await settle();
  assert.match(ui.html, /The transaction reverted/);
  assert.match(ui.html, /This transaction did not save the checkpoint/);
  assert.match(ui.html, /Automatic checks have stopped/);
  assert.match(nextStep(ui.html), /TRANSACTION REVERTED/);
  assert.match(nextStep(ui.html), /This checkpoint was not saved/);
  assert.doesNotMatch(
    nextStep(ui.html),
    /WAITING FOR CONFIRMATION|Check the existing transaction/,
  );
  assert.doesNotMatch(ui.html, /id="check-transaction"/);
  assert.match(
    ui.html,
    /id="edit-state">Transaction reverted · draft not saved</,
  );
  assert.match(ui.html, /id="export-ticket"/);
  assert.equal(ui.disabled("#save"), true);
  assert.equal(ui.disabled("#restore"), true);
  assert.match(ui.html, /saved v2/);
  ui.tick(300000);
  await settle();
  assert.equal(ui.calls.filter((c) => c === "failed-status-read").length, 1);
  assert.equal(ui.calls.filter((c) => c === "reconcile-checkpoint").length, 0);
  assert.equal(ui.calls.filter((c) => c === "save-checkpoint").length, 1);
});

test("handoff expiry revokes signing while finalize is still uploading, before its result can queue", async () => {
  let finishUpload;
  let signingAttempts = 0;
  const ui = await boot({
    beforeFinalize: async (account) => {
      await new Promise((resolve) => {
        finishUpload = resolve;
      });
      account.writer.assertActive();
      signingAttempts++;
    },
  });
  ui.pending();
  await ui.enroll();
  assert.equal(signingAttempts, 0);
  ui.expire();
  assert.equal(ui.calls.filter((c) => c === "close-writer").length, 1);
  finishUpload();
  await settle();
  assert.equal(
    signingAttempts,
    0,
    "Expiry cannot extend authority through an awaited upload",
  );
  assert.equal(ui.calls.filter((c) => c === "finalize-enrollment").length, 0);
  assert.equal(ui.sent.filter((m) => m.kind === "committed").length, 0);
  assert.doesNotMatch(
    ui.html,
    /id="check-transaction"|Reserve prepared and transaction confirmed/,
  );
});
