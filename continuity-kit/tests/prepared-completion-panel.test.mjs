import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createRuntime } from "../src/runtime.ts";
const source = readFileSync(
  new URL("../src/prepared-completion-panel.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText;
const approved = JSON.parse(
  readFileSync(
    new URL("../testnet/runtime-candidate-foundation.json", import.meta.url),
    "utf8",
  ),
);
const settle = () => new Promise((r) => setImmediate(r));
async function boot({
  config = approved,
  origin = approved.policy.aOrigin,
  late = false,
} = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const calls = [];
  let finish;
  const repair = {
    content: { title: "SYNTHETIC" },
    ticket: undefined,
    close() {
      calls.push("close");
    },
    async complete() {
      calls.push("complete");
      this.ticket = { transactionHash: "synthetic" };
      return { status: "unresolved" };
    },
    async reconcile() {
      calls.push("reconcile");
      return { status: "unresolved" };
    },
  };
  const context = vm.createContext({
    exports: {},
    __CONTINUITY_TESTNET_CONFIG__: config,
    location: { origin },
    AbortController,
    document: {
      querySelector(id) {
        if (!nodes.has(id))
          nodes.set(id, {
            disabled: true,
            textContent: "",
            handlers: new Map(),
            addEventListener(e, f) {
              this.handlers.set(e, f);
            },
          });
        return nodes.get(id);
      },
    },
    window: {
      addEventListener(e, f) {
        listeners.set(e, f);
      },
    },
    require(path) {
      if (path === "./runtime.ts") return { createRuntime };
      if (path === "./sdk/passkeys.ts") return { MeraPasskeyAdapter: class {} };
      if (path === "../testnet/complete-prepared.ts")
        return {
          async openPreparedCompletion(p, pin, _keys, a, signal) {
            calls.push("open");
            assert.equal(p.registryAddress, approved.policy.registryAddress);
            assert.equal(
              pin.owner,
              "0x5ff3d5ff4794a7abdf7a888aa58b72a6aaff633c",
            );
            assert.equal(a.sessionLimits.maxTransactions, 1);
            assert.equal(a.sessionLimits.maxTotalFeeWei, 60000000000000000n);
            assert.equal(signal.aborted, false);
            if (late)
              return new Promise((r) => {
                finish = () => r(repair);
              });
            return repair;
          },
        };
      assert.fail("Unexpected import " + path);
    },
  });
  vm.runInContext(compiled, context);
  const click = async (id) => {
    nodes.get(id).handlers.get("click")?.();
    await settle();
  };
  return {
    nodes,
    calls,
    click,
    end: () => listeners.get("pagehide")(),
    finish: () => finish?.(),
  };
}
test("completion panel starts with no authentication or chain action; only explicit gestures open and submit once", async () => {
  const ui = await boot();
  assert.deepEqual(ui.calls, []);
  assert.equal(ui.nodes.get("#open").disabled, false);
  assert.equal(ui.nodes.get("#complete").disabled, true);
  await ui.click("#complete");
  assert.deepEqual(ui.calls, []);
  await ui.click("#open");
  assert.deepEqual(ui.calls, ["open"]);
  await ui.click("#complete");
  await ui.click("#complete");
  await ui.click("#open");
  assert.deepEqual(ui.calls, ["open", "complete"]);
  await ui.click("#reconcile");
  assert.deepEqual(ui.calls, ["open", "complete", "reconcile"]);
  ui.end();
  await ui.click("#complete");
  assert.equal(ui.nodes.get("#complete").disabled, true);
});
test("completion panel is dormant outside the reviewed origin/runtime and discards late authentication", async () => {
  for (const options of [
    { origin: approved.policy.bOrigin },
    { config: null },
  ]) {
    const ui = await boot(options);
    await ui.click("#open");
    assert.deepEqual(ui.calls, []);
    assert.equal(ui.nodes.get("#open").disabled, true);
  }
  const ui = await boot({ late: true });
  await ui.click("#open");
  ui.end();
  ui.finish();
  await settle();
  assert.deepEqual(ui.calls, ["open", "close"]);
  assert.equal(ui.nodes.get("#complete").disabled, true);
});
