import type { PasskeySecretVault } from "@category-labs/mera";
export type Hex = `0x${string}`;
export type ErrorCode =
  | "AUTH_CANCELLED"
  | "AUTH_FAILED"
  | "PRF_UNAVAILABLE"
  | "NO_RECOVERY_MATERIAL"
  | "MANIFEST_INVALID"
  | "ENROLLMENT_CONFLICT"
  | "CONTEXT_MISMATCH"
  | "CREDENTIAL_MISMATCH"
  | "UNREGISTERED_ENROLLMENT"
  | "MANIFEST_BINDING_MISMATCH"
  | "FRESHNESS_UNAVAILABLE"
  | "DIGEST_MISMATCH"
  | "CURRENT_DATA_UNAVAILABLE"
  | "DECRYPT_FAILED"
  | "SCHEMA_INVALID"
  | "WRITE_CONFLICT"
  | "HEAD_MOVED"
  | "SESSION_EXPIRED"
  | "STORAGE_FAILED"
  | "POLICY_INVALID";
export class ContinuityError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message = code as string, details?: unknown) {
    super(message);
    this.name = "ContinuityError";
    this.code = code;
    this.details = details;
  }
}
export interface FixedContext {
  protocol: "continuity-kit/v1";
  applicationId: string;
  schemaId: string;
  deploymentId: string;
  aOrigin: string;
  bOrigin: string;
  aRpId: string;
  bRpId: string;
  chainId: string;
  registryAddress: Hex;
  registryCodeHash: Hex;
}
export interface Context extends FixedContext {
  owner: Hex;
  streamId: Hex;
}
export interface RecoveryPolicy extends FixedContext {
  trustMode: "local-model";
  bootstrapNamespace: string;
  mirrorUrls: readonly string[];
  registryUrl: string;
  maxManifestBytes: number;
  maxCapsuleBytes: number;
  timeoutMs: number;
  maxHeadAgeMs: number;
}
export interface Workspace {
  title: string;
  plan: string;
  tasks: { id: string; text: string; done: boolean }[];
  draft: string;
}
export interface Evidence {
  trustMode: "local-model";
  blockNumber: string;
  blockHash: Hex;
  observedAt: string;
}
export interface Head {
  exists: boolean;
  manifestDigest: Hex;
  version: string;
  capsuleDigest: Hex;
  evidence: Evidence;
}
export interface MirrorStore {
  readonly id: string;
  putIndexIfAbsent(locator: string, bytes: Uint8Array): Promise<void>;
  getIndex(locator: string): Promise<Uint8Array | null>;
  putBlob(digest: Hex, bytes: Uint8Array): Promise<void>;
  getBlob(digest: Hex): Promise<Uint8Array | null>;
}
export interface RegistryReader {
  getHead(policy: RecoveryPolicy, owner: Hex, streamId: Hex): Promise<Head>;
}
export type RegistryCommand =
  | {
      operation: "create";
      owner: Hex;
      streamId: Hex;
      manifestDigest: Hex;
      initialCapsuleDigest: Hex;
    }
  | {
      operation: "commit";
      owner: Hex;
      streamId: Hex;
      expectedVersion: string;
      expectedDigest: Hex;
      nextDigest: Hex;
    };
export interface OwnerRegistryWriter {
  execute(
    policy: RecoveryPolicy,
    command: RegistryCommand,
    signature: Hex,
  ): Promise<Head>;
}
export interface Adapters {
  mirrors: MirrorStore[];
  registry: RegistryReader & OwnerRegistryWriter;
}
export interface PrfResult {
  credentialId: string;
  prfOutput: Uint8Array<ArrayBuffer>;
}
export interface PasskeyAdapter {
  createPrimary(policy: RecoveryPolicy): Promise<PrfResult>;
  openPrimary(policy: RecoveryPolicy): Promise<PrfResult>;
  createBackup(
    secret: Uint8Array,
    policy: RecoveryPolicy,
  ): Promise<PasskeySecretVault>;
  discover(policy: RecoveryPolicy, credentialId?: string): Promise<PrfResult>;
  unwrap(
    vault: PasskeySecretVault,
    policy: RecoveryPolicy,
  ): Promise<Uint8Array>;
}
export interface Manifest {
  format: "continuity-manifest/v1";
  context: Context;
  vault: PasskeySecretVault;
}
export interface PreparedBackup {
  manifest: Manifest;
  manifestDigest: Hex;
  locator: string;
  indexBytes: Uint8Array;
}
export interface Recovered {
  content: Workspace;
  context: Context;
  manifestDigest: Hex;
  version: string;
  capsuleDigest: Hex;
  evidence: Evidence;
  diagnostics: { source: string; code: string }[];
}
export interface DiscoveredRecovery {
  policy: RecoveryPolicy;
  manifest: Manifest;
  manifestDigest: Hex;
  credentialId: string;
  acceptedHead: Head;
  diagnostics: { source: string; code: string }[];
}
