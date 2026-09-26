import { recoverMessageAddress } from "viem";
import { bytesOf, canonical, digest, equal } from "./crypto.ts";
import { validateHead, hex32, uint, record, LOCAL_POLICY } from "./policy.ts";
import { registryDomain, registrySigningMessage } from "./registry-signing.ts";
import { ContinuityError } from "./types.ts";
import type {
  Hex,
  Head,
  RecoveryPolicy,
  RegistryCommand,
  MirrorStore,
  RegistryReader,
  OwnerRegistryWriter,
} from "./types.ts";
const ZERO = `0x${"0".repeat(64)}` as Hex;
export class MemoryMirrorStore implements MirrorStore {
  readonly id: string;
  readonly indexes = new Map<string, Uint8Array>();
  readonly blobs = new Map<Hex, Uint8Array>();
  offline = false;
  readIndexHook?: (
    locator: string,
    bytes: Uint8Array | null,
  ) => Uint8Array | null;
  readBlobHook?: (digest: Hex, bytes: Uint8Array | null) => Uint8Array | null;
  constructor(id = "memory") {
    this.id = id;
  }
  private check() {
    if (this.offline) throw new ContinuityError("STORAGE_FAILED");
  }
  async putIndexIfAbsent(locator: string, bytes: Uint8Array) {
    this.check();
    const old = this.indexes.get(locator);
    if (old && !equal(old, bytes))
      throw new ContinuityError("ENROLLMENT_CONFLICT");
    this.indexes.set(locator, new Uint8Array(bytes));
  }
  async getIndex(locator: string) {
    this.check();
    const b = this.indexes.get(locator);
    const copy = b ? new Uint8Array(b) : null;
    return this.readIndexHook ? this.readIndexHook(locator, copy) : copy;
  }
  async putBlob(hash: Hex, bytes: Uint8Array) {
    this.check();
    if ((await digest(bytes)) !== hash)
      throw new ContinuityError("DIGEST_MISMATCH");
    const old = this.blobs.get(hash);
    if (old && !equal(old, bytes)) throw new ContinuityError("DIGEST_MISMATCH");
    this.blobs.set(hash, new Uint8Array(bytes));
  }
  async getBlob(hash: Hex) {
    this.check();
    const b = this.blobs.get(hash);
    const copy = b ? new Uint8Array(b) : null;
    return this.readBlobHook ? this.readBlobHook(hash, copy) : copy;
  }
}
export class MemoryRegistry implements RegistryReader, OwnerRegistryWriter {
  readonly heads = new Map<string, Head>();
  offline = false;
  private block = 0n;
  readonly #domain: ReturnType<typeof registryDomain>;
  constructor(policy: RecoveryPolicy = LOCAL_POLICY) {
    this.#domain = registryDomain(policy);
  }
  private checkDomain(policy: RecoveryPolicy) {
    if (canonical(registryDomain(policy)) !== canonical(this.#domain))
      throw new ContinuityError(
        "CONTEXT_MISMATCH",
        "Registry deployment scope mismatch",
      );
  }
  private evidence() {
    return {
      trustMode: "local-model" as const,
      blockNumber: String(this.block),
      blockHash: `0x${(this.block + 1n).toString(16).padStart(64, "0")}` as Hex,
      observedAt: new Date().toISOString(),
    };
  }
  async getHead(
    _policy: RecoveryPolicy,
    owner: Hex,
    streamId: Hex,
  ): Promise<Head> {
    this.checkDomain(_policy);
    if (this.offline) throw new ContinuityError("FRESHNESS_UNAVAILABLE");
    const head = this.heads.get(owner + streamId);
    return structuredClone(
      head
        ? { ...head, evidence: this.evidence() }
        : {
            exists: false,
            manifestDigest: ZERO,
            version: "0",
            capsuleDigest: ZERO,
            evidence: this.evidence(),
          },
    );
  }
  async execute(
    p: RecoveryPolicy,
    c: RegistryCommand,
    signature: Hex,
  ): Promise<Head> {
    this.checkDomain(p);
    if (this.offline) throw new ContinuityError("FRESHNESS_UNAVAILABLE");
    const signer = (
      await recoverMessageAddress({
        message: registrySigningMessage(this.#domain, c),
        signature,
      })
    ).toLowerCase();
    if (signer !== c.owner)
      throw new ContinuityError("CONTEXT_MISMATCH", "Owner signature mismatch");
    hex32(c.streamId);
    const key = c.owner + c.streamId;
    const current = this.heads.get(key);
    let next: Head;
    if (c.operation === "create") {
      record(c, [
        "operation",
        "owner",
        "streamId",
        "manifestDigest",
        "initialCapsuleDigest",
      ]);
      hex32(c.manifestDigest);
      hex32(c.initialCapsuleDigest);
      if (current) throw new ContinuityError("ENROLLMENT_CONFLICT");
      next = {
        exists: true,
        manifestDigest: c.manifestDigest,
        version: "1",
        capsuleDigest: c.initialCapsuleDigest,
        evidence: this.evidence(),
      };
    } else {
      record(c, [
        "operation",
        "owner",
        "streamId",
        "expectedVersion",
        "expectedDigest",
        "nextDigest",
      ]);
      hex32(c.expectedDigest);
      hex32(c.nextDigest);
      uint(c.expectedVersion);
      if (
        !current ||
        current.version !== c.expectedVersion ||
        current.capsuleDigest !== c.expectedDigest ||
        current.capsuleDigest === c.nextDigest ||
        current.version === "18446744073709551615"
      )
        throw new ContinuityError("WRITE_CONFLICT");
      next = {
        ...current,
        version: String(BigInt(current.version) + 1n),
        capsuleDigest: c.nextDigest,
        evidence: this.evidence(),
      };
    }
    this.block++;
    this.heads.set(key, next);
    return this.getHead(p, c.owner, c.streamId);
  }
}
export async function boundedResponse(
  response: Response,
  max: number,
): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > max)
    throw new ContinuityError("STORAGE_FAILED", "Oversized response");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max)
        throw new ContinuityError("STORAGE_FAILED", "Oversized response");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
export class HttpMirrorStore implements MirrorStore {
  readonly id: string;
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  constructor(baseUrl: string, slot?: 0 | 1, timeoutMs = 10000) {
    this.baseUrl =
      slot === undefined
        ? baseUrl.replace(/\/$/, "")
        : `${baseUrl.replace(/\/$/, "")}/v1/mirrors/${slot}`;
    this.id = this.baseUrl;
    this.timeoutMs = timeoutMs;
  }
  private async get(kind: string, id: string, max: number) {
    const response = await fetch(
      `${this.baseUrl}/${kind}/${encodeURIComponent(id)}`,
      {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
        cache: "no-store",
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new ContinuityError("STORAGE_FAILED");
    return boundedResponse(response, max);
  }
  private async put(kind: string, id: string, bytes: Uint8Array) {
    const response = await fetch(
      `${this.baseUrl}/${kind}/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      },
    );
    if (response.status === 409)
      throw new ContinuityError("ENROLLMENT_CONFLICT");
    if (!response.ok) throw new ContinuityError("STORAGE_FAILED");
  }
  getIndex(locator: string) {
    return this.get("index", locator, 131072);
  }
  putIndexIfAbsent(locator: string, bytes: Uint8Array) {
    return this.put("index", locator, bytes);
  }
  getBlob(hash: Hex) {
    return this.get("blob", hash, 1048576);
  }
  putBlob(hash: Hex, bytes: Uint8Array) {
    return this.put("blob", hash, bytes);
  }
}
export class HttpRegistry implements RegistryReader, OwnerRegistryWriter {
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  private async request(
    p: RecoveryPolicy,
    url: string,
    options: RequestInit = {},
  ): Promise<Head> {
    try {
      if (this.baseUrl !== p.registryUrl)
        throw new ContinuityError(
          "POLICY_INVALID",
          "Registry endpoint mismatch",
        );
      const response = await fetch(this.baseUrl + url, {
        ...options,
        signal: AbortSignal.timeout(p.timeoutMs),
        redirect: "error",
        cache: "no-store",
      });
      const raw = await boundedResponse(response, 8192);
      const body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
      if (!response.ok) {
        if (
          body.code === "WRITE_CONFLICT" ||
          body.code === "ENROLLMENT_CONFLICT"
        )
          throw new ContinuityError(body.code);
        throw new ContinuityError("FRESHNESS_UNAVAILABLE");
      }
      validateHead(body, p);
      return body;
    } catch (e) {
      if (e instanceof ContinuityError) throw e;
      throw new ContinuityError("FRESHNESS_UNAVAILABLE");
    }
  }
  getHead(p: RecoveryPolicy, owner: Hex, streamId: Hex) {
    return this.request(p, `/v1/registry/${owner}/${streamId}`);
  }
  execute(p: RecoveryPolicy, command: RegistryCommand, signature: Hex) {
    return this.request(p, "/v1/registry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new TextDecoder().decode(
        bytesOf({ ...command, domain: registryDomain(p), signature }),
      ),
    });
  }
}
