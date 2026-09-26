/** PUBLIC SYNTHETIC DEMO. No real passkeys, private content, HTTP or blockchain. */
import {
  LOCAL_POLICY,
  MeraPasskeyAdapter,
  MemoryMirrorStore,
  MemoryRegistry,
  createPrimary,
  prepareBackup,
  finalizeEnrollment,
  restorePrimary,
  saveCheckpoint,
  discoverRecovery,
  recoverCurrent,
  createLocalCopy,
  exportLocalCopy,
} from "../src/sdk/index.ts";
import type { Adapters, Workspace } from "../src/sdk/index.ts";
// Deliberately separate from the public SDK export: this is a test fixture.
import { SyntheticWebAuthnClient } from "../src/sdk/demo-fixture.ts";

const seed = "PUBLIC CONTINUITY INTEGRATOR EXAMPLE";
const newPasskeys = () =>
  new MeraPasskeyAdapter(new SyntheticWebAuthnClient({ seed }));
const adapters: Adapters = {
  mirrors: [
    new MemoryMirrorStore("mirror-0"),
    new MemoryMirrorStore("mirror-1"),
  ],
  registry: new MemoryRegistry(),
};
const workspace: Workspace = {
  title: "Synthetic integration",
  plan: "Recover an approved checkpoint.",
  tasks: [{ id: "review", text: "Try the recovery path", done: false }],
  draft: "Version one: public sample content.",
};

const passkeys = newPasskeys();
const primary = await createPrimary(LOCAL_POLICY, passkeys);
let restored: Awaited<ReturnType<typeof restorePrimary>> | undefined;
try {
  // Real browsers must run these operations at their respective RP origins,
  // using the explicit validated handoff. This fixture has no browser origin.
  const backup = await prepareBackup(LOCAL_POLICY, passkeys, primary);
  await finalizeEnrollment(primary, backup, workspace, adapters);
  const originalOwner = primary.context.owner;
  primary.close();

  restored = await restorePrimary(LOCAL_POLICY, newPasskeys(), adapters);
  if (restored.state.context.owner !== originalOwner)
    throw new Error("Owner changed");
  await saveCheckpoint(
    restored.state,
    {
      ...workspace,
      draft: "Version two: public sample content.",
    },
    adapters,
  );
  restored.state.close();

  // B gets only the fixture credential, fixed policy and surviving adapters.
  const freshB = newPasskeys();
  const discovered = await discoverRecovery(LOCAL_POLICY, freshB, adapters);
  const recovered = await recoverCurrent(discovered, freshB, adapters);
  if (
    recovered.version !== "2" ||
    recovered.content.draft !== "Version two: public sample content."
  ) {
    throw new Error("Expected current checkpoint v2");
  }
  const copy = createLocalCopy(recovered);
  copy.content.draft = "Local edit after recovery; no A registry write.";
  const exported = exportLocalCopy(copy); // Plaintext; save only at explicit user request.
  console.log(
    JSON.stringify(
      {
        evidence: "synthetic-public-fixture",
        trustMode: recovered.evidence.trustMode,
        samePrimaryOwner: true,
        recoveredVersion: recovered.version,
        localCopyStatus: copy.status,
        exportBytes: new TextEncoder().encode(exported).length,
      },
      null,
      2,
    ),
  );
} finally {
  primary.close();
  restored?.state.close();
}
