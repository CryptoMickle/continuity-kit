import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";

// Shared bounded quorum reader and exact immutable registry ABI.
export const registryAbi = parseAbi([
  "event StreamCreated(address indexed owner, bytes32 indexed streamId, bytes32 manifestDigest, uint64 version, bytes32 capsuleDigest)",
  "event HeadCommitted(address indexed owner, bytes32 indexed streamId, uint64 version, bytes32 capsuleDigest)",
  "error WriteConflict(uint64 expectedVersion, uint64 actualVersion, bytes32 expectedDigest, bytes32 actualDigest)",
  "function create(bytes32 streamId, bytes32 manifestDigest, bytes32 initialCapsuleDigest)",
  "function commit(bytes32 streamId, uint64 expectedVersion, bytes32 expectedDigest, bytes32 nextDigest)",
  "function getHead(address owner, bytes32 streamId) view returns (bool exists, bytes32 manifestDigest, uint64 version, bytes32 capsuleDigest)",
]);
export interface TestnetPolicy {
  chainId: 10143;
  registryAddress: Hex;
  registryCodeHash: Hex;
  rpcUrls: readonly [string, string];
  maxHeadAgeMs: number;
  timeoutMs: number;
  maxResponseBytes: number;
}
export class FreshnessError extends Error {
  readonly code = "FRESHNESS_UNAVAILABLE";
}
function fail(message: string): never {
  throw new FreshnessError(message);
}
const zero = `0x${"0".repeat(64)}`;
function hex(
  value: unknown,
  bytes: number,
  nonzero = true,
): asserts value is Hex {
  if (
    typeof value !== "string" ||
    !new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(value) ||
    (nonzero && /^0x0+$/.test(value))
  )
    fail("Invalid canonical identifier");
}
function quantity(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) ||
    value.length > 66
  )
    fail("Invalid RPC quantity");
  return BigInt(value as string);
}
export function validatePolicy(input: TestnetPolicy): Readonly<TestnetPolicy> {
  if (input.chainId !== 10143)
    fail("Only Monad testnet chain 10143 is supported");
  hex(input.registryAddress, 20);
  hex(input.registryCodeHash, 32);
  if (!Array.isArray(input.rpcUrls) || input.rpcUrls.length !== 2)
    fail("Two approved RPC endpoints required");
  const urls = input.rpcUrls.map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      fail("RPC must be approved HTTPS without embedded credentials");
    return url;
  });
  if (urls[0]!.hostname === urls[1]!.hostname)
    fail(
      "RPC endpoints must have distinct hosts; operator independence needs review",
    );
  for (const [value, max] of [
    [input.timeoutMs, 10_000],
    [input.maxHeadAgeMs, 60_000],
    [input.maxResponseBytes, 1_048_576],
  ]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > max!)
      fail("Invalid bounded policy");
  }
  return Object.freeze({
    ...input,
    rpcUrls: Object.freeze([input.rpcUrls[0], input.rpcUrls[1]]) as readonly [
      string,
      string,
    ],
  });
}
type Method =
  "eth_chainId" | "eth_getBlockByNumber" | "eth_getCode" | "eth_call";
export type ReadRpc = (
  url: string,
  method: Method,
  params: readonly unknown[],
  signal: AbortSignal,
) => Promise<unknown>;

