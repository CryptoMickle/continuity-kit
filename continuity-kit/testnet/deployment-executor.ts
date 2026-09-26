/** Offline-prepared deployment capability. Importing this module performs no I/O.
 * The caller must obtain real user approval: a plan/object is not evidence of consent.
 * All dependencies are explicit TRUSTED capabilities, including fixture transports.
 */
import {
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import {
  getContractAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
} from "viem";
import type { Hex, TransactionSerializableEIP1559 } from "viem";
import type { WebAuthnClient } from "@category-labs/mera";

const HOSTS = Object.freeze([
  "https://testnet-rpc.monad.xyz",
  "https://monad-testnet.drpc.org",
] as const);
const CREATION_HASH =
  "0xffe3a0181af4fe73ac31b6ef29707b4a4ed141adccf8fbb09232f8a63b8be717";
const RUNTIME_HASH =
  "0x0605a2eae3c27f4d12476d61af8b1eb53a8b7b64f145c9139b47c95f8aef9dd9";
const PROPOSED_OWNER = "0x9d9bf455f58994c17852d3241e775974cdc05281";
const MAX_BYTES = 1024 * 1024;
export interface DeploymentApproval {
  chainId: 10143;
  deployer: Hex;
  nonce: "0";
  predictedContractAddress: Hex;
  creationData: Hex;
  creationDataHash: Hex;
  runtimeCodeHash: Hex;
  gasLimitCeiling: "1000000";
  maxFeePerGasWei: "200000000000";
  maxPriorityFeePerGasWei: "2000000000";
  maxTotalFeeWei: "200000000000000000";
  valueWei: "0";
}
/** Narrow trusted dependency; never handed to consumers of the executor. */
export interface DeploymentSigner {
  address: Hex;
  sign(transaction: Readonly<TransactionSerializableEIP1559>): Promise<Hex>;
  close(): void;
}
export type DeploymentRpc = (
  host: string,
  method: string,
  params: readonly unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export interface DeploymentDependencies {
  rpc: DeploymentRpc;
  openSigner: () => Promise<DeploymentSigner>;
  now: () => number;
}
export interface DeploymentTicket {
  readonly chainId: 10143;
  readonly transactionHash: Hex;
  readonly deployer: Hex;
  readonly contractAddress: Hex;
  readonly nonce: "0";
}
export type DeploymentOutcome = Readonly<{
  status:
    | "submitted"
    | "uncertain"
    | "pending"
    | "reverted"
    | "evidence-invalid"
    | "finalized";
  ticket: DeploymentTicket;
}>;
const fail = (message: string): never => {
  throw new Error(`DEPLOYMENT_${message}`);
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("OBJECT");
  return value as Record<string, unknown>;
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const result = object(value);
  if (
    Reflect.ownKeys(result).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(result, k))
  )
    fail("FIELDS");
  for (const key of keys)
    if (
      !Object.getOwnPropertyDescriptor(result, key)?.enumerable ||
      !("value" in Object.getOwnPropertyDescriptor(result, key)!)
    )
      fail("ACCESSOR");
  return result;
}
function hex(value: unknown, bytes?: number): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
    (bytes !== undefined && value.length !== 2 + bytes * 2)
  )
    fail("HEX");
  return (value as string).toLowerCase() as Hex;
}
function quantity(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ||
    value.length > 66
  )
    fail("QUANTITY");
  return BigInt(value as string);
}
const q = (value: bigint) => `0x${value.toString(16)}`;
function copyApproval(input: unknown): Readonly<DeploymentApproval> {
  const p = exact(input, [
    "chainId",
    "deployer",
    "nonce",
    "predictedContractAddress",
    "creationData",
    "creationDataHash",
    "runtimeCodeHash",
    "gasLimitCeiling",
    "maxFeePerGasWei",
    "maxPriorityFeePerGasWei",
    "maxTotalFeeWei",
    "valueWei",
  ]);
  if (
    p.chainId !== 10143 ||
    p.nonce !== "0" ||
    p.valueWei !== "0" ||
    p.gasLimitCeiling !== "1000000" ||
    p.maxFeePerGasWei !== "200000000000" ||
    p.maxPriorityFeePerGasWei !== "2000000000" ||
    p.maxTotalFeeWei !== "200000000000000000"
  )
    fail("SCOPE");
  const deployer = hex(p.deployer, 20),
    creationData = hex(p.creationData),
    predictedContractAddress = hex(p.predictedContractAddress, 20);
  if (
    creationData.length > 10000 ||
    keccak256(creationData) !== CREATION_HASH ||
    hex(p.creationDataHash, 32) !== CREATION_HASH ||
    hex(p.runtimeCodeHash, 32) !== RUNTIME_HASH ||
    getContractAddress({ from: deployer, nonce: 0n }).toLowerCase() !==
      predictedContractAddress
  )
    fail("SCOPE");
  return Object.freeze({
    chainId: 10143,
    nonce: "0",
    valueWei: "0",
    gasLimitCeiling: "1000000",
    maxFeePerGasWei: "200000000000",
    maxPriorityFeePerGasWei: "2000000000",
    maxTotalFeeWei: "200000000000000000",
    deployer,
    predictedContractAddress,
    creationData,
    creationDataHash: CREATION_HASH,
    runtimeCodeHash: RUNTIME_HASH,
  });
}
/** Validates a separately authorized exact plan against this proposal's physical owner.
 * Does not read the proposal JSON or infer authorization from any status field. */
