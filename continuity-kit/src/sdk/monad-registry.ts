import {
  decodeErrorResult,
  encodeErrorResult,
  decodeFunctionData,
  encodeFunctionData,
} from "viem";
import {
  MonadRegistryReader as QuorumReader,
  boundedHttpRpc,
  type ReadRpc,
  type TestnetPolicy,
  registryAbi,
} from "./quorum.ts";
import {
  freezePolicy,
  validateHead,
  evmUint,
  record,
  hex32,
} from "./policy.ts";
import { ContinuityError } from "./types.ts";
import type {
  MonadRecoveryPolicy,
  RegistryReader,
  Hex,
  Head,
  TransactionTransport,
} from "./types.ts";
import { boundedResponse } from "./stores.ts";
export function chainPolicy(p: MonadRecoveryPolicy): TestnetPolicy {
  return {
    chainId: 10143,
    registryAddress: p.registryAddress,
    registryCodeHash: p.registryCodeHash,
    rpcUrls: p.rpcUrls,
    maxHeadAgeMs: p.maxHeadAgeMs,
    timeoutMs: p.timeoutMs,
    maxResponseBytes: p.maxResponseBytes,
  };
}
export class MonadRegistryReader implements RegistryReader {
  readonly #policy: MonadRecoveryPolicy;
  get policy() {
    return this.#policy;
  }
  readonly #reader: QuorumReader;
  readonly #now: () => number;
  constructor(input: MonadRecoveryPolicy, rpc?: ReadRpc, now = Date.now) {
    this.#policy = freezePolicy(input);
    this.#now = now;
    this.#reader = new QuorumReader(
      chainPolicy(this.policy),
      rpc ?? boundedHttpRpc(this.policy.maxResponseBytes),
      now,
    );
    Object.freeze(this);
  }
  async getHead(owner: Hex, streamId: Hex): Promise<Head> {
    try {
      const h = await this.#reader.getHead(owner, streamId),
        e = h.evidence;
      const head: Head = {
        exists: h.exists,
        manifestDigest: h.manifestDigest,
        version: h.version,
        capsuleDigest: h.capsuleDigest,
        evidence: {
          trustMode: "trusted-rpc-quorum",
          chainId: "10143",
          registryAddress: e.registryAddress,
          registryCodeHash: e.registryCodeHash,
          blockNumber: e.blockNumber,
          blockHash: e.blockHash,
          blockTimestamp: e.blockTimestamp,
          observedAt: e.observedAt,
          finality: e.finality,
          maxHeadAgeMs: e.maxHeadAgeMs,
        },
      };
      validateHead(head, this.policy, this.#now());
      return head;
    } catch {
      throw new ContinuityError(
        "FRESHNESS_UNAVAILABLE",
        "Cannot obtain finalized quorum head",
      );
    }
  }
}
/** Dormant unless an integrator supplies a complete reviewed deployment policy. */
export class HttpTransactionTransport implements TransactionTransport {
  readonly #policy: MonadRecoveryPolicy;
  get policy() {
    return this.#policy;
  }
  readonly #fetch: typeof fetch;
  #id = 0;
  constructor(policy: MonadRecoveryPolicy, fetcher: typeof fetch = fetch) {
    this.#policy = freezePolicy(policy);
    this.#fetch = fetcher;
    Object.freeze(this);
  }
  async #rpc(
    provider: 0 | 1,
    method: string,
    params: readonly unknown[],
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = ++this.#id;
    const response = await this.#fetch(this.policy.rpcUrls[provider], {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(this.policy.timeoutMs),
      ]),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok || response.redirected)
      throw new ContinuityError("FRESHNESS_UNAVAILABLE");
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedResponse(response, this.policy.maxResponseBytes),
      ),
    );
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new ContinuityError("TRANSACTION_EVIDENCE_INVALID");
    const r = raw as Record<string, unknown>;
    if (
      method === "eth_estimateGas" &&
      Object.keys(r).sort().join(",") === "error,id,jsonrpc" &&
      r.id === id &&
      r.jsonrpc === "2.0"
    ) {
      const error = record(r.error, ["code", "message"], ["data"]);
      if (
        Number.isSafeInteger(error.code) &&
        typeof error.message === "string" &&
        typeof error.data === "string" &&
        /^0x[0-9a-f]+$/.test(error.data)
      ) {
        let conflict = false;
        try {
          const decoded = decodeErrorResult({
            abi: registryAbi,
            data: error.data as Hex,
          });
          conflict =
            decoded.errorName === "WriteConflict" &&
            encodeErrorResult({
              abi: registryAbi,
              errorName: decoded.errorName,
              args: decoded.args,
            }) === error.data;
        } catch {
          /* Not an exact registry conflict. */
        }
        if (conflict)
          throw new ContinuityError(
            "WRITE_CONFLICT",
            "Registry simulation reported an exact CAS conflict",
          );
      }
      throw new ContinuityError(
        "TRANSACTION_EVIDENCE_INVALID",
        "Unrecognized estimate error",
      );
    }
    if (
      Object.keys(r).sort().join(",") !== "id,jsonrpc,result" ||
      r.id !== id ||
      r.jsonrpc !== "2.0"
    )
      throw new ContinuityError(
        "TRANSACTION_EVIDENCE_INVALID",
        "Invalid RPC envelope",
      );
    return r.result;
  }
  pendingNonce(provider: 0 | 1, owner: Hex, signal: AbortSignal) {
    return this.#rpc(
      provider,
      "eth_getTransactionCount",
      [owner, "pending"],
      signal,
    );
  }
  estimateGas(
    provider: 0 | 1,
    call: { from: Hex; to: Hex; data: Hex; value: "0x0"; gas: Hex },
    signal: AbortSignal,
  ) {
    record(call, ["from", "to", "data", "value", "gas"]);
    if (
      call.to !== this.policy.registryAddress ||
      call.value !== "0x0" ||
      typeof call.gas !== "string" ||
      !/^0x[1-9a-f][0-9a-f]{0,63}$/.test(call.gas) ||
      !/^0x[0-9a-f]{40}$/.test(call.from) ||
      !/^0x[0-9a-f]{8}(?:[0-9a-f]{64}){3,4}$/.test(call.data)
    )
      throw new ContinuityError("CONTEXT_MISMATCH");
    const decoded = decodeFunctionData({ abi: registryAbi, data: call.data });
    if (
      (decoded.functionName !== "create" &&
        decoded.functionName !== "commit") ||
      encodeFunctionData({
        abi: registryAbi,
        functionName: decoded.functionName,
        args: decoded.args,
      }) !== call.data
    )
      throw new ContinuityError("CONTEXT_MISMATCH");
    return this.#rpc(provider, "eth_estimateGas", [call], signal);
  }
  async fees(provider: 0 | 1, signal: AbortSignal) {
    const [maxFeePerGas, maxPriorityFeePerGas] = await Promise.all([
      this.#rpc(provider, "eth_gasPrice", [], signal),
      this.#rpc(provider, "eth_maxPriorityFeePerGas", [], signal),
    ]);
    return { maxFeePerGas, maxPriorityFeePerGas };
  }
  broadcast(raw: Hex, signal: AbortSignal) {
    if (!/^0x02[0-9a-f]+$/.test(raw) || raw.length > 4096)
      throw new ContinuityError("TRANSACTION_EVIDENCE_INVALID");
    return this.#rpc(0, "eth_sendRawTransaction", [raw], signal);
  }
  transaction(provider: 0 | 1, hash: Hex, signal: AbortSignal) {
    hex32(hash);
    return this.#rpc(provider, "eth_getTransactionByHash", [hash], signal);
  }
  receipt(provider: 0 | 1, hash: Hex, signal: AbortSignal) {
    hex32(hash);
    return this.#rpc(provider, "eth_getTransactionReceipt", [hash], signal);
  }
  block(provider: 0 | 1, number: string, signal: AbortSignal) {
    evmUint(number);
    return this.#rpc(
      provider,
      "eth_getBlockByNumber",
      [`0x${BigInt(number).toString(16)}`, false],
      signal,
    );
  }
  code(provider: 0 | 1, number: string, signal: AbortSignal) {
    evmUint(number);
    return this.#rpc(
      provider,
      "eth_getCode",
      [this.policy.registryAddress, `0x${BigInt(number).toString(16)}`],
      signal,
    );
  }
}
