import { ContinuityError } from "./types.ts";
import type { Context, RecoveryPolicy, Workspace, Head } from "./types.ts";
import { canonical, unb64, wellFormed } from "./crypto.ts";
import { parseSecretVault } from "@category-labs/mera";
export const LOCAL_POLICY: RecoveryPolicy = Object.freeze({
  protocol: "continuity-kit/v1",
  applicationId: "continuity-private-workspace",
  schemaId: "workspace/v1",
  deploymentId: "local-model-2026-09-v1",
  aOrigin: "http://primary.localhost:4173",
  bOrigin: "http://recovery.localhost:4174",
  aRpId: "primary.localhost",
  bRpId: "recovery.localhost",
  chainId: "31337",
  registryAddress: "0x1111111111111111111111111111111111111111",
  registryCodeHash:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  trustMode: "local-model",
  bootstrapNamespace: "continuity-kit/demo-recovery/v1",
  mirrorUrls: Object.freeze([
    "http://localhost:4175/v1/mirrors/0",
    "http://localhost:4175/v1/mirrors/1",
  ]),
  registryUrl: "http://localhost:4175",
  maxManifestBytes: 65536,
  maxCapsuleBytes: 1048576,
  timeoutMs: 10000,
  maxHeadAgeMs: 30000,
});
export const CONTEXT_FIELDS = [
  "protocol",
  "applicationId",
  "schemaId",
  "deploymentId",
  "aOrigin",
  "bOrigin",
  "aRpId",
  "bRpId",
  "chainId",
  "registryAddress",
  "registryCodeHash",
  "owner",
  "streamId",
] as const;
export function record(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContinuityError("SCHEMA_INVALID", "Expected object");
  const r = value as Record<string, unknown>;
  if (
    fields.some((k) => !Object.hasOwn(r, k)) ||
    Object.keys(r).some((k) => !fields.includes(k) && !optional.includes(k))
  )
    throw new ContinuityError("SCHEMA_INVALID", "Unexpected or missing fields");
  return r;
}
export function string(value: unknown, max = 10000): asserts value is string {
  if (typeof value !== "string" || value.length > max || !wellFormed(value))
    throw new ContinuityError("SCHEMA_INVALID", "Invalid string");
}
export function hex32(value: unknown): asserts value is `0x${string}` {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(value) ||
    /^0x0+$/.test(value)
  )
    throw new ContinuityError("SCHEMA_INVALID", "Invalid nonzero digest");
}
export function uint(
  value: unknown,
  allowZero = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 20 ||
    BigInt(value) > 18446744073709551615n ||
    (!allowZero && value === "0")
  )
    throw new ContinuityError("SCHEMA_INVALID", "Invalid uint64");
}
export function validatePolicy(p: RecoveryPolicy) {
  for (const field of [
    "applicationId",
    "schemaId",
    "deploymentId",
    "bootstrapNamespace",
  ] as const) {
    string(p[field], 200);
    if (!p[field])
      throw new ContinuityError("POLICY_INVALID", "Empty policy identity");
  }
  uint(p.chainId);
  hex32(p.registryCodeHash);
  if (
    !/^0x[0-9a-f]{40}$/.test(p.registryAddress) ||
    /^0x0+$/.test(p.registryAddress)
  )
    throw new ContinuityError("POLICY_INVALID", "Invalid registry address");
  if (p.trustMode !== "local-model" || p.protocol !== "continuity-kit/v1")
    throw new ContinuityError(
      "POLICY_INVALID",
      "Only explicitly simulated registry deployment is implemented",
    );
  for (const [origin, rp] of [
    [p.aOrigin, p.aRpId],
    [p.bOrigin, p.bRpId],
  ]) {
    const u = new URL(origin);
    if (u.origin !== origin || u.hostname !== rp)
      throw new ContinuityError("POLICY_INVALID", "Origin/RP mismatch");
    if (
      u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        (rp === "localhost" || rp.endsWith(".localhost"))
      )
    )
      throw new ContinuityError("POLICY_INVALID", "Secure origins required");
  }
  if (
    p.aRpId === p.bRpId ||
    p.aRpId.endsWith("." + p.bRpId) ||
    p.bRpId.endsWith("." + p.aRpId)
  )
    throw new ContinuityError(
      "POLICY_INVALID",
      "Primary and recovery RPs must have disjoint scope",
    );
  if (
    p.mirrorUrls.length < 1 ||
    p.mirrorUrls.length > 2 ||
    p.maxManifestBytes > 65536 ||
    p.maxManifestBytes < 1024 ||
    p.maxCapsuleBytes > 1048576 ||
    p.maxCapsuleBytes < 1024 ||
    p.timeoutMs < 1 ||
    p.timeoutMs > 10000 ||
    p.maxHeadAgeMs < 1 ||
    p.maxHeadAgeMs > 60000
  )
    throw new ContinuityError("POLICY_INVALID", "Invalid policy bounds");
}
export function contextFor(
  p: RecoveryPolicy,
  owner: `0x${string}`,
  streamId: `0x${string}`,
): Context {
  const context = {} as Context;
  for (const field of CONTEXT_FIELDS) {
    if (field === "owner") context.owner = owner;
    else if (field === "streamId") context.streamId = streamId;
    else (context as unknown as Record<string, unknown>)[field] = p[field];
  }
  validateContext(context, p);
  return context;
}
export function validateContext(
  value: unknown,
  p: RecoveryPolicy,
): asserts value is Context {
  validatePolicy(p);
  const r = record(value, CONTEXT_FIELDS);
  for (const field of CONTEXT_FIELDS) {
    if (field === "owner" || field === "streamId") continue;
    if (r[field] !== p[field])
      throw new ContinuityError(
        "CONTEXT_MISMATCH",
        `Policy field mismatch: ${field}`,
      );
  }
  if (
    typeof r.owner !== "string" ||
    !/^0x[0-9a-f]{40}$/.test(r.owner) ||
    /^0x0+$/.test(r.owner)
  )
    throw new ContinuityError("CONTEXT_MISMATCH", "Invalid owner");
  hex32(r.streamId);
}
export function validateWorkspace(value: unknown): asserts value is Workspace {
  const r = record(value, ["title", "plan", "tasks", "draft"]);
  string(r.title, 200);
  string(r.plan, 16000);
  string(r.draft, 64000);
  if (!Array.isArray(r.tasks) || r.tasks.length > 200)
    throw new ContinuityError("SCHEMA_INVALID", "Task limit");
  const seen = new Set();
  for (const t of r.tasks) {
    const task = record(t, ["id", "text", "done"]);
    string(task.id, 100);
    string(task.text, 2000);
    if (!task.id || seen.has(task.id) || typeof task.done !== "boolean")
      throw new ContinuityError("SCHEMA_INVALID", "Invalid task");
    seen.add(task.id);
  }
}
export function validateVault(value: unknown) {
  const r = record(value, [
    "version",
    "credential",
    "prfSalt",
    "nonce",
    "ciphertext",
  ]);
  const c = record(r.credential, ["credentialId"], ["transports"]);
  unb64(c.credentialId);
  if (
    c.transports !== undefined &&
    (!Array.isArray(c.transports) ||
      c.transports.length > 10 ||
      c.transports.some((t) => typeof t !== "string" || t.length > 40))
  )
    throw new ContinuityError("SCHEMA_INVALID");
  const vault = parseSecretVault(value);
  if (canonical(vault) !== canonical(value))
    throw new ContinuityError("SCHEMA_INVALID");
  return vault;
}
export function validateHead(
  head: unknown,
  p: RecoveryPolicy,
): asserts head is Head {
  const r = record(head, [
    "exists",
    "manifestDigest",
    "version",
    "capsuleDigest",
    "evidence",
  ]);
  if (typeof r.exists !== "boolean")
    throw new ContinuityError("FRESHNESS_UNAVAILABLE");
  uint(r.version, !r.exists);
  if (r.exists) {
    hex32(r.manifestDigest);
    hex32(r.capsuleDigest);
  }
  const e = record(r.evidence, [
    "trustMode",
    "blockNumber",
    "blockHash",
    "observedAt",
  ]);
  uint(e.blockNumber, true);
  hex32(e.blockHash);
  if (e.trustMode !== p.trustMode || typeof e.observedAt !== "string")
    throw new ContinuityError("FRESHNESS_UNAVAILABLE");
  const age = Date.now() - Date.parse(e.observedAt);
  if (!Number.isFinite(age) || age < -5000 || age > p.maxHeadAgeMs)
    throw new ContinuityError(
      "FRESHNESS_UNAVAILABLE",
      "Registry evidence outside freshness bound",
    );
}
