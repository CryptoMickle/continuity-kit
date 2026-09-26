import { ContinuityError } from "./types.ts";
import type {
  RecoveryPolicy,
  PrimaryAdapters,
  SaveResult,
  WriteProof,
  WriteTicket,
  RegistryCommand,
  WriteOutcome,
  Context,
  Workspace,
  PreparedBackup,
  PasskeyAdapter,
  Adapters,
  Hex,
  Manifest,
  Head,
  DiscoveredRecovery,
  Recovered,
} from "./types.ts";
import {
  b64,
  unb64,
  bytesOf,
  canonical,
  digest,
  equal,
  lookupKeys,
  seal,
  open,
  parseCanonical,
} from "./crypto.ts";
import {
  validateContext,
  validateWorkspace,
  validateVault,
  record,
  hex32,
  uint,
  validateHead,
  validatePolicy,
  freezePolicy,
  metadataFingerprint,
} from "./policy.ts";
import { accountFromPrf } from "./account.ts";
import type { PrimaryAccount, PrimaryState } from "./account.ts";
const indexAAD = (p: RecoveryPolicy, locator: string) => ({
  format: "continuity-index/v1",
  bootstrapNamespace: p.bootstrapNamespace,
  bRpId: p.bRpId,
  locator,
});
const primaryAAD = (p: RecoveryPolicy, locator: string) => ({
  format: "continuity-primary-index/v1",
  aRpId: p.aRpId,
  applicationId: p.applicationId,
  locator,
});
function sameContext(a: unknown, b: unknown) {
  if (canonical(a) !== canonical(b))
    throw new ContinuityError("CONTEXT_MISMATCH");
}
function envelope(bytes: Uint8Array, max: number, format: string) {
  const r = record(parseCanonical(bytes, max), [
    "format",
    "nonce",
    "ciphertext",
  ]);
  if (r.format !== format) throw new ContinuityError("SCHEMA_INVALID");
  unb64(r.nonce, 12);
  unb64(r.ciphertext);
  return r as { format: string; nonce: string; ciphertext: string };
}
function manifestFrom(value: unknown, p: RecoveryPolicy): Manifest {
  const r = record(value, ["format", "context", "vault"]);
  if (r.format !== "continuity-manifest/v1")
    throw new ContinuityError("MANIFEST_INVALID");
  validateContext(r.context, p);
  const vault = validateVault(r.vault);
  return { format: "continuity-manifest/v1", context: r.context, vault };
}
function checkAdapters(p: RecoveryPolicy, a: Adapters) {
  validatePolicy(p);
  if (metadataFingerprint(p) !== metadataFingerprint(a.registry.policy))
    throw new ContinuityError("POLICY_INVALID", "Reader policy mismatch");
  if (a.mirrors.length !== p.mirrorUrls.length)
    throw new ContinuityError("POLICY_INVALID");
  for (const m of a.mirrors) {
    if (m.id.startsWith("http") && !p.mirrorUrls.includes(m.id))
      throw new ContinuityError(
        "POLICY_INVALID",
        "Mirror endpoint not in trusted policy",
      );
  }
}
export async function readHead(
  p: RecoveryPolicy,
  c: Context,
  manifestDigest: Hex,
  a: Adapters,
): Promise<Head> {
  checkAdapters(p, a);
  try {
    const h = await a.registry.getHead(c.owner, c.streamId);
    validateHead(h, p);
    if (!h.exists) throw new ContinuityError("UNREGISTERED_ENROLLMENT");
    if (h.manifestDigest !== manifestDigest)
      throw new ContinuityError("MANIFEST_BINDING_MISMATCH");
    return h;
  } catch (e) {
    if (
      e instanceof ContinuityError &&
      ["UNREGISTERED_ENROLLMENT", "MANIFEST_BINDING_MISMATCH"].includes(e.code)
    )
      throw e;
    throw new ContinuityError(
      "FRESHNESS_UNAVAILABLE",
      "Cannot obtain accepted registry head",
    );
  }
}
export async function prepareBackup(
  policy: RecoveryPolicy,
  passkeys: PasskeyAdapter,
  input: { context: Context; dataKey: Uint8Array },
  isActive: () => boolean = () => true,
): Promise<PreparedBackup> {
  const assertActive = () => {
    if (!isActive()) throw new ContinuityError("SESSION_EXPIRED");
  };
  assertActive();
  validateContext(input.context, policy);
  if (input.dataKey.length !== 32) throw new ContinuityError("SCHEMA_INVALID");
  const context = structuredClone(input.context);
  const wrapped = bytesOf({
    format: "continuity-key/v1",
    context,
    dataKey: b64(input.dataKey),
  });
  let vault;
  try {
    vault = await passkeys.createBackup(wrapped, policy);
  } finally {
    wrapped.fill(0);
  }
  // Native work already inside Mera may finish late. Never start our next
  // separate ceremony on behalf of a handoff that has since ended.
  assertActive();
  validateVault(vault);
  const discovered = await passkeys.discover(
    policy,
    vault.credential.credentialId,
  );
  let keys: Awaited<ReturnType<typeof lookupKeys>> | undefined;
  try {
    assertActive();
    if (discovered.credentialId !== vault.credential.credentialId)
      throw new ContinuityError("CREDENTIAL_MISMATCH");
    keys = await lookupKeys(discovered.prfOutput);
    const manifest: Manifest = {
      format: "continuity-manifest/v1",
      context,
      vault,
    };
    const bytes = bytesOf(manifest);
    if (bytes.length > policy.maxManifestBytes)
      throw new ContinuityError("SCHEMA_INVALID");
    const result = {
      manifest,
      manifestDigest: await digest(bytes),
      locator: keys.locator,
      indexBytes: bytesOf({
        format: "continuity-index-envelope/v1",
        ...(await seal(keys.key, bytes, indexAAD(policy, keys.locator))),
      }),
    };
    assertActive();
    return result;
  } finally {
    discovered.prfOutput.fill(0);
    keys?.key.fill(0);
  }
}
export async function encryptCapsule(
  context: Context,
  manifestDigest: Hex,
  dataKey: Uint8Array,
  version: string,
  content: Workspace,
): Promise<{ bytes: Uint8Array; digest: Hex }> {
  validateWorkspace(content);
  content = structuredClone(content);
  context = structuredClone(context);
  uint(version);
  hex32(manifestDigest);
  const header = {
    format: "continuity-checkpoint/v1",
    contextHash: await digest(bytesOf(context)),
    manifestDigest,
    owner: context.owner,
    streamId: context.streamId,
    version,
    schemaId: context.schemaId,
  };
  const bytes = bytesOf({
    header,
    ...(await seal(
      dataKey,
      bytesOf({ format: "continuity-content/v1", content }),
      header,
    )),
  });
  return { bytes, digest: await digest(bytes) };
}
async function upload(
  a: Adapters,
  kind: "index" | "blob",
  key: string,
  bytes: Uint8Array,
) {
  const results = await Promise.allSettled(
    a.mirrors.map(async (m) => {
      if (kind === "index") await m.putIndexIfAbsent(key, bytes);
      else await m.putBlob(key as Hex, bytes);
      const read =
        kind === "index" ? await m.getIndex(key) : await m.getBlob(key as Hex);
      if (!read || !equal(read, bytes))
        throw new ContinuityError(
          "STORAGE_FAILED",
          "Read-back verification failed",
        );
    }),
  );
  for (const r of results)
    if (r.status === "rejected")
      throw r.reason instanceof ContinuityError
        ? r.reason
        : new ContinuityError("STORAGE_FAILED");
}
export type EnrollmentResult =
  | {
      status: "prepared";
      state: PrimaryState;
      proof: WriteProof;
      currentHead: Head;
      unresolvedTicket?: WriteTicket;
    }
  | { status: "pending"; ticket: WriteTicket };
