import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  createSecretVaultWithNewPasskey,
  decryptSecretVaultWithPasskey,
} from "@category-labs/mera";
import type { WebAuthnClient, PasskeySecretVault } from "@category-labs/mera";
import type { PasskeyAdapter, RecoveryPolicy, PrfResult } from "./types.ts";
import { ContinuityError } from "./types.ts";
import { sha, utf8 } from "./crypto.ts";
import { validatePolicy, validateVault } from "./policy.ts";
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ContinuityError) throw error;
    const e = error as {
      code?: string;
      cause?: { name?: string };
      name?: string;
    };
    if (e.code === "PRF_UNAVAILABLE")
      throw new ContinuityError("PRF_UNAVAILABLE");
    if (
      e.name === "NotAllowedError" ||
      e.cause?.name === "NotAllowedError" ||
      e.name === "AbortError" ||
      e.cause?.name === "AbortError"
    )
      throw new ContinuityError("AUTH_CANCELLED");
    if (e.code === "DECRYPT_FAILED")
      throw new ContinuityError("DECRYPT_FAILED");
    throw new ContinuityError("AUTH_FAILED", "Passkey operation failed");
  }
}
export class MeraPasskeyAdapter implements PasskeyAdapter {
  readonly webAuthnClient?: WebAuthnClient;
  constructor(webAuthnClient?: WebAuthnClient) {
    this.webAuthnClient = webAuthnClient;
  }
  async createPrimary(p: RecoveryPolicy): Promise<PrfResult> {
    validatePolicy(p);
    return mapped(() =>
      createPasskeyWithPrfOutput({
        rp: { id: p.aRpId, name: "Continuity primary" },
        user: {
          name: `Continuity A ${new Date().toISOString().slice(0, 16)}`,
          displayName: `Continuity A ${new Date().toISOString().slice(0, 16)}`,
        },
        webAuthnClient: this.webAuthnClient,
        timeout: 120000,
      }),
    );
  }
  async openPrimary(
    p: RecoveryPolicy,
    credentialId?: string,
  ): Promise<PrfResult> {
    validatePolicy(p);
    return mapped(() =>
      getPasskeyPrfOutput({
        rpId: p.aRpId,
        ...(credentialId ? { credential: { credentialId } } : {}),
        webAuthnClient: this.webAuthnClient,
        timeout: 120000,
      }),
    );
  }
  async createBackup(
    secret: Uint8Array,
    p: RecoveryPolicy,
  ): Promise<PasskeySecretVault> {
    validatePolicy(p);
    if (secret.length > 8192) throw new ContinuityError("SCHEMA_INVALID");
    return mapped(() =>
      createSecretVaultWithNewPasskey({
        rp: { id: p.bRpId, name: "Continuity recovery" },
        user: {
          name: `Continuity B ${new Date().toISOString().slice(0, 16)}`,
          displayName: `Continuity B ${new Date().toISOString().slice(0, 16)}`,
        },
        secret,
        webAuthnClient: this.webAuthnClient,
        timeout: 120000,
      }),
    );
  }
  async discover(p: RecoveryPolicy, credentialId?: string): Promise<PrfResult> {
    validatePolicy(p);
    const prfSalt = await sha(
      utf8("continuity-kit/v1/bootstrap\0" + p.bootstrapNamespace),
    );
    return mapped(() =>
      getPasskeyPrfOutput({
        rpId: p.bRpId,
        prfSalt,
        ...(credentialId ? { credential: { credentialId } } : {}),
        webAuthnClient: this.webAuthnClient,
        timeout: 120000,
      }),
    );
  }
  async unwrap(
    vault: PasskeySecretVault,
    p: RecoveryPolicy,
  ): Promise<Uint8Array> {
    validatePolicy(p);
    const validated = validateVault(vault);
    return mapped(() =>
      decryptSecretVaultWithPasskey({
        rpId: p.bRpId,
        vault: validated,
        webAuthnClient: this.webAuthnClient,
        timeout: 120000,
      }),
    );
  }
}
