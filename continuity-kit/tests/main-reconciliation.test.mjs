import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { HandoffChannel } from "../src/handoff.ts";
import {
  contextFor,
  LOCAL_POLICY,
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
  const nodes = new Map();
  const listeners = new Map();
  const intervals = new Set();
  const calls = [];
  const sent = [];
  const opened = [];
  const popup = {
    closed: false,
    postMessage(data, origin) {
      assert.equal(
        origin,
        recovery ? LOCAL_POLICY.aOrigin : LOCAL_POLICY.bOrigin,
      );
      sent.push(data);
    },
  };
  let now = 1000;
  let html = "";
  let passkeyClient;
  let outcome;
  const ticket = { command: { operation: "create" } };
  const capsuleDigest = `0x${"3".repeat(64)}`;
  const account = {
    context: {
      owner: "0x4444444444444444444444444444444444444444",
    },
    dataKey: new Uint8Array(32),
    manifestDigest: `0x${"5".repeat(64)}`,
    enrollment: { capsuleDigest },
    writer: { pendingTicket: ticket },
    close() {
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
      for (const [, id] of value.matchAll(/\bid="([^"]+)"/g)) {
        nodes.set(`#${id}`, {
          handlers: new Map(),
          addEventListener(event, fn) {
            this.handlers.set(event, fn);
          },
        });
      }
    },
  };
  const sdkResult = (action) => {
    calls.push(action);
    assert.ok(outcome, "A synthetic SDK outcome must be supplied");
    account.writer.pendingTicket =
      outcome.status === "pending" ? ticket : outcome.unresolvedTicket;
    return outcome;
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
    "./sdk/policy.ts": { validateContext },
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
    "./sdk/index.ts": {
      async finalizeEnrollment() {
        return sdkResult("finalize-enrollment");
      },
      async reconcileEnrollment() {
        return sdkResult("reconcile-enrollment");
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
    physicalEnv: "false",
    location: {
      origin: recovery ? LOCAL_POLICY.bOrigin : LOCAL_POLICY.aOrigin,
      search,
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
      assert.equal(url, `${CONTROL_URL}/v1/status`);
      calls.push("local-status");
      return {
        json: async () => ({ primaryOnline: true, scenario: "healthy" }),
      };
    },
    setTimeout() {},
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
  assert.deepEqual(calls, ["local-status"]);
  const click = async (selector) => {
    const handler = nodes.get(selector)?.handlers.get("click");
    assert.ok(handler, `${selector} must be visible and wired`);
    handler();
    await settle();
  };
  const message = async (data, overrides = {}) => {
    listeners.get("message")({
      origin: recovery ? LOCAL_POLICY.aOrigin : LOCAL_POLICY.bOrigin,
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
    message,
    nodeText(selector) {
      return nodes.get(selector)?.textContent;
    },
    closePeer() {
      popup.closed = true;
      for (const tick of [...intervals]) tick();
    },
    tick(ms = 500) {
      now += ms;
      for (const tick of [...intervals]) tick();
    },
    get html() {
      return html;
    },
    synthetic: passkeyClient instanceof FixtureClient,
    pending() {
      outcome = { status: "pending", ticket };
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
        protocol: "continuity-handoff/v1",
        kind: "ready",
        step: 0,
        bNonce: "b".repeat(64),
      });
      const offer = sent.find((m) => m.kind === "offer");
      assert.ok(offer, "The real handoff must send its bound offer");
      await message({
        protocol: "continuity-handoff/v1",
        kind: "backup",
        step: 2,
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
  assert.match(ui.html, /Reserve preparation expired\./);
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
    protocol: "continuity-handoff/v1",
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
      dataKey: new Uint8Array(32).fill(7),
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

test("expired or closed handoffs cannot reopen with the wiped primary account", async () => {
  for (const close of [false, true]) {
    const ui = await boot();
    await ui.click("#prepare");
    await ui.click("#prepare");
    if (close) ui.closePeer();
    else ui.expire();
    assert.match(ui.html, /id="prepare" disabled>Setup ended/);
    assert.equal(ui.calls.filter((c) => c === "close-account").length, 1);
    // Exercise the handler directly too: disabled markup is not the only guard.
    await ui.click("#prepare");
    assert.equal(ui.opened.length, 1);
    assert.equal(ui.calls.filter((c) => c === "create-primary").length, 1);
    await ui.message({
      protocol: "continuity-handoff/v1",
      kind: "ready",
      step: 0,
      bNonce: "b".repeat(64),
    });
    assert.equal(ui.sent.length, 0);
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
    protocol: "continuity-handoff/v1",
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
      dataKey: new Uint8Array(32).fill(7),
    },
  });
  ui.tick();
  assert.equal(ui.sent.length, count);
  assert.deepEqual(ui.calls, ["local-status"]);
  assert.doesNotMatch(ui.html, /id="(?:enroll|recover)"/);
});

test("setup time is disclosed before creating a primary key and does not extend on ticks", async () => {
  const ui = await boot();
  assert.match(ui.html, /window expires after five minutes/);
  await ui.click("#prepare");
  await ui.click("#prepare");
  assert.match(ui.html, /Setup time remaining: 5:00/);
  ui.tick(60000);
  assert.match(ui.nodeText("#setup-clock"), /Setup time remaining: 4:00/);
  ui.tick(239999);
  assert.match(ui.nodeText("#setup-clock"), /Setup time remaining: 0:01/);
  ui.tick(1);
  assert.match(ui.html, /Reserve preparation expired/);
  assert.doesNotMatch(ui.html, /id="setup-clock"/);
  assert.equal(ui.calls.filter((c) => c === "close-account").length, 1);
});
