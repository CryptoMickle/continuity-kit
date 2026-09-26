/** SYNTHETIC PUBLIC TEST CREDENTIALS. No hardware, authenticator, or PRF support evidence.
 * Never use this client for private content. All secrets are reproducible from the public seed. */
import type { WebAuthnClient } from "@category-labs/mera";
import { b64, equal, sha, utf8 } from "./crypto.ts";
export class SyntheticWebAuthnClient implements WebAuthnClient {
  readonly evidence = "synthetic-public-fixture";
  readonly seed: string;
  readonly credentialIndex: number;
  readonly fallbackOnCreate: boolean;
  readonly ceremonies: {
    operation: "create" | "get";
    rpId: string;
    pinned: boolean;
  }[] = [];
  cancelNext = false;
  prfUnavailable = false;
  private counters = new Map<string, number>();
  constructor(options: {
    seed: string;
    credentialIndex?: number;
    fallbackOnCreate?: boolean;
  }) {
    this.seed = options.seed;
    this.credentialIndex = options.credentialIndex ?? 0;
    this.fallbackOnCreate = options.fallbackOnCreate ?? false;
  }
  async credentialId(rpId: string, index = this.credentialIndex) {
    return sha(
      utf8(`SYNTHETIC PUBLIC CREDENTIAL\0${this.seed}\0${rpId}\0${index}`),
    );
  }
  private async output(rpId: string, id: Uint8Array, salt: Uint8Array) {
    const secret = await sha(
      utf8(`SYNTHETIC PUBLIC PRF\0${this.seed}\0${rpId}\0${b64(id)}`),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new Uint8Array(salt)),
    );
  }
  private cancel() {
    if (this.cancelNext) {
      this.cancelNext = false;
      throw new DOMException("Synthetic user cancellation", "NotAllowedError");
    }
  }
  async createCredential(
    req: WebAuthnClient.CreateCredentialRequest,
  ): Promise<WebAuthnClient.CreateCredentialResult> {
    this.cancel();
    this.ceremonies.push({
      operation: "create",
      rpId: req.rp.id,
      pinned: false,
    });
    const index = this.counters.get(req.rp.id) ?? this.credentialIndex;
    this.counters.set(req.rp.id, index + 1);
    const credentialId = await this.credentialId(req.rp.id, index);
    return {
      credentialId,
      transports: ["internal"],
      prfEnabled: !this.prfUnavailable,
      ...(!this.fallbackOnCreate && !this.prfUnavailable
        ? { prfOutput: await this.output(req.rp.id, credentialId, req.prfSalt) }
        : {}),
    };
  }
  async getCredential(
    req: WebAuthnClient.GetCredentialRequest,
  ): Promise<WebAuthnClient.GetCredentialResult> {
    this.cancel();
    this.ceremonies.push({
      operation: "get",
      rpId: req.rpId,
      pinned: !!req.allowCredential,
    });
    const credentialId =
      req.allowCredential?.credentialId ?? (await this.credentialId(req.rpId));
    if (req.allowCredential) {
      let valid = false;
      for (
        let i = 0;
        i <
        Math.max(this.counters.get(req.rpId) ?? 0, this.credentialIndex + 1);
        i++
      )
        if (equal(credentialId, await this.credentialId(req.rpId, i)))
          valid = true;
      if (!valid)
        throw new DOMException(
          "Synthetic credential RP mismatch",
          "NotAllowedError",
        );
    }
    return {
      credentialId,
      ...(!this.prfUnavailable
        ? { prfOutput: await this.output(req.rpId, credentialId, req.prfSalt) }
        : {}),
    };
  }
}
