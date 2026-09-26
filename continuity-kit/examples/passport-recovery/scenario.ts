/** PUBLIC SYNTHETIC FEASIBILITY TEST. No HTTP, disk storage, real passkeys or chain. */
import assert from "node:assert/strict";
import {
  LOCAL_POLICY,
  MemoryMirrorStore,
  MemoryRegistry,
  MeraPasskeyAdapter,
  createPrimary,
  prepareBackup,
  finalizeEnrollment,
  saveCheckpoint,
  discoverRecovery,
  recoverCurrent,
  ContinuityError,
} from "../../src/sdk/index.ts";
import type {
  LocalRecoveryPolicy,
  PrimaryAdapters,
  RecoveryAdapters,
  Hex,
} from "../../src/sdk/index.ts";
import { SyntheticWebAuthnClient } from "../../src/sdk/demo-fixture.ts";
import {
  fromCheckpoint,
  hasMeaningfulChange,
  toCheckpoint,
} from "./adapter.ts";
import type { PassportData } from "./adapter.ts";

export const EXAMPLE_POLICY: LocalRecoveryPolicy = Object.freeze({
  ...LOCAL_POLICY,
  applicationId: "continuity-passport-example",
  schemaId: "workspace-with-passport-example/v1",
  deploymentId: "local-passport-feasibility-v1",
  bootstrapNamespace: "continuity-kit/passport-feasibility/v1",
});
const SEED = "PUBLIC SYNTHETIC PASSPORT FEASIBILITY ONLY";
const KEY = `10143:0x${"11".repeat(20)}:1`;
const REMOVED_KEY = `10143:0x${"22".repeat(20)}:2`;

