/** Local operator repair for an exact, previously reviewed pre-signing failure.
 * Not generic enrollment resume, and never imported by the ordinary app/SDK.
 * An absent head/nonce alone does NOT establish that a prior send never happened.
 * The operator must separately reconcile the old attempt before offering this.
 */
import { accountFromPrf } from "../src/sdk/account.ts";
import {
  bytesOf,
  canonical,
  digest,
  equal,
  open,
  parseCanonical,
  unb64,
} from "../src/sdk/crypto.ts";
import {
  freezePolicy,
  hex32,
  metadataFingerprint,
  record,
  validateContext,
  validateHead,
  validateWorkspace,
} from "../src/sdk/policy.ts";
import { rpcQuantity } from "../src/sdk/owner-writer.ts";
import { ContinuityError } from "../src/sdk/types.ts";
import type {
  Context,
  Hex,
  MonadRecoveryPolicy,
  PasskeyAdapter,
  PrimaryAdapters,
  Workspace,
  WriteOutcome,
} from "../src/sdk/types.ts";

export interface PreparedPin {
  owner: Hex;
  streamId: Hex;
  manifestDigest: Hex;
  capsuleDigest: Hex;
}

export async function openPreparedCompletion(
  inputPolicy: MonadRecoveryPolicy,
  inputPin: PreparedPin,
  passkeys: Pick<PasskeyAdapter, "openPrimary">,
  adapters: PrimaryAdapters,
  signal: AbortSignal,
) {
  const policy = freezePolicy(inputPolicy);
  record(inputPin, ["owner", "streamId", "manifestDigest", "capsuleDigest"]);
  const pin = Object.freeze({ ...inputPin });
  if (!/^0x[0-9a-f]{40}$/.test(pin.owner))
    throw new ContinuityError("CONTEXT_MISMATCH");
  for (const value of [pin.streamId, pin.manifestDigest, pin.capsuleDigest]) {
    hex32(value);
    if (value === `0x${"00".repeat(32)}`)
      throw new ContinuityError("CONTEXT_MISMATCH");
  }
  if (
    adapters.trustMode !== "trusted-rpc-quorum" ||
    metadataFingerprint(adapters.registry.policy) !==
      metadataFingerprint(policy) ||
    adapters.mirrors.length !== 2 ||
    adapters.sessionLimits.maxTransactions !== 1 ||
    adapters.sessionLimits.lifetimeMs > 600000 ||
    adapters.sessionLimits.maxGas > 300000n ||
    adapters.sessionLimits.maxFeePerGas > 200000000000n ||
    adapters.sessionLimits.maxPriorityFeePerGas > 2000000000n ||
    adapters.sessionLimits.maxTotalFeeWei > 60000000000000000n
  )
    throw new ContinuityError("POLICY_INVALID");

  signal.throwIfAborted();
  const prf = await passkeys.openPrimary(policy);
  if (signal.aborted) {
    prf.prfOutput.fill(0);
    signal.throwIfAborted();
  }
  // Enforce nonce zero again at the writer's own immediate pre-signing check.
  const original = adapters.transactions;
  const guarded: typeof original = {
    policy: original.policy,
    async pendingNonce(provider, owner, deadline) {
      const nonce = await original.pendingNonce(provider, owner, deadline);
      if (owner !== pin.owner || rpcQuantity(nonce) !== 0n)
        throw new ContinuityError("WRITE_CONFLICT");
      return nonce;
    },
    estimateGas: (...args) => original.estimateGas(...args),
    fees: (...args) => original.fees(...args),
    broadcast: (...args) => original.broadcast(...args),
    transaction: (...args) => original.transaction(...args),
    receipt: (...args) => original.receipt(...args),
    block: (...args) => original.block(...args),
    code: (...args) => original.code(...args),
  };
  const primary = await accountFromPrf(
    policy,
    prf.credentialId,
    prf.prfOutput,
    {
      ...adapters,
      transactions: guarded,
    },
  );
  let closed = false;
  const close = () => {
    closed = true;
    primary.close();
  };
  const active = () => {
    signal.throwIfAborted();
    if (closed) throw new ContinuityError("SESSION_EXPIRED");
    primary.writer.assertActive();
  };
  signal.addEventListener("abort", close, { once: true });
  async function absentAndUnused() {
    active();
    const head = await adapters.registry.getHead(pin.owner, pin.streamId);
    validateHead(head, policy);
    if (head.exists) throw new ContinuityError("ENROLLMENT_CONFLICT");
    await Promise.all(
      ([0, 1] as const).map((provider) =>
        guarded.pendingNonce(provider, pin.owner, signal),
      ),
    );
    active();
  }
  try {
    active();
    if (primary.writer.owner !== pin.owner)
      throw new ContinuityError("CREDENTIAL_MISMATCH");
    await absentAndUnused();
    const records = await Promise.all(
      adapters.mirrors.map((m) => m.getIndex(primary.locator)),
    );
    active();
    if (!records[0] || !records[1] || !equal(records[0], records[1]))
      throw new ContinuityError("NO_RECOVERY_MATERIAL");
    const box = record(parseCanonical(records[0], policy.maxManifestBytes), [
      "format",
      "nonce",
      "ciphertext",
    ]);
    if (box.format !== "continuity-primary-envelope/v1")
      throw new ContinuityError("SCHEMA_INVALID");
    unb64(box.nonce, 12);
    unb64(box.ciphertext);
    const plain = await open(
      primary.recordKey,
      box as { nonce: string; ciphertext: string },
      {
        format: "continuity-primary-index/v1",
        aRpId: policy.aRpId,
        applicationId: policy.applicationId,
        locator: primary.locator,
      },
    );
    let context: Context;
    try {
      const r = record(parseCanonical(plain, 8192), [
        "format",
        "context",
        "manifestDigest",
        "dataKey",
      ]);
      validateContext(r.context, policy);
      if (
        r.format !== "continuity-primary/v1" ||
        r.context.owner !== pin.owner ||
        r.context.streamId !== pin.streamId ||
        r.manifestDigest !== pin.manifestDigest
      )
        throw new ContinuityError("CONTEXT_MISMATCH");
      context = structuredClone(r.context);
      primary.dataKey.fill(0);
      primary.dataKey = unb64(r.dataKey, 32);
    } finally {
      plain.fill(0);
    }
    const copies = await Promise.all(
      adapters.mirrors.map((m) => m.getBlob(pin.capsuleDigest)),
    );
    active();
    if (
      !copies[0] ||
      !copies[1] ||
      !equal(copies[0], copies[1]) ||
      (await digest(copies[0])) !== pin.capsuleDigest
    )
      throw new ContinuityError("DIGEST_MISMATCH");
    const capsule = record(parseCanonical(copies[0], policy.maxCapsuleBytes), [
      "header",
      "nonce",
      "ciphertext",
    ]);
    const expected = {
      format: "continuity-checkpoint/v1",
      contextHash: await digest(bytesOf(context)),
      manifestDigest: pin.manifestDigest,
      owner: pin.owner,
      streamId: pin.streamId,
      version: "1",
      schemaId: policy.schemaId,
    };
    if (canonical(capsule.header) !== canonical(expected))
      throw new ContinuityError("CONTEXT_MISMATCH");
    unb64(capsule.nonce, 12);
    unb64(capsule.ciphertext);
    const contentBytes = await open(
      primary.dataKey,
      capsule as { nonce: string; ciphertext: string },
      expected,
    );
    let content: Workspace;
    try {
      const payload = record(
        parseCanonical(contentBytes, policy.maxCapsuleBytes),
        ["format", "content"],
      );
      if (payload.format !== "continuity-content/v1")
        throw new ContinuityError("SCHEMA_INVALID");
      validateWorkspace(payload.content);
      content = structuredClone(payload.content);
    } finally {
      contentBytes.fill(0);
    }
    active();
    primary.context = context;
    primary.writer.bindContext(context);
    primary.writer.bindManifest(pin.manifestDigest);
    // No secret is needed after preview; keep only the bounded writer in RAM.
    primary.dataKey.fill(0);
    primary.recordKey.fill(0);
    let attempted = false;
    let checking = false;
    return Object.freeze({
      pin,
      content,
      get ticket() {
        return primary.writer.pendingTicket;
      },
      close,
      async complete(): Promise<WriteOutcome> {
        active();
        if (attempted) throw new ContinuityError("WRITE_PENDING");
        attempted = true; // Never reset on any error or unknown submission outcome.
        try {
          await absentAndUnused();
          await Promise.all(
            adapters.mirrors.map(async (mirror) => {
              const savedRecord = await mirror.getIndex(primary.locator);
              const savedCapsule = await mirror.getBlob(pin.capsuleDigest);
              if (
                !savedRecord ||
                !savedCapsule ||
                !equal(savedRecord, records[0]!) ||
                !equal(savedCapsule, copies[0]!)
              )
                throw new ContinuityError("STORAGE_FAILED");
            }),
          );
          active();
          return await primary.writer.execute({
            operation: "create",
            owner: pin.owner,
            streamId: pin.streamId,
            manifestDigest: pin.manifestDigest,
            initialCapsuleDigest: pin.capsuleDigest,
          });
        } finally {
          close();
        } // Reconciliation remains read-only after signer close.
      },
      async reconcile(): Promise<WriteOutcome> {
        signal.throwIfAborted();
        const ticket = primary.writer.pendingTicket;
        if (!ticket || checking) throw new ContinuityError("WRITE_PENDING");
        checking = true;
        try {
          return await primary.writer.reconcile(ticket);
        } finally {
          checking = false;
        }
      },
    });
  } catch (error) {
    close();
    throw error;
  }
}
