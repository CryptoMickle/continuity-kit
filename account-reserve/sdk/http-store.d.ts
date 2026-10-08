/** Read-only ciphertext access; no account keys, credential identifiers or owner hints. */
export interface ReserveReadStore {
  get(locator: string): Promise<Uint8Array | undefined>;
}
export interface ReserveEnrollmentStore extends ReserveReadStore {
  /** Exactly one attempt per adapter. Unknown result must not be automatically retried. */
  putIfAbsent(locator: string, bytes: Uint8Array): Promise<boolean>;
  clearEnrollmentCapability(): void;
}
export interface ReserveHttpStoreOptions {
  /** Explicit single-use enrollment capability. Omit for recovery. Never persisted by this adapter. */
  enrollmentToken?: string;
  /** Root-relative same-origin endpoint without trailing slash. Default: /api/reserve. */
  basePath?: string;
  /** Trusted fetch implementation. Injection cannot enforce the native fetch security boundary. */
  fetcher?: typeof fetch;
  /** Total request and response-body timeout, from 1 to 10000 ms. Default 10000. */
  timeoutMs?: number;
}
/**
 * Throws code-bearing errors: STORE_CONFIG_INVALID, ENROLLMENT_DENIED,
 * LOCATOR_INVALID, RECORD_INVALID, STORE_UNAVAILABLE, STORE_EXPIRED or
 * STORE_WRITE_UNKNOWN. STORE_WRITE_UNKNOWN never implies failure to persist.
 * The adapter has no retry, local storage or credential side effects.
 */
export function createReserveHttpStore(options?: ReserveHttpStoreOptions): Readonly<ReserveEnrollmentStore>;