export async function runPassportScenario() {
  const v1: PassportData = {
    v: 1,
    name: "Public fixture — Øya 🎵",
    notes: {
      [KEY]: { text: "Opening song: Example One.", at: 1_790_000_000_000 },
      [REMOVED_KEY]: { text: "Sample note to remove.", at: 1_790_000_000_000 },
    },
  };
  const v2: PassportData = {
    ...v1,
    notes: {
      [KEY]: {
        text: "Correction: closing song was Example Two.",
        at: 1_790_000_001_000,
      },
    },
  };
  const fixture = () => new SyntheticWebAuthnClient({ seed: SEED });
  const mirrors = [
    new MemoryMirrorStore("example-mirror-0"),
    new MemoryMirrorStore("example-mirror-1"),
  ];
  const registry = new MemoryRegistry(EXAMPLE_POLICY);
  let registryWrites = 0;
  const adapters: PrimaryAdapters = {
    trustMode: "local-model",
    mirrors,
    registry,
    localWriter: {
      async executeLocal(command, signature) {
        registryWrites++;
        return registry.executeLocal(command, signature);
      },
    },
  };
  const primary = await createPrimary(
    EXAMPLE_POLICY,
    new MeraPasskeyAdapter(fixture()),
    adapters,
  );
  const recoveryAdapters: RecoveryAdapters = {
    // No primary account, signer or localWriter is passed to the recovery path.
    mirrors,
    registry: {
      policy: EXAMPLE_POLICY,
      getHead: (owner, stream) => registry.getHead(owner, stream),
    },
  };
  let recoveryCalls = 0;
  const freshRecovery = async (policy = EXAMPLE_POLICY, seed = SEED) => {
    const client = new SyntheticWebAuthnClient({ seed });
    const passkeys = new MeraPasskeyAdapter(client);
    try {
      const found = await discoverRecovery(policy, passkeys, recoveryAdapters);
      const recovered = await recoverCurrent(found, passkeys, recoveryAdapters);
      assert.ok(client.ceremonies.length > 0);
      return { recovered, passport: fromCheckpoint(recovered.content) };
    } finally {
      recoveryCalls++;
      assert.ok(
        client.ceremonies.every(
          (c) => c.operation === "get" && c.rpId === EXAMPLE_POLICY.bRpId,
        ),
      );
    }
  };
  const code = (expected: string) => (e: unknown) =>
    e instanceof ContinuityError && e.code === expected;

  try {
    const backup = await prepareBackup(
      EXAMPLE_POLICY,
      new MeraPasskeyAdapter(fixture()),
      primary,
    );
    const enrolled = await finalizeEnrollment(
      primary,
      backup,
      toCheckpoint(v1),
      adapters,
    );
    assert.equal(enrolled.status, "prepared");
    if (enrolled.status !== "prepared")
      throw new Error("Synthetic enrollment is pending; do not retry.");
    const first = primary.enrollment!.capsuleBytes.slice();
    assert.equal(hasMeaningfulChange(v1, v2), true);
    const saved = await saveCheckpoint(
      enrolled.state,
      toCheckpoint(v2),
      adapters,
    );
    assert.equal(saved.status, "saved");
    if (saved.status !== "saved" || saved.unresolvedTicket)
      throw new Error("Checkpoint unresolved; do not claim saved or retry.");
    const v2Digest: Hex = saved.recovered.capsuleDigest;
    assert.equal(saved.recovered.version, "2");

    // A repeated save / timestamp-only change must not trigger a third checkpoint.
    const unchanged = structuredClone(v2);
    unchanged.notes[KEY]!.at++;
    unchanged.notes[KEY]!.text += " ";
    if (hasMeaningfulChange(v2, unchanged))
      await saveCheckpoint(enrolled.state, toCheckpoint(unchanged), adapters);
    assert.equal(registryWrites, 2);
    assert.equal(
      (await registry.getHead(primary.context.owner, primary.context.streamId))
        .version,
      "2",
    );
    primary.close();

    mirrors[0]!.readBlobHook = (hash, bytes) =>
      hash === v2Digest ? first.slice() : bytes;
    const result = await freshRecovery();
    assert.deepEqual(result.passport, v2);
    assert.equal(result.recovered.version, "2");
    assert.equal(result.recovered.evidence.trustMode, "local-model");
    assert.ok(
      result.recovered.diagnostics.some(
        (d) => d.source === mirrors[0]!.id && d.code === "DIGEST_MISMATCH",
      ),
    );
    assert.equal(Object.hasOwn(result.passport.notes, REMOVED_KEY), false);

    mirrors[1]!.readBlobHook = mirrors[0]!.readBlobHook;
    await assert.rejects(
      () => freshRecovery(),
      code("CURRENT_DATA_UNAVAILABLE"),
    );
    for (const mirror of mirrors)
      mirror.readBlobHook = (hash, bytes) => (hash === v2Digest ? null : bytes);
    await assert.rejects(
      () => freshRecovery(),
      code("CURRENT_DATA_UNAVAILABLE"),
    );
    for (const mirror of mirrors) mirror.readBlobHook = undefined;
    registry.offline = true;
    await assert.rejects(() => freshRecovery(), code("FRESHNESS_UNAVAILABLE"));
    registry.offline = false;
    await assert.rejects(
      () => freshRecovery(EXAMPLE_POLICY, "DIFFERENT PUBLIC FIXTURE"),
      code("NO_RECOVERY_MATERIAL"),
    );
    await assert.rejects(
      () =>
        freshRecovery({
          ...EXAMPLE_POLICY,
          applicationId: "wrong-application",
        }),
      code("POLICY_INVALID"),
    );
    assert.equal(registryWrites, 2);

    return {
      evidence: "synthetic-public-fixture",
      trustMode: "local-model",
      sourceCommit: "0d36bc5b214c47cf07a9eacea2a8753610c313d0",
      identity: "separate-synthetic-continuity-pair",
      authority: "last-confirmed-continuity-checkpoint-only",
      checkpointVersion: "2",
      exactPayloadRoundTrip: true,
      correctionPreserved: true,
      removedNoteAbsentFromCurrentCopy: true,
      unchangedCheckpointSkipped: true,
      oldCopyRejected: true,
      bothOldCopiesRejected: true,
      missingCurrentRejected: true,
      unavailableRegistryRejected: true,
      wrongCredentialRejected: true,
      wrongApplicationRejected: true,
      localRegistryWrites: registryWrites,
      freshRecoveryAttempts: recoveryCalls,
      blockchainTransactions: 0,
      physicalCeremonies: 0,
      turnstileIntegration: false,
      externalAdoption: false,
    };
  } finally {
    primary.close();
  }
}

if (import.meta.main) {
  // Only public result metadata is printed; never log decrypted passport content or keys.
  console.log(JSON.stringify(await runPassportScenario(), null, 2));
}
