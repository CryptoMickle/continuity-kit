/** Disposable offline chain. Its receipts are synthetic evidence, never Monad observations. */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from "viem";
import { LOCAL_POLICY, freezePolicy } from "../../src/sdk/policy.ts";
import { registryAbi, type ReadRpc } from "../../src/sdk/quorum.ts";
import type {
  MonadRecoveryPolicy,
  TransactionTransport,
  TransactionSessionLimits,
} from "../../src/sdk/types.ts";
export const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
export const runtime = "0x60006000" as Hex;
const { registryUrl: _localUrl, trustMode: _mode, ...common } = LOCAL_POLICY;
export const policy: MonadRecoveryPolicy = freezePolicy({
  ...common,
  trustMode: "trusted-rpc-quorum",
  chainId: "10143",
  deploymentId: "SYNTHETIC-OFFLINE-CHAIN-NOT-DEPLOYED",
  registryAddress: `0x${"42".repeat(20)}`,
  registryCodeHash: keccak256(runtime),
  rpcUrls: ["https://offline-one.invalid", "https://offline-two.invalid"],
  finality: "finalized",
  maxResponseBytes: 65536,
});
export const fixtureLimits: TransactionSessionLimits = {
  lifetimeMs: 600000,
  maxTransactions: 3,
  maxGas: 200000n,
  maxFeePerGas: 10n,
  maxPriorityFeePerGas: 2n,
  maxTotalFeeWei: 6000000n,
};
const q = (n: bigint | number) => `0x${n.toString(16)}`;
interface State {
  manifest: Hex;
  version: bigint;
  digest: Hex;
}
export class OfflineChain implements TransactionTransport {
  readonly policy = policy;
  readonly heads = new Map<string, State>();
  readonly transactions = new Map<Hex, Record<string, unknown>>();
  readonly receipts = new Map<Hex, Record<string, unknown>>();
  readonly nonces = new Map<Hex, bigint>();
  blockNumber = 100;
  now = Date.now();
  sends = 0;
  hideReceipts = false;
  broadcastMode: "normal" | "timeout" | "wrong-hash" | "unmined" = "normal";
  afterBroadcast?: () => void;
  stage?: (name: string) => void;
  alterReceipt?: (value: Record<string, unknown>, provider: 0 | 1) => void;
  alterTransaction?: (value: Record<string, unknown>, provider: 0 | 1) => void;
  nonceOffset = 0n;
  gasEstimate: unknown = "0x186a0";
  feeQuote = { maxFeePerGas: "0x5", maxPriorityFeePerGas: "0x1" };
  historicalCode = runtime;
  blockHashes = new Map<number, Hex>();
  timestamp = Math.floor(this.now / 1000);
  readonly rpc: ReadRpc = async (_url, method, params) => {
    if (method === "eth_chainId") return "0x279f";
    if (method === "eth_getBlockByNumber")
      return this.block(0, String(params[0]), new AbortController().signal);
    if (method === "eth_getCode") return runtime;
    if (method === "eth_call") {
      const { args } = decodeFunctionData({
        abi: registryAbi,
        data: (params[0] as { data: Hex }).data,
      });
      const h = this.heads.get(String(args[0]).toLowerCase() + String(args[1]));
      return encodeFunctionResult({
        abi: registryAbi,
        functionName: "getHead",
        result: h
          ? [true, h.manifest, h.version, h.digest]
          : [false, id(0), 0n, id(0)],
      });
    }
    throw new Error(
      "Real network and unrecognized RPC are forbidden in offline fixture",
    );
  };
  async pendingNonce(provider: 0 | 1, owner: Hex, _signal: AbortSignal) {
    this.stage?.("nonce");
    return q(
      (this.nonces.get(owner) ?? 0n) + (provider ? this.nonceOffset : 0n),
    );
  }
  async estimateGas(
    _provider: 0 | 1,
    _call: { from: Hex; to: Hex; data: Hex; value: "0x0" },
    _signal: AbortSignal,
  ) {
    this.stage?.("estimate");
    return this.gasEstimate;
  }
  async fees(_provider: 0 | 1, _signal: AbortSignal) {
    this.stage?.("fees");
    return { ...this.feeQuote };
  }
  async broadcast(raw: Hex, _signal: AbortSignal) {
    this.sends++;
    if (!raw.startsWith("0x02"))
      throw new Error("Expected actual serialized EIP-1559 transaction");
    const serialized = raw as `0x02${string}`,
      tx = parseTransaction(serialized),
      hash = keccak256(raw);
    const owner = (
      await recoverTransactionAddress({ serializedTransaction: serialized })
    ).toLowerCase() as Hex;
    if (this.broadcastMode === "unmined") return hash;
    const decoded = decodeFunctionData({ abi: registryAbi, data: tx.data! });
    ++this.blockNumber;
    const blockHash = id(this.blockNumber),
      index = "0x0",
      blockNumber = q(this.blockNumber);
    let eventData: Hex, topics: readonly Hex[];
    if (decoded.functionName === "create") {
      const [stream, manifest, digest] = decoded.args;
      this.heads.set(owner + stream, { manifest, version: 1n, digest });
      topics = encodeEventTopics({
        abi: registryAbi,
        eventName: "StreamCreated",
        args: { owner, streamId: stream },
      }) as Hex[];
      eventData = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }],
        [manifest, 1n, digest],
      );
    } else if (decoded.functionName === "commit") {
      const [stream, expected, digest, next] = decoded.args,
        h = this.heads.get(owner + stream)!;
      if (!h || h.version !== expected || h.digest !== digest)
        throw new Error("Synthetic CAS conflict");
      ++h.version;
      h.digest = next;
      topics = encodeEventTopics({
        abi: registryAbi,
        eventName: "HeadCommitted",
        args: { owner, streamId: stream },
      }) as Hex[];
      eventData = encodeAbiParameters(
        [{ type: "uint64" }, { type: "bytes32" }],
        [h.version, next],
      );
    } else throw new Error("Unexpected transaction");
    this.nonces.set(owner, BigInt(tx.nonce!) + 1n);
    this.transactions.set(hash, {
      hash,
      from: owner,
      to: tx.to!.toLowerCase(),
      input: tx.data,
      type: "0x2",
      chainId: q(tx.chainId!),
      nonce: q(tx.nonce!),
      value: q(tx.value ?? 0n),
      gas: q(tx.gas!),
      maxFeePerGas: q(tx.maxFeePerGas!),
      maxPriorityFeePerGas: q(tx.maxPriorityFeePerGas!),
      r: tx.r,
      s: tx.s,
      yParity: q(tx.yParity!),
      accessList: [],
      blockHash,
      blockNumber,
      transactionIndex: index,
    });
    this.receipts.set(hash, {
      transactionHash: hash,
      blockHash,
      blockNumber,
      transactionIndex: index,
      from: owner,
      to: tx.to!.toLowerCase(),
      type: "0x2",
      status: "0x1",
      gasUsed: "0x186a0",
      effectiveGasPrice: "0x5",
      logs: [
        {
          address: tx.to!.toLowerCase(),
          topics,
          data: eventData,
          removed: false,
          transactionHash: hash,
          blockHash,
          blockNumber,
          transactionIndex: index,
          logIndex: "0x0",
        },
      ],
    });
    this.afterBroadcast?.();
    if (this.broadcastMode === "timeout")
      throw new Error("Synthetic timeout after submission");
    return this.broadcastMode === "wrong-hash" ? id(999) : hash;
  }
  async transaction(provider: 0 | 1, hash: Hex, _signal: AbortSignal) {
    const value = this.transactions.get(hash);
    if (!value) return null;
    const copy = structuredClone(value);
    this.alterTransaction?.(copy, provider);
    return copy;
  }
  async receipt(provider: 0 | 1, hash: Hex, _signal: AbortSignal) {
    if (this.hideReceipts) return null;
    const value = this.receipts.get(hash);
    if (!value) return null;
    const copy = structuredClone(value);
    this.alterReceipt?.(copy, provider);
    return copy;
  }
  async block(_provider: 0 | 1, tag: string, _signal: AbortSignal) {
    const n = tag === "finalized" ? this.blockNumber : Number(BigInt(tag));
    return {
      number: q(n),
      hash: this.blockHashes.get(n) ?? id(n),
      timestamp: q(this.timestamp),
    };
  }
  async code(_provider: 0 | 1, _tag: string, _signal: AbortSignal) {
    return this.historicalCode;
  }
}