const enrollmentLocks = new WeakMap<
  PrimaryAccount,
  { intent: string; pending?: Promise<EnrollmentResult> }
>();
/** Serialize enrollment per newly created primary account before any async work.
 * A failed upload may be retried, but its exact prepared bytes remain cached. */
export async function finalizeEnrollment(
  primary: PrimaryAccount,
  backup: PreparedBackup,
  content: Workspace,
  a: Adapters,
): Promise<EnrollmentResult> {
  if (!primary.writer.pendingTicket) primary.writer.assertActive();
  checkAdapters(primary.policy, a);
  validateWorkspace(content);
  const snapshot = structuredClone(backup);
  const capturedContent = structuredClone(content);
  manifestFrom(snapshot.manifest, primary.policy);
  sameContext(snapshot.manifest.context, primary.context);
  unb64(snapshot.locator, 32);
  envelope(
    snapshot.indexBytes,
    primary.policy.maxManifestBytes * 2,
    "continuity-index-envelope/v1",
  );
  const intent = canonical({
    manifest: snapshot.manifest,
    manifestDigest: snapshot.manifestDigest,
    locator: snapshot.locator,
    indexBytes: b64(snapshot.indexBytes),
  });
  let lock = enrollmentLocks.get(primary);
  if (lock && lock.intent !== intent)
    throw new ContinuityError(
      "ENROLLMENT_CONFLICT",
      "Enrollment intent is immutable",
    );
  if (lock?.pending) return lock.pending;
  if (!lock) {
    lock = { intent };
    enrollmentLocks.set(primary, lock);
  }
  const current = lock;
  const pending = finalizeEnrollmentOnce(primary, snapshot, capturedContent, a);
  current.pending = pending;
  try {
    return await pending;
  } finally {
    if (current.pending === pending) current.pending = undefined;
  }
}
async function finalizeEnrollmentOnce(
  primary: PrimaryAccount,
  backup: PreparedBackup,
  content: Workspace,
  a: Adapters,
): Promise<EnrollmentResult> {
  if (!primary.writer.pendingTicket) primary.writer.assertActive();
  const p = primary.policy;
  checkAdapters(p, a);
  validateWorkspace(content);
  content = structuredClone(content);
  const manifest = manifestFrom(backup.manifest, p);
  sameContext(manifest.context, primary.context);
  if ((await digest(bytesOf(manifest))) !== backup.manifestDigest)
    throw new ContinuityError("MANIFEST_INVALID");
  unb64(backup.locator, 32);
  envelope(
    backup.indexBytes,
    p.maxManifestBytes * 2,
    "continuity-index-envelope/v1",
  );
  if (primary.enrollment) {
    if (
      primary.enrollment.backup.manifestDigest !== backup.manifestDigest ||
      !equal(primary.enrollment.backup.indexBytes, backup.indexBytes)
    )
      throw new ContinuityError(
        "ENROLLMENT_CONFLICT",
        "Enrollment is immutable",
      );
  } else {
    const box = await seal(
      primary.recordKey,
      bytesOf({
        format: "continuity-primary/v1",
        context: primary.context,
        manifestDigest: backup.manifestDigest,
        dataKey: b64(primary.dataKey),
      }),
      primaryAAD(p, primary.locator),
    );
    const capsule = await encryptCapsule(
      primary.context,
      backup.manifestDigest,
      primary.dataKey,
      "1",
      content,
    );
    primary.enrollment = {
      backup: structuredClone(backup),
      primaryBytes: bytesOf({
        format: "continuity-primary-envelope/v1",
        ...box,
      }),
      capsuleBytes: capsule.bytes,
      capsuleDigest: capsule.digest,
    };
  }
  const cached = primary.enrollment;
  await upload(a, "index", primary.locator, cached.primaryBytes);
  await upload(a, "index", backup.locator, cached.backup.indexBytes);
  await upload(a, "blob", cached.capsuleDigest, cached.capsuleBytes);
  const command = {
    operation: "create" as const,
    owner: primary.context.owner,
    streamId: primary.context.streamId,
    manifestDigest: backup.manifestDigest,
    initialCapsuleDigest: cached.capsuleDigest,
  };
  primary.writer.bindManifest(backup.manifestDigest);
  const result = await primary.writer.execute(command);
  if (result.status === "unresolved")
    return { status: "pending", ticket: result.ticket };
  const state = Object.assign(primary, {
    manifestDigest: backup.manifestDigest,
    writes: Number(result.currentHead.version),
  });
  return {
    status: "prepared",
    state,
    proof: result.proof,
    currentHead: result.currentHead,
    unresolvedTicket: result.unresolvedTicket,
  };
}
export async function discoverRecovery(
  policy: RecoveryPolicy,
  passkeys: PasskeyAdapter,
  a: Adapters,
): Promise<DiscoveredRecovery> {
  policy = freezePolicy(policy);
  checkAdapters(policy, a);
  const result = await passkeys.discover(policy);
  const keys = await lookupKeys(result.prfOutput);
  result.prfOutput.fill(0);
  const diagnostics: { source: string; code: string }[] = [];
  const valid: { manifest: Manifest; manifestDigest: Hex }[] = [];
  let anyBytes = false;
  try {
    await Promise.all(
      a.mirrors.map(async (m) => {
        try {
          const bytes = await m.getIndex(keys.locator);
          if (!bytes) return;
          anyBytes = true;
          const box = envelope(
            bytes,
            policy.maxManifestBytes * 2,
            "continuity-index-envelope/v1",
          );
          const plain = await open(
            keys.key,
            box,
            indexAAD(policy, keys.locator),
          );
          const manifest = manifestFrom(
            parseCanonical(plain, policy.maxManifestBytes),
            policy,
          );
          if (manifest.vault.credential.credentialId !== result.credentialId)
            throw new ContinuityError("CREDENTIAL_MISMATCH");
          valid.push({ manifest, manifestDigest: await digest(plain) });
        } catch (e) {
          diagnostics.push({
            source: m.id,
            code: e instanceof ContinuityError ? e.code : "STORAGE_FAILED",
          });
        }
      }),
    );
  } finally {
    keys.key.fill(0);
  }
  if (!valid.length)
    throw new ContinuityError(
      anyBytes ? "MANIFEST_INVALID" : "NO_RECOVERY_MATERIAL",
      "No authenticated recovery manifest",
      diagnostics,
    );
  if (new Set(valid.map((v) => v.manifestDigest)).size !== 1)
    throw new ContinuityError(
      "ENROLLMENT_CONFLICT",
      "Mirrors returned different authenticated enrollments",
    );
  const selected = valid[0];
  const acceptedHead = await readHead(
    policy,
    selected.manifest.context,
    selected.manifestDigest,
    a,
  );
  return {
    policy,
    ...selected,
    credentialId: result.credentialId,
    acceptedHead,
    diagnostics,
  };
}
async function capsuleContent(
  bytes: Uint8Array,
  p: RecoveryPolicy,
  c: Context,
  manifestDigest: Hex,
  key: Uint8Array,
  h: Head,
): Promise<Workspace> {
  if ((await digest(bytes)) !== h.capsuleDigest)
    throw new ContinuityError("DIGEST_MISMATCH");
  const capsule = record(parseCanonical(bytes, p.maxCapsuleBytes), [
    "header",
    "nonce",
    "ciphertext",
  ]);
  const header = record(capsule.header, [
    "format",
    "contextHash",
    "manifestDigest",
    "owner",
    "streamId",
    "version",
    "schemaId",
  ]);
  const expected = {
    format: "continuity-checkpoint/v1",
    contextHash: await digest(bytesOf(c)),
    manifestDigest,
    owner: c.owner,
    streamId: c.streamId,
    version: h.version,
    schemaId: p.schemaId,
  };
  if (canonical(header) !== canonical(expected))
    throw new ContinuityError("CONTEXT_MISMATCH", "Capsule header mismatch");
  unb64(capsule.nonce, 12);
  unb64(capsule.ciphertext);
  const plain = await open(
    key,
    capsule as { nonce: string; ciphertext: string },
    header,
  );
  try {
    const payload = record(parseCanonical(plain, p.maxCapsuleBytes), [
      "format",
      "content",
    ]);
    if (payload.format !== "continuity-content/v1")
      throw new ContinuityError("SCHEMA_INVALID");
    validateWorkspace(payload.content);
    return payload.content;
  } finally {
    plain.fill(0);
  }
}
async function recoverWithKey(
  p: RecoveryPolicy,
  c: Context,
  manifestDigest: Hex,
  getKey: () => Promise<Uint8Array>,
  a: Adapters,
  diagnostics: Recovered["diagnostics"] = [],
  baseline?: Head,
): Promise<Recovered> {
  checkAdapters(p, a);
  let dataKey: Uint8Array | undefined;
  try {
    let h = await readHead(p, c, manifestDigest, a);
    if (
      baseline &&
      (BigInt(h.version) < BigInt(baseline.version) ||
        BigInt(h.evidence.blockNumber) <
          BigInt(baseline.evidence.blockNumber) ||
        (h.version === baseline.version &&
          h.capsuleDigest !== baseline.capsuleDigest) ||
        (h.evidence.blockNumber === baseline.evidence.blockNumber &&
          h.evidence.blockHash !== baseline.evidence.blockHash))
    )
      throw new ContinuityError(
        "FRESHNESS_UNAVAILABLE",
        "Registry view regressed since discovery",
      );
    for (let attempt = 0; attempt <= 3; attempt++) {
      let bytes: Uint8Array | undefined;
      for (const m of a.mirrors) {
        try {
          const candidate = await m.getBlob(h.capsuleDigest);
          if (!candidate) continue;
          if (
            candidate.length > p.maxCapsuleBytes ||
            (await digest(candidate)) !== h.capsuleDigest
          )
            throw new ContinuityError("DIGEST_MISMATCH");
          bytes = candidate;
          break;
        } catch (e) {
          diagnostics.push({
            source: m.id,
            code: e instanceof ContinuityError ? e.code : "STORAGE_FAILED",
          });
        }
      }
      if (!bytes)
        throw new ContinuityError(
          "CURRENT_DATA_UNAVAILABLE",
          "Known current checkpoint has no valid surviving bytes",
          { version: h.version, capsuleDigest: h.capsuleDigest, diagnostics },
        );
      dataKey ??= await getKey();
      const content = await capsuleContent(
        bytes,
        p,
        c,
        manifestDigest,
        dataKey,
        h,
      );
      const final = await readHead(p, c, manifestDigest, a);
      if (
        BigInt(final.evidence.blockNumber) < BigInt(h.evidence.blockNumber) ||
        (final.evidence.blockNumber === h.evidence.blockNumber &&
          final.evidence.blockHash !== h.evidence.blockHash)
      )
        throw new ContinuityError(
          "FRESHNESS_UNAVAILABLE",
          "Registry block evidence regressed or changed",
        );
      if (
        final.version === h.version &&
        final.capsuleDigest === h.capsuleDigest
      ) {
        return {
          content,
          context: structuredClone(c),
          manifestDigest,
          version: h.version,
          capsuleDigest: h.capsuleDigest,
          evidence: final.evidence,
          diagnostics,
        };
      }
      if (
        BigInt(final.version) <= BigInt(h.version) ||
        BigInt(final.evidence.blockNumber) < BigInt(h.evidence.blockNumber)
      )
        throw new ContinuityError(
          "FRESHNESS_UNAVAILABLE",
          "Registry view regressed",
        );
      h = final;
    }
    throw new ContinuityError("HEAD_MOVED");
  } finally {
    dataKey?.fill(0);
  }
}
export async function recoverCurrent(
  discovered: DiscoveredRecovery,
  passkeys: PasskeyAdapter,
  a: Adapters,
): Promise<Recovered> {
  const { policy, manifest, manifestDigest, credentialId } = discovered;
  validateContext(manifest.context, policy);
  if ((await digest(bytesOf(manifest))) !== manifestDigest)
    throw new ContinuityError("MANIFEST_INVALID");
  if (manifest.vault.credential.credentialId !== credentialId)
    throw new ContinuityError("CREDENTIAL_MISMATCH");
  return recoverWithKey(
    policy,
    manifest.context,
    manifestDigest,
    async () => {
      const secret = await passkeys.unwrap(
        validateVault(manifest.vault),
        policy,
      );
      try {
        const wrapped = record(parseCanonical(secret, 8192), [
          "format",
          "context",
          "dataKey",
        ]);
        if (wrapped.format !== "continuity-key/v1")
          throw new ContinuityError("SCHEMA_INVALID");
        sameContext(wrapped.context, manifest.context);
        return unb64(wrapped.dataKey, 32);
      } finally {
        secret.fill(0);
      }
    },
    a,
    [...discovered.diagnostics],
    discovered.acceptedHead,
  );
}
export async function restorePrimary(
  policy: RecoveryPolicy,
  passkeys: PasskeyAdapter,
  a: PrimaryAdapters,
): Promise<{ state: PrimaryState; recovered: Recovered }> {
  checkAdapters(policy, a);
  const prf = await passkeys.openPrimary(policy);
  const primary = await accountFromPrf(
    policy,
    prf.credentialId,
    prf.prfOutput,
    a,
  );
  const records: {
    context: Context;
    manifestDigest: Hex;
    dataKey: Uint8Array;
    fingerprint: string;
  }[] = [];
  let anyBytes = false;
  try {
    for (const mirror of a.mirrors) {
      try {
        const bytes = await mirror.getIndex(primary.locator);
        if (!bytes) continue;
        anyBytes = true;
        const box = envelope(
          bytes,
          policy.maxManifestBytes,
          "continuity-primary-envelope/v1",
        );
        const plain = await open(
          primary.recordKey,
          box,
          primaryAAD(policy, primary.locator),
        );
        try {
          const r = record(parseCanonical(plain, 8192), [
            "format",
            "context",
            "manifestDigest",
            "dataKey",
          ]);
          if (r.format !== "continuity-primary/v1")
            throw new ContinuityError("SCHEMA_INVALID");
          validateContext(r.context, policy);
          if (r.context.owner !== primary.writer.owner)
            throw new ContinuityError("CONTEXT_MISMATCH");
          hex32(r.manifestDigest);
          records.push({
            context: r.context,
            manifestDigest: r.manifestDigest,
            dataKey: unb64(r.dataKey, 32),
            fingerprint: await digest(plain),
          });
        } finally {
          plain.fill(0);
        }
      } catch {
        /* another approved mirror can still provide a valid record */
      }
    }
    if (!records.length)
      throw new ContinuityError(
        anyBytes ? "MANIFEST_INVALID" : "NO_RECOVERY_MATERIAL",
      );
    if (new Set(records.map((r) => r.fingerprint)).size !== 1)
      throw new ContinuityError("ENROLLMENT_CONFLICT");
    const r = records[0];
    primary.context = r.context;
    primary.writer.bindContext(r.context, true);
    primary.writer.bindManifest(r.manifestDigest);
    primary.dataKey.fill(0);
    primary.dataKey = new Uint8Array(r.dataKey);
    const recovered = await recoverWithKey(
      policy,
      r.context,
      r.manifestDigest,
      async () => new Uint8Array(primary.dataKey),
      a,
    );
    const state = Object.assign(primary, {
      manifestDigest: r.manifestDigest,
      writes: Number(recovered.version),
    });
    return { state, recovered };
  } catch (e) {
    primary.close();
    throw e;
  } finally {
    records.forEach((r) => r.dataKey.fill(0));
  }
}
interface PendingSave {
  command: RegistryCommand;
  bytes: Uint8Array;
  digest: Hex;
  content: Workspace;
}
const pendingSaves = new WeakMap<PrimaryState, PendingSave>();
const saving = new WeakSet<PrimaryState>();
export async function saveCheckpoint(
  state: PrimaryState,
  content: Workspace,
  a: Adapters,
): Promise<SaveResult> {
  checkAdapters(state.policy, a);
  validateWorkspace(content);
  if (saving.has(state))
    throw new ContinuityError("WRITE_PENDING", "Another save is preparing");
  saving.add(state);
  try {
    let pending = pendingSaves.get(state);
    if (pending && canonical(pending.content) !== canonical(content))
      throw new ContinuityError(
        "WRITE_PENDING",
        "Resolve retained draft before another save",
        state.writer.pendingTicket,
      );
    if (!pending) {
      state.writer.assertActive();
      const captured = structuredClone(content);
      if (state.writes >= 100000)
        throw new ContinuityError(
          "WRITE_CONFLICT",
          "Data-key write bound reached",
        );
      const h = await readHead(
        state.policy,
        state.context,
        state.manifestDigest,
        a,
      );
      if (BigInt(h.version) >= 100000n)
        throw new ContinuityError("WRITE_CONFLICT");
      const capsule = await encryptCapsule(
        state.context,
        state.manifestDigest,
        state.dataKey,
        String(BigInt(h.version) + 1n),
        captured,
      );
      if (capsule.bytes.length > state.policy.maxCapsuleBytes)
        throw new ContinuityError("SCHEMA_INVALID");
      pending = {
        command: {
          operation: "commit",
          owner: state.context.owner,
          streamId: state.context.streamId,
          expectedVersion: h.version,
          expectedDigest: h.capsuleDigest,
          nextDigest: capsule.digest,
        },
        bytes: capsule.bytes,
        digest: capsule.digest,
        content: captured,
      };
      pendingSaves.set(state, pending);
    }
    if (!state.writer.pendingTicket)
      await upload(a, "blob", pending.digest, pending.bytes);
    const result = await state.writer.execute(pending.command);
    return completedSave(state, pending, result);
  } catch (e) {
    // A definite preflight conflict can be explicitly resolved by the caller; uncertain submissions stay pinned.
    if (
      !state.writer.pendingTicket &&
      e instanceof ContinuityError &&
      ["WRITE_CONFLICT", "TRANSACTION_REVERTED"].includes(e.code)
    )
      pendingSaves.delete(state);
    throw e;
  } finally {
    saving.delete(state);
  }
}
function completedSave(
  state: PrimaryState,
  pending: PendingSave,
  result: WriteOutcome,
): SaveResult {
  if (result.status === "unresolved")
    return {
      status: "pending",
      ticket: result.ticket,
      draft: structuredClone(pending.content),
    };
  if (!result.unresolvedTicket) {
    pendingSaves.delete(state);
    state.writes = Number(result.currentHead.version);
  }
  if (!result.current)
    return {
      status: "superseded",
      checkpoint: result.checkpoint,
      proof: result.proof,
      currentHead: result.currentHead,
      draft: structuredClone(pending.content),
    };
  const recovered: Recovered = {
    content: structuredClone(pending.content),
    context: structuredClone(state.context),
    manifestDigest: state.manifestDigest,
    version: result.checkpoint.version,
    capsuleDigest: result.checkpoint.capsuleDigest,
    evidence: result.currentHead.evidence,
    diagnostics: [],
  };
  return {
    status: "saved",
    recovered,
    proof: result.proof,
    unresolvedTicket: result.unresolvedTicket,
  };
}
/** Read-only status check also resolves the SDK's retained draft cache. */
export async function reconcileCheckpoint(
  state: PrimaryState,
  ticket: WriteTicket,
  a: Adapters,
): Promise<SaveResult> {
  checkAdapters(state.policy, a);
  if (saving.has(state)) throw new ContinuityError("WRITE_PENDING");
  const pending = pendingSaves.get(state);
  if (!pending || canonical(pending.command) !== canonical(ticket.command))
    throw new ContinuityError("CONTEXT_MISMATCH", "No matching retained draft");
  saving.add(state);
  try {
    return completedSave(state, pending, await state.writer.reconcile(ticket));
  } catch (error) {
    if (
      !state.writer.pendingTicket &&
      error instanceof ContinuityError &&
      error.code === "TRANSACTION_REVERTED"
    )
      pendingSaves.delete(state);
    throw error;
  } finally {
    saving.delete(state);
  }
}
/** Confirms an already submitted create without uploading, signing, or sending again. */
export async function reconcileEnrollment(
  primary: PrimaryAccount,
  ticket: WriteTicket,
  a: Adapters,
): Promise<EnrollmentResult> {
  checkAdapters(primary.policy, a);
  if (
    ticket.command.operation !== "create" ||
    !primary.enrollment ||
    ticket.command.manifestDigest !==
      primary.enrollment.backup.manifestDigest ||
    ticket.command.initialCapsuleDigest !== primary.enrollment.capsuleDigest
  )
    throw new ContinuityError("CONTEXT_MISMATCH");
  const result = await primary.writer.reconcile(ticket);
  if (result.status === "unresolved")
    return { status: "pending", ticket: result.ticket };
  const state = Object.assign(primary, {
    manifestDigest: result.checkpoint.manifestDigest,
    writes: Number(result.currentHead.version),
  });
  return {
    status: "prepared",
    state,
    proof: result.proof,
    currentHead: result.currentHead,
    unresolvedTicket: result.unresolvedTicket,
  };
}
export function createLocalCopy(recovered: Recovered) {
  return {
    status: "local-working-copy" as const,
    content: structuredClone(recovered.content),
    source: structuredClone({
      context: recovered.context,
      version: recovered.version,
      capsuleDigest: recovered.capsuleDigest,
      evidence: recovered.evidence,
    }),
  };
}
export function exportLocalCopy(
  copy: ReturnType<typeof createLocalCopy>,
): string {
  validateWorkspace(copy.content);
  return JSON.stringify(copy, null, 2);
}
