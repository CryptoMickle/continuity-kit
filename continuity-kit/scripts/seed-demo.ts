/** Public, deterministic fixture only. Does not use a browser/authenticator or a blockchain. */
import {
  createPrimary,
  prepareBackup,
  finalizeEnrollment,
  LOCAL_POLICY,
  HttpMirrorStore,
  HttpRegistry,
  MeraPasskeyAdapter,
} from "../src/sdk/index.ts";
import { SyntheticWebAuthnClient } from "../src/sdk/demo-fixture.ts";
const passkeys = new MeraPasskeyAdapter(
  new SyntheticWebAuthnClient({ seed: "continuity-demo-profile-1" }),
);
const registry = new HttpRegistry(LOCAL_POLICY);
const adapters = {
  trustMode: "local-model" as const,
  localWriter: registry,
  mirrors: LOCAL_POLICY.mirrorUrls.map((url) => new HttpMirrorStore(url)),
  registry,
};
const primary = await createPrimary(LOCAL_POLICY, passkeys, adapters);
try {
  const backup = await prepareBackup(LOCAL_POLICY, passkeys, {
    context: primary.context,
    dataKey: primary.dataKey,
  });
  const result = await finalizeEnrollment(
    primary,
    backup,
    {
      title: "The next expedition",
      plan: "Build a small product people can trust with work they do not want to lose.",
      tasks: [
        { id: "proof", text: "Prove the recovery path", done: true },
        {
          id: "latest",
          text: "Keep the latest checkpoint honest",
          done: false,
        },
        { id: "review", text: "Let another developer try it", done: false },
      ],
      draft:
        "A great recovery flow should feel ordinary. Open a separate client, use the reserve you prepared, and find your work exactly where you left it.",
    },
    adapters,
  );
  if (result.status !== "prepared")
    throw new Error("Local fixture preparation pending");
  const state = result.state;
  process.stdout.write(
    `Public synthetic fixture prepared at v1. Owner: ${state.context.owner}\nUse Restore primary in A or Recover demo workspace in B.\nThis seed bypasses browser enrollment; it is not evidence of physical passkeys or the window handoff.\n`,
  );
} finally {
  primary.close();
}
