import type { WebAuthnClient } from '@category-labs/mera';

/** Constructing a scope does not create or request any credential. */
export declare function createWebAuthnScope(options?: {
  webAuthnClient?: WebAuthnClient;
  signal?: AbortSignal;
  /** Whole-operation deadline, not a new timeout per prompt; 1–300000 ms. */
  timeoutMs?: number;
}): Readonly<{
  client: WebAuthnClient;
  signal: AbortSignal;
  assertActive(): void;
  /** Cancel pending ceremonies and wipe adapter-owned PRF outputs. */
  close(): void;
}>;
