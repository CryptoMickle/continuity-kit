import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONTROL_URL,
  TESTNET_RUNTIME_CODE_HASH,
  createRuntime,
  validateTestnetRuntimeConfig,
} from "../src/runtime.ts";
import type { TestnetRuntimeConfig } from "../src/runtime.ts";
import {
  LOCAL_POLICY,
  contextFor,
  validateContext,
} from "../src/sdk/policy.ts";
import { HttpMirrorStore, HttpRegistry } from "../src/sdk/stores.ts";
import {
  MonadRegistryReader,
  HttpTransactionTransport,
} from "../src/sdk/monad-registry.ts";
import { ContinuityError } from "../src/sdk/types.ts";

function fixture(): TestnetRuntimeConfig {
  const { registryUrl: _unused, ...common } = LOCAL_POLICY;
  return {
    kind: "monad-testnet",
    controlUrl: CONTROL_URL,
    policy: {
      ...common,
      deploymentId: "OFFLINE-TEST-ONLY-monad-v1",
      bootstrapNamespace: "continuity-kit/OFFLINE-TEST-ONLY/testnet/v1",
      chainId: "10143",
      trustMode: "trusted-rpc-quorum",
      registryAddress: "0x2222222222222222222222222222222222222222",
      registryCodeHash: TESTNET_RUNTIME_CODE_HASH,
      rpcUrls: [
        "https://testnet-rpc.monad.xyz",
        "https://monad-testnet.drpc.org",
      ],
      mirrorUrls: [...LOCAL_POLICY.mirrorUrls],
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
const invalid = (error: unknown) =>
  error instanceof ContinuityError && error.code === "POLICY_INVALID";

test("default and explicit runtime constructors perform no network or authentication", () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("No network permitted");
  };
  try {
    const local = createRuntime();
    assert.equal(local.kind, "local");
    assert.equal(local.policy, LOCAL_POLICY);
    assert.equal(local.requirePhysicalPasskeys, false);
    assert.equal(local.controlUrl, CONTROL_URL);
    assert.ok(local.adapters.registry instanceof HttpRegistry);
    assert.equal(local.adapters.trustMode, "local-model");
    if (local.adapters.trustMode === "local-model")
      assert.equal(local.adapters.localWriter, local.adapters.registry);
    const chain = createRuntime(JSON.parse(JSON.stringify(fixture())));
    assert.equal(chain.kind, "monad-testnet");
    assert.equal(chain.requirePhysicalPasskeys, true);
    assert.equal(chain.controlUrl, CONTROL_URL);
    assert.ok(chain.adapters.registry instanceof MonadRegistryReader);
    assert.equal(chain.adapters.trustMode, "trusted-rpc-quorum");
    if (chain.adapters.trustMode === "trusted-rpc-quorum") {
      assert.ok(
        chain.adapters.transactions instanceof HttpTransactionTransport,
      );
      assert.equal(
        chain.adapters.sessionLimits.maxTotalFeeWei,
        180000000000000000n,
      );
      assert.ok(Object.isFrozen(chain.adapters.sessionLimits));
      assert.equal(
        chain.adapters.sessionLimits.maxGas *
          chain.adapters.sessionLimits.maxFeePerGas *
          BigInt(chain.adapters.sessionLimits.maxTransactions),
        chain.adapters.sessionLimits.maxTotalFeeWei,
      );
    }
    for (const runtime of [local, chain]) {
      assert.ok(Object.isFrozen(runtime));
      assert.ok(Object.isFrozen(runtime.adapters));
      assert.ok(Object.isFrozen(runtime.adapters.mirrors));
      assert.ok(
        runtime.adapters.mirrors.every(
          (store) => store instanceof HttpMirrorStore,
        ),
      );
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("runtime code hash matches pinned deployment artifact review", () => {
  const proposal = JSON.parse(
    readFileSync(
      new URL("../testnet/deployment-proposal.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(TESTNET_RUNTIME_CODE_HASH, proposal.expectedRuntimeCodeHash);
});

test("explicit Foundation candidate preserves the fixed primary endpoint and rejects unreviewed pair changes", () => {
  const candidate = JSON.parse(
    readFileSync(
      new URL("../testnet/runtime-candidate-foundation.json", import.meta.url),
      "utf8",
    ),
  );
  const approved = validateTestnetRuntimeConfig(candidate);
  assert.deepEqual(approved.policy.rpcUrls, [
    "https://testnet-rpc.monad.xyz",
    "https://rpc-testnet.monadinfra.com",
  ]);
  candidate.policy.rpcUrls[1] = "https://changed.invalid";
  assert.equal(
    approved.policy.rpcUrls[1],
    "https://rpc-testnet.monadinfra.com",
  );
  assert.ok(Object.isFrozen(approved.policy.rpcUrls));
  for (const pair of [
    ["https://changed.invalid", "https://rpc-testnet.monadinfra.com"],
    ["https://testnet-rpc.monad.xyz", "https://rpc-testnet.monadinfra.com/"],
    ["https://testnet-rpc.monad.xyz", "https://rpc.monad.xyz"],
    ["https://testnet-rpc.monad.xyz", "https://testnet-rpc.monad.xyz"],
    [...approved.policy.rpcUrls, "https://extra.invalid"],
  ]) {
    candidate.policy.rpcUrls = pair;
    assert.throws(() => validateTestnetRuntimeConfig(candidate), invalid);
  }
});

test("validated config is serializable, detached, frozen and does not bind local credentials", () => {
  const input = fixture();
  const copy = validateTestnetRuntimeConfig(input);
  assert.deepEqual(JSON.parse(JSON.stringify(copy)), input);
  input.policy.registryAddress = "0x3333333333333333333333333333333333333333";
  input.policy.rpcUrls = ["https://changed.invalid", "https://other.invalid"];
  input.sessionLimits.maxTransactions = 100;
  assert.equal(
    copy.policy.registryAddress,
    "0x2222222222222222222222222222222222222222",
  );
  assert.equal(copy.sessionLimits.maxTransactions, 3);
  for (const value of [
    copy,
    copy.policy,
    copy.policy.rpcUrls,
    copy.policy.mirrorUrls,
    copy.sessionLimits,
  ])
    assert.ok(Object.isFrozen(value));
  assert.throws(
    () =>
      validateContext(
        contextFor(
          LOCAL_POLICY,
          "0x1111111111111111111111111111111111111111",
          `0x${"1".repeat(64)}`,
        ),
        copy.policy,
      ),
    (e: unknown) =>
      e instanceof ContinuityError && e.code === "CONTEXT_MISMATCH",
  );
});

test("only absent config selects local; incomplete or extra config fails closed", () => {
  for (const bad of [
    null,
    false,
    "local",
    {},
    { kind: "local" },
    { ...fixture(), extra: true },
    { ...fixture(), controlUrl: "https://elsewhere.invalid" },
  ])
    assert.throws(() => createRuntime(bad), invalid);
  for (const field of Object.keys(fixture())) {
    const input = fixture() as unknown as Record<string, unknown>;
    delete input[field];
    assert.throws(() => createRuntime(input), invalid, field);
  }
  for (const field of Object.keys(fixture().policy)) {
    const input = fixture();
    delete (input.policy as unknown as Record<string, unknown>)[field];
    assert.throws(() => createRuntime(input), invalid, field);
  }
});

test("reject policy substitution, local identity reuse and endpoint changes", () => {
  const mutations: Record<string, unknown> = {
    protocol: "other",
    applicationId: "other",
    schemaId: "other",
    deploymentId: LOCAL_POLICY.deploymentId,
    bootstrapNamespace: LOCAL_POLICY.bootstrapNamespace,
    aOrigin: "http://primary.localhost:4183",
    bOrigin: "http://recovery.localhost:4184",
    aRpId: "other.localhost",
    bRpId: "other.localhost",
    chainId: "31337",
    registryAddress: `0x${"0".repeat(40)}`,
    registryCodeHash: `0x${"1".repeat(64)}`,
    rpcUrls: ["https://testnet-rpc.monad.xyz", "https://attacker.invalid"],
    mirrorUrls: [
      "http://localhost:4175/v1/mirrors/0",
      "https://attacker.invalid",
    ],
    finality: "latest",
    trustMode: "local-model",
    maxResponseBytes: 1048577,
    registryUrl: CONTROL_URL,
  };
  for (const [key, value] of Object.entries(mutations)) {
    const config = fixture();
    Object.assign(config.policy, { [key]: value });
    assert.throws(() => createRuntime(config), invalid, key);
  }
});

test("session caps reject all excess and noncanonical values, permit stricter caps", () => {
  for (const [key, value] of Object.entries({
    lifetimeMs: 600001,
    maxTransactions: 4,
    maxGas: "300001",
    maxFeePerGas: "200000000001",
    maxPriorityFeePerGas: "2000000001",
    maxTotalFeeWei: "180000000000000001",
    extra: 1,
  })) {
    const config = fixture();
    Object.assign(config.sessionLimits, { [key]: value });
    assert.throws(() => createRuntime(config), invalid, key);
  }
  for (const value of ["-1", "01", "1.0", "1e2", 300000, 300000n, "0"]) {
    const config = fixture();
    Object.assign(config.sessionLimits, { maxGas: value });
    assert.throws(() => createRuntime(config), invalid);
  }
  const config = fixture();
  config.sessionLimits = {
    lifetimeMs: 1000,
    maxTransactions: 1,
    maxGas: "21000",
    maxFeePerGas: "1",
    maxPriorityFeePerGas: "0",
    maxTotalFeeWei: "21000",
  };
  assert.doesNotThrow(() => createRuntime(config));
  config.sessionLimits.maxPriorityFeePerGas = "2";
  assert.throws(() => createRuntime(config), invalid);
});

test("configuration is JSON data, never executable getters or hidden fields", () => {
  let invoked = false;
  const accessor = fixture();
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() {
      invoked = true;
      return "monad-testnet";
    },
  });
  assert.throws(() => createRuntime(accessor), invalid);
  assert.equal(invoked, false);
  for (const key of ["hidden", Symbol("hidden")]) {
    const config = fixture();
    Object.defineProperty(config, key, { value: "ignored?" });
    assert.throws(() => createRuntime(config), invalid);
  }
  const arrayExtra = fixture();
  Object.assign(arrayExtra.policy.rpcUrls, { extra: true });
  assert.throws(() => createRuntime(arrayExtra), invalid);
});
