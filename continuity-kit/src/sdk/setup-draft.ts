import { deriveOwnerWriter, type PrimaryAccount } from "./account.ts";
import {
  b64,
  bytesOf,
  hkdf,
  lookupKeys,
  open,
  parseCanonical,
  seal,
  unb64,
} from "./crypto.ts";
import {
  freezePolicy,
  metadataFingerprint,
  record,
  validateContext,
} from "./policy.ts";
import { assertPrimaryAdapters } from "./owner-writer.ts";
import {
  ContinuityError,
  type PasskeyAdapter,
  type PrimaryAdapters,
  type RecoveryPolicy,
} from "./types.ts";

// Reservations outlive close/failure. An alias of an account may not fork its fence.
const ownedAccounts = new WeakSet<PrimaryAccount>();
const ownedWriters = new WeakSet<PrimaryAccount["writer"]>();
function reserve(account: PrimaryAccount) {
  if (ownedAccounts.has(account) || ownedWriters.has(account.writer))
    throw new ContinuityError("ENROLLMENT_CONFLICT");
  ownedAccounts.add(account);
  ownedWriters.add(account.writer);
}

/** Same-tab, pre-B pause only. No serialization API, durable journal, or recovery authority. */
export class SetupDraft {
  readonly #policy: RecoveryPolicy;
  readonly #credentialId: string;
  readonly #context: PrimaryAccount["context"];
  readonly #limits: string;
  #box: Awaited<ReturnType<typeof seal>> | undefined;
  #phase: "ready" | "paused" | "opening" | "spent" = "ready";
  #account: PrimaryAccount | undefined;

