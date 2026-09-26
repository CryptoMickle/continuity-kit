import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { HandoffChannel } from "../src/handoff.ts";
import { LOCAL_POLICY } from "../src/sdk/policy.ts";
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
  const { search = "" } = options;
  const explicitConfig = Object.hasOwn(options, "explicitConfig")
    ? options.explicitConfig
    : config();
  const nodes = new Map();
  const listeners = new Map();
  const intervals = new Set();
  const calls = [];
  const sent = [];
  const popup = {
    closed: false,
    postMessage(data, origin) {
      assert.equal(origin, LOCAL_POLICY.bOrigin);
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
    "./sdk/policy.ts": {},
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
    location: { origin: LOCAL_POLICY.aOrigin, search },
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
      addEventListener(event, fn) {
        listeners.set(event, fn);
      },
      open(url) {
        assert.equal(url, `${LOCAL_POLICY.bOrigin}/?enroll=1&mode=physical`);
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
  const message = async (data) => {
    listeners.get("message")({
      origin: LOCAL_POLICY.bOrigin,
      source: popup,
      data,
    });
    await settle();
  };
  return {
    calls,
    sent,
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