/** Inject only trusted transports. The default transport bounds streaming bytes before JSON parsing. */
export function boundedHttpRpc(
  maxResponseBytes: number,
  fetcher: typeof fetch = fetch,
): ReadRpc {
  let id = 0;
  return async (url, method, params, signal) => {
    const requestId = ++id;
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    });
    if (!response.ok || !response.body) fail("RPC HTTP failure");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxResponseBytes) fail("RPC response exceeds limit");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== "id,jsonrpc,result" ||
      result.jsonrpc !== "2.0" ||
      result.id !== requestId ||
      "error" in result ||
      !("result" in result)
    )
      fail("Invalid RPC envelope");
    return result.result;
  };
}
interface Block {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}
export interface TestnetHead {
  exists: boolean;
  manifestDigest: Hex;
  version: string;
  capsuleDigest: Hex;
  evidence: {
    trustMode: "trusted-rpc-quorum";
    chainId: 10143;
    registryAddress: Hex;
    registryCodeHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    blockTimestamp: string;
    observedAt: string;
    finality: "finalized";
    maxHeadAgeMs: number;
  };
}
export class MonadRegistryReader {
  readonly #policy: Readonly<TestnetPolicy>;
  readonly #rpc: ReadRpc;
  readonly #now: () => number;
  #deadline = 0;
  #lastBlock?: Block;
  #heads = new Map<string, TestnetHead>();
  #queue: Promise<unknown> = Promise.resolve();
  constructor(policy: TestnetPolicy, rpc?: ReadRpc, now = Date.now) {
    this.#policy = validatePolicy(policy);
    this.#rpc = rpc ?? boundedHttpRpc(policy.maxResponseBytes);
    this.#now = now;
  }
  getHead(owner: Hex, streamId: Hex): Promise<TestnetHead> {
    hex(owner, 20);
    hex(streamId, 32);
    const result = this.#queue.then(() => this.#read(owner, streamId));
    this.#queue = result.catch(() => {});
    return result;
  }
  async #call(
    url: string,
    method: Method,
    params: readonly unknown[],
  ): Promise<unknown> {
    if (Date.now() >= this.#deadline) fail("RPC operation deadline");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#rpc(url, method, params, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new FreshnessError("RPC timeout"));
            },
            Math.min(this.#policy.timeoutMs, this.#deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  #block(raw: unknown): Block {
    if (!raw || typeof raw !== "object") fail("Missing finalized block");
    const value = raw as Record<string, unknown>;
    hex(value.hash, 32);
    const block = {
      number: quantity(value.number),
      hash: value.hash,
      timestamp: quantity(value.timestamp),
    };
    this.#fresh(block);
    return block;
  }
  #fresh(block: Block) {
    const age = BigInt(this.#now()) - block.timestamp * 1000n;
    if (age < -5000n || age > BigInt(this.#policy.maxHeadAgeMs))
      fail("Finalized block is stale or from the future");
  }
  async #read(owner: Hex, streamId: Hex): Promise<TestnetHead> {
    this.#deadline = Date.now() + this.#policy.timeoutMs;
    try {
      const policy = this.#policy;
      const tips = await Promise.all(
        policy.rpcUrls.map(async (url) => {
          if (quantity(await this.#call(url, "eth_chainId", [])) !== 10143n)
            fail("Wrong RPC chain");
          return this.#block(
            await this.#call(url, "eth_getBlockByNumber", ["finalized", false]),
          );
        }),
      );
      const number =
        tips[0]!.number < tips[1]!.number ? tips[0]!.number : tips[1]!.number;
      const tag = `0x${number.toString(16)}`;
      const observations = await Promise.all(
        policy.rpcUrls.map(async (url, index) => {
          const block = this.#block(
            await this.#call(url, "eth_getBlockByNumber", [tag, false]),
          );
          if (
            block.number !== number ||
            (tips[index]!.number === number && tips[index]!.hash !== block.hash)
          )
            fail("Finalized block identity changed");
          const code = await this.#call(url, "eth_getCode", [
            policy.registryAddress,
            tag,
          ]);
          if (
            typeof code !== "string" ||
            !/^0x(?:[0-9a-f]{2})+$/.test(code) ||
            keccak256(code as Hex) !== policy.registryCodeHash
          )
            fail("Registry runtime code mismatch");
          const data = encodeFunctionData({
            abi: registryAbi,
            functionName: "getHead",
            args: [owner, streamId],
          });
          const raw = await this.#call(url, "eth_call", [
            { to: policy.registryAddress, data },
            tag,
          ]);
          if (typeof raw !== "string" || !/^0x[0-9a-f]{256}$/.test(raw))
            fail("Invalid head response");
          const [exists, manifestDigest, version, capsuleDigest] =
            decodeFunctionResult({
              abi: registryAbi,
              functionName: "getHead",
              data: raw as Hex,
            });
          if (
            version > (1n << 64n) - 1n ||
            encodeFunctionResult({
              abi: registryAbi,
              functionName: "getHead",
              result: [exists, manifestDigest, version, capsuleDigest],
            }) !== raw
          )
            fail("Noncanonical registry state");
          if (
            exists
              ? version === 0n ||
                manifestDigest === zero ||
                capsuleDigest === zero
              : version !== 0n ||
                manifestDigest !== zero ||
                capsuleDigest !== zero
          )
            fail("Invalid registry state");
          const after = this.#block(
            await this.#call(url, "eth_getBlockByNumber", [tag, false]),
          );
          if (
            after.number !== block.number ||
            after.hash !== block.hash ||
            after.timestamp !== block.timestamp
          )
            fail("Block identity changed during read");
          return {
            block,
            raw,
            exists,
            manifestDigest,
            version: version.toString(),
            capsuleDigest,
          };
        }),
      );
      const a = observations[0]!,
        b = observations[1]!;
      if (
        a.block.hash !== b.block.hash ||
        a.block.timestamp !== b.block.timestamp ||
        a.raw !== b.raw
      )
        fail("RPC quorum disagreement");
      this.#fresh(a.block);
      if (
        this.#lastBlock &&
        (number < this.#lastBlock.number ||
          (number === this.#lastBlock.number &&
            a.block.hash !== this.#lastBlock.hash) ||
          a.block.timestamp < this.#lastBlock.timestamp)
      )
        fail("Accepted block regressed");
      const key = `${owner}/${streamId}`,
        previous = this.#heads.get(key);
      if (
        previous &&
        previous.exists &&
        (!a.exists ||
          a.manifestDigest !== previous.manifestDigest ||
          BigInt(a.version) < BigInt(previous.version) ||
          (a.version === previous.version &&
            a.capsuleDigest !== previous.capsuleDigest))
      )
        fail("Accepted head regressed or changed immutable state");
      if (
        previous &&
        previous.evidence.blockNumber === number.toString() &&
        (a.exists !== previous.exists ||
          a.version !== previous.version ||
          a.capsuleDigest !== previous.capsuleDigest)
      )
        fail("Same block returned different head");
      const head: TestnetHead = {
        exists: a.exists,
        manifestDigest: a.manifestDigest,
        version: a.version,
        capsuleDigest: a.capsuleDigest,
        evidence: {
          trustMode: "trusted-rpc-quorum",
          chainId: 10143,
          registryAddress: policy.registryAddress,
          registryCodeHash: policy.registryCodeHash,
          blockNumber: number.toString(),
          blockHash: a.block.hash,
          blockTimestamp: a.block.timestamp.toString(),
          observedAt: new Date(this.#now()).toISOString(),
          finality: "finalized",
          maxHeadAgeMs: policy.maxHeadAgeMs,
        },
      };
      this.#lastBlock = a.block;
      this.#heads.set(key, structuredClone(head));
      return head;
    } catch (error) {
      if (error instanceof FreshnessError) throw error;
      throw new FreshnessError(
        "Unable to obtain an accepted finalized registry head",
      );
    }
  }
}

