import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { hex, lookupKeys, random } from "./crypto.ts";
import { contextFor, freezePolicy } from "./policy.ts";
import { OwnerWriter, assertPrimaryAdapters } from "./owner-writer.ts";
import { ContinuityError } from "./types.ts";
import type {
  Hex,
  Context,
  RecoveryPolicy,
  PrimaryAdapters,
  ScopedOwnerWriter,
  PasskeyAdapter,
  PreparedBackup,
} from "./types.ts";
export interface PrimaryAccount {
  policy: RecoveryPolicy;
  context: Context;
  dataKey: Uint8Array;
  locator: string;
  recordKey: Uint8Array;
  credentialId: string;
  writer: ScopedOwnerWriter;
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
export function deriveOwnerWriter(
  prf: Uint8Array,
  policy: RecoveryPolicy,
  adapters: PrimaryAdapters,
): ScopedOwnerWriter {
  if (prf.length !== 32) throw new ContinuityError("PRF_UNAVAILABLE");
  const mnemonic = entropyToMnemonic(prf, wordlist);
  const seed = mnemonicToSeedSync(mnemonic);
  let root: HDKey | undefined;
  let child: HDKey | undefined;
  try {
    root = HDKey.fromMasterSeed(seed);
    child = root.derive("m/44'/60'/0'/0/0");
    if (!child.privateKey) throw new ContinuityError("AUTH_FAILED");
    return new OwnerWriter(child.privateKey, policy, adapters);
  } finally {
    seed.fill(0);
    root?.wipePrivateData();
    child?.wipePrivateData();
  }
}
export async function accountFromPrf(
  policy: RecoveryPolicy,
  credentialId: string,
  prf: Uint8Array,
  adapters: PrimaryAdapters,
): Promise<PrimaryAccount> {
  let writer: ScopedOwnerWriter | undefined;
  try {
    policy = freezePolicy(policy);
    assertPrimaryAdapters(policy, adapters);
    writer = deriveOwnerWriter(prf, policy, adapters);
    const keys = await lookupKeys(prf, true);
    const account: PrimaryAccount = {
      policy,
      context: contextFor(policy, writer.owner, hex(random(32))),
      dataKey: random(32),
      locator: keys.locator,
      recordKey: keys.key,
      credentialId,
      writer,
      close() {
        this.writer.close();
        this.dataKey.fill(0);
        this.recordKey.fill(0);
      },
    };
    return account;
  } catch (e) {
    writer?.close();
    throw e;
  } finally {
    prf.fill(0);
  }
}
export async function createPrimary(
  policy: RecoveryPolicy,
  passkeys: PasskeyAdapter,
  adapters: PrimaryAdapters,
): Promise<PrimaryAccount> {
  policy = freezePolicy(policy);
  assertPrimaryAdapters(policy, adapters);
  const result = await passkeys.createPrimary(policy);
  const account = await accountFromPrf(
    policy,
    result.credentialId,
    result.prfOutput,
    adapters,
  );
  account.writer.bindContext(account.context);
  return account;
}
