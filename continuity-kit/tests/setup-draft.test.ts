import test from "node:test";
import assert from "node:assert/strict";
import { SetupDraft } from "../src/sdk/setup-draft.ts";
import { accountFromPrf } from "../src/sdk/account.ts";
import { LOCAL_POLICY } from "../src/sdk/policy.ts";
import { MemoryMirrorStore, MemoryRegistry } from "../src/sdk/stores.ts";
import { MeraPasskeyAdapter } from "../src/sdk/passkeys.ts";
import { SyntheticWebAuthnClient } from "../src/sdk/demo-fixture.ts";
import {
  prepareBackup,
  finalizeEnrollment,
  discoverRecovery,
  recoverCurrent,
} from "../src/sdk/protocol.ts";
import { MonadRegistryReader } from "../src/sdk/monad-registry.ts";
import {
  OfflineChain,
  fixtureLimits,
  policy as chainPolicy,
} from "./fixtures/offline-chain.ts";
import type {
  PasskeyAdapter,
  PrimaryAdapters,
  RecoveryPolicy,
  PrfResult,
} from "../src/sdk/types.ts";

// These public PRFs are disposable synthetic fixtures. No native authentication/network.
async function setup(
  policy: RecoveryPolicy = LOCAL_POLICY,
  supplied?: PrimaryAdapters,
) {
  const registry = new MemoryRegistry();
  const adapters: PrimaryAdapters = supplied ?? {
    trustMode: "local-model",
    mirrors: [new MemoryMirrorStore("one"), new MemoryMirrorStore("two")],
    registry,
    localWriter: registry,
  };
  const originalPrf = new Uint8Array(32).fill(41);
  const primary = await accountFromPrf(
    policy,
    "synthetic-A",
    originalPrf.slice(),
    adapters,
  );
  primary.writer.bindContext(primary.context);
  const calls: string[] = [];
  let answer = async (): Promise<PrfResult> => ({
    credentialId: "synthetic-A",
    prfOutput: originalPrf.slice(),
  });
  const passkeys = {
    async openPrimary(p: RecoveryPolicy, credentialId?: string) {
      assert.deepEqual(p, policy);
      assert.equal(credentialId, "synthetic-A");
      calls.push("open-A");
      return answer();
    },
    async createPrimary() {
      assert.fail("Resume must never create A");
    },
    async createBackup() {
      assert.fail("Resume must never create B");
    },
  } as unknown as PasskeyAdapter;
  const draft = await SetupDraft.create(primary, adapters);
  return {
    primary,
    draft,
    adapters,
    passkeys,
    calls,
    answer(fn: typeof answer) {
      answer = fn;
    },
    originalPrf,
  };
}
test("repeated pre-B pauses reopen the exact same account and key, then normal independent recovery works", async () => {
  const s = await setup();
  const context = structuredClone(s.primary.context),
    key = s.primary.dataKey.slice(),
    locator = s.primary.locator;
  let current = s.primary;
  for (let n = 0; n < 2; n++) {
    const closed = current;
    assert.equal(s.draft.pause(), true);
    assert.ok(closed.dataKey.every((v) => v === 0));
    assert.ok(closed.recordKey.every((v) => v === 0));
    assert.throws(() => closed.writer.assertActive(), {
      code: "SESSION_EXPIRED",
    });
    current = await s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters);
    assert.deepEqual(current.context, context);
    assert.deepEqual(current.dataKey, key);
    assert.equal(current.locator, locator);
    assert.equal(current.writer.budget.signingAttempts, 0);
    assert.equal(current.writer.budget.reservedFeeWei, "0");
    assert.throws(() => closed.writer.assertActive(), {
      code: "SESSION_EXPIRED",
    });
  }
  assert.deepEqual(s.calls, ["open-A", "open-A"]);
  s.draft.beginBackup(current);
  assert.equal(s.draft.pause(), false);
  await assert.rejects(s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters), {
    code: "ENROLLMENT_CONFLICT",
  });
  const b = new MeraPasskeyAdapter(
    new SyntheticWebAuthnClient({ seed: "synthetic-pause-proof" }),
  );
  const backup = await prepareBackup(LOCAL_POLICY, b, current);
  const content = {
    title: "Synthetic retained setup",
    plan: "Pause proof",
    tasks: [],
    draft: "Public fixture",
  };
  assert.equal(
    (await finalizeEnrollment(current, backup, content, s.adapters)).status,
    "prepared",
  );
  current.close();
  s.draft.close();
  const recovered = await recoverCurrent(
    await discoverRecovery(LOCAL_POLICY, b, s.adapters),
    b,
    s.adapters,
  );
  assert.deepEqual(recovered.content, content);
  assert.deepEqual(recovered.context, context);
});
test("wrong credential and wrong PRF cannot replace the retained setup", async () => {
  const s = await setup();
  s.draft.pause();
  let output = s.originalPrf.slice();
  s.answer(async () => ({ credentialId: "different-A", prfOutput: output }));
  await assert.rejects(s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters), {
    code: "CREDENTIAL_MISMATCH",
  });
  assert.ok(output.every((v) => v === 0));
  assert.equal(s.draft.paused, true);
  output = new Uint8Array(32).fill(99);
  s.answer(async () => ({ credentialId: "synthetic-A", prfOutput: output }));
  await assert.rejects(s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters), {
    code: "DECRYPT_FAILED",
  });
  assert.ok(output.every((v) => v === 0));
  assert.equal(s.draft.paused, true);
  s.draft.close();
});
test("full policy and signing caps are bound before authentication and again after its asynchronous return", async () => {
  const chain = new OfflineChain();
  const adapters: PrimaryAdapters = {
    trustMode: "trusted-rpc-quorum",
    registry: new MonadRegistryReader(chainPolicy, chain.rpc, () => chain.now),
    mirrors: [new MemoryMirrorStore("one"), new MemoryMirrorStore("two")],
    transactions: chain,
    sessionLimits: { ...fixtureLimits },
  };
  const s = await setup(chainPolicy, adapters);
  s.draft.pause();
  for (const changed of [
    { ...chainPolicy, bootstrapNamespace: "different" },
    {
      ...chainPolicy,
      rpcUrls: ["https://changed.invalid", chainPolicy.rpcUrls[1]],
    },
  ]) {
    await assert.rejects(
      s.draft.resume(changed as RecoveryPolicy, s.passkeys, adapters),
      { code: "POLICY_INVALID" },
    );
  }
  adapters.sessionLimits.maxGas += 1n;
  await assert.rejects(s.draft.resume(chainPolicy, s.passkeys, adapters), {
    code: "POLICY_INVALID",
  });
  assert.equal(s.calls.length, 0);
  adapters.sessionLimits.maxGas -= 1n;
  s.answer(async () => {
    adapters.sessionLimits.maxTotalFeeWei += 1n;
    return { credentialId: "synthetic-A", prfOutput: s.originalPrf.slice() };
  });
  await assert.rejects(s.draft.resume(chainPolicy, s.passkeys, adapters), {
    code: "POLICY_INVALID",
  });
  assert.equal(chain.sends, 0);
  assert.equal(s.draft.paused, true);
  s.draft.close();
});
test("one live handle serializes resumes; closing it invalidates late authentication permanently", async () => {
  const s = await setup();
  s.draft.pause();
  let finish!: (value: PrfResult) => void;
  s.answer(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters);
  await assert.rejects(s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters), {
    code: "ENROLLMENT_CONFLICT",
  });
  s.draft.close();
  const prf = s.originalPrf.slice();
  finish({ credentialId: "synthetic-A", prfOutput: prf });
  await assert.rejects(first, { code: "SESSION_EXPIRED" });
  assert.ok(prf.every((v) => v === 0));
  assert.equal(s.calls.length, 1);
  await assert.rejects(s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters), {
    code: "ENROLLMENT_CONFLICT",
  });
});
test("a grant irrevocably prevents resume, even with no B result or cancelled native creation", async () => {
  const s = await setup();
  s.draft.beginBackup(s.primary);
  assert.equal(s.draft.pause(), false);
  assert.throws(() => s.draft.beginBackup(s.primary), {
    code: "ENROLLMENT_CONFLICT",
  });
  await assert.rejects(s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters), {
    code: "ENROLLMENT_CONFLICT",
  });
  assert.deepEqual(s.calls, []);
  s.primary.close();
});
test("a primary account or alias cannot fork independent pause controllers, including after resume", async () => {
  const s = await setup();
  for (const account of [s.primary, { ...s.primary }])
    await assert.rejects(SetupDraft.create(account, s.adapters), {
      code: "ENROLLMENT_CONFLICT",
    });
  s.draft.pause();
  const reopened = await s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters);
  await assert.rejects(SetupDraft.create(reopened, s.adapters), {
    code: "ENROLLMENT_CONFLICT",
  });
  s.draft.beginBackup(reopened);
  await assert.rejects(SetupDraft.create({ ...reopened }, s.adapters), {
    code: "ENROLLMENT_CONFLICT",
  });
  assert.equal(s.draft.pause(), false);
  reopened.close();
});
test("B expiry between native creation and discovery cannot initiate another ceremony", async () => {
  const s = await setup();
  const b = new MeraPasskeyAdapter(
    new SyntheticWebAuthnClient({ seed: "synthetic-late-create" }),
  );
  let active = true,
    discovers = 0;
  let captured: Uint8Array | undefined;
  const create = b.createBackup.bind(b);
  b.createBackup = async (secret, policy) => {
    captured = secret;
    const vault = await create(secret, policy);
    active = false;
    return vault;
  };
  b.discover = async () => {
    discovers++;
    assert.fail("Expired handoff must not ask for discovery authentication");
  };
  await assert.rejects(
    prepareBackup(LOCAL_POLICY, b, s.primary, () => active),
    { code: "SESSION_EXPIRED" },
  );
  assert.equal(discovers, 0);
  assert.ok(captured?.every((v) => v === 0));
  s.draft.close();
});
test("late B discovery wipes returned PRF and yields no prepared reserve", async () => {
  const s = await setup();
  const b = new MeraPasskeyAdapter(
    new SyntheticWebAuthnClient({ seed: "synthetic-late-discovery" }),
  );
  let active = true;
  let captured: Uint8Array | undefined;
  const discover = b.discover.bind(b);
  b.discover = async (policy, credential) => {
    const result = await discover(policy, credential);
    captured = result.prfOutput;
    active = false;
    return result;
  };
  await assert.rejects(
    prepareBackup(LOCAL_POLICY, b, s.primary, () => active),
    { code: "SESSION_EXPIRED" },
  );
  assert.ok(captured?.every((v) => v === 0));
  s.draft.close();
});
test("prepared enrollment, consumed signing budget or unknown ticket can never renew a setup session", async () => {
  for (const kind of ["enrollment", "ticket", "attempt", "fee"]) {
    const s = await setup();
    if (kind === "enrollment")
      s.primary.enrollment = {} as NonNullable<typeof s.primary.enrollment>;
    else {
      const real = s.primary.writer;
      s.primary.writer = new Proxy(real, {
        get(target, key) {
          if (key === "pendingTicket" && kind === "ticket")
            return { synthetic: true };
          if (key === "budget")
            return {
              ...real.budget,
              signingAttempts: kind === "attempt" ? 1 : 0,
              reservedFeeWei: kind === "fee" ? "1" : "0",
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    assert.equal(s.draft.pause(), false);
    await assert.rejects(s.draft.resume(LOCAL_POLICY, s.passkeys, s.adapters), {
      code: "ENROLLMENT_CONFLICT",
    });
    assert.equal(s.calls.length, 0);
  }
});
