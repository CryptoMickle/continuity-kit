import type { PasskeyCredentialMetadata, Secp256k1SigningSession, WebAuthnClient } from '@category-labs/mera';
import type { LocalAccount } from 'viem';
import type { ReserveConfig, ReservePolicy, ReserveReader, ReserveStore } from './index.js';

export declare const WORK_PROTOCOL: 'account-continuity/work-reserve-v1';
export declare const WORK_SCHEMA: 'continuity-work/brief-v1';
export declare const MAX_WORK_BYTES: 16384;
export declare class WorkReserveError extends Error {
  readonly code: string;
  recordMayExist?: boolean;
  constructor(code: string);
}
/** One immutable snapshot, at most 16384 UTF-8 bytes in canonical JSON. */
export interface ContinuityWork {
  readonly schema: typeof WORK_SCHEMA;
  /** At most 256 JavaScript string code units. */
  readonly title: string;
  /** At most 256 JavaScript string code units. */
  readonly client: string;
  readonly brief: string;
  readonly deliverable: string;
  readonly nextStep: string;
}
/** Validates exact fields and returns a frozen copy, before native creation. */
export declare function validateWork(value: unknown): Readonly<ContinuityWork>;
export interface CreatedWorkReserveCredential extends PasskeyCredentialMetadata {
  /** Invalidate the one-use discovery handle; idempotent. */
  close(): void;
}
export declare function createWorkReserveCredential(options: {
  config: ReserveConfig;
  user: { name: string; displayName: string };
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  /** Overall creation/handle lifetime, 1–300000 ms; defaults to five minutes. */
  timeoutMs?: number;
}): Promise<Readonly<CreatedWorkReserveCredential>>;
export interface WorkReserveReady {
  readonly status: 'ready';
  readonly owner: `0x${string}`;
  readonly locator: string;
  /** SHA-256 of canonical work JSON, 64 lowercase hex digits, without 0x. */
  readonly workDigest: string;
  readonly independentlyVerified: true;
  readonly protocol: typeof WORK_PROTOCOL;
}
export interface OpenedWorkAccount {
  readonly session: Secp256k1SigningSession;
  /** Unrestricted EOA signer: expose deliberate actions only. */
  readonly account: LocalAccount<'mera'>;
  readonly owner: `0x${string}`;
  readonly policy: Readonly<ReservePolicy>;
  close(): void;
}
export interface RecoveredWorkReserve {
  readonly owner: `0x${string}`;
  /** Plaintext is exposed to the caller only after authenticated decryption. */
  readonly work: Readonly<ContinuityWork>;
  readonly workDigest: string;
  readonly locator: string;
  /** Separate deliberate action: asks for account-vault PRF and creates a signer.
   * Rejects if closed, expired, cancelled or another account opening is active. */
  openAccount(options?: { signal?: AbortSignal }): Promise<Readonly<OpenedWorkAccount>>;
  /** Idempotent. Cancels pending work and closes any active signer. Does not
   * promise to erase plaintext JS strings already returned to the caller. */
  close(): void;
}
export declare function prepareWorkReserve(options: {
  /** Caller remains responsible for wiping its original derived leaf key. */
  privateKey: Uint8Array;
  policy: ReservePolicy;
  recoveryCredential: PasskeyCredentialMetadata | CreatedWorkReserveCredential;
  work: ContinuityWork;
  store: ReserveStore;
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  onProgress?: (stage: 'protect-work' | 'verify-work') => void;
}): Promise<Readonly<WorkReserveReady>>;
export declare function recoverWorkReserve(options: {
  config: ReserveConfig;
  store: ReserveReader;
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  onProgress?: (stage: 'find-work' | 'open-work') => void;
}): Promise<Readonly<RecoveredWorkReserve>>;
