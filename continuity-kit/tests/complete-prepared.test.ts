import assert from "node:assert/strict";
import test from "node:test";
import { openPreparedCompletion } from "../testnet/complete-prepared.ts";
import {
  MemoryMirrorStore,
  MeraPasskeyAdapter,
  createPrimary,
  prepareBackup,
  finalizeEnrollment,
  discoverRecovery,
  recoverCurrent,
  MonadRegistryReader,
} from "../src/sdk/index.ts";
import { SyntheticWebAuthnClient } from "../src/sdk/demo-fixture.ts";
import {
  fixtureLimits,
  id,
  OfflineChain,
  policy,
} from "./fixtures/offline-chain.ts";
import type { PrimaryAdapters } from "../src/sdk/types.ts";

globalThis.fetch = async () => {
  throw Error("Network forbidden in repair tests");
};
const content = {
  title: "SYNTHETIC interrupted setup",
  plan: "offline only",
  tasks: [],
  draft: "exact prepared v1",
};
async function fixture() {
  const chain = new OfflineChain();
  const mirrors = [
    new MemoryMirrorStore("offline-0"),
    new MemoryMirrorStore("offline-1"),
  ];
  const adapters: PrimaryAdapters = {
    trustMode: "trusted-rpc-quorum",
    registry: new MonadRegistryReader(policy, chain.rpc, () => chain.now),
    transactions: chain,
    sessionLimits: { ...fixtureLimits, maxTransactions: 1 },
    mirrors,
  };
  const seed = "PUBLIC OFFLINE PREPARED COMPLETION";
  const client = new SyntheticWebAuthnClient({ seed });
  const passkeys = new MeraPasskeyAdapter(client);
  const primary = await createPrimary(policy, passkeys, adapters);
  const backup = await prepareBackup(policy, passkeys, primary);
  chain.stage = (stage) => {
    if (stage === "nonce") throw new TypeError("Illegal invocation");
  };
  await assert.rejects(
    finalizeEnrollment(primary, backup, content, adapters),
    /Illegal invocation/,
  );
  assert.equal(chain.sends, 0);
  const pin = {
    owner: primary.context.owner,
    streamId: primary.context.streamId,
    manifestDigest: backup.manifestDigest,
    capsuleDigest: primary.enrollment!.capsuleDigest,
  };
  const locator = primary.locator;
  primary.close();
  chain.stage = undefined;
  const fresh = new SyntheticWebAuthnClient({ seed });
  const open = (target = pin, c = fresh, controller = new AbortController()) =>
    openPreparedCompletion(
      policy,
      target,
      new MeraPasskeyAdapter(c),
      adapters,
      controller.signal,
    );
  return { chain, mirrors, adapters, pin, locator, fresh, seed, open };
}

test("repair reopens the same uploaded enrollment without new credentials/uploads, then existing B recovers exact v1", async () => {
  const f = await fixture();
  for (const m of f.mirrors) {
    m.putIndexIfAbsent = async () => {
      throw Error("No new index writes allowed");
    };
    m.putBlob = async () => {
      throw Error("No new blobs allowed");
    };
  }
  const original = structuredClone(f.pin);
  const repair = await f.open();
  assert.deepEqual(repair.content, content);
  assert.equal(f.chain.sends, 0, "Authentication/preview never sends");
  f.pin.capsuleDigest = id(123);
  repair.content.draft = "Preview mutation must not change signed intent";
  const outcome = await repair.complete();
  assert.equal(outcome.status, "confirmed");
  if (outcome.status !== "confirmed") return;
  assert.deepEqual(outcome.checkpoint, { ...original, version: "1" });
  assert.equal(f.chain.sends, 1);
  await assert.rejects(repair.complete());
  assert.equal(f.chain.sends, 1);
  assert.ok(f.fresh.ceremonies.every((c) => c.operation === "get"));
  const b = new MeraPasskeyAdapter(
    new SyntheticWebAuthnClient({ seed: f.seed }),
  );
  const found = await discoverRecovery(policy, b, f.adapters);
  assert.deepEqual(
    (await recoverCurrent(found, b, f.adapters)).content,
    content,
  );
});