  private constructor(account: PrimaryAccount, adapters: PrimaryAdapters) {
    this.#policy = freezePolicy(account.policy);
    this.#credentialId = account.credentialId;
    this.#context = structuredClone(account.context);
    this.#limits = limitsFingerprint(adapters);
    this.#account = account;
  }
  static async create(account: PrimaryAccount, adapters: PrimaryAdapters) {
    reserve(account);
    assertPrimaryAdapters(account.policy, adapters);
    unused(account);
    validateContext(account.context, account.policy);
    if (account.context.owner !== account.writer.owner)
      throw new ContinuityError("CONTEXT_MISMATCH");
    const draft = new SetupDraft(account, adapters);
    const parentKey = account.recordKey.slice();
    let key: Uint8Array | undefined;
    let plain: Uint8Array | undefined;
    try {
      plain = bytesOf({
        format: "continuity-setup-pause/v1",
        context: draft.#context,
        dataKey: b64(account.dataKey),
      });
      key = await hkdf(parentKey, "pre-backup-pause-aes-gcm");
      draft.#box = await seal(key, plain, draft.#aad());
      account.writer.assertActive();
      unused(account);
      return draft;
    } catch (e) {
      draft.close();
      throw e;
    } finally {
      parentKey.fill(0);
      key?.fill(0);
      plain?.fill(0);
    }
  }
  #aad() {
    return {
      format: "continuity-setup-pause/v1",
      policy: metadataFingerprint(this.#policy),
      credentialId: this.#credentialId,
      limits: this.#limits,
    };
  }
  get paused() {
    return this.#phase === "paused";
  }
  get resumable() {
    return this.#phase === "ready" || this.#phase === "paused";
  }
  pause(): boolean {
    if (this.#phase !== "ready" || !this.#account) return false;
    try {
      unused(this.#account);
    } catch {
      this.close();
      return false;
    }
    this.#account.close();
    this.#account = undefined;
    this.#phase = "paused";
    return true;
  }
  async resume(
    policy: RecoveryPolicy,
    passkeys: PasskeyAdapter,
    adapters: PrimaryAdapters,
  ): Promise<PrimaryAccount> {
    if (this.#phase !== "paused" || !this.#box)
      throw new ContinuityError("ENROLLMENT_CONFLICT");
    if (
      metadataFingerprint(policy) !== metadataFingerprint(this.#policy) ||
      limitsFingerprint(adapters) !== this.#limits
    )
      throw new ContinuityError("POLICY_INVALID");
    assertPrimaryAdapters(policy, adapters);
    this.#phase = "opening";
    let account: PrimaryAccount | undefined;
    let keys: Awaited<ReturnType<typeof lookupKeys>> | undefined;
    let key: Uint8Array | undefined;
    let plain: Uint8Array | undefined;
    let prf: Uint8Array | undefined;
    let writer: PrimaryAccount["writer"] | undefined;
    let dataKey: Uint8Array | undefined;
    try {
      const result = await passkeys.openPrimary(
        this.#policy,
        this.#credentialId,
      );
      prf = result.prfOutput;
      if (result.credentialId !== this.#credentialId)
        throw new ContinuityError("CREDENTIAL_MISMATCH");
      if (!this.#opening()) throw new ContinuityError("SESSION_EXPIRED");
      keys = await lookupKeys(prf, true);
      key = await hkdf(keys.key, "pre-backup-pause-aes-gcm");
      plain = await open(key, this.#box!, this.#aad());
      const body = record(parseCanonical(plain, 8192), [
        "format",
        "context",
        "dataKey",
      ]);
      if (
        body.format !== "continuity-setup-pause/v1" ||
        metadataFingerprint(body.context) !== metadataFingerprint(this.#context)
      )
        throw new ContinuityError("CONTEXT_MISMATCH");
      validateContext(body.context, this.#policy);
      dataKey = unb64(body.dataKey, 32);
      if (!this.#opening()) throw new ContinuityError("SESSION_EXPIRED");
      if (
        metadataFingerprint(policy) !== metadataFingerprint(this.#policy) ||
        limitsFingerprint(adapters) !== this.#limits
      )
        throw new ContinuityError("POLICY_INVALID");
      assertPrimaryAdapters(this.#policy, adapters);
      writer = deriveOwnerWriter(prf, this.#policy, adapters);
      if (writer.owner !== this.#context.owner)
        throw new ContinuityError("CONTEXT_MISMATCH");
      writer.bindContext(this.#context);
      account = {
        policy: this.#policy,
        context: structuredClone(this.#context),
        dataKey,
        locator: keys.locator,
        recordKey: keys.key,
        credentialId: this.#credentialId,
        writer,
        close() {
          this.writer.close();
          this.dataKey.fill(0);
          this.recordKey.fill(0);
        },
      };
      reserve(account);
      this.#account = account;
      this.#phase = "ready";
      return account;
    } catch (e) {
      account?.close();
      writer?.close();
      keys?.key.fill(0);
      dataKey?.fill(0);
      if (this.#opening()) this.#phase = "paused";
      throw e;
    } finally {
      prf?.fill(0);
      key?.fill(0);
      plain?.fill(0);
    }
  }
  #opening() {
    return this.#phase === "opening";
  }
  /** Irreversible before the grant is sent, including a lost grant or native cancellation. */
  beginBackup(account: PrimaryAccount) {
    if (this.#phase !== "ready" || account !== this.#account)
      throw new ContinuityError("ENROLLMENT_CONFLICT");
    unused(account);
    account.writer.assertActive();
    if (
      metadataFingerprint(account.context) !==
      metadataFingerprint(this.#context)
    )
      throw new ContinuityError("CONTEXT_MISMATCH");
    this.#phase = "spent";
    this.#box = undefined;
    this.#account = undefined;
  }
  close() {
    this.#phase = "spent";
    this.#box = undefined;
    this.#account?.close();
    this.#account = undefined;
  }
}
function unused(account: PrimaryAccount) {
  if (
    account.enrollment ||
    account.writer.pendingTicket ||
    account.writer.budget.signingAttempts !== 0 ||
    account.writer.budget.reservedFeeWei !== "0"
  )
    throw new ContinuityError(
      "ENROLLMENT_CONFLICT",
      "Only an untouched pre-backup setup may pause",
    );
}
function limitsFingerprint(adapters: PrimaryAdapters) {
  return metadataFingerprint(
    adapters.trustMode === "trusted-rpc-quorum"
      ? Object.fromEntries(
          Object.entries(adapters.sessionLimits).map(([k, v]) => [
            k,
            typeof v === "bigint" ? { $bigint: String(v) } : v,
          ]),
        )
      : { trustMode: "local-model" },
  );
}