export type IntentCommand =
  | { operation: "create"; manifestDigest: Hex; initialCapsuleDigest: Hex }
  | {
      operation: "commit";
      expectedVersion: string;
      expectedDigest: Hex;
      nextDigest: Hex;
    };
export interface IntentScope {
  owner: Hex;
  streamId: Hex;
}
/** Unsigned calldata only. No wallet, secret, account, signature, nonce or broadcast API. */
export function createIntentBuilder(
  policyInput: TestnetPolicy,
  scopeInput: IntentScope,
) {
  const policy = validatePolicy(policyInput),
    scope = Object.freeze({ ...scopeInput });
  hex(scope.owner, 20);
  hex(scope.streamId, 32);
  return (command: IntentCommand) => {
    let data: Hex;
    if (command.operation === "create") {
      hex(command.manifestDigest, 32);
      hex(command.initialCapsuleDigest, 32);
      if (
        Object.keys(command).sort().join(",") !==
        "initialCapsuleDigest,manifestDigest,operation"
      )
        fail("Unexpected intent fields");
      data = encodeFunctionData({
        abi: registryAbi,
        functionName: "create",
        args: [
          scope.streamId,
          command.manifestDigest,
          command.initialCapsuleDigest,
        ],
      });
    } else if (command.operation === "commit") {
      hex(command.expectedDigest, 32);
      hex(command.nextDigest, 32);
      if (
        Object.keys(command).sort().join(",") !==
          "expectedDigest,expectedVersion,nextDigest,operation" ||
        typeof command.expectedVersion !== "string" ||
        !/^[1-9][0-9]{0,19}$/.test(command.expectedVersion) ||
        BigInt(command.expectedVersion) >= (1n << 64n) - 1n ||
        command.expectedDigest === command.nextDigest
      )
        fail("Invalid commit expectation");
      data = encodeFunctionData({
        abi: registryAbi,
        functionName: "commit",
        args: [
          scope.streamId,
          BigInt(command.expectedVersion),
          command.expectedDigest,
          command.nextDigest,
        ],
      });
    } else fail("Operation outside registry intent scope");
    return Object.freeze({
      kind: "unsigned-registry-intent" as const,
      chainId: 10143 as const,
      from: scope.owner,
      to: policy.registryAddress,
      value: "0x0" as const,
      data,
      streamId: scope.streamId,
      registryCodeHash: policy.registryCodeHash,
    });
  };
}
