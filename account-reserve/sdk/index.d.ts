import type { PasskeyCredentialMetadata, Secp256k1SigningSession, WebAuthnClient } from '@category-labs/mera';
import type { LocalAccount } from 'viem';

export declare const PROTOCOL: 'account-continuity/reserve-v1';
export declare class ReserveError extends Error {
  readonly code: string;
  /** An interrupted preparation may already have stored its immutable record. */
  recordMayExist?: boolean;
  constructor(code: string);
}
export interface ReserveConfig {
  readonly appId: string;
  readonly originalRpId: string;
  readonly recoveryRpId: string;
  readonly derivation: string;
}
/** Short-lived, one-use creation handle. Contains no PRF output or exported key.
 * Pass this exact object to prepareReserve to reuse creation-time discovery.
 * Copying metadata deliberately uses ordinary discovery instead. */
export interface CreatedReserveCredential extends PasskeyCredentialMetadata {
  /** Invalidate retained discovery material; safe to call repeatedly in finally. */
  close(): void;
}
export declare function createReserveCredential(options: {
  config: ReserveConfig;
  user: { name: string; displayName: string };
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  /** Overall creation/handle lifetime, 1–300000 ms; defaults to five minutes. */
  timeoutMs?: number;
}): Promise<Readonly<CreatedReserveCredential>>;
export interface ReservePolicy extends ReserveConfig {
  /** Lowercase existing EVM owner, checked against the supplied leaf key. */
  readonly expectedOwner: `0x${string}`;
}
export interface ReserveReader {
  get(locator: string): Promise<Uint8Array | undefined | null>;
}
export interface ReserveStore extends ReserveReader {
  /** Must atomically create; true means created, false means it already existed. */
  putIfAbsent(locator: string, bytes: Uint8Array): Promise<boolean>;
}
export interface ReserveReady {
  readonly status: 'ready';
  readonly owner: `0x${string}`;
  readonly locator: string;
  readonly independentlyVerified: true;
  readonly protocol: typeof PROTOCOL;
}
export interface RecoveredReserve {
  readonly session: Secp256k1SigningSession;
  /** Unrestricted EOA signer. An integration must expose only deliberate actions. */
  readonly account: LocalAccount<'mera'>;
  readonly owner: `0x${string}`;
  readonly policy: Readonly<ReservePolicy>;
  readonly locator: string;
  close(): void;
}
export declare function prepareReserve(options: {
  /** Already-derived leaf; the caller retains responsibility for wiping its copy. */
  privateKey: Uint8Array;
  policy: ReservePolicy;
  /** The exact creation handle saves one initial assertion. Existing metadata
   * retains the normal discovery path. Closed/expired/consumed handles reject. */
  recoveryCredential: PasskeyCredentialMetadata | CreatedReserveCredential;
  store: ReserveStore;
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  /** Stage names only, never prompt counts or secret material. Observer errors are ignored. */
  onProgress?: (stage: 'protect-reserve' | 'verify-reserve') => void;
}): Promise<Readonly<ReserveReady>>;
export declare function recoverReserve(options: {
  config: ReserveConfig;
  store: ReserveReader;
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  /** Called before discovery and before vault unlock; completion is the returned result. */
  onProgress?: (stage: 'find-reserve' | 'unlock-reserve') => void;
}): Promise<RecoveredReserve>;
