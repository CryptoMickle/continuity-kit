/** PUBLIC SYNTHETIC CONSUMER. No real credentials, network, or blockchain. */
import {
  ContinuityError,
  LOCAL_POLICY,
  MemoryMirrorStore,
  MemoryRegistry,
  MeraPasskeyAdapter,
  createPrimary,
  discoverRecovery,
  finalizeEnrollment,
  prepareBackup,
  recoverCurrent,
  saveCheckpoint,
} from "continuity-kit";
import type {
  LocalRecoveryPolicy,
  PrimaryAdapters,
  RecoveryAdapters,
  Workspace,
} from "continuity-kit";
import { SyntheticWebAuthnClient } from "continuity-kit/testing";

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectCode(action: () => Promise<unknown>, code: string) {
  try {
    await action();
  } catch (error) {
    expect(
      error instanceof ContinuityError && error.code === code,
      `Expected ${code}; received a different failure`,
    );
    return;
  }
  throw new Error(`Expected ${code}; operation unexpectedly succeeded`);
}

// This separate application owns its namespace, content selection, and save policy.
const policy: LocalRecoveryPolicy = Object.freeze({
  ...LOCAL_POLICY,
  applicationId: "standalone-project-journal",
  schemaId: "project-journal-workspace/v1",
  deploymentId: "local-standalone-consumer-v1",
  bootstrapNamespace: "continuity-kit/standalone-consumer/v1",
});
const seed = "PUBLIC SYNTHETIC STANDALONE CONSUMER ONLY";
const newPasskeys = () =>
  new MeraPasskeyAdapter(new SyntheticWebAuthnClient({ seed }));
const mirrors = [
  new MemoryMirrorStore("consumer-mirror-0"),
  new MemoryMirrorStore("consumer-mirror-1"),
];
const registry = new MemoryRegistry(policy);
let registryWrites = 0;
const primaryAdapters: PrimaryAdapters = {
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

// A public invented project journal: a decision is corrected before handover.
const first: Workspace = {
  title: "Public fixture: project handover",
  plan: "Keep the approved project decision available for later work.",
  tasks: [{ id: "review", text: "Review the example decision", done: false }],
  draft: "Proposed delivery: Friday. This is invented demonstration content.",
};
const corrected: Workspace = {
  ...first,
  tasks: [{ id: "review", text: "Review the example decision", done: true }],
  draft: "Corrected delivery: Monday. This is invented demonstration content.",
};

// Fixed fields are serialized explicitly; an unchanged snapshot produces no write.
// Exact text, task order, and checked state matter in this example's product policy.
function sameSnapshot(a: Workspace, b: Workspace) {
  const key = (w: Workspace) =>
    JSON.stringify([
      w.title,
      w.plan,
      w.tasks.map((task) => [task.id, task.text, task.done]),
      w.draft,
    ]);
  return key(a) === key(b);
}

const primary = await createPrimary(policy, newPasskeys(), primaryAdapters);
try {
  // The fixture can model both origins in one process. Real browser enrollment
  // needs the separate A/B origins and validated handoff described in the contract.
  const backup = await prepareBackup(policy, newPasskeys(), primary);
  const enrollment = await finalizeEnrollment(
    primary,
    backup,
    first,
    primaryAdapters,
  );
  expect(enrollment.status === "prepared", "Enrollment is not confirmed");
  const state = enrollment.state;
  expect(primary.enrollment, "Missing encrypted enrollment checkpoint");
  const oldEncryptedBytes = primary.enrollment.capsuleBytes.slice();
  let accepted = structuredClone(first);
  let unchangedSkipped = 0;

  async function checkpointIfChanged(draft: Workspace) {
    if (sameSnapshot(accepted, draft)) {
      unchangedSkipped++;
      return undefined;
    }
    // Capture before awaiting. Later host edits must not become the saved baseline.
    const captured = structuredClone(draft);
    const saved = await saveCheckpoint(state, captured, primaryAdapters);
    // A real host must retain pending state/tickets and reconcile rather than retry.
    // This memory-only exercise aborts any unresolved operation without resubmitting.
    expect(
      saved.status === "saved" && !saved.unresolvedTicket,
      "Checkpoint unresolved; preserve the draft and reconcile, do not retry",
    );
    accepted = structuredClone(saved.recovered.content);
    return saved.recovered;
  }

  const saved = await checkpointIfChanged(corrected);
  expect(saved?.version === "2", "Expected confirmed checkpoint v2");
  await checkpointIfChanged(structuredClone(corrected));
  expect(registryWrites === 2, "An unchanged snapshot caused another write");
  primary.close();

  // Fresh B receives only fixed policy, encrypted stores, and a registry reader.
  // It receives no A key, writer, remembered owner, or plaintext baseline.
  const recoveryAdapters: RecoveryAdapters = {
    mirrors,
    registry: {
      policy,
      getHead: (owner, stream) => registry.getHead(owner, stream),
    },
  };
  async function freshRecovery() {
    const passkeys = newPasskeys();
    const found = await discoverRecovery(policy, passkeys, recoveryAdapters);
    return recoverCurrent(found, passkeys, recoveryAdapters);
  }

  // One mirror substitutes an authentic old checkpoint for the current digest.
  const stale = (hash: string, bytes: Uint8Array | null) =>
    hash === saved.capsuleDigest ? oldEncryptedBytes.slice() : bytes;
  mirrors[0]!.readBlobHook = stale;
  const recovered = await freshRecovery();
  expect(recovered.version === "2", "Recovery accepted an old version");
  expect(
    sameSnapshot(recovered.content, corrected),
    "Correction was not preserved",
  );
  expect(
    recovered.diagnostics.some(
      (d) => d.source === mirrors[0]!.id && d.code === "DIGEST_MISMATCH",
    ),
    "The substituted old copy was not rejected",
  );
  mirrors[1]!.readBlobHook = stale;
  await expectCode(freshRecovery, "CURRENT_DATA_UNAVAILABLE");
  for (const mirror of mirrors) mirror.readBlobHook = undefined;
  registry.offline = true;
  await expectCode(freshRecovery, "FRESHNESS_UNAVAILABLE");
  registry.offline = false;

  // Result metadata only. Never print keys or private workspace contents.
  console.log(
    JSON.stringify(
      {
        evidence: "synthetic-public-fixture",
        trustMode: recovered.evidence.trustMode,
        consumer: "separate-package-import",
        verifiedVersion: recovered.version,
        correctedDecisionPreserved: true,
        unchangedSnapshotsSkipped: unchangedSkipped,
        oneStaleMirrorRejected: true,
        bothStaleMirrorsFailedClosed: true,
        unavailableRegistryFailedClosed: true,
        localRegistryWrites: registryWrites,
        blockchainTransactions: 0,
        physicalCeremonies: 0,
        externalAdoption: false,
      },
      null,
      2,
    ),
  );
} finally {
  primary.close();
}
