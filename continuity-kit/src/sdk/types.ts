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
  | "POLICY_INVALID"
  | "SESSION_LIMIT_EXCEEDED"
  | "TRANSACTION_REVERTED"
  | "TRANSACTION_EVIDENCE_INVALID"
  | "WRITE_PENDING";
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
export interface CommonRecoveryPolicy extends FixedContext {
  bootstrapNamespace: string;
  mirrorUrls: readonly string[];
  maxManifestBytes: number;
  maxCapsuleBytes: number;
  timeoutMs: number;
  maxHeadAgeMs: number;
}
export interface LocalRecoveryPolicy extends CommonRecoveryPolicy {
  trustMode: "local-model";
  registryUrl: string;
}
export interface MonadRecoveryPolicy extends CommonRecoveryPolicy {
  trustMode: "trusted-rpc-quorum";
  chainId: "10143";
  rpcUrls: readonly [string, string];
  finality: "finalized";
  maxResponseBytes: number;
}
export type RecoveryPolicy = LocalRecoveryPolicy | MonadRecoveryPolicy;
export interface Workspace {
  title: string;
  plan: string;
  tasks: { id: string; text: string; done: boolean }[];
  draft: string;
}
export interface LocalEvidence {
  trustMode: "local-model";
  blockNumber: string;
  blockHash: Hex;
  observedAt: string;
}
export interface MonadEvidence {
  trustMode: "trusted-rpc-quorum";
  chainId: "10143";
  registryAddress: Hex;
  registryCodeHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  blockTimestamp: string;
  observedAt: string;
  finality: "finalized";
  maxHeadAgeMs: number;
}
export type Evidence = LocalEvidence | MonadEvidence;
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
  readonly policy: RecoveryPolicy;
  getHead(owner: Hex, streamId: Hex): Promise<Head>;
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
export interface LocalRegistryWriteTransport {
  executeLocal(command: RegistryCommand, signature: Hex): Promise<Head>;
}
export interface RecoveryAdapters {
  mirrors: readonly MirrorStore[];
  registry: RegistryReader;
}
export type Adapters = RecoveryAdapters;
export type PrimaryAdapters = RecoveryAdapters &
  (
    | { trustMode: "local-model"; localWriter: LocalRegistryWriteTransport }
    | {
        trustMode: "trusted-rpc-quorum";
        transactions: TransactionTransport;
        sessionLimits: TransactionSessionLimits;
      }
  );
export interface TransactionSessionLimits {
  lifetimeMs: number;
  maxTransactions: number;
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxTotalFeeWei: bigint;
}
export interface TransactionEnvelope {
  type: "eip1559";
  chainId: 10143;
  nonce: number;
  to: Hex;
  value: bigint;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
/** All results are untrusted RPC data. No signer is ever passed to transport. */
export interface TransactionTransport {
  readonly policy: MonadRecoveryPolicy;
  pendingNonce(
    provider: 0 | 1,
    owner: Hex,
    signal: AbortSignal,
  ): Promise<unknown>;
  estimateGas(
    provider: 0 | 1,
    call: { from: Hex; to: Hex; data: Hex; value: "0x0"; gas: Hex },
    signal: AbortSignal,
  ): Promise<unknown>;
  fees(
    provider: 0 | 1,
    signal: AbortSignal,
  ): Promise<{ maxFeePerGas: unknown; maxPriorityFeePerGas: unknown }>;
  broadcast(raw: Hex, signal: AbortSignal): Promise<unknown>;
  transaction(
    provider: 0 | 1,
    hash: Hex,
    signal: AbortSignal,
  ): Promise<unknown>;
  receipt(provider: 0 | 1, hash: Hex, signal: AbortSignal): Promise<unknown>;
  block(provider: 0 | 1, number: string, signal: AbortSignal): Promise<unknown>;
  code(provider: 0 | 1, number: string, signal: AbortSignal): Promise<unknown>;
}
export interface CheckpointIdentity {
  owner: Hex;
  streamId: Hex;
  manifestDigest: Hex;
  version: string;
  capsuleDigest: Hex;
}
/** Decimal envelope values make tickets JSON-exportable; no signed bytes. */
export interface WriteTicket {
  format: "continuity-write-ticket/v1";
  policyFingerprint: string;
  command: RegistryCommand;
  checkpoint: CheckpointIdentity;
  transactionHash: Hex;
  envelope: {
    type: "eip1559";
    chainId: 10143;
    nonce: number;
    to: Hex;
    value: string;
    data: Hex;
    gas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  };
}
export interface VerifiedReceipt {
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  transactionIndex: string;
  status: "success";
  event: CheckpointIdentity;
  gasLimit: string;
  maxFeePerGas: string;
  maximumFeeWei: string;
  fullGasFeeWei: string;
  gasUsed: string;
  effectiveGasPrice: string;
  finalized: MonadEvidence;
}
export type WriteProof =
  | { kind: "local-model" }
  | { kind: "finalized-receipt"; receipt: VerifiedReceipt }
  | { kind: "finalized-state" };
export type WriteOutcome =
  | {
      status: "confirmed";
      checkpoint: CheckpointIdentity;
      proof: WriteProof;
      currentHead: Head;
      current: boolean;
      unresolvedTicket?: WriteTicket;
    }
  | { status: "unresolved"; ticket: WriteTicket };
export interface ScopedOwnerWriter {
  readonly owner: Hex;
  readonly expiresAt: number;
  readonly trustMode: RecoveryPolicy["trustMode"];
  readonly pendingTicket: WriteTicket | undefined;
  readonly budget: Readonly<{
    signingAttempts: number;
    reservedFeeWei: string;
    maxTransactions?: number;
    maxTotalFeeWei?: string;
  }>;
  bindContext(context: Context, commitOnly?: boolean): void;
  bindManifest(digest: Hex): void;
  assertActive(): void;
  execute(command: RegistryCommand): Promise<WriteOutcome>;
  reconcile(ticket: WriteTicket): Promise<WriteOutcome>;
  close(): void;
}
export type SaveResult =
  | {
      status: "saved";
      recovered: Recovered;
      proof: WriteProof;
      unresolvedTicket?: WriteTicket;
    }
  | {
      status: "superseded";
      checkpoint: CheckpointIdentity;
      proof: WriteProof;
      currentHead: Head;
      draft: Workspace;
    }
  | { status: "pending"; ticket: WriteTicket; draft: Workspace };
export interface PrfResult {
  credentialId: string;
  prfOutput: Uint8Array<ArrayBuffer>;
}
export interface PasskeyAdapter {
  createPrimary(policy: RecoveryPolicy): Promise<PrfResult>;
  openPrimary(
    policy: RecoveryPolicy,
    credentialId?: string,
  ): Promise<PrfResult>;
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
