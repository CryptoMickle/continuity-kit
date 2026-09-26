import { LOCAL_POLICY, freezePolicy, record } from "./sdk/policy.ts";
import { HttpMirrorStore, HttpRegistry } from "./sdk/stores.ts";
import {
  HttpTransactionTransport,
  MonadRegistryReader,
} from "./sdk/monad-registry.ts";
import { ContinuityError } from "./sdk/types.ts";
import type {
  MonadRecoveryPolicy,
  PrimaryAdapters,
  RecoveryPolicy,
  TransactionSessionLimits,
} from "./sdk/types.ts";

export const CONTROL_URL = "http://localhost:4175";
// Pinned compiled artifact, not evidence that a contract has been deployed.
export const TESTNET_RUNTIME_CODE_HASH =
  "0x0605a2eae3c27f4d12476d61af8b1eb53a8b7b64f145c9139b47c95f8aef9dd9";
export interface TestnetRuntimeConfig {
  kind: "monad-testnet";
  policy: MonadRecoveryPolicy;
  controlUrl: typeof CONTROL_URL;
  sessionLimits: {
    lifetimeMs: number;
    maxTransactions: number;
    maxGas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    maxTotalFeeWei: string;
  };
}
export interface Runtime {
  readonly kind: "local" | "monad-testnet";
  readonly policy: RecoveryPolicy;
  readonly adapters: PrimaryAdapters;
  readonly requirePhysicalPasskeys: boolean;
  readonly controlUrl: typeof CONTROL_URL;
}
function invalid(): never {
  throw new ContinuityError(
    "POLICY_INVALID",
    "Invalid explicit testnet runtime",
  );
}
/** Copy JSON data without invoking getters, toJSON or accepting hidden fields. */
function jsonCopy(value: unknown, depth = 0): unknown {
  if (depth > 5) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") invalid();
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (array) {
    if (
      value.length > 100 ||
      keys.length !== value.length + 1 ||
      !Array.from({ length: value.length }, (_, i) => String(i)).every((key) =>
        Object.hasOwn(descriptors, key),
      )
    )
      invalid();
  }
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") invalid();
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      invalid();
    copy[key] = jsonCopy(descriptor.value, depth + 1);
  }
  return array
    ? Array.from({ length: value.length }, (_, i) => copy[String(i)])
    : { ...copy };
}
const feeCaps = {
  maxGas: 300000n,
  maxFeePerGas: 200000000000n,
  maxPriorityFeePerGas: 2000000000n,
  maxTotalFeeWei: 180000000000000000n,
} as const;

/** Pure validation: only undefined selects local mode; malformed config fails closed. */
export function validateTestnetRuntimeConfig(
  input: unknown,
): Readonly<TestnetRuntimeConfig> {
  try {
    const copy = jsonCopy(input);
    const config = record(copy, [
      "kind",
      "policy",
      "controlUrl",
      "sessionLimits",
    ]);
    if (config.kind !== "monad-testnet" || config.controlUrl !== CONTROL_URL)
      invalid();
    const policy = freezePolicy(config.policy as MonadRecoveryPolicy);
    const fixed = {
      protocol: LOCAL_POLICY.protocol,
      applicationId: LOCAL_POLICY.applicationId,
      schemaId: LOCAL_POLICY.schemaId,
      aOrigin: LOCAL_POLICY.aOrigin,
      bOrigin: LOCAL_POLICY.bOrigin,
      aRpId: LOCAL_POLICY.aRpId,
      bRpId: LOCAL_POLICY.bRpId,
      chainId: "10143",
      registryCodeHash: TESTNET_RUNTIME_CODE_HASH,
      trustMode: "trusted-rpc-quorum",
      finality: "finalized",
    };
    if (
      Object.entries(fixed).some(
        ([key, value]) => policy[key as keyof MonadRecoveryPolicy] !== value,
      ) ||
      policy.deploymentId === LOCAL_POLICY.deploymentId ||
      policy.bootstrapNamespace === LOCAL_POLICY.bootstrapNamespace ||
      JSON.stringify(policy.mirrorUrls) !==
        JSON.stringify(LOCAL_POLICY.mirrorUrls) ||
      JSON.stringify(policy.rpcUrls) !==
        JSON.stringify([
          "https://testnet-rpc.monad.xyz",
          "https://monad-testnet.drpc.org",
        ])
    )
      invalid();
    const limits = record(config.sessionLimits, [
      "lifetimeMs",
      "maxTransactions",
      ...Object.keys(feeCaps),
    ]);
    for (const [key, max] of [
      ["lifetimeMs", 600000],
      ["maxTransactions", 3],
    ] as const)
      if (
        !Number.isSafeInteger(limits[key]) ||
        (limits[key] as number) < 1 ||
        (limits[key] as number) > max
      )
        invalid();
    for (const [key, cap] of Object.entries(feeCaps)) {
      const value = limits[key];
      if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(value))
        invalid();
      if (
        BigInt(value) > cap ||
        (key !== "maxPriorityFeePerGas" && BigInt(value) === 0n)
      )
        invalid();
    }
    if (
      BigInt(limits.maxPriorityFeePerGas as string) >
      BigInt(limits.maxFeePerGas as string)
    )
      invalid();
    return Object.freeze({
      kind: "monad-testnet",
      policy,
      controlUrl: CONTROL_URL,
      sessionLimits: Object.freeze(
        limits,
      ) as unknown as TestnetRuntimeConfig["sessionLimits"],
    });
  } catch {
    return invalid();
  }
}

/** Constructs adapters only: no fetch, signing, authentication or storage access. */
export function createRuntime(config?: unknown): Runtime {
  if (config === undefined) {
    const policy = LOCAL_POLICY;
    const registry = new HttpRegistry(policy);
    return Object.freeze({
      kind: "local",
      policy,
      adapters: Object.freeze({
        trustMode: "local-model",
        localWriter: registry,
        registry,
        mirrors: Object.freeze(
          policy.mirrorUrls.map((url) => new HttpMirrorStore(url)),
        ),
      }),
      requirePhysicalPasskeys: false,
      controlUrl: CONTROL_URL,
    });
  }
  const approved = validateTestnetRuntimeConfig(config);
  const policy = approved.policy;
  const sessionLimits: TransactionSessionLimits = {
    ...approved.sessionLimits,
    maxGas: BigInt(approved.sessionLimits.maxGas),
    maxFeePerGas: BigInt(approved.sessionLimits.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(approved.sessionLimits.maxPriorityFeePerGas),
    maxTotalFeeWei: BigInt(approved.sessionLimits.maxTotalFeeWei),
  };
  return Object.freeze({
    kind: "monad-testnet",
    policy,
    adapters: Object.freeze({
      trustMode: "trusted-rpc-quorum",
      registry: new MonadRegistryReader(policy),
      transactions: new HttpTransactionTransport(policy),
      sessionLimits: Object.freeze(sessionLimits),
      mirrors: Object.freeze(
        policy.mirrorUrls.map((url) => new HttpMirrorStore(url)),
      ),
    }),
    requirePhysicalPasskeys: true,
    controlUrl: CONTROL_URL,
  });
}
