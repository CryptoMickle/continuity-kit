export interface ReserveConfiguration {
  appId: string;
  originalRpId: string;
  recoveryRpId: string;
  derivation: string;
}
/** For synthetic tests only. Real browser clients should omit the environment override. */
export interface ReserveEnvironmentSnapshot {
  origin?: string;
  isSecureContext?: boolean;
  crypto?: Pick<Crypto, 'getRandomValues' | 'subtle'>;
  navigator?: { credentials?: Pick<CredentialsContainer, 'get' | 'create'> };
  PublicKeyCredential?: typeof PublicKeyCredential;
  fetch?: typeof fetch;
  AbortController?: typeof AbortController;
  TextEncoder?: typeof TextEncoder;
  TextDecoder?: typeof TextDecoder;
}
export interface ReserveEnvironmentOptions {
  config: ReserveConfiguration;
  role: 'primary' | 'recovery';
  originalOrigin: string;
  recoveryOrigin: string;
  /** Explicit synthetic/test injection. Its claims are not browser or physical-device evidence. */
  environment?: ReserveEnvironmentSnapshot;
}
export interface ReserveEnvironmentCheck {
  readonly id: string;
  readonly status: 'pass' | 'fail' | 'unverified';
  readonly message: string;
}
export interface ReserveEnvironmentReport {
  /** Only means no static check failed. Never means the reserve is prepared or PRF works. */
  readonly ok: boolean;
  readonly checks: readonly ReserveEnvironmentCheck[];
  readonly physicalPasskey: 'unverified';
}
/** Synchronous; no credential creation, storage, fetch, signature or chain operation. */
export function checkReserveEnvironment(options: ReserveEnvironmentOptions): ReserveEnvironmentReport;
