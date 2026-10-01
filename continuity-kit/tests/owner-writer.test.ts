import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OwnerWriter,
  MonadRegistryReader,
  MemoryMirrorStore,
  MeraPasskeyAdapter,
  createPrimary,
  prepareBackup,
  finalizeEnrollment,
  saveCheckpoint,
  discoverRecovery,
  recoverCurrent,
  restorePrimary,
  reconcileCheckpoint,
  reconcileEnrollment,
  validatePolicy,
  validateHead,
  HttpTransactionTransport,
  LOCAL_POLICY,
} from "../src/sdk/index.ts";
import type {
  PrimaryAdapters,
  RegistryCommand,
  WriteTicket,
  TransactionSessionLimits,
} from "../src/sdk/types.ts";
import { SyntheticWebAuthnClient } from "../src/sdk/demo-fixture.ts";
import { contextFor } from "../src/sdk/policy.ts";
import {
  fixtureLimits,
  id,
  OfflineChain,
  policy,
} from "./fixtures/offline-chain.ts";
globalThis.fetch = async () => {
  throw new Error("Real network is forbidden in offline writer tests");
};
const code = (expected: string) => (e: unknown) =>
  e instanceof Error && "code" in e && e.code === expected;
const content = {
  title: "SYNTHETIC OFFLINE SDK",
  plan: "Not Monad evidence",
  tasks: [],
  draft: "v1",
};
function fixture(caps: Partial<TransactionSessionLimits> = {}) {
  const chain = new OfflineChain(),
    registry = new MonadRegistryReader(policy, chain.rpc, () => chain.now),
    mirrors = [
      new MemoryMirrorStore("offline-0"),
      new MemoryMirrorStore("offline-1"),
    ];
  const adapters: PrimaryAdapters = {
    trustMode: "trusted-rpc-quorum",
    registry,
    mirrors,
    transactions: chain,
    sessionLimits: { ...fixtureLimits, ...caps },
  };
  return { chain, registry, mirrors, adapters };
}
function writerFixture(caps: Partial<TransactionSessionLimits> = {}) {
  const f = fixture(caps),
    writer = new OwnerWriter(
      new Uint8Array(32).fill(7),
      policy,
      f.adapters,
      () => f.chain.now,
    );
  writer.bindContext(contextFor(policy, writer.owner, id(1)));
  writer.bindManifest(id(2));
  const command: RegistryCommand = {
    operation: "create",
    owner: writer.owner,
    streamId: id(1),
    manifestDigest: id(2),
    initialCapsuleDigest: id(3),
  };
  return { ...f, writer, command };
}
function commit(
  owner: `0x${string}`,
  expected = "1",
  digest = id(3),
  next = id(4),
): RegistryCommand {
  return {
    operation: "commit",
    owner,
    streamId: id(1),
    expectedVersion: expected,
    expectedDigest: digest,
    nextDigest: next,
  };
}

