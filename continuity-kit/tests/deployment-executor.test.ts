/** OFFLINE ONLY: disposable random synthetic secp256k1 keys and an in-memory RPC.
 * Never connects to a provider, invokes WebAuthn, persists keys or funds an account. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSecp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  getContractAddress,
  hexToBytes,
  keccak256,
  parseTransaction,
} from "viem";
import type { Hex, TransactionSerializableEIP1559 } from "viem";
import {
  createDeploymentExecutor,
  createDeploymentFetchRpc,
  createProposedDeploymentExecutor,
  validateProposedDeploymentApproval,
} from "../testnet/deployment-executor.ts";
import type {
  DeploymentApproval,
  DeploymentRpc,
} from "../testnet/deployment-executor.ts";

const proposal = JSON.parse(
  readFileSync(
    new URL("../testnet/deployment-proposal.json", import.meta.url),
    "utf8",
  ),
);
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const q = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
type Override = (
  host: string,
  method: string,
  params: readonly unknown[],
  result: unknown,
) => unknown;
function fixture() {
  const key = generatePrivateKey(); // fresh, disposable, public test fixture; never persisted
  const account = privateKeyToAccount(key);
  const plan: DeploymentApproval = {
    chainId: 10143,
    deployer: account.address.toLowerCase() as Hex,
    nonce: "0",
    predictedContractAddress: getContractAddress({
      from: account.address,
      nonce: 0n,
    }),
    creationData: proposal.transaction.data,
    creationDataHash: proposal.creationDataKeccak256,
    runtimeCodeHash: proposal.expectedRuntimeCodeHash,
    gasLimitCeiling: "1000000",
    maxFeePerGasWei: "200000000000",
    maxPriorityFeePerGasWei: "2000000000",
    maxTotalFeeWei: "200000000000000000",
    valueWei: "0",
  };
  let time = 1800000000000;
  let opens = 0,
    signs = 0,
    closes = 0,
    broadcasts = 0;
  let raw: Hex | undefined;
  let override: Override = (_h, _m, _p, result) => result;
  let beforeOpen = async () => {};
  let beforeSign = async () => {};
  let signMutation = (tx: Readonly<TransactionSerializableEIP1559>) => tx;
  const calls: { host: string; method: string; params: readonly unknown[] }[] =
    [];
  const block = (number = 10) => ({
    number: q(number),
    hash: hash(number === 10 ? "a" : "b"),
    timestamp: q(Math.floor(time / 1000)),
    baseFeePerGas: q(1000000000n),
  });
  const runtime = `0x${plan.creationData.slice(2 + 31 * 2)}` as Hex;
  assert.equal(keccak256(runtime), plan.runtimeCodeHash);
  const rpc: DeploymentRpc = async (host, method, params, signal) => {
    assert.equal(signal.aborted, false);
    calls.push({ host, method, params });
    let result: unknown;
    switch (method) {
      case "eth_chainId":
        result = q(10143);
        break;
      case "eth_getTransactionCount":
        result = "0x0";
        break;
      case "eth_getBalance":
        result = q(10n ** 18n);
        break;
      case "eth_getCode":
        result = params[1] === "pending" ? "0x" : runtime;
        break;
      case "eth_estimateGas":
        result = q(host.includes("drpc") ? 400001 : 400000);
        break;
      case "eth_maxPriorityFeePerGas":
        result = q(1000000000n);
        break;
      case "eth_getBlockByNumber":
        result = block(params[0] === "0xb" ? 11 : 10);
        break;
      case "eth_sendRawTransaction":
        broadcasts++;
        raw = params[0] as Hex;
        result = keccak256(raw);
        break;
      case "eth_getTransactionByHash": {
        assert.ok(raw);
        const p = parseTransaction(raw);
        result = {
          hash: keccak256(raw),
          from: account.address,
          to: null,
          input: p.data,
          type: "0x2",
          chainId: q(10143),
          nonce: "0x0",
          value: "0x0",
          gas: q(p.gas!),
          maxFeePerGas: q(p.maxFeePerGas!),
          maxPriorityFeePerGas: q(p.maxPriorityFeePerGas!),
          accessList: [],
          r: p.r,
          s: p.s,
          yParity: q(p.yParity!),
          blockHash: hash("a"),
          blockNumber: "0xa",
          transactionIndex: "0x0",
        };
        break;
      }
      case "eth_getTransactionReceipt": {
        assert.ok(raw);
        result = {
          transactionHash: keccak256(raw),
          from: account.address,
          to: null,
          type: "0x2",
          blockHash: hash("a"),
          blockNumber: "0xa",
          transactionIndex: "0x0",
          status: "0x1",
          contractAddress: plan.predictedContractAddress,
          gasUsed: q(400000),
          effectiveGasPrice: q(2000000000n),
          logs: [],
        };
        break;
      }
      default:
        assert.fail(`Unexpected offline method ${method}`);
    }
    return override(host, method, params, result);
  };
  const deps = {
    rpc,
    now: () => time,
    openSigner: async () => {
      opens++;
      await beforeOpen();
      const bytes = hexToBytes(key);
      const session = createSecp256k1SigningSession({ privateKey: bytes });
      bytes.fill(0);
      const mera = toViemAccount(session);
      return {
        address: mera.address,
        sign: async (tx: Readonly<TransactionSerializableEIP1559>) => {
          signs++;
          await beforeSign();
          return mera.signTransaction(signMutation(tx));
        },
        close: () => {
          closes++;
          session.end();
        },
      };
    },
  };
  return {
    plan,
    deps,
    calls,
    create: () => createDeploymentExecutor(plan, deps),
    change: (fn: Override) => {
      override = fn;
    },
    atOpen: (fn: () => Promise<void>) => {
      beforeOpen = fn;
    },
    atSign: (fn: () => Promise<void>) => {
      beforeSign = fn;
    },
    mutateSignature: (fn: typeof signMutation) => {
      signMutation = fn;
    },
    advance: (ms: number) => {
      time += ms;
    },
    counts: () => ({ opens, signs, closes, broadcasts }),
  };
}

test("offline Mera signs one exact creation; two providers confirm finalized runtime", async () => {
  const f = fixture(),
    executor = f.create();
  const submitted = await executor.execute();
  assert.equal(submitted.status, "submitted");
  assert.deepEqual(Object.keys(submitted).sort(), ["status", "ticket"]);
  assert.ok(Object.isFrozen(submitted.ticket));
  assert.equal((await executor.reconcile()).status, "finalized");
  assert.deepEqual(f.counts(), {
    opens: 1,
    signs: 1,
    closes: 1,
    broadcasts: 1,
  });
  for (const call of f.calls.filter((c) => c.method === "eth_estimateGas")) {
    assert.deepEqual(Object.keys(call.params[0] as object).sort(), [
      "data",
      "from",
      "nonce",
      "value",
    ]);
  }
  const sent = f.calls.find((c) => c.method === "eth_sendRawTransaction")!;
  const parsed = parseTransaction(sent.params[0] as Hex);
  assert.equal(parsed.gas, 480002n); // ceil(max(native estimates) * 1.20)
  assert.equal(parsed.to, undefined);
  await assert.rejects(executor.execute(), /ATTEMPT_USED/);
});

test("plan schema rejects extras, accessors, wrong hash, nonce, caps and substituted data", () => {
  const f = fixture();
  for (const bad of [
    { ...f.plan, to: f.plan.deployer },
    { ...f.plan, accessList: [] },
    { ...f.plan, blobVersionedHashes: [] },
    { ...f.plan, authorizationList: [] },
    { ...f.plan, serializer: () => {} },
    { ...f.plan, nonce: "1" },
    { ...f.plan, chainId: 1 },
    { ...f.plan, valueWei: "1" },
    { ...f.plan, maxFeePerGasWei: "200000000001" },
    { ...f.plan, creationData: "0x00" },
    { ...f.plan, runtimeCodeHash: hash("f") },
    {
      ...f.plan,
      get deployer() {
        throw Error("must not invoke");
      },
    },
  ])
    assert.throws(() => createDeploymentExecutor(bad, f.deps), /DEPLOYMENT_/);
  assert.equal(f.counts().opens, 0);
});

test("exact proposal-owner gate is separate from synthetic approved fixture plans", () => {
  const f = fixture();
  assert.throws(
    () => validateProposedDeploymentApproval(f.plan),
    /PROPOSAL_OWNER/,
  );
  const approved = validateProposedDeploymentApproval({
    ...f.plan,
    deployer: proposal.deployer,
    predictedContractAddress: proposal.predictedContractAddress,
  });
  assert.ok(Object.isFrozen(approved));
});

test("copied authority cannot be changed through original plan, dependencies or executor", async () => {
  const f = fixture(),
    executor = f.create();
  f.plan.deployer = `0x${"f".repeat(40)}`;
  f.plan.creationData = "0x00";
  f.deps.rpc = async () => {
    throw Error("mutated dependency");
  };
  assert.ok(Object.isFrozen(executor));
  assert.throws(() => Object.assign(executor, { expiresAt: Infinity }));
  assert.equal((await executor.execute()).status, "submitted");
});

for (const [name, method, replacement] of [
  ["chain disagreement", "eth_chainId", "0x1"],
  ["pending nonce", "eth_getTransactionCount", "0x1"],
  ["deployer or CREATE code exists", "eth_getCode", "0x00"],
  ["insufficient funds", "eth_getBalance", "0x0"],
  ["native gas cap", "eth_estimateGas", q(833334)],
  ["priority fee cap", "eth_maxPriorityFeePerGas", q(2000000001n)],
] as const)
  test(`preflight rejects ${name} before opening signer`, async () => {
    const f = fixture();
    f.change((host, m, _p, result) =>
      host.includes("drpc") && m === method ? replacement : result,
    );
    await assert.rejects(f.create().execute(), /STOPPED/);
    assert.deepEqual(f.counts(), {
      opens: 0,
      signs: 0,
      closes: 0,
      broadcasts: 0,
    });
  });

test("fresh block and base fee caps checked before signer", async () => {
  for (const change of [
    { timestamp: "0x1" },
    { baseFeePerGas: q(200000000000n) },
  ]) {
    const f = fixture();
    f.change((_h, m, _p, result) =>
      m === "eth_getBlockByNumber"
        ? { ...(result as object), ...change }
        : result,
    );
    await assert.rejects(f.create().execute(), /STOPPED/);
    assert.equal(f.counts().opens, 0);
  }
});

test("post-auth nonce change burns attempt and closes session without signing", async () => {
  const f = fixture(),
    executor = f.create();
  f.atOpen(async () =>
    f.change((_h, m, _p, result) =>
      m === "eth_getTransactionCount" ? "0x1" : result,
    ),
  );
  await assert.rejects(executor.execute(), /STOPPED/);
  await assert.rejects(executor.execute(), /ATTEMPT_USED/);
  assert.deepEqual(f.counts(), {
    opens: 1,
    signs: 0,
    closes: 1,
    broadcasts: 0,
  });
});

test("post-sign nonce change retains public hash ticket and never broadcasts", async () => {
  const f = fixture(),
    executor = f.create();
  f.atSign(async () =>
    f.change((_h, m, _p, result) =>
      m === "eth_getTransactionCount" ? "0x1" : result,
    ),
  );
  await assert.rejects(executor.execute(), /STOPPED/);
  assert.ok(executor.ticket()?.transactionHash);
  assert.equal(f.counts().broadcasts, 0);
  await assert.rejects(executor.execute(), /ATTEMPT_USED/);
});

test("expired/closed capability rejects; close during auth burns attempt", async () => {
  const f = fixture(),
    expired = f.create();
  f.advance(600000);
  await assert.rejects(expired.execute(), /EXPIRED/);
  assert.equal(f.counts().opens, 0);
  const g = fixture(),
    closed = g.create();
  g.atOpen(async () => closed.close());
  await assert.rejects(closed.execute(), /STOPPED/);
  assert.deepEqual(g.counts(), {
    opens: 1,
    signs: 0,
    closes: 1,
    broadcasts: 0,
  });
});

test("parallel execute is serialized and cannot cause another signing attempt", async () => {
  const f = fixture(),
    executor = f.create();
  const first = executor.execute();
  await assert.rejects(executor.execute(), /ATTEMPT_USED/);
  await first;
  assert.equal(f.counts().signs, 1);
});

for (const [name, change] of [
  ["to", { to: `0x${"1".repeat(40)}` as Hex }],
  ["value", { value: 1n }],
  ["chain", { chainId: 1 }],
  ["nonce", { nonce: 1 }],
  ["data", { data: "0x00" as Hex }],
  ["gas", { gas: 999999n }],
  [
    "access list",
    {
      accessList: [{ address: `0x${"1".repeat(40)}` as Hex, storageKeys: [] }],
    },
  ],
] as const)
  test(`locally rejects signer mutation of ${name}`, async () => {
    const f = fixture(),
      executor = f.create();
    f.mutateSignature((tx) => ({ ...tx, ...change }));
    await assert.rejects(executor.execute(), /STOPPED/);
    assert.equal(f.counts().broadcasts, 0);
    assert.equal(f.counts().closes, 1);
  });

for (const mode of ["throw", "wrong-hash"])
  test(`uncertain ${mode} submission retains one hash and reconciles read-only`, async () => {
    const f = fixture(),
      executor = f.create();
    f.change((_h, m, _p, result) => {
      if (m === "eth_sendRawTransaction") {
        if (mode === "throw") throw Error("secret raw provider text");
        return hash("f");
      }
      return result;
    });
    const result = await executor.execute();
    assert.equal(result.status, "uncertain");
    executor.close();
    assert.equal((await executor.reconcile()).status, "finalized");
    assert.equal(f.counts().broadcasts, 1);
    await assert.rejects(executor.execute());
  });

test("pending receipt is honest; no finalized status or extra broadcasts", async () => {
  const f = fixture(),
    executor = f.create();
  await executor.execute();
  f.change((host, m, _p, r) =>
    host.includes("drpc") && m === "eth_getTransactionReceipt" ? null : r,
  );
  assert.equal((await executor.reconcile()).status, "pending");
  assert.equal(f.counts().broadcasts, 1);
});

for (const [name, method, changes] of [
  ["transaction input", "eth_getTransactionByHash", { input: "0x00" }],
  ["signature", "eth_getTransactionByHash", { r: hash("f") }],
  ["receipt block", "eth_getTransactionReceipt", { blockHash: hash("f") }],
  [
    "receipt address",
    "eth_getTransactionReceipt",
    { contractAddress: `0x${"f".repeat(40)}` },
  ],
  ["receipt gas", "eth_getTransactionReceipt", { gasUsed: q(1000001) }],
  ["unexpected constructor log", "eth_getTransactionReceipt", { logs: [{}] }],
  ["finalized disagreement", "eth_getBlockByNumber", { hash: hash("f") }],
] as const)
  test(`confirmation rejects ${name} mismatch`, async () => {
    const f = fixture(),
      executor = f.create();
    await executor.execute();
    f.change((host, m, _p, result) =>
      host.includes("drpc") && m === method
        ? { ...(result as object), ...changes }
        : result,
    );
    assert.equal((await executor.reconcile()).status, "evidence-invalid");
    assert.equal(f.counts().broadcasts, 1);
  });

test("confirmation requires actual runtime on both providers", async () => {
  const f = fixture(),
    executor = f.create();
  await executor.execute();
  f.change((host, m, _p, result) =>
    host.includes("drpc") && m === "eth_getCode" ? "0x" : result,
  );
  assert.equal((await executor.reconcile()).status, "evidence-invalid");
});

test("reverted outcome requires agreeing finalized exact transaction and receipt", async () => {
  const f = fixture(),
    executor = f.create();
  await executor.execute();
  f.change((_h, m, _p, result) =>
    m === "eth_getTransactionReceipt"
      ? { ...(result as object), status: "0x0", contractAddress: null }
      : result,
  );
  assert.equal((await executor.reconcile()).status, "reverted");
});

test("unequal finalized heights accept only the fresh lower tip corroborated by both", async () => {
  const f = fixture(),
    executor = f.create();
  await executor.execute();
  f.change((host, m, p, result) =>
    host.includes("drpc") &&
    m === "eth_getBlockByNumber" &&
    p[0] === "finalized"
      ? { ...(result as object), number: "0xb", hash: hash("b") }
      : result,
  );
  assert.equal((await executor.reconcile()).status, "finalized");
});

test("re-read detects changing block identity after code verification", async () => {
  const f = fixture(),
    executor = f.create();
  await executor.execute();
  let numberedReads = 0;
  f.change((_h, m, p, result) => {
    if (m === "eth_getBlockByNumber" && p[0] === "0xa" && ++numberedReads > 4)
      return { ...(result as object), hash: hash("f") };
    return result;
  });
  assert.equal((await executor.reconcile()).status, "evidence-invalid");
});

test("RPC response size limit stops before auth", async () => {
  const f = fixture();
  f.change((_h, m, _p, result) =>
    m === "eth_chainId" ? "x".repeat(1024 * 1024 + 1) : result,
  );
  await assert.rejects(f.create().execute(), /STOPPED/);
  assert.equal(f.counts().opens, 0);
});

test("explicit fetch adapter rejects unpinned host and oversized streamed response", async () => {
  let calls = 0;
  const rpc = createDeploymentFetchRpc(async (_url, options) => {
    calls++;
    assert.equal(options?.redirect, "error");
    assert.equal(options?.credentials, "omit");
    return new Response("x".repeat(1024 * 1024 + 1));
  });
  await assert.rejects(
    rpc(
      "https://unapproved.invalid",
      "eth_chainId",
      [],
      new AbortController().signal,
    ),
    /HOST/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    rpc(
      "https://testnet-rpc.monad.xyz",
      "eth_chainId",
      [],
      new AbortController().signal,
    ),
    /RPC_SIZE/,
  );
});

test("same-height A historical / B finalized / A reread cannot fabricate finality", async () => {
  const f = fixture(),
    executor = f.create();
  await executor.execute();
  let numberedReads = 0;
  f.change((_h, m, p, result) => {
    if (m === "eth_getBlockByNumber") {
      if (p[0] === "finalized")
        return { ...(result as object), hash: hash("b") };
      if (p[0] === "0xa" && ++numberedReads > 2 && numberedReads <= 4)
        return { ...(result as object), hash: hash("b") };
    }
    return result;
  });
  assert.equal((await executor.reconcile()).status, "evidence-invalid");
});

test("same block hash with conflicting finalized timestamps is rejected", async () => {
  const f = fixture(),
    executor = f.create();
  await executor.execute();
  f.change((host, m, p, result) =>
    host.includes("drpc") &&
    m === "eth_getBlockByNumber" &&
    p[0] === "finalized"
      ? { ...(result as object), timestamp: q(1800000001) }
      : result,
  );
  assert.equal((await executor.reconcile()).status, "evidence-invalid");
});

test("stale finalized tips are not treated as current finality", async () => {
  const f = fixture(),
    executor = f.create();
  await executor.execute();
  f.change((_h, m, p, result) =>
    m === "eth_getBlockByNumber" && p[0] === "finalized"
      ? { ...(result as object), timestamp: "0x1" }
      : result,
  );
  assert.equal((await executor.reconcile()).status, "evidence-invalid");
});

test("auth refresh still requires funds for original selected gas and fees", async () => {
  const f = fixture(),
    executor = f.create();
  f.atOpen(async () =>
    f.change((_h, m, _p, result) => {
      if (m === "eth_estimateGas") return q(100000);
      if (m === "eth_getBalance") return q(400000000000000n); // refreshed smaller envelope fits, original does not
      return result;
    }),
  );
  await assert.rejects(executor.execute(), /STOPPED/);
  assert.equal(f.counts().signs, 0);
});

test("authentication expiry stops before signing and closes returned session", async () => {
  const f = fixture(),
    executor = f.create();
  f.atOpen(async () => f.advance(600001));
  await assert.rejects(executor.execute(), /STOPPED/);
  assert.deepEqual(f.counts(), {
    opens: 1,
    signs: 0,
    closes: 1,
    broadcasts: 0,
  });
});

test("total preflight deadline and backwards clock both fail closed before auth", async () => {
  for (const elapsed of [60001, -1]) {
    const f = fixture(),
      executor = f.create();
    f.change((_h, m, _p, result) => {
      if (m === "eth_chainId") f.advance(elapsed);
      return result;
    });
    await assert.rejects(executor.execute(), /STOPPED/);
    assert.equal(f.counts().opens, 0);
  }
});

test("locally recovered sender must match owner even if signer lies about address", async () => {
  const f = fixture();
  const wrong = privateKeyToAccount(generatePrivateKey());
  let closed = false;
  const executor = createDeploymentExecutor(f.plan, {
    ...f.deps,
    openSigner: async () => ({
      address: f.plan.deployer,
      sign: (tx) => wrong.signTransaction(tx),
      close: () => {
        closed = true;
      },
    }),
  });
  await assert.rejects(executor.execute(), /STOPPED/);
  assert.equal(closed, true);
  assert.equal(f.counts().broadcasts, 0);
});

test("production factory keeps signer private; only existing A selection/default salt, wrong owner fails", async () => {
  const f = fixture();
  const plan = {
    ...f.plan,
    deployer: proposal.deployer,
    predictedContractAddress: proposal.predictedContractAddress,
  };
  let gets = 0;
  const client = {
    createCredential: async () => {
      assert.fail("must never create a credential");
    },
    getCredential: async (
      request: import("@category-labs/mera").WebAuthnClient.GetCredentialRequest,
    ) => {
      gets++;
      assert.equal(request.rpId, "primary.localhost");
      assert.equal(request.allowCredential, undefined);
      assert.equal(request.userVerification, "required");
      const expectedSalt = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("mera.prf.salt.v1"),
        ),
      );
      assert.deepEqual(request.prfSalt, expectedSalt);
      return {
        credentialId: new Uint8Array([1, 2, 3]),
        prfOutput: crypto.getRandomValues(new Uint8Array(32)),
      };
    },
  };
  const executor = createProposedDeploymentExecutor(plan, {
    rpc: f.deps.rpc,
    now: f.deps.now,
    webAuthnClient: client,
  });
  assert.deepEqual(Object.keys(executor).sort(), [
    "close",
    "execute",
    "reconcile",
    "ticket",
  ]);
  await assert.rejects(executor.execute(), /STOPPED/);
  assert.equal(gets, 1);
  assert.equal(f.counts().broadcasts, 0);
  assert.throws(
    () =>
      createProposedDeploymentExecutor(plan, {
        rpc: f.deps.rpc,
        now: f.deps.now,
        webAuthnClient: undefined as never,
      }),
    /WEBAUTHN_DEPENDENCY/,
  );
});

test("RPC timeout is bounded and aborts even when trusted fixture ignores signal", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const signals: AbortSignal[] = [];
  const executor = createDeploymentExecutor(f.plan, {
    ...f.deps,
    rpc: async (_h, _m, _p, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    },
  });
  const running = assert.rejects(executor.execute(), /STOPPED/);
  context.mock.timers.tick(10001);
  await running;
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(f.counts().opens, 0);
});

for (const stage of ["finalized", "common", "reread"])
  test(`same-hash timestamp drift at ${stage} cannot fabricate block identity`, async () => {
    const f = fixture(),
      executor = f.create();
    await executor.execute();
    let reads = 0;
    f.change((_h, m, p, result) => {
      if (m !== "eth_getBlockByNumber") return result;
      if (p[0] === "0xa") reads++;
      const drift =
        stage === "finalized"
          ? p[0] === "finalized"
          : stage === "common"
            ? p[0] === "0xa" && reads > 2
            : p[0] === "0xa" && reads > 4;
      return drift
        ? { ...(result as object), timestamp: q(1800000001) }
        : result;
    });
    assert.equal((await executor.reconcile()).status, "evidence-invalid");
  });

test("100 gwei base plus 2 gwei priority clamps recommendation to approved 200 gwei", async () => {
  const f = fixture(),
    executor = f.create();
  f.change((_h, method, _p, result) => {
    if (method === "eth_getBlockByNumber")
      return { ...(result as object), baseFeePerGas: q(100000000000n) };
    if (method === "eth_maxPriorityFeePerGas") return q(2000000000n);
    return result;
  });
  assert.equal((await executor.execute()).status, "submitted");
  const raw = f.calls.find((c) => c.method === "eth_sendRawTransaction")!
    .params[0] as Hex;
  const signed = parseTransaction(raw);
  assert.equal(signed.maxFeePerGas, 200000000000n);
  assert.equal(signed.maxPriorityFeePerGas, 2000000000n);
  assert.deepEqual(f.counts(), {
    opens: 1,
    signs: 1,
    closes: 1,
    broadcasts: 1,
  });
});

test("199 gwei base plus 2 gwei priority cannot fit approved 200 gwei cap", async () => {
  const f = fixture(),
    executor = f.create();
  f.change((_h, method, _p, result) => {
    if (method === "eth_getBlockByNumber")
      return { ...(result as object), baseFeePerGas: q(199000000000n) };
    if (method === "eth_maxPriorityFeePerGas") return q(2000000000n);
    return result;
  });
  await assert.rejects(executor.execute(), /STOPPED/);
  assert.deepEqual(f.counts(), {
    opens: 0,
    signs: 0,
    closes: 0,
    broadcasts: 0,
  });
});

test("post-auth cap clamp never hides base plus priority exceeding selected fee", async () => {
  const f = fixture(),
    executor = f.create();
  let authenticated = false;
  f.atOpen(async () => {
    authenticated = true;
  });
  f.change((_h, method, _p, result) => {
    if (method === "eth_getBlockByNumber")
      return {
        ...(result as object),
        baseFeePerGas: q(authenticated ? 199000000000n : 100000000000n),
      };
    if (method === "eth_maxPriorityFeePerGas") return q(2000000000n);
    return result;
  });
  await assert.rejects(executor.execute(), /STOPPED/);
  assert.deepEqual(f.counts(), {
    opens: 1,
    signs: 0,
    closes: 1,
    broadcasts: 0,
  });
});

for (const stage of ["latest", "finalized"]) {
  for (const [offsetSeconds, accepted] of [
    [-60, true],
    [-61, false],
    [5, true],
    [6, false],
  ] as const) {
    test(`${stage} currentness boundary ${offsetSeconds}s is ${accepted ? "accepted" : "rejected"}`, async () => {
      const f = fixture(),
        executor = f.create();
      const change: Override = (_h, method, _p, result) =>
        method === "eth_getBlockByNumber"
          ? { ...(result as object), timestamp: q(1800000000 + offsetSeconds) }
          : result;
      if (stage === "latest") {
        f.change(change);
        if (accepted)
          assert.equal((await executor.execute()).status, "submitted");
        else {
          await assert.rejects(executor.execute(), /STOPPED/);
          assert.equal(f.counts().opens, 0);
        }
      } else {
        await executor.execute();
        f.change(change);
        assert.equal(
          (await executor.reconcile()).status,
          accepted ? "finalized" : "evidence-invalid",
        );
      }
    });
  }
}
