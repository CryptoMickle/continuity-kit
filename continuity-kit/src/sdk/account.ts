import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import {
  createSecp256k1SigningSession,
  getEvmAddress,
} from "@category-labs/mera";
import { hashMessage } from "viem";
import { fromHex, hex, lookupKeys, random } from "./crypto.ts";
import { contextFor, validatePolicy } from "./policy.ts";
import { registryDomain, registrySigningMessage } from "./registry-signing.ts";
import { ContinuityError } from "./types.ts";
import type {
  Hex,
  Context,
  FixedContext,
  RecoveryPolicy,
  RegistryCommand,
  PasskeyAdapter,
  PreparedBackup,
} from "./types.ts";
export class ScopedOwnerSession {
  readonly owner: Hex;
  readonly expiresAt: number;
  readonly allowedOperations = ["create", "commit"] as const;
  readonly #session: ReturnType<typeof createSecp256k1SigningSession>;
  #ended = false;
  #scope?: { owner: Hex; streamId: Hex; domain: FixedContext };
  constructor(privateKey: Uint8Array, lifetimeMs = 600000) {
    if (lifetimeMs < 1 || lifetimeMs > 600000)
      throw new ContinuityError("SESSION_EXPIRED");
    this.#session = createSecp256k1SigningSession({ privateKey });
    this.owner = getEvmAddress(this.#session.publicKey).toLowerCase() as Hex;
    this.expiresAt = Date.now() + lifetimeMs;
  }
  bindContext(context: Context) {
    if (this.#scope)
      throw new ContinuityError(
        "ENROLLMENT_CONFLICT",
        "Session already scoped",
      );
    if (context.owner !== this.owner)
      throw new ContinuityError("CONTEXT_MISMATCH");
    this.#scope = Object.freeze({
      owner: context.owner,
      streamId: context.streamId,
      domain: registryDomain(context),
    });
  }
  assertActive() {
    if (this.#ended || Date.now() >= this.expiresAt) {
      this.close();
      throw new ContinuityError("SESSION_EXPIRED");
    }
  }
  async sign(command: RegistryCommand): Promise<Hex> {
    if (this.#ended || Date.now() >= this.expiresAt) {
      this.close();
      throw new ContinuityError("SESSION_EXPIRED");
    }
    if (
      !this.#scope ||
      command.owner !== this.#scope.owner ||
      command.streamId !== this.#scope.streamId ||
      !this.allowedOperations.includes(command.operation)
    )
      throw new ContinuityError("CONTEXT_MISMATCH", "Session scope violated");
    this.assertActive();
    const result = await this.#session.signDigest(
      fromHex(hashMessage(registrySigningMessage(this.#scope.domain, command))),
    );
    this.assertActive();
    return hex(new Uint8Array([...result.compact, 27 + result.recovery]));
  }
  close() {
    this.#ended = true;
    this.#session.end();
  }
}
export interface PrimaryAccount {
  policy: RecoveryPolicy;
  context: Context;
  dataKey: Uint8Array;
  locator: string;
  recordKey: Uint8Array;
  credentialId: string;
  session: ScopedOwnerSession;
  close(): void;
  enrollment?: {
    backup: PreparedBackup;
    primaryBytes: Uint8Array;
    capsuleBytes: Uint8Array;
    capsuleDigest: Hex;
  };
}
export interface PrimaryState extends PrimaryAccount {
  manifestDigest: Hex;
  writes: number;
}
export function deriveOwnerSession(prf: Uint8Array): ScopedOwnerSession {
  if (prf.length !== 32) throw new ContinuityError("PRF_UNAVAILABLE");
  const mnemonic = entropyToMnemonic(prf, wordlist);
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive("m/44'/60'/0'/0/0");
  try {
    if (!child.privateKey) throw new ContinuityError("AUTH_FAILED");
    return new ScopedOwnerSession(child.privateKey);
  } finally {
    seed.fill(0);
    root.wipePrivateData();
    child.wipePrivateData();
  }
}
export async function accountFromPrf(
  policy: RecoveryPolicy,
  credentialId: string,
  prf: Uint8Array,
): Promise<PrimaryAccount> {
  validatePolicy(policy);
  const session = deriveOwnerSession(prf);
  const keys = await lookupKeys(prf, true);
  prf.fill(0);
  const account: PrimaryAccount = {
    policy,
    context: contextFor(policy, session.owner, hex(random(32))),
    dataKey: random(32),
    locator: keys.locator,
    recordKey: keys.key,
    credentialId,
    session,
    close() {
      this.session.close();
      this.dataKey.fill(0);
      this.recordKey.fill(0);
    },
  };
  return account;
}
export async function createPrimary(
  policy: RecoveryPolicy,
  passkeys: PasskeyAdapter,
): Promise<PrimaryAccount> {
  validatePolicy(policy);
  const result = await passkeys.createPrimary(policy);
  const account = await accountFromPrf(
    policy,
    result.credentialId,
    result.prfOutput,
  );
  account.session.bindContext(account.context);
  return account;
}
