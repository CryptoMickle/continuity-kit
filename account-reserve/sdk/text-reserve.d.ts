import type { PasskeyCredentialMetadata, WebAuthnClient } from '@category-labs/mera';

export declare const TEXT_PROTOCOL: 'account-continuity/text-reserve-v1';
export declare const MAX_TEXT_BYTES: 16384;
export declare class TextReserveError extends Error {
  readonly code: string;
  /** True after a write could have reached storage, even if the response was lost.
   * Recover/check the reserve; never automatically repeat enrollment. */
  recordMayExist?: boolean;
  constructor(code: string);
}
export interface TextReserveConfig {
  readonly appId: string;
  /** Exact canonical HTTPS origin. HTTP is allowed only for localhost,
   * subdomains of localhost, or 127.0.0.1 during local development. */
  readonly recoveryOrigin: string;
  /** Must equal the recovery origin's hostname exactly. */
  readonly recoveryRpId: string;
}
export interface TextReserveReader {
  get(locator: string): Promise<Uint8Array | undefined | null>;
}
export interface TextReserveStore extends TextReserveReader {
  /** Atomically insert only when absent. Never overwrite. True means inserted;
   * false means already present; rejection/other values have unknown outcome. */
  putIfAbsent(locator: string, record: Uint8Array): Promise<boolean>;
}
/** Returns the unchanged string, including CRLF, initial BOM and empty text.
 * Rejects malformed surrogates and text larger than 16384 raw UTF-8 bytes.
 * Does not open a credential prompt or access storage. */
export declare function validateText(value: unknown): string;
declare const createdTextCredential: unique symbol;
export interface CreatedTextReserveCredential extends PasskeyCredentialMetadata {
  readonly [createdTextCredential]: true;
  /** Idempotently cancel/release the one-use handle and any active preparation.
   * Does not delete a credential from the authenticator or a stored record. */
  close(): void;
}
/** A created or explicitly selected credential, bound to one config and one
 * preparation. Kept compatible with the original created-handle type. */
export type TextReserveCredential = CreatedTextReserveCredential;
export declare function createTextReserveCredential(options: {
  config: TextReserveConfig;
  user: { name: string; displayName: string };
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  /** Creation and handle deadline, 1–300000 ms; defaults to five minutes. */
  timeoutMs?: number;
}): Promise<Readonly<CreatedTextReserveCredential>>;
/** Call directly from a user action on B. Discover/authenticate an existing
 * credential; no creation fallback or storage access. Derives private state for
 * this config only. The returned handle cannot be copied or reused. */
export declare function selectTextReserveCredential(options: {
  config: TextReserveConfig;
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  /** Selection and handle deadline, 1–300000 ms; defaults to five minutes. */
  timeoutMs?: number;
}): Promise<Readonly<TextReserveCredential>>;
export interface RecoveredTextReserve {
  readonly protocol: typeof TEXT_PROTOCOL;
  readonly text: string;
  /** SHA-256 of raw UTF-8 text, 64 lowercase hex digits without a prefix. */
  readonly textDigest: string;
  readonly locator: string;
}
export interface TextReserveReady extends RecoveredTextReserve {
  readonly status: 'ready';
  readonly independentlyVerified: true;
}
export declare function prepareTextReserve(options: {
  config: TextReserveConfig;
  /** Exact, unexpired handle from createTextReserveCredential or
   * selectTextReserveCredential; consumed once.
   * Copied metadata and handles from another module instance are rejected. */
  recoveryCredential: TextReserveCredential;
  text: string;
  store: TextReserveStore;
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  /** Observational stage names only; exceptions do not change the operation. */
  onProgress?: (stage: 'protect-text' | 'verify-text') => void;
}): Promise<Readonly<TextReserveReady>>;
/** Discoverable read, authenticated decryption and no write. Returns data only:
 * no live cryptographic context or close method remains. JavaScript plaintext
 * strings already returned to the caller cannot be reliably erased. */
export declare function recoverTextReserve(options: {
  config: TextReserveConfig;
  store: TextReserveReader;
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  onProgress?: (stage: 'find-text' | 'open-text') => void;
}): Promise<Readonly<RecoveredTextReserve>>;