test("repair rejects a different existing A key, mismatched pins, corrupt/missing copies and already-used owner", async () => {
  for (const mutation of [
    "key",
    "stream",
    "manifest",
    "digest",
    "index",
    "missing",
    "nonce",
    "head",
  ]) {
    const f = await fixture();
    let client = f.fresh;
    if (mutation === "key")
      client = new SyntheticWebAuthnClient({
        seed: "wrong existing test credential",
      });
    if (mutation === "stream") f.pin.streamId = id(9);
    if (mutation === "manifest") f.pin.manifestDigest = id(9);
    if (mutation === "digest") f.pin.capsuleDigest = id(9);
    if (mutation === "index") f.mirrors[1].indexes.get(f.locator)![0] ^= 1;
    if (mutation === "missing") f.mirrors[1].blobs.delete(f.pin.capsuleDigest);
    if (mutation === "nonce") f.chain.nonces.set(f.pin.owner, 1n);
    if (mutation === "head")
      f.chain.heads.set(f.pin.owner + f.pin.streamId, {
        manifest: f.pin.manifestDigest,
        version: 1n,
        digest: f.pin.capsuleDigest,
      });
    await assert.rejects(f.open(f.pin, client), mutation);
    assert.equal(f.chain.sends, 0, mutation);
    assert.ok(client.ceremonies.every((c) => c.operation === "get"));
  }
});

test("completion fences concurrent clicks, stale preview nonces and aborted sessions", async () => {
  const f = await fixture();
  const repair = await f.open();
  const outcomes = await Promise.allSettled([
    repair.complete(),
    repair.complete(),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(f.chain.sends, 1);
  const g = await fixture();
  const stale = await g.open();
  g.chain.nonces.set(g.pin.owner, 1n);
  await assert.rejects(stale.complete());
  assert.equal(g.chain.sends, 0);
  const h = await fixture();
  const abort = new AbortController();
  const closed = await h.open(h.pin, h.fresh, abort);
  abort.abort();
  await assert.rejects(closed.complete());
  assert.equal(h.chain.sends, 0);
});

test("unknown send retains the exact ticket and allows only read-only reconciliation", async () => {
  const f = await fixture();
  const repair = await f.open();
  f.chain.broadcastMode = "unmined";
  assert.equal((await repair.complete()).status, "unresolved");
  const ticket = repair.ticket;
  assert.ok(ticket);
  await assert.rejects(repair.complete());
  assert.equal((await repair.reconcile()).status, "unresolved");
  assert.deepEqual(repair.ticket, ticket);
  assert.equal(f.chain.sends, 1);
});

test("completion rechecks both stored copies after preview, and any failure consumes its one attempt", async () => {
  const f = await fixture();
  const repair = await f.open();
  const bytes = f.mirrors[1].blobs.get(f.pin.capsuleDigest)!;
  f.mirrors[1].blobs.delete(f.pin.capsuleDigest);
  await assert.rejects(repair.complete());
  f.mirrors[1].blobs.set(f.pin.capsuleDigest, bytes);
  await assert.rejects(repair.complete());
  assert.equal(f.chain.sends, 0);
});

test("late existing-key authentication is discarded after page termination", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const passkeys = new MeraPasskeyAdapter(f.fresh);
  let output: Uint8Array | undefined;
  await assert.rejects(
    openPreparedCompletion(
      policy,
      f.pin,
      {
        async openPrimary(p) {
          const r = await passkeys.openPrimary(p);
          output = r.prfOutput;
          abort.abort();
          return r;
        },
      },
      f.adapters,
      abort.signal,
    ),
  );
  assert.ok(output?.every((x) => x === 0));
  assert.equal(f.chain.sends, 0);
});
