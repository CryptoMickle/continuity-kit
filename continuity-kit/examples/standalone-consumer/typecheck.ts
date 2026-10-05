/** Consumer compilation checks against the installed package declarations. */
import type { RecoveryAdapters, Workspace } from "continuity-kit";
import { SyntheticWebAuthnClient } from "continuity-kit/testing";

// The synthetic authenticator must require its explicitly labeled testing path.
// @ts-expect-error Synthetic credentials are deliberately not a root SDK export.
import { SyntheticWebAuthnClient as unsafeRootFixture } from "continuity-kit";
void unsafeRootFixture;
void SyntheticWebAuthnClient;

const invalidWorkspace: Workspace = {
  title: "Public sample",
  plan: "Only the documented Workspace shape is accepted",
  tasks: [],
  // @ts-expect-error A workspace draft must be text, not an arbitrary object.
  draft: { arbitrary: "payload" },
};
void invalidWorkspace;

function recoveryHasNoWriter(adapters: RecoveryAdapters) {
  // @ts-expect-error Recovery adapters do not provide primary writing authority.
  return adapters.localWriter;
}
void recoveryHasNoWriter;