export function validateProposedDeploymentApproval(
  input: unknown,
): Readonly<DeploymentApproval> {
  const plan = copyApproval(input);
  if (plan.deployer !== PROPOSED_OWNER) fail("PROPOSAL_OWNER");
  return plan;
}
/** Explicit production transport. No global fetch default, redirects, credentials or retries. */
export function createDeploymentFetchRpc(
  trustedFetch: typeof fetch,
): DeploymentRpc {
  let id = 0;
  return async (host, method, params, signal) => {
    if (!(HOSTS as readonly string[]).includes(host)) fail("HOST");
    const requestId = ++id;
    const response = await trustedFetch(host, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal,
    });
    if (!response.ok || !response.body) fail("RPC");
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) fail("RPC_SIZE");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      payload.jsonrpc !== "2.0" ||
      payload.id !== requestId ||
      Object.hasOwn(payload, "error") ||
      !Object.hasOwn(payload, "result")
    )
      fail("RPC");
    return payload.result;
  };
}
/** Existing selected credential only. Mera's default PRF salt matches the original A.
 * Invocation is authentication and MUST only occur under later explicit approval. */
function existingPrimaryDeploymentSigner(
  webAuthnClient: WebAuthnClient,
  credentialId?: string,
): () => Promise<DeploymentSigner> {
  if (
    credentialId !== undefined &&
    !/^[A-Za-z0-9_-]{1,2048}$/.test(credentialId)
  )
    fail("CREDENTIAL");
  return async () => {
    const result = await getPasskeyPrfOutput({
      rpId: "primary.localhost",
      ...(credentialId === undefined ? {} : { credential: { credentialId } }),
      timeout: 120000,
      webAuthnClient,
    });
    let seed: Uint8Array | undefined,
      root: HDKey | undefined,
      child: HDKey | undefined;
    try {
      if (
        (credentialId !== undefined && result.credentialId !== credentialId) ||
        result.prfOutput.length !== 32
      )
        fail("CREDENTIAL");
      seed = mnemonicToSeedSync(
        entropyToMnemonic(result.prfOutput, wordlist),
        "",
      );
      root = HDKey.fromMasterSeed(seed);
      child = root.derive("m/44'/60'/0'/0/0");
      if (!child.privateKey) fail("KEY");
      const session = createSecp256k1SigningSession({
        privateKey: child.privateKey!,
      });
      const account = toViemAccount(session);
      let used = false;
      return Object.freeze({
        address: account.address,
        sign: async (transaction: Readonly<TransactionSerializableEIP1559>) => {
          if (used) fail("SIGNER_USED");
          used = true;
          return account.signTransaction(transaction);
        },
        close: () => {
          used = true;
          session.end();
        },
      });
    } finally {
      result.prfOutput.fill(0);
      seed?.fill(0);
      root?.wipePrivateData();
      child?.wipePrivateData();
    }
  };
}

/** Only production entry: exact proposed physical owner, privately wired passkey signer.
 * Existing discoverable A selection is allowed; no credential creation is possible.
 * The selected credential's derived owner is checked before any signing operation. */
