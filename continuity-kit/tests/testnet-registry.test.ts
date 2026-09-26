import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  type Hex,
} from "viem";
import {
  MonadRegistryReader,
  boundedHttpRpc,
  createIntentBuilder,
  registryAbi,
  validatePolicy,
  type ReadRpc,
  type TestnetPolicy,
} from "../testnet/registry.ts";

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const owner = `0x${"11".repeat(20)}` as Hex,
  address = `0x${"22".repeat(20)}` as Hex;
const now = 1_800_000_000_000,
  code = "0x60006000" as Hex;
const policy: TestnetPolicy = {
  chainId: 10143,
  registryAddress: address,
  registryCodeHash: keccak256(code),
  rpcUrls: ["https://one.example/rpc", "https://two.example/rpc"],
  timeoutMs: 100,
  maxHeadAgeMs: 30_000,
  maxResponseBytes: 16_384,
};
const wire = (version = 1n, digest = id(3)) =>
  encodeFunctionResult({
    abi: registryAbi,
    functionName: "getHead",
    result: [true, id(2), version, digest],
  });
function fixture() {
  const state = {
    number: 100n,
    version: 1n,
    digest: id(3),
    timestamp: BigInt(now / 1000),
    hash: id(100),
  };
  const calls: { url: string; method: string; params: readonly unknown[] }[] =
    [];
  const rpc: ReadRpc = async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === "eth_chainId") return "0x279f";
    if (method === "eth_getBlockByNumber")
      return {
        number: `0x${state.number.toString(16)}`,
        hash: state.hash,
        timestamp: `0x${state.timestamp.toString(16)}`,
      };
    if (method === "eth_getCode") return code;
    return wire(state.version, state.digest);
  };
  return { state, calls, rpc };
}
test("testnet reader returns explicit trusted RPC evidence and pins code/call at common finalized block", async () => {
  const f = fixture();
  const result = await new MonadRegistryReader(
    policy,
    f.rpc,
    () => now,
  ).getHead(owner, id(1));
  assert.equal(result.version, "1");
  assert.equal(result.evidence.trustMode, "trusted-rpc-quorum");
  assert.equal(result.evidence.blockNumber, "100");
  assert.equal(result.evidence.finality, "finalized");
  for (const call of f.calls.filter(
    (c) => c.method === "eth_getCode" || c.method === "eth_call",
  ))
    assert.equal(call.params[1], "0x64");
  const call = f.calls.find((c) => c.method === "eth_call")!;
  assert.deepEqual(
    decodeFunctionData({
      abi: registryAbi,
      data: (call.params[0] as { data: Hex }).data,
    }).args,
    [owner, id(1)],
  );
  assert.ok(
    f.calls.every((c) =>
      [
        "eth_chainId",
        "eth_getBlockByNumber",
        "eth_getCode",
        "eth_call",
      ].includes(c.method),
    ),
  );
});
for (const failure of [
  "chain",
  "code",
  "stale",
  "future",
  "hash",
  "head",
  "missing-finality",
  "malformed-head",
  "reorg",
] as const) {
  test(`testnet reader fails closed: ${failure}`, async () => {
    const f = fixture();
    let blockCalls = 0;
    const rpc: ReadRpc = async (url, method, params, signal) => {
      if (failure === "chain" && method === "eth_chainId") return "0x1";
      if (failure === "code" && method === "eth_getCode") return "0x";
      if (method === "eth_getBlockByNumber") {
        if (failure === "missing-finality") return null;
        const b = (await f.rpc(url, method, params, signal)) as Record<
          string,
          unknown
        >;
        if (failure === "stale")
          b.timestamp = `0x${(BigInt(now / 1000) - 31n).toString(16)}`;
        if (failure === "future")
          b.timestamp = `0x${(BigInt(now / 1000) + 6n).toString(16)}`;
        if (failure === "hash" && url.includes("two")) b.hash = id(999);
        if (failure === "reorg" && ++blockCalls > 4) b.hash = id(999);
        return b;
      }
      if (failure === "head" && method === "eth_call" && url.includes("two"))
        return wire(2n, id(4));
      if (failure === "malformed-head" && method === "eth_call") return "0x01";
      return f.rpc(url, method, params, signal);
    };
    await assert.rejects(
      new MonadRegistryReader(policy, rpc, () => now).getHead(owner, id(1)),
      { code: "FRESHNESS_UNAVAILABLE" },
    );
  });
}
test("different finalized heights use their lower common block", async () => {
  const f = fixture();
  const rpc: ReadRpc = async (url, method, params, signal) => {
    const result = await f.rpc(url, method, params, signal);
    if (
      method === "eth_getBlockByNumber" &&
      params[0] === "finalized" &&
      url.includes("two")
    )
      return { ...(result as object), number: "0x65", hash: id(101) };
    return result;
  };
  assert.equal(
    (
      await new MonadRegistryReader(policy, rpc, () => now).getHead(
        owner,
        id(1),
      )
    ).evidence.blockNumber,
    "100",
  );
});
test("monotonic reader rejects block rollback and protects internal evidence from caller mutation", async () => {
  const f = fixture(),
    reader = new MonadRegistryReader(policy, f.rpc, () => now);
  const first = await reader.getHead(owner, id(1));
  first.version = "0";
  f.state.number = 99n;
  f.state.hash = id(99);
  await assert.rejects(reader.getHead(owner, id(1)), /regressed/);
});
test("monotonic reader rejects version rollback, same-version digest change and same-block advancement", async () => {
  for (const kind of ["rollback", "digest", "same-block"]) {
    const f = fixture();
    f.state.version = 2n;
    const reader = new MonadRegistryReader(policy, f.rpc, () => now);
    await reader.getHead(owner, id(1));
    if (kind !== "same-block") {
      f.state.number++;
      f.state.hash = id(101);
    }
    if (kind === "rollback") f.state.version = 1n;
    if (kind === "digest") f.state.digest = id(4);
    if (kind === "same-block") f.state.version = 3n;
    await assert.rejects(reader.getHead(owner, id(1)), {
      code: "FRESHNESS_UNAVAILABLE",
    });
  }
});
test("hanging injected RPC is bounded even if it ignores abort", async () => {
  await assert.rejects(
    new MonadRegistryReader(
      { ...policy, timeoutMs: 5 },
      async () => new Promise(() => {}),
      () => now,
    ).getHead(owner, id(1)),
    /timeout/,
  );
});
test("HTTP transport rejects oversized streaming responses and mismatched envelope IDs", async () => {
  const large = (async () => new Response("x".repeat(65))) as typeof fetch;
  await assert.rejects(
    boundedHttpRpc(64, large)(
      "https://one.example",
      "eth_chainId",
      [],
      new AbortController().signal,
    ),
    /limit/,
  );
  const wrong = (async () =>
    Response.json({
      jsonrpc: "2.0",
      id: 99,
      result: "0x279f",
    })) as typeof fetch;
  await assert.rejects(
    boundedHttpRpc(256, wrong)(
      "https://one.example",
      "eth_chainId",
      [],
      new AbortController().signal,
    ),
    /envelope/,
  );
});
test("policy rejects zero authority, wrong chain, duplicate hosts, insecure endpoints and unbounded settings", () => {
  for (const patch of [
    { registryAddress: `0x${"0".repeat(40)}` },
    { registryCodeHash: id(0) },
    { chainId: 1 },
    { rpcUrls: ["https://one.example/a", "https://one.example/b"] },
    { rpcUrls: ["http://one.example", "https://two.example"] },
    { maxHeadAgeMs: Infinity },
  ])
    assert.throws(() =>
      validatePolicy({ ...policy, ...patch } as TestnetPolicy),
    );
});
test("intent builder ABI encodes exact owner/stream/domain, zero value and CAS", () => {
  const scope = { owner, streamId: id(1) },
    input = { ...policy };
  const build = createIntentBuilder(input, scope);
  scope.streamId = id(99);
  input.registryAddress = owner;
  const create = build({
    operation: "create",
    manifestDigest: id(2),
    initialCapsuleDigest: id(3),
  });
  assert.equal(create.from, owner);
  assert.equal(create.to, address);
  assert.equal(create.chainId, 10143);
  assert.equal(create.value, "0x0");
  assert.deepEqual(
    decodeFunctionData({ abi: registryAbi, data: create.data }),
    { functionName: "create", args: [id(1), id(2), id(3)] },
  );
  const commit = build({
    operation: "commit",
    expectedVersion: "1",
    expectedDigest: id(3),
    nextDigest: id(4),
  });
  assert.deepEqual(
    decodeFunctionData({ abi: registryAbi, data: commit.data }),
    { functionName: "commit", args: [id(1), 1n, id(3), id(4)] },
  );
  assert.throws(() =>
    build({
      operation: "commit",
      expectedVersion: "18446744073709551615",
      expectedDigest: id(3),
      nextDigest: id(4),
    }),
  );
  assert.throws(() =>
    build({
      operation: "create",
      manifestDigest: id(2),
      initialCapsuleDigest: id(3),
      value: "0x1",
    } as never),
  );
  assert.throws(() => build({ operation: "transfer" } as never));
});
test("prepared function ABI matches compiled contract ABI", () => {
  const artifact = JSON.parse(
    readFileSync(
      new URL("../contracts/abi/ContinuityRegistry.json", import.meta.url),
      "utf8",
    ),
  ) as {
    type: string;
    name: string;
    inputs: { type: string }[];
    outputs?: { type: string }[];
  }[];
  for (const entry of registryAbi) {
    const actual = artifact.find(
      (e) => e.type === entry.type && e.name === entry.name,
    )!;
    assert.deepEqual(
      actual.inputs.map((e) => e.type),
      entry.inputs.map((e) => e.type),
    );
    assert.deepEqual(
      actual.outputs?.map((e) => e.type),
      entry.type === "function" ? entry.outputs.map((e) => e.type) : undefined,
    );
  }
});
test("standalone reader rejects uint64 overflow and noncanonical ABI padding", async () => {
  const f = fixture();
  const rpc: ReadRpc = async (...args) =>
    args[1] === "eth_call"
      ? "0x" +
        "0".repeat(63) +
        "1" +
        id(2).slice(2) +
        (1n << 64n).toString(16).padStart(64, "0") +
        id(3).slice(2)
      : f.rpc(...args);
  await assert.rejects(
    new MonadRegistryReader(policy, rpc, () => now).getHead(owner, id(1)),
    { code: "FRESHNESS_UNAVAILABLE" },
  );
});