test("offline full SDK: actual serialized Mera create/v2, fresh B with A absent, stale/missing copies, fresh A same owner and v3", async () => {
  const f = fixture(),
    seed = "DISPOSABLE OFFLINE T1 FIXTURE",
    passkeys = () =>
      new MeraPasskeyAdapter(new SyntheticWebAuthnClient({ seed }));
  const a = await createPrimary(policy, passkeys(), f.adapters),
    backup = await prepareBackup(policy, passkeys(), a);
  const enrollment = await finalizeEnrollment(a, backup, content, f.adapters);
  assert.equal(enrollment.status, "prepared");
  if (enrollment.status !== "prepared") return;
  assert.equal(enrollment.proof.kind, "finalized-receipt");
  const v1 = a.enrollment!.capsuleBytes,
    owner = a.context.owner;
  const save = await saveCheckpoint(
    enrollment.state,
    { ...content, draft: "v2" },
    f.adapters,
  );
  assert.equal(save.status, "saved");
  if (save.status !== "saved") return;
  assert.equal(save.proof.kind, "finalized-receipt");
  a.close();
  const bFixture = new SyntheticWebAuthnClient({ seed }),
    b = new MeraPasskeyAdapter(bFixture);
  const readOnly = { registry: f.registry, mirrors: f.mirrors };
  assert.equal("writer" in readOnly, false);
  assert.equal("execute" in readOnly.registry, false);
  f.mirrors[0].readBlobHook = () => v1;
  const discovered = await discoverRecovery(policy, b, readOnly),
    recovered = await recoverCurrent(discovered, b, readOnly);
  assert.equal(recovered.content.draft, "v2");
  assert.ok(recovered.diagnostics.some((d) => d.code === "DIGEST_MISMATCH"));
  assert.ok(bFixture.ceremonies.every((c) => c.rpId === policy.bRpId));
  f.mirrors[1].blobs.delete(recovered.capsuleDigest);
  await assert.rejects(
    recoverCurrent(discovered, b, readOnly),
    code("CURRENT_DATA_UNAVAILABLE"),
  );
  f.mirrors[0].readBlobHook = undefined;
  const restored = await restorePrimary(policy, passkeys(), f.adapters);
  assert.equal(restored.state.context.owner, owner);
  assert.equal(restored.recovered.content.draft, "v2");
  const v3 = await saveCheckpoint(
    restored.state,
    { ...content, draft: "v3" },
    f.adapters,
  );
  assert.equal(v3.status, "saved");
  if (v3.status !== "saved") return;
  assert.equal(v3.recovered.version, "3");
  assert.equal(v3.proof.kind, "finalized-receipt");
  assert.equal(f.chain.sends, 3);
  assert.equal("sign" in restored.state.writer, false);
  assert.equal("session" in restored.state, false);
  restored.state.close();
});
test("Mera transaction roundtrip, copied policy/command scope and ten-minute budgets", async () => {
  const f = writerFixture({ maxTransactions: 1 });
  const command = { ...f.command };
  const resultPromise = f.writer.execute(command);
  command.streamId = id(999);
  const result = await resultPromise;
  assert.equal(result.status, "confirmed");
  if (result.status !== "confirmed") return;
  assert.equal(result.proof.kind, "finalized-receipt");
  const tx = [...f.chain.transactions.values()][0]!;
  assert.equal(tx.from, f.writer.owner);
  assert.equal(tx.chainId, "0x279f");
  assert.equal(tx.value, "0x0");
  await assert.rejects(
    f.writer.execute(commit(f.writer.owner)),
    code("SESSION_LIMIT_EXCEEDED"),
  );
  assert.equal(f.chain.sends, 1);
  f.writer.close();
});
test("closed writer reconciles quantity-encoded signature scalars without resending", async () => {
  const f = writerFixture();
  // This synthetic signed envelope has an s scalar with a leading zero nibble.
  f.chain.gasEstimate = "0x186a1";
  f.chain.broadcastMode = "timeout";
  const pending = await f.writer.execute(f.command);
  assert.equal(pending.status, "unresolved");
  if (pending.status !== "unresolved") return;
  f.writer.close();
  let shortened = false;
  f.chain.alterTransaction = (tx) => {
    for (const key of ["r", "s"] as const) {
      const original = tx[key] as string;
      tx[key] = `0x${BigInt(original).toString(16)}`;
      shortened ||= (tx[key] as string).length < original.length;
    }
  };
  const result = await f.writer.reconcile(pending.ticket);
  assert.equal(shortened, true);
  assert.equal(result.status, "confirmed");
  if (result.status !== "confirmed") return;
  assert.equal(result.proof.kind, "finalized-receipt");
  assert.equal(result.checkpoint.version, "1");
  assert.equal(f.writer.pendingTicket, undefined);
  assert.equal(f.chain.sends, 1);
});
for (const mutation of [
  "owner",
  "stream",
  "manifest",
  "extra",
  "nonzero",
  "serializer",
  "operation",
]) {
  test(`scope rejects ${mutation} before broadcast`, async () => {
    const f = writerFixture();
    const c: Record<string, unknown> = { ...f.command };
    if (mutation === "owner") c.owner = `0x${"aa".repeat(20)}`;
    if (mutation === "stream") c.streamId = id(9);
    if (mutation === "manifest") c.manifestDigest = id(9);
    if (mutation === "extra") c.to = policy.registryAddress;
    if (mutation === "nonzero") c.value = 1n;
    if (mutation === "serializer") c.serializer = () => "";
    if (mutation === "operation") c.operation = "transfer";
    await assert.rejects(async () =>
      f.writer.execute(c as unknown as RegistryCommand),
    );
    assert.equal(f.chain.sends, 0);
    f.writer.close();
  });
}
for (const stage of ["nonce", "estimate", "fees"]) {
  test(`expiry or close during ${stage} prevents broadcast`, async () => {
    for (const close of [false, true]) {
      const f = writerFixture();
      f.chain.stage = (name) => {
        if (name === stage) {
          if (close) f.writer.close();
          else f.chain.now += 600001;
        }
      };
      await assert.rejects(
        f.writer.execute(f.command),
        code("SESSION_EXPIRED"),
      );
      assert.equal(f.chain.sends, 0);
    }
  });
}
test("nonce disagreement, malformed quantities, gas, fees and aggregate reservation fail closed", async () => {
  for (const change of [
    (f: ReturnType<typeof writerFixture>) => {
      f.chain.nonceOffset = 1n;
    },
    (f: ReturnType<typeof writerFixture>) => {
      f.chain.gasEstimate = "0x00";
    },
    (f: ReturnType<typeof writerFixture>) => {
      f.chain.gasEstimate = "0xfffffff";
    },
    (f: ReturnType<typeof writerFixture>) => {
      f.chain.feeQuote = { maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x2" };
    },
  ]) {
    const f = writerFixture();
    change(f);
    await assert.rejects(f.writer.execute(f.command));
    assert.equal(f.chain.sends, 0);
    f.writer.close();
  }
  const f = writerFixture({ maxTotalFeeWei: 1n });
  await assert.rejects(
    f.writer.execute(f.command),
    code("SESSION_LIMIT_EXCEEDED"),
  );
  assert.equal(f.chain.sends, 0);
  f.writer.close();
});
for (const mode of ["timeout", "wrong-hash", "unmined"] as const) {
  test(`${mode} submission preserves one ticket without re-signing or rebroadcast`, async () => {
    const f = writerFixture();
    f.chain.broadcastMode = mode;
    const out = await f.writer.execute(f.command);
    assert.equal(out.status, "unresolved");
    if (out.status !== "unresolved") return;
    const ticket = JSON.parse(JSON.stringify(out.ticket)) as WriteTicket;
    assert.equal(JSON.stringify(ticket).includes("privateKey"), false);
    assert.equal(JSON.stringify(ticket).includes("raw"), false);
    f.writer.close();
    for (let i = 0; i < 2; i++) await f.writer.reconcile(ticket);
    assert.equal(f.chain.sends, 1);
    if (mode === "unmined")
      await assert.rejects(
        f.writer.execute(commit(f.writer.owner)),
        code("WRITE_PENDING"),
      );
  });
}
test("state-only confirmation retains unresolved nonce; later exact receipt resolves without another send", async () => {
  const f = writerFixture();
  f.chain.hideReceipts = true;
  const out = await f.writer.execute(f.command);
  assert.equal(out.status, "confirmed");
  if (out.status !== "confirmed") return;
  assert.deepEqual(out.proof, { kind: "finalized-state" });
  assert.ok(out.unresolvedTicket);
  await assert.rejects(
    f.writer.execute(commit(f.writer.owner)),
    code("WRITE_PENDING"),
  );
  f.chain.hideReceipts = false;
  const done = await f.writer.reconcile(out.unresolvedTicket!);
  assert.equal(done.status, "confirmed");
  assert.equal(f.writer.pendingTicket, undefined);
  assert.equal(f.chain.sends, 1);
  f.writer.close();
});
test("same-block superseding commit proves original receipt transition and reports current false", async () => {
  const f = writerFixture();
  await f.writer.execute(f.command);
  f.chain.afterBroadcast = () => {
    const h = f.chain.heads.get(f.writer.owner + id(1))!;
    h.version++;
    h.digest = id(6);
  };
  const out = await f.writer.execute(commit(f.writer.owner));
  assert.equal(out.status, "confirmed");
  if (out.status !== "confirmed") return;
  assert.equal(out.current, false);
  assert.equal(out.currentHead.version, "3");
  assert.equal(out.checkpoint.version, "2");
  f.writer.close();
});

for (const attack of [
  "status-only",
  "unrelated-event",
  "wrong-contract",
  "duplicate",
  "removed",
  "wrong-manifest",
  "wrong-block",
  "disagreement",
  "trailing-data",
]) {
  test(`receipt rejects ${attack} while retaining ticket`, async () => {
    const f = writerFixture();
    f.chain.alterReceipt = (r, provider) => {
      const logs = r.logs as Record<string, unknown>[];
      const l = logs[0]!;
      if (attack === "status-only") r.logs = [];
      if (attack === "unrelated-event") l.topics = [id(999)];
      if (attack === "wrong-contract") l.address = `0x${"ff".repeat(20)}`;
      if (attack === "duplicate") logs.push(structuredClone(l));
      if (attack === "removed") l.removed = true;
      if (attack === "wrong-manifest")
        l.data = (l.data as string).replace(id(2).slice(2), id(9).slice(2));
      if (attack === "wrong-block") l.blockHash = id(99);
      if (attack === "disagreement" && provider === 1) r.gasUsed = "0x1";
      if (attack === "trailing-data") l.data += "00";
    };
    await assert.rejects(
      f.writer.execute(f.command),
      code("TRANSACTION_EVIDENCE_INVALID"),
    );
    assert.ok(f.writer.pendingTicket);
    assert.equal(f.chain.sends, 1);
    f.writer.close();
  });
}
for (const attack of [
  "from",
  "to",
  "input",
  "nonce",
  "value",
  "chainId",
  "gas",
  "r",
  "s",
  "authorizationList",
]) {
  test(`retrieved transaction rejects altered ${attack}`, async () => {
    const f = writerFixture();
    f.chain.alterTransaction = (tx) => {
      tx[attack] =
        attack === "authorizationList"
          ? []
          : attack === "from" || attack === "to"
            ? `0x${"ff".repeat(20)}`
            : attack === "input"
              ? "0x"
              : attack === "r" || attack === "s"
                ? id(8)
                : "0x1";
    };
    await assert.rejects(
      f.writer.execute(f.command),
      code("TRANSACTION_EVIDENCE_INVALID"),
    );
    assert.ok(f.writer.pendingTicket);
    f.writer.close();
  });
}
test("historical runtime mismatch and changed block fail; old historical block can still verify under fresh finalized tip", async () => {
  const bad = writerFixture();
  bad.chain.historicalCode = "0x6001";
  await assert.rejects(
    bad.writer.execute(bad.command),
    code("TRANSACTION_EVIDENCE_INVALID"),
  );
  bad.writer.close();
  const f = writerFixture();
  f.chain.broadcastMode = "timeout";
  const out = await f.writer.execute(f.command);
  assert.equal(out.status, "unresolved");
  if (out.status !== "unresolved") return;
  f.chain.blockHashes.set(101, id(909));
  await assert.rejects(
    f.writer.reconcile(out.ticket),
    code("TRANSACTION_EVIDENCE_INVALID"),
  );
  f.chain.blockHashes.clear();
  f.chain.now += 120000;
  f.chain.timestamp += 120;
  f.chain.blockNumber += 10;
  const block = f.chain.block.bind(f.chain);
  f.chain.block = async (...args) => {
    const result = await block(...args);
    if (args[1] === "101")
      result.timestamp = `0x${(f.chain.timestamp - 120).toString(16)}`;
    return result;
  };
  const result = await f.writer.reconcile(out.ticket);
  assert.equal(result.status, "confirmed");
  f.writer.close();
});
test("unknown history beyond target remains pending; conflicting target and manifest remain explicit conflicts", async () => {
  for (const mode of ["beyond", "digest", "manifest"]) {
    const f = writerFixture();
    f.chain.hideReceipts = true;
    f.chain.afterBroadcast = () => {
      const h = f.chain.heads.get(f.writer.owner + id(1))!;
      if (mode === "beyond") {
        h.version = 2n;
        h.digest = id(9);
      } else if (mode === "digest") h.digest = id(9);
      else h.manifest = id(9);
    };
    if (mode === "beyond") {
      const r = await f.writer.execute(f.command);
      assert.equal(r.status, "unresolved");
    } else
      await assert.rejects(
        f.writer.execute(f.command),
        code(mode === "digest" ? "WRITE_CONFLICT" : "ENROLLMENT_CONFLICT"),
      );
    assert.ok(f.writer.pendingTicket);
    assert.equal(f.chain.sends, 1);
    f.writer.close();
  }
});
test("finalized failed receipt is reverted, consumes budget and resolves submission", async () => {
  const f = writerFixture({ maxTransactions: 1 });
  f.chain.alterReceipt = (r) => {
    r.status = "0x0";
    r.logs = [];
  };
  await assert.rejects(
    f.writer.execute(f.command),
    code("TRANSACTION_REVERTED"),
  );
  assert.equal(f.writer.pendingTicket, undefined);
  f.chain.alterReceipt = undefined;
  await assert.rejects(
    f.writer.execute(commit(f.writer.owner)),
    code("SESSION_LIMIT_EXCEEDED"),
  );
  f.writer.close();
});
test("read-only restored ticket verifies exact transaction without rebroadcast or allowing a different ticket", async () => {
  const f = writerFixture();
  f.chain.broadcastMode = "timeout";
  const out = await f.writer.execute(f.command);
  assert.equal(out.status, "unresolved");
  if (out.status !== "unresolved") return;
  f.writer.close();
  const restored = new OwnerWriter(
    new Uint8Array(32).fill(7),
    policy,
    f.adapters,
    () => f.chain.now,
  );
  restored.bindContext(contextFor(policy, restored.owner, id(1)), true);
  restored.bindManifest(id(2));
  restored.close();
  const forged = structuredClone(out.ticket);
  forged.envelope.value = "1";
  await assert.rejects(
    restored.reconcile(forged),
    code("TRANSACTION_EVIDENCE_INVALID"),
  );
  assert.equal((await restored.reconcile(out.ticket)).status, "confirmed");
  assert.equal(f.chain.sends, 1);
});
test("strict policy and head mode separation, absent-state shape, timestamp freshness and copied arrays", async () => {
  const f = fixture();
  const h = await f.registry.getHead(`0x${"12".repeat(20)}`, id(1));
  assert.throws(() =>
    validatePolicy({ ...LOCAL_POLICY, trustMode: "trusted-rpc-quorum" }),
  );
  assert.throws(() =>
    validatePolicy({ ...policy, registryAddress: `0x${"0".repeat(40)}` }),
  );
  assert.throws(() => validatePolicy({ ...policy, timeoutMs: NaN }));
  assert.throws(() => validateHead(h, LOCAL_POLICY));
  assert.throws(() => validateHead({ ...h, version: "1" }, policy));
  assert.throws(() =>
    validateHead(
      {
        ...h,
        evidence: {
          ...h.evidence,
          blockTimestamp: "1",
          observedAt: new Date().toISOString(),
        },
      },
      policy,
    ),
  );
  const mutable = {
    ...policy,
    rpcUrls: [...policy.rpcUrls] as [string, string],
    mirrorUrls: [...policy.mirrorUrls],
  };
  const reader = new MonadRegistryReader(mutable, f.chain.rpc);
  mutable.rpcUrls[0] = "https://attacker.invalid";
  assert.equal(reader.policy.rpcUrls[0], policy.rpcUrls[0]);
  assert.ok(Object.isFrozen(reader.policy.rpcUrls));
});
test("HTTP transport calls a receiver-sensitive browser fetch as a standalone function", async () => {
  const calls: string[] = [];
  // Arrow-function mocks and Node fetch accept the transport as `this`, hiding
  // the illegal invocation produced by a Window WebIDL function in a browser.
  const fetcher = async function (
    this: unknown,
    _url: string | URL | Request,
    options?: RequestInit,
  ) {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    const body = JSON.parse(String(options?.body));
    calls.push(body.method);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x0" }),
    );
  };
  const transport = new HttpTransactionTransport(policy, fetcher);
  const signal = new AbortController().signal;
  for (const provider of [0, 1] as const)
    assert.equal(
      await transport.pendingNonce(provider, `0x${"12".repeat(20)}`, signal),
      "0x0",
    );
  assert.deepEqual(calls, [
    "eth_getTransactionCount",
    "eth_getTransactionCount",
  ]);
});
test("dormant HTTP transport bounds bytes, rejects redirects and invalid envelopes, and exposes no generic RPC", async () => {
  const controller = new AbortController();
  for (const fetcher of [
    async () => new Response("x".repeat(70000)),
    async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: "0x0" })),
    async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0", extra: true }),
      ),
    async () => {
      throw new TypeError("redirect forbidden");
    },
  ]) {
    const t = new HttpTransactionTransport(policy, fetcher as typeof fetch);
    await assert.rejects(
      t.pendingNonce(0, `0x${"12".repeat(20)}`, controller.signal),
    );
    assert.equal("rpc" in t, false);
  }
  let method = "";
  const t = new HttpTransactionTransport(policy, (async (_url, options) => {
    assert.equal(options?.redirect, "error");
    const body = JSON.parse(String(options?.body));
    method = body.method;
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x0" }),
    );
  }) as typeof fetch);
  assert.equal(
    await t.pendingNonce(1, `0x${"12".repeat(20)}`, controller.signal),
    "0x0",
  );
  assert.equal(method, "eth_getTransactionCount");
});
test("storage failure signs nothing; pending SDK saves retain exact capsule/draft; superseded save stays distinct", async () => {
  const f = fixture(),
    passkeys = new MeraPasskeyAdapter(
      new SyntheticWebAuthnClient({ seed: "offline-outcomes" }),
    ),
    primary = await createPrimary(policy, passkeys, f.adapters),
    backup = await prepareBackup(policy, passkeys, primary);
  f.mirrors[0].offline = true;
  await assert.rejects(
    finalizeEnrollment(primary, backup, content, f.adapters),
  );
  assert.equal(f.chain.sends, 0);
  const initial = primary.enrollment!.capsuleDigest;
  f.mirrors[0].offline = false;
  const prepared = await finalizeEnrollment(
    primary,
    backup,
    content,
    f.adapters,
  );
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  assert.equal(primary.enrollment!.capsuleDigest, initial);
  f.chain.broadcastMode = "unmined";
  const draft = { ...content, draft: "pending" };
  const pending = await saveCheckpoint(prepared.state, draft, f.adapters);
  assert.equal(pending.status, "pending");
  const count = f.mirrors[0].blobs.size;
  const again = await saveCheckpoint(prepared.state, draft, f.adapters);
  assert.equal(again.status, "pending");
  assert.equal(f.mirrors[0].blobs.size, count);
  assert.equal(f.chain.sends, 2);
  await assert.rejects(
    saveCheckpoint(
      prepared.state,
      { ...draft, draft: "different" },
      f.adapters,
    ),
    code("WRITE_PENDING"),
  );
  primary.close();
  const g = fixture(),
    p = await createPrimary(
      policy,
      new MeraPasskeyAdapter(
        new SyntheticWebAuthnClient({ seed: "superseded-sdk" }),
      ),
      g.adapters,
    ),
    b = await prepareBackup(
      policy,
      new MeraPasskeyAdapter(
        new SyntheticWebAuthnClient({ seed: "superseded-sdk" }),
      ),
      p,
    ),
    e = await finalizeEnrollment(p, b, content, g.adapters);
  if (e.status !== "prepared") throw new Error("fixture");
  g.chain.afterBroadcast = () => {
    const h = g.chain.heads.get(p.context.owner + p.context.streamId)!;
    h.version++;
    h.digest = id(99);
  };
  const result = await saveCheckpoint(
    e.state,
    { ...content, draft: "superseded" },
    g.adapters,
  );
  assert.equal(result.status, "superseded");
  p.close();
});
test("runtime properties cannot extend expiry or replace pinned policy/endpoints", async () => {
  const f = writerFixture();
  for (const field of ["owner", "expiresAt", "trustMode"]) {
    assert.throws(() =>
      Object.assign(f.writer, {
        [field]: field === "expiresAt" ? Number.MAX_SAFE_INTEGER : "changed",
      }),
    );
  }
  f.chain.now += 600001;
  assert.throws(() => f.writer.assertActive(), code("SESSION_EXPIRED"));
  const transport = new HttpTransactionTransport(policy, (async () => {
    throw new Error("No network");
  }) as typeof fetch);
  assert.throws(() =>
    Object.assign(transport, {
      policy: {
        ...policy,
        rpcUrls: ["https://replacement.invalid", "https://second.invalid"],
      },
    }),
  );
  assert.throws(() => Object.assign(f.registry, { policy: LOCAL_POLICY }));
});
test("receipt at finalized height must match the accepted finalized block hash", async () => {
  const f = writerFixture(),
    original = f.chain.rpc;
  const rpc: typeof original = async (...args) => {
    const result = await original(...args);
    if (
      args[1] === "eth_getBlockByNumber" &&
      Number(BigInt((result as { number: string }).number)) > 100
    )
      return { ...(result as object), hash: id(999) };
    return result;
  };
  const registry = new MonadRegistryReader(policy, rpc, () => f.chain.now),
    adapters = { ...f.adapters, registry };
  const writer = new OwnerWriter(
    new Uint8Array(32).fill(7),
    policy,
    adapters,
    () => f.chain.now,
  );
  writer.bindContext(contextFor(policy, writer.owner, id(1)));
  writer.bindManifest(id(2));
  await assert.rejects(
    writer.execute(f.command),
    code("TRANSACTION_EVIDENCE_INVALID"),
  );
  assert.ok(writer.pendingTicket);
  writer.close();
  f.writer.close();
});
test("provider maxima, full-gas budget proof, and concurrent calls never duplicate a nonce", async () => {
  const f = writerFixture();
  const estimate = f.chain.estimateGas.bind(f.chain),
    fees = f.chain.fees.bind(f.chain);
  f.chain.estimateGas = async (...args) =>
    args[0] === 1 ? "0x1d4c0" : estimate(...args);
  f.chain.fees = async (...args) =>
    args[0] === 1
      ? { maxFeePerGas: "0x6", maxPriorityFeePerGas: "0x2" }
      : fees(...args);
  const results = await Promise.all([
    f.writer.execute(f.command),
    f.writer.execute(commit(f.writer.owner)),
  ]);
  assert.equal(f.chain.sends, 2);
  assert.deepEqual(
    [...f.chain.transactions.values()].map((t) => t.nonce),
    ["0x0", "0x1"],
  );
  for (const r of results) {
    assert.equal(r.status, "confirmed");
    if (r.status !== "confirmed" || r.proof.kind !== "finalized-receipt")
      continue;
    assert.equal(r.proof.receipt.gasLimit, "144000");
    assert.equal(r.proof.receipt.maximumFeeWei, "864000");
    assert.equal(r.proof.receipt.fullGasFeeWei, "720000");
  }
  assert.equal(f.writer.budget.signingAttempts, 2);
  assert.equal(f.writer.budget.reservedFeeWei, "1728000");
  f.writer.close();
});
test("expiry immediately after actual Mera signing consumes reservation and prevents first broadcast", async () => {
  const f = fixture();
  let stage = "",
    checks = 0;
  f.chain.stage = (name) => {
    stage = name;
  };
  const writer = new OwnerWriter(
    new Uint8Array(32).fill(7),
    policy,
    f.adapters,
    () => {
      if (stage === "fees" && ++checks >= 3) return f.chain.now + 600001;
      return f.chain.now;
    },
  );
  writer.bindContext(contextFor(policy, writer.owner, id(1)));
  writer.bindManifest(id(2));
  await assert.rejects(
    writer.execute({
      operation: "create",
      owner: writer.owner,
      streamId: id(1),
      manifestDigest: id(2),
      initialCapsuleDigest: id(3),
    }),
    code("SESSION_EXPIRED"),
  );
  assert.equal(writer.budget.signingAttempts, 1);
  assert.equal(f.chain.sends, 0);
  assert.equal(writer.pendingTicket, undefined);
  writer.close();
});
test("SDK read-only reconciliation completes enrollment/save caches and permits next explicit save", async () => {
  const f = fixture(),
    passkeys = new MeraPasskeyAdapter(
      new SyntheticWebAuthnClient({ seed: "read-only-sdk-reconcile" }),
    ),
    p = await createPrimary(policy, passkeys, f.adapters),
    b = await prepareBackup(policy, passkeys, p);
  f.chain.broadcastMode = "timeout";
  const e = await finalizeEnrollment(p, b, content, f.adapters);
  assert.equal(e.status, "pending");
  if (e.status !== "pending") return;
  let uploads = 0;
  const put = f.mirrors[0].putBlob.bind(f.mirrors[0]);
  f.mirrors[0].putBlob = async (...args) => {
    uploads++;
    return put(...args);
  };
  const prepared = await reconcileEnrollment(p, e.ticket, f.adapters);
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  assert.equal(uploads, 0);
  assert.equal(f.chain.sends, 1);
  const pending = await saveCheckpoint(
    prepared.state,
    { ...content, draft: "v2" },
    f.adapters,
  );
  assert.equal(pending.status, "pending");
  if (pending.status !== "pending") return;
  const before = uploads;
  const saved = await reconcileCheckpoint(
    prepared.state,
    pending.ticket,
    f.adapters,
  );
  assert.equal(saved.status, "saved");
  assert.equal(uploads, before);
  assert.equal(f.chain.sends, 2);
  f.chain.broadcastMode = "normal";
  const v3 = await saveCheckpoint(
    prepared.state,
    { ...content, draft: "v3" },
    f.adapters,
  );
  assert.equal(v3.status, "saved");
  assert.equal(f.chain.sends, 3);
  p.close();
});
test("pending ticket survives a freshness failure; later check is read-only", async () => {
  const f = writerFixture();
  f.chain.broadcastMode = "timeout";
  const out = await f.writer.execute(f.command);
  assert.equal(out.status, "unresolved");
  if (out.status !== "unresolved") return;
  f.chain.timestamp -= 100;
  await assert.rejects(
    f.writer.reconcile(out.ticket),
    code("FRESHNESS_UNAVAILABLE"),
  );
  assert.deepEqual(f.writer.pendingTicket, out.ticket);
  f.chain.timestamp += 100;
  assert.equal((await f.writer.reconcile(out.ticket)).status, "confirmed");
  assert.equal(f.chain.sends, 1);
  f.writer.close();
});
test("expiry before preparation and no-change/overflow commits broadcast nothing", async () => {
  const f = writerFixture();
  f.chain.now += 600001;
  await assert.rejects(f.writer.execute(f.command), code("SESSION_EXPIRED"));
  assert.equal(f.chain.sends, 0);
  const g = writerFixture();
  await assert.rejects(
    g.writer.execute(commit(g.writer.owner, "18446744073709551615")),
    code("WRITE_CONFLICT"),
  );
  await assert.rejects(
    g.writer.execute(commit(g.writer.owner, "1", id(3), id(3))),
    code("WRITE_CONFLICT"),
  );
  assert.equal(g.chain.sends, 0);
  g.writer.close();
});
test("owner estimates stay within the caller's gas ceiling before signing", async () => {
  const f = writerFixture({ maxGas: 180000n });
  const original = f.chain.estimateGas.bind(f.chain);
  let estimates = 0;
  f.chain.estimateGas = async (provider, call, signal) => {
    estimates++;
    assert.equal(call.gas, "0x2bf20");
    return original(provider, call, signal);
  };
  await f.writer.execute(f.command);
  assert.equal(estimates, 2);
  assert.equal(f.chain.sends, 1);
  f.writer.close();
});
test("HTTP estimate decodes only exact WriteConflict; historical calls take canonical decimal block numbers", async () => {
  const { encodeErrorResult, encodeFunctionData } = await import("viem"),
    { registryAbi } = await import("../src/sdk/quorum.ts");
  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: "create",
    args: [id(1), id(2), id(3)],
  });
  const conflict = encodeErrorResult({
    abi: registryAbi,
    errorName: "WriteConflict",
    args: [1n, 2n, id(3), id(4)],
  });
  const t = new HttpTransactionTransport(policy, (async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.equal(request.params[0].gas, "0x493e0");
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "execution reverted", data: conflict },
      }),
    );
  }) as typeof fetch);
  await assert.rejects(
    t.estimateGas(
      0,
      {
        from: `0x${"12".repeat(20)}`,
        to: policy.registryAddress,
        value: "0x0",
        gas: "0x493e0",
        data,
      },
      new AbortController().signal,
    ),
    code("WRITE_CONFLICT"),
  );
  assert.throws(() => t.block(0, "finalized", new AbortController().signal));
  assert.throws(() => t.code(0, "0x1", new AbortController().signal));
  for (const gas of [
    300000,
    { toString: () => "0x493e0", toJSON: () => "0x0" },
    "0x0",
    "0x00",
    "0x0493e0",
    "300000",
    "0x" + "1".repeat(65),
  ])
    assert.throws(
      () =>
        t.estimateGas(
          0,
          {
            from: `0x${"12".repeat(20)}`,
            to: policy.registryAddress,
            value: "0x0",
            gas: gas as `0x${string}`,
            data,
          },
          new AbortController().signal,
        ),
      code("CONTEXT_MISMATCH"),
    );
});