export function createProposedDeploymentExecutor(
  approvedInput: unknown,
  trusted: {
    rpc: DeploymentRpc;
    webAuthnClient: WebAuthnClient;
    now: () => number;
    credentialId?: string;
  },
) {
  const plan = validateProposedDeploymentApproval(approvedInput);
  if (
    !trusted.webAuthnClient ||
    typeof trusted.webAuthnClient.getCredential !== "function" ||
    typeof trusted.webAuthnClient.createCredential !== "function"
  )
    fail("WEBAUTHN_DEPENDENCY");
  const webAuthnClient = Object.freeze({
    getCredential: trusted.webAuthnClient.getCredential.bind(
      trusted.webAuthnClient,
    ),
    createCredential: trusted.webAuthnClient.createCredential.bind(
      trusted.webAuthnClient,
    ),
  });
  return createDeploymentExecutor(plan, {
    rpc: trusted.rpc,
    now: trusted.now,
    openSigner: existingPrimaryDeploymentSigner(
      webAuthnClient,
      trusted.credentialId,
    ),
  });
}

export function createDeploymentExecutor(
  approvedInput: unknown,
  trusted: DeploymentDependencies,
) {
  const plan = copyApproval(approvedInput);
  const rpc = trusted.rpc,
    openSigner = trusted.openSigner,
    now = trusted.now;
  if (
    typeof rpc !== "function" ||
    typeof openSigner !== "function" ||
    typeof now !== "function"
  )
    fail("DEPENDENCIES");
  const start = now();
  if (!Number.isSafeInteger(start) || start < 0) fail("CLOCK");
  const expiresAt = start + 600000;
  let lastTime = start,
    closed = false,
    reserved = false,
    busy = false;
  let signer: DeploymentSigner | undefined;
  let ticket: DeploymentTicket | undefined;
  let envelope: Readonly<TransactionSerializableEIP1559> | undefined;
  function clock() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < lastTime) fail("CLOCK");
    lastTime = time;
    return time;
  }
  function active() {
    if (closed || clock() >= expiresAt) fail("CLOSED_OR_EXPIRED");
  }
  async function bounded<T>(
    fn: () => Promise<T>,
    milliseconds: number,
  ): Promise<T> {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0)
      return fail("DEADLINE");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("DEPLOYMENT_TIMEOUT")),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function call(
    host: string,
    method: string,
    params: readonly unknown[],
    deadline: number,
  ) {
    const remaining = deadline - clock();
    if (remaining <= 0) fail("DEADLINE");
    const controller = new AbortController();
    try {
      const value = await bounded(
        () => rpc(host, method, params, controller.signal),
        Math.min(10000, remaining),
      );
      if (clock() > deadline) fail("DEADLINE");
      const json = JSON.stringify(value);
      if (
        json === undefined ||
        new TextEncoder().encode(json).length > MAX_BYTES
      )
        fail("RPC_SIZE");
      return JSON.parse(json) as unknown;
    } finally {
      controller.abort();
    }
  }
  async function both(
    method: string,
    params: readonly unknown[],
    deadline: number,
  ) {
    return Promise.all(
      HOSTS.map((host) => call(host, method, params, deadline)),
    );
  }
  async function nonceCheck(deadline: number) {
    const chains = await both("eth_chainId", [], deadline);
    if (chains.some((c) => quantity(c) !== 10143n)) fail("CHAIN");
    const nonces = await both(
      "eth_getTransactionCount",
      [plan.deployer, "pending"],
      deadline,
    );
    if (nonces.some((n) => quantity(n) !== BigInt(plan.nonce))) fail("NONCE");
  }
  async function preflight(
    deadline: number,
    selected?: Readonly<TransactionSerializableEIP1559>,
  ) {
    await nonceCheck(deadline);
    for (const address of [plan.deployer, plan.predictedContractAddress]) {
      const codes = await both("eth_getCode", [address, "pending"], deadline);
      if (codes.some((c) => hex(c) !== "0x")) fail("CODE_PRESENT");
    }
    const base = {
      from: plan.deployer,
      data: plan.creationData,
      value: "0x0",
      nonce: "0x0",
    };
    const estimates = (await both("eth_estimateGas", [base], deadline)).map(
      quantity,
    );
    const estimate = estimates.reduce((a, b) => (a > b ? a : b));
    const gas = (estimate * 120n + 99n) / 100n;
    if (estimate <= 0n || gas > BigInt(plan.gasLimitCeiling)) fail("GAS");
    const tips = (await both("eth_maxPriorityFeePerGas", [], deadline)).map(
      quantity,
    );
    const priority = tips.reduce((a, b) => (a > b ? a : b));
    const blocks = (
      await both("eth_getBlockByNumber", ["latest", false], deadline)
    ).map(object);
    const bases = blocks.map((b) => {
      freshBlock(b);
      return quantity(b.baseFeePerGas);
    });
    const maxBase = bases.reduce((a, b) => (a > b ? a : b));
    const cap = BigInt(plan.maxFeePerGasWei);
    const recommendation = maxBase * 2n + priority;
    const fee = recommendation < cap ? recommendation : cap;
    if (
      priority > BigInt(plan.maxPriorityFeePerGasWei) ||
      maxBase + priority > cap ||
      gas * fee > BigInt(plan.maxTotalFeeWei)
    )
      fail("FEES");
    const balances = (
      await both("eth_getBalance", [plan.deployer, "pending"], deadline)
    ).map(quantity);
    const liability = selected
      ? selected.gas! * selected.maxFeePerGas!
      : gas * fee;
    if (balances.some((b) => b < liability)) fail("FUNDS");
    return Object.freeze({
      type: "eip1559" as const,
      chainId: 10143,
      nonce: 0,
      data: plan.creationData,
      value: 0n,
      gas,
      maxFeePerGas: fee,
      maxPriorityFeePerGas: priority,
    });
  }
  function freshBlock(block: Record<string, unknown>) {
    hex(block.hash, 32);
    quantity(block.number);
    const timestamp = quantity(block.timestamp) * 1000n,
      time = BigInt(clock());
    if (timestamp > time + 5000n || timestamp < time - 60000n)
      fail("STALE_BLOCK");
  }
  function identity(block: unknown) {
    const b = object(block);
    return {
      hash: hex(b.hash, 32),
      number: quantity(b.number),
      timestamp: quantity(b.timestamp),
    };
  }
  function sameBlock(a: unknown, b: unknown) {
    const x = identity(a),
      y = identity(b);
    if (
      x.hash !== y.hash ||
      x.number !== y.number ||
      x.timestamp !== y.timestamp
    )
      fail("BLOCK_MISMATCH");
    return x;
  }
  async function validateRaw(
    raw: Hex,
    tx: Readonly<TransactionSerializableEIP1559>,
  ) {
    hex(raw);
    if (raw.length > 20000 || !raw.startsWith("0x02")) fail("SIGNED_ENVELOPE");
    const parsed = parseTransaction(raw);
    if (
      parsed.type !== "eip1559" ||
      parsed.to !== undefined ||
      (parsed.accessList?.length ?? 0) !== 0 ||
      parsed.chainId !== 10143 ||
      parsed.nonce !== tx.nonce ||
      parsed.data !== tx.data ||
      (parsed.value ?? 0n) !== 0n ||
      parsed.gas !== tx.gas ||
      parsed.maxFeePerGas !== tx.maxFeePerGas ||
      parsed.maxPriorityFeePerGas !== tx.maxPriorityFeePerGas ||
      serializeTransaction(parsed) !== raw ||
      (
        await recoverTransactionAddress({
          serializedTransaction: raw as `0x02${string}`,
        })
      ).toLowerCase() !== plan.deployer
    )
      fail("SIGNED_ENVELOPE");
  }
  function result(status: DeploymentOutcome["status"]): DeploymentOutcome {
    return Object.freeze({ status, ticket: ticket! });
  }
  async function execute(): Promise<DeploymentOutcome> {
    active();
    if (busy || reserved) fail("ATTEMPT_USED");
    busy = true;
    let raw: Hex | undefined;
    let acceptingSigner = true;
    const deadline = Math.min(expiresAt, clock() + 240000);
    try {
      const candidate = await preflight(Math.min(deadline, clock() + 60000));
      active();
      // Reserve BEFORE opening/signing: cancellation or uncertainty never enables a retry.
      reserved = true;
      signer = await bounded(
        async () => {
          const opened = await openSigner();
          if (!acceptingSigner || closed || clock() >= deadline) {
            opened.close();
            fail("CLOSED_OR_EXPIRED");
          }
          return opened;
        },
        Math.min(120000, deadline - clock()),
      );
      active();
      if (hex(signer.address, 20) !== plan.deployer) fail("SIGNER_OWNER");
      const refreshed = await preflight(
        Math.min(deadline, clock() + 60000),
        candidate,
      );
      if (
        refreshed.gas > candidate.gas ||
        refreshed.maxFeePerGas > candidate.maxFeePerGas ||
        refreshed.maxPriorityFeePerGas > candidate.maxPriorityFeePerGas
      )
        fail("PREFLIGHT_CHANGED");
      active();
      envelope = candidate;
      raw = await bounded(
        () => signer!.sign(candidate),
        Math.min(10000, deadline - clock()),
      );
      await validateRaw(raw, candidate);
      ticket = Object.freeze({
        chainId: 10143,
        transactionHash: keccak256(raw),
        deployer: plan.deployer,
        contractAddress: plan.predictedContractAddress,
        nonce: plan.nonce,
      });
      active();
      await nonceCheck(deadline);
      active();
      try {
        const hash = await call(
          HOSTS[0],
          "eth_sendRawTransaction",
          [raw],
          deadline,
        );
        return result(
          hex(hash, 32) === ticket.transactionHash ? "submitted" : "uncertain",
        );
      } catch {
        return result("uncertain");
      }
    } catch {
      return fail("STOPPED");
    } finally {
      acceptingSigner = false;
      raw = undefined;
      try {
        signer?.close();
      } catch {
        /* best effort cleanup */
      } finally {
        signer = undefined;
        busy = false;
      }
    }
  }
  async function reconcile(): Promise<DeploymentOutcome> {
    if (!ticket || !envelope || busy) fail("NO_TICKET_OR_BUSY");
    const recoveryTicket = ticket!,
      expectedEnvelope = envelope!;
    busy = true;
    const deadline = clock() + 60000;
    try {
      const chains = await both("eth_chainId", [], deadline);
      if (chains.some((c) => quantity(c) !== 10143n)) fail("CHAIN");
      const receipts = await both(
        "eth_getTransactionReceipt",
        [recoveryTicket.transactionHash],
        deadline,
      );
      if (receipts.some((r) => r === null)) return result("pending");
      const receipt = receipts.map(object);
      const transactions = await both(
        "eth_getTransactionByHash",
        [recoveryTicket.transactionHash],
        deadline,
      );
      if (transactions.some((t) => t === null)) return result("pending");
      for (const value of transactions) {
        const t = object(value);
        if (
          hex(t.hash, 32) !== recoveryTicket.transactionHash ||
          hex(t.from, 20) !== plan.deployer ||
          t.to !== null ||
          quantity(t.type) !== 2n ||
          quantity(t.chainId) !== 10143n ||
          quantity(t.nonce) !== 0n ||
          quantity(t.value) !== 0n ||
          hex(t.input) !== plan.creationData ||
          quantity(t.gas) !== expectedEnvelope.gas ||
          quantity(t.maxFeePerGas) !== expectedEnvelope.maxFeePerGas ||
          quantity(t.maxPriorityFeePerGas) !==
            expectedEnvelope.maxPriorityFeePerGas ||
          !Array.isArray(t.accessList) ||
          t.accessList.length ||
          t.authorizationList !== undefined ||
          t.blobVersionedHashes !== undefined
        )
          fail("TRANSACTION");
        const serialized = serializeTransaction({
          ...expectedEnvelope,
          r: hex(t.r, 32),
          s: hex(t.s, 32),
          yParity: Number(quantity(t.yParity ?? t.v)),
        });
        if (keccak256(serialized) !== recoveryTicket.transactionHash)
          fail("TRANSACTION_HASH");
      }
      for (let i = 0; i < 2; i++) {
        const r = receipt[i],
          t = object(transactions[i]);
        if (
          hex(r.transactionHash, 32) !== recoveryTicket.transactionHash ||
          hex(r.from, 20) !== plan.deployer ||
          r.to !== null ||
          quantity(r.type) !== 2n ||
          hex(r.blockHash, 32) !== hex(t.blockHash, 32) ||
          quantity(r.blockNumber) !== quantity(t.blockNumber) ||
          quantity(r.transactionIndex) !== quantity(t.transactionIndex) ||
          !Array.isArray(r.logs) ||
          r.logs.length !== 0 ||
          quantity(r.gasUsed) > expectedEnvelope.gas! ||
          quantity(r.effectiveGasPrice) > expectedEnvelope.maxFeePerGas!
        )
          fail("RECEIPT");
      }
      if (
        hex(receipt[0].blockHash, 32) !== hex(receipt[1].blockHash, 32) ||
        quantity(receipt[0].blockNumber) !== quantity(receipt[1].blockNumber) ||
        receipt[0].status !== receipt[1].status ||
        receipt[0].gasUsed !== receipt[1].gasUsed ||
        receipt[0].effectiveGasPrice !== receipt[1].effectiveGasPrice ||
        receipt[0].transactionIndex !== receipt[1].transactionIndex
      )
        fail("RECEIPT_MISMATCH");
      const number = quantity(receipt[0].blockNumber),
        blockHash = hex(receipt[0].blockHash, 32);
      const historic = await both(
        "eth_getBlockByNumber",
        [q(number), false],
        deadline,
      );
      const historicalIdentity = sameBlock(historic[0], historic[1]);
      if (
        historicalIdentity.number !== number ||
        historicalIdentity.hash !== blockHash
      )
        fail("RECEIPT_BLOCK");
      const finalized = (
        await both("eth_getBlockByNumber", ["finalized", false], deadline)
      ).map(object);
      finalized.forEach(freshBlock);
      const tips = finalized.map(identity);
      if (tips[0].number === tips[1].number && tips[0].hash !== tips[1].hash)
        fail("FINALITY_MISMATCH");
      const accepted = tips[0].number < tips[1].number ? tips[0] : tips[1];
      if (
        accepted.number === number &&
        (accepted.hash !== blockHash ||
          accepted.timestamp !== historicalIdentity.timestamp)
      )
        fail("FINALITY_RECEIPT_MISMATCH");
      if (
        tips[0].number === tips[1].number &&
        quantity(finalized[0].timestamp) !== quantity(finalized[1].timestamp)
      )
        fail("FINALITY_TIMESTAMP");
      if (accepted.number < number) return result("pending");
      const common = await both(
        "eth_getBlockByNumber",
        [q(accepted.number), false],
        deadline,
      );
      const commonIdentity = sameBlock(common[0], common[1]);
      common.map(object).forEach(freshBlock);
      if (
        commonIdentity.hash !== accepted.hash ||
        commonIdentity.number !== accepted.number ||
        commonIdentity.timestamp !== accepted.timestamp
      )
        fail("FINALITY_MISMATCH");
      const status = quantity(receipt[0].status);
      if (status === 0n) {
        if (receipt.some((r) => r.contractAddress !== null))
          fail("REVERT_ADDRESS");
        return result("reverted");
      }
      if (
        status !== 1n ||
        receipt.some(
          (r) => hex(r.contractAddress, 20) !== plan.predictedContractAddress,
        )
      )
        fail("CONTRACT_ADDRESS");
      for (const at of [number, accepted.number]) {
        const codes = await both(
          "eth_getCode",
          [plan.predictedContractAddress, q(at)],
          deadline,
        );
        if (codes.some((c) => keccak256(hex(c)) !== plan.runtimeCodeHash))
          fail("RUNTIME");
        const reread = await both(
          "eth_getBlockByNumber",
          [q(at), false],
          deadline,
        );
        const rereadIdentity = sameBlock(reread[0], reread[1]);
        if (
          rereadIdentity.number !== at ||
          rereadIdentity.hash !== (at === number ? blockHash : accepted.hash) ||
          rereadIdentity.timestamp !==
            (at === number
              ? historicalIdentity.timestamp
              : commonIdentity.timestamp)
        )
          fail("BLOCK_CHANGED");
      }
      return result("finalized");
    } catch {
      return result("evidence-invalid");
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    execute,
    reconcile,
    ticket: () => ticket,
    close: () => {
      closed = true;
      try {
        signer?.close();
      } catch {
        /* best effort */
      }
    },
  });
}
