import { HttpMirrorStore } from "../sdk/stores.ts";
import {
  HttpTransactionTransport,
  MonadRegistryReader,
} from "../sdk/monad-registry.ts";
import { ContinuityError } from "../sdk/types.ts";
import {
  RELEASE_LIMITS,
  releasePolicy,
  validateReleaseProfile,
} from "./profile.ts";
import type { PrimaryAdapters } from "../sdk/types.ts";

export function createReleaseRuntime(
  input: unknown,
  uploadToken: () => string,
) {
  const profile = validateReleaseProfile(input);
  const policy = releasePolicy(profile);
  const adapters: PrimaryAdapters = Object.freeze({
    trustMode: "trusted-rpc-quorum",
    registry: new MonadRegistryReader(policy),
    transactions: new HttpTransactionTransport(policy),
    sessionLimits: RELEASE_LIMITS,
    mirrors: Object.freeze(
      policy.mirrorUrls.map(
        (url) =>
          new HttpMirrorStore(url, undefined, policy.timeoutMs, () => {
            const token = uploadToken();
            if (
              !/^[a-f0-9]{64}$/.test(token) ||
              Date.now() >= Date.parse(profile.expiresAt)
            )
              throw new ContinuityError(
                "STORAGE_FAILED",
                "Demo uploads are locked",
              );
            return { authorization: `Bearer ${token}` };
          }),
      ),
    ),
  });
  return Object.freeze({
    kind: "monad-testnet" as const,
    policy,
    adapters,
    requirePhysicalPasskeys: true,
    controlUrl: null,
    profile,
  });
}
