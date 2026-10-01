import { LOCAL_POLICY, freezePolicy, record, string } from "../sdk/policy.ts";
import { TESTNET_RUNTIME_CODE_HASH } from "../runtime.ts";
import type { MonadRecoveryPolicy } from "../sdk/types.ts";

export interface ReleaseProfile {
  format: "continuity-demo-release/v1";
  deploymentId: string;
  aOrigin: string;
  bOrigin: string;
  storeOrigin: string;
  expiresAt: string;
}
export const REGISTRY_ADDRESS = "0x3fc9997e62e56ba17225a47c32ad9406313dc98a";
export const RELEASE_LIMITS = Object.freeze({
  lifetimeMs: 600000,
  maxTransactions: 2,
  maxGas: 300000n,
  maxFeePerGas: 200000000000n,
  maxPriorityFeePerGas: 2000000000n,
  maxTotalFeeWei: 120000000000000000n,
});
export function validateReleaseProfile(
  input: unknown,
): Readonly<ReleaseProfile> {
  const p = record(input, [
    "format",
    "deploymentId",
    "aOrigin",
    "bOrigin",
    "storeOrigin",
    "expiresAt",
  ]);
  if (p.format !== "continuity-demo-release/v1")
    throw new Error("RELEASE_PROFILE_INVALID");
  string(p.deploymentId, 100);
  if (!/^public-demo-[a-z0-9-]{1,60}$/.test(p.deploymentId as string))
    throw new Error("RELEASE_PROFILE_INVALID");
  for (const field of ["aOrigin", "bOrigin", "storeOrigin"]) {
    string(p[field], 250);
    const u = new URL(p[field] as string);
    if (
      u.origin !== p[field] ||
      u.protocol !== "https:" ||
      u.port ||
      u.hostname === "localhost" ||
      u.hostname.endsWith(".localhost") ||
      !/^[a-z0-9.-]+$/.test(u.hostname) ||
      !u.hostname.includes(".") ||
      /^[0-9.]+$/.test(u.hostname)
    )
      throw new Error("RELEASE_ORIGIN_INVALID");
  }
  if (new Set([p.aOrigin, p.bOrigin, p.storeOrigin]).size !== 3)
    throw new Error("RELEASE_ORIGIN_INVALID");
  string(p.expiresAt, 30);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(p.expiresAt as string) ||
    !Number.isFinite(Date.parse(p.expiresAt as string)) ||
    new Date(p.expiresAt as string).toISOString() !== p.expiresAt
  )
    throw new Error("RELEASE_EXPIRY_INVALID");
  const result = Object.freeze({ ...p }) as unknown as Readonly<ReleaseProfile>;
  releasePolicy(result); // Includes RP disjointness and all existing bounds.
  return result;
}
export function releasePolicy(
  p: Readonly<ReleaseProfile>,
): MonadRecoveryPolicy {
  const { registryUrl: _registryUrl, ...base } = LOCAL_POLICY;
  return freezePolicy({
    ...base,
    aOrigin: p.aOrigin,
    bOrigin: p.bOrigin,
    aRpId: new URL(p.aOrigin).hostname,
    bRpId: new URL(p.bOrigin).hostname,
    deploymentId: p.deploymentId,
    bootstrapNamespace: `continuity-kit/${p.deploymentId}/v1`,
    chainId: "10143",
    registryAddress: REGISTRY_ADDRESS,
    registryCodeHash: TESTNET_RUNTIME_CODE_HASH,
    trustMode: "trusted-rpc-quorum",
    finality: "finalized",
    maxResponseBytes: 65536,
    rpcUrls: [
      "https://testnet-rpc.monad.xyz",
      "https://rpc-testnet.monadinfra.com",
    ],
    mirrorUrls: [
      `${p.storeOrigin}/v1/mirrors/0`,
      `${p.storeOrigin}/v1/mirrors/1`,
    ],
  });
}
