import {
  createSecp256k1SigningSession,
  getEvmAddress,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  decodeFunctionData,
  encodeFunctionData,
  hashMessage,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
} from "viem";
import { fromHex, hex } from "./crypto.ts";
import {
  metadataFingerprint as canonical,
  freezePolicy,
  hex32,
  record,
  uint,
  validateContext,
  validateHead,
} from "./policy.ts";
import { chainPolicy } from "./monad-registry.ts";
import { createIntentBuilder, registryAbi } from "./quorum.ts";
import { registrySigningMessage } from "./registry-signing.ts";
import { ContinuityError } from "./types.ts";
import type {
  CheckpointIdentity,
  Context,
  Head,
  Hex,
  MonadRecoveryPolicy,
  PrimaryAdapters,
  RecoveryPolicy,
  RegistryCommand,
  ScopedOwnerWriter,
  TransactionEnvelope,
  TransactionSessionLimits,
  TransactionTransport,
  VerifiedReceipt,
  WriteOutcome,
  WriteTicket,
} from "./types.ts";

function invalid(message = "Transaction evidence mismatch"): never {
  throw new ContinuityError("TRANSACTION_EVIDENCE_INVALID", message);
}
export function rpcQuantity(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) ||
    value.length > 66
  )
    invalid("Invalid RPC quantity");
  return BigInt(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function limits(
  input: TransactionSessionLimits,
): Readonly<TransactionSessionLimits> {
  record(input, [
    "lifetimeMs",
    "maxTransactions",
    "maxGas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "maxTotalFeeWei",
  ]);
  if (
    !Number.isSafeInteger(input.lifetimeMs) ||
    input.lifetimeMs < 1 ||
    input.lifetimeMs > 600000 ||
    !Number.isSafeInteger(input.maxTransactions) ||
    input.maxTransactions < 1 ||
    input.maxTransactions > 3
  )
    throw new ContinuityError("POLICY_INVALID");
  for (const k of ["maxGas", "maxFeePerGas", "maxTotalFeeWei"] as const)
    if (typeof input[k] !== "bigint" || input[k] < 1n || input[k] >= 1n << 256n)
      throw new ContinuityError("POLICY_INVALID");
  if (
    typeof input.maxPriorityFeePerGas !== "bigint" ||
    input.maxPriorityFeePerGas < 0n ||
    input.maxPriorityFeePerGas > input.maxFeePerGas
  )
    throw new ContinuityError("POLICY_INVALID");
  return Object.freeze({ ...input });
}
function envelopeTicket(e: TransactionEnvelope): WriteTicket["envelope"] {
  return {
    ...e,
    value: String(e.value),
    gas: String(e.gas),
    maxFeePerGas: String(e.maxFeePerGas),
    maxPriorityFeePerGas: String(e.maxPriorityFeePerGas),
  };
}
function ticketEnvelope(e: WriteTicket["envelope"]): TransactionEnvelope {
  record(e, [
    "type",
    "chainId",
    "nonce",
    "to",
    "value",
    "data",
    "gas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
  ]);
  for (const k of [
    "value",
    "gas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
  ] as const)
    if (!/^(0|[1-9][0-9]{0,77})$/.test(e[k]) || BigInt(e[k]) >= 1n << 256n)
      invalid();
  if (
    e.type !== "eip1559" ||
    e.chainId !== 10143 ||
    !Number.isSafeInteger(e.nonce) ||
    e.nonce < 0 ||
    e.value !== "0" ||
    BigInt(e.gas) < 1n ||
    BigInt(e.maxFeePerGas) < 1n ||
    BigInt(e.maxPriorityFeePerGas) > BigInt(e.maxFeePerGas)
  )
    invalid();
  return {
    ...e,
    value: BigInt(e.value),
    gas: BigInt(e.gas),
    maxFeePerGas: BigInt(e.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(e.maxPriorityFeePerGas),
  };
}
export function assertPrimaryAdapters(p: RecoveryPolicy, a: PrimaryAdapters) {
  if (
    canonical(p) !== canonical(a.registry.policy) ||
    p.trustMode !== a.trustMode ||
    a.mirrors.length !== 2 ||
    a.mirrors.some(
      (m) => m.id.startsWith("http") && !p.mirrorUrls.includes(m.id),
    )
  )
    throw new ContinuityError("POLICY_INVALID", "Adapter policy mismatch");
  if (
    a.trustMode === "trusted-rpc-quorum" &&
    canonical(a.transactions.policy) !== canonical(p)
  )
    throw new ContinuityError("POLICY_INVALID", "Transport policy mismatch");
}
/** Owns Mera's unrestricted capability privately; callers can only execute frozen registry commands. */
export class OwnerWriter implements ScopedOwnerWriter {
  readonly #owner: Hex;
  readonly #expiresAt: number;
  readonly #trustMode: RecoveryPolicy["trustMode"];
  get owner() {
    return this.#owner;
  }
  get expiresAt() {
    return this.#expiresAt;
  }
  get trustMode() {
    return this.#trustMode;
  }
  readonly #policy: RecoveryPolicy;
  readonly #adapters: PrimaryAdapters;
  readonly #session: ReturnType<typeof createSecp256k1SigningSession>;
  readonly #account: ReturnType<typeof toViemAccount>;
  readonly #limits?: Readonly<TransactionSessionLimits>;
  readonly #now: () => number;
  #context?: Readonly<Context>;
  #manifest?: Hex;
  #commitOnly = false;
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();
  #pending?: WriteTicket;
  #count = 0;
  #reserved = 0n;
  #nextNonce?: number;
  #created?: Extract<WriteOutcome, { status: "confirmed" }>;
  get budget() {
    return Object.freeze({
      signingAttempts: this.#count,
      reservedFeeWei: String(this.#reserved),
      maxTransactions: this.#limits?.maxTransactions,
      maxTotalFeeWei: this.#limits?.maxTotalFeeWei.toString(),
    });
  }
  get pendingTicket() {
    return this.#pending && structuredClone(this.#pending);
  }
  constructor(
    privateKey: Uint8Array,
    policy: RecoveryPolicy,
    adapters: PrimaryAdapters,
    now = Date.now,
  ) {
    this.#policy = freezePolicy(policy);
    assertPrimaryAdapters(this.#policy, adapters);
    this.#adapters = Object.freeze({
      ...adapters,
      mirrors: Object.freeze([...adapters.mirrors]),
    });
    this.#trustMode = policy.trustMode;
    this.#limits =
      adapters.trustMode === "trusted-rpc-quorum"
        ? limits(adapters.sessionLimits)
        : undefined;
    this.#now = now;
    this.#expiresAt = now() + (this.#limits?.lifetimeMs ?? 600000);
    this.#session = createSecp256k1SigningSession({
      privateKey,
    });
    this.#account = toViemAccount(this.#session);
    this.#owner = getEvmAddress(this.#session.publicKey).toLowerCase() as Hex;
    Object.freeze(this);
  }
  bindContext(context: Context, commitOnly = false) {
    if (this.#context) throw new ContinuityError("ENROLLMENT_CONFLICT");
    validateContext(context, this.#policy);
    if (context.owner !== this.owner)
      throw new ContinuityError("CONTEXT_MISMATCH");
    this.#context = Object.freeze({ ...context });
    this.#commitOnly = commitOnly;
  }
  bindManifest(digest: Hex) {
    hex32(digest);
    if (this.#manifest && this.#manifest !== digest)
      throw new ContinuityError("ENROLLMENT_CONFLICT");
    this.#manifest = digest;
  }
  assertActive() {
    if (this.#closed || this.#now() >= this.expiresAt) {
      this.close();
      throw new ContinuityError("SESSION_EXPIRED");
    }
  }
  close() {
    this.#closed = true;
    this.#session.end();
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn);
    this.#queue = next.catch(() => {});
    return next;
  }
  #command(c: RegistryCommand, reconciliation = false): CheckpointIdentity {
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
      if (
        (!reconciliation && this.#commitOnly) ||
        c.manifestDigest !== this.#manifest
      )
        throw new ContinuityError("CONTEXT_MISMATCH");
    } else if (c.operation === "commit") {
      record(c, [
        "operation",
        "owner",
        "streamId",
        "expectedVersion",
        "expectedDigest",
        "nextDigest",
      ]);
      uint(c.expectedVersion);
      hex32(c.expectedDigest);
      hex32(c.nextDigest);
      if (
        c.expectedVersion === "18446744073709551615" ||
        c.expectedDigest === c.nextDigest
      )
        throw new ContinuityError("WRITE_CONFLICT");
    } else throw new ContinuityError("CONTEXT_MISMATCH");
    if (
      !this.#context ||
      !this.#manifest ||
      c.owner !== this.owner ||
      c.streamId !== this.#context.streamId
    )
      throw new ContinuityError("CONTEXT_MISMATCH");
    return {
      owner: c.owner,
      streamId: c.streamId,
      manifestDigest: this.#manifest,
      version:
        c.operation === "create" ? "1" : String(BigInt(c.expectedVersion) + 1n),
      capsuleDigest:
        c.operation === "create" ? c.initialCapsuleDigest : c.nextDigest,
    };
  }
  #intent(c: RegistryCommand) {
    if (this.#policy.trustMode !== "trusted-rpc-quorum")
      throw new ContinuityError("POLICY_INVALID");
    const { owner, streamId, ...command } = c;
    const intent = createIntentBuilder(chainPolicy(this.#policy), {
      owner,
      streamId,
    })(command);
    const decoded = decodeFunctionData({ abi: registryAbi, data: intent.data });
    // Decode/re-encode independently; rejects trailing arguments and alternate ABI encodings.
    if (
      decoded.functionName !== c.operation ||
      encodeFunctionData({
        abi: registryAbi,
        functionName: decoded.functionName,
        args: decoded.args,
      }) !== intent.data
    )
      invalid("Invalid calldata");
    return intent;
  }
  async #head(c: RegistryCommand): Promise<Head> {
    const head = await this.#adapters.registry.getHead(c.owner, c.streamId);
    validateHead(head, this.#policy, this.#now());
    return head;
  }
  #preflight(c: RegistryCommand, h: Head) {
    if (c.operation === "create") {
      if (h.exists) throw new ContinuityError("ENROLLMENT_CONFLICT");
    } else if (
      !h.exists ||
      h.manifestDigest !== this.#manifest ||
      h.version !== c.expectedVersion ||
      h.capsuleDigest !== c.expectedDigest
    )
      throw new ContinuityError("WRITE_CONFLICT");
  }
  execute(input: RegistryCommand): Promise<WriteOutcome> {
    const command = Object.freeze(structuredClone(input));
    return this.#serial(() => this.#execute(command));
  }
  async #execute(c: RegistryCommand): Promise<WriteOutcome> {
    const checkpoint = this.#command(c);
    if (this.#pending) {
      if (canonical(this.#pending.command) !== canonical(c))
        throw new ContinuityError(
          "WRITE_PENDING",
          "Resolve pending transaction before another write",
          this.pendingTicket,
        );
      return this.#reconcile(this.#pending);
    }
    this.assertActive();
    const signal = AbortSignal.timeout(this.#policy.timeoutMs);
    const h = await this.#bounded(() => this.#head(c), signal);
    this.assertActive();
    if (
      c.operation === "create" &&
      h.exists &&
      h.manifestDigest === checkpoint.manifestDigest &&
      h.version === "1" &&
      h.capsuleDigest === checkpoint.capsuleDigest
    )
      return {
        status: "confirmed",
        checkpoint,
        proof:
          this.trustMode === "local-model"
            ? { kind: "local-model" }
            : { kind: "finalized-state" },
        currentHead: h,
        current: true,
      };
    if (
      c.operation === "create" &&
      this.#created &&
      this.#created.checkpoint.capsuleDigest === checkpoint.capsuleDigest &&
      this.#created.checkpoint.manifestDigest === checkpoint.manifestDigest
    )
      return {
        ...structuredClone(this.#created),
        currentHead: h,
        current: this.#current(checkpoint, h),
      };
    this.#preflight(c, h);
    if (this.#adapters.trustMode === "local-model") {
      const sig = await this.#session.signDigest(
        fromHex(hashMessage(registrySigningMessage(this.#policy, c))),
      );
      this.assertActive();
      const committed = await this.#adapters.localWriter.executeLocal(
        c,
        hex(new Uint8Array([...sig.compact, 27 + sig.recovery])),
      );
      validateHead(committed, this.#policy, this.#now());
      // Local transport success still needs an exact committed identity.
      if (
        !committed.exists ||
        committed.manifestDigest !== checkpoint.manifestDigest ||
        committed.version !== checkpoint.version ||
        committed.capsuleDigest !== checkpoint.capsuleDigest
      )
        invalid();
      const currentHead = await this.#head(c);
      const current = this.#current(checkpoint, currentHead);
      const outcome = {
        status: "confirmed" as const,
        checkpoint,
        proof: { kind: "local-model" as const },
        currentHead,
        current,
      };
      if (c.operation === "create") this.#created = structuredClone(outcome);
      return outcome;
    }
    const transport = this.#adapters.transactions,
      cap = this.#limits!,
      intent = this.#intent(c);
    const stage = async <T>(fn: () => Promise<T>): Promise<T> => {
      this.assertActive();
      const out = await this.#bounded(fn, signal);
      this.assertActive();
      return out;
    };
    const nonceViews = await stage(() =>
      Promise.all([
        transport.pendingNonce(0, this.owner, signal),
        transport.pendingNonce(1, this.owner, signal),
      ]),
    );
    const n = rpcQuantity(nonceViews[0]);
    if (
      n !== rpcQuantity(nonceViews[1]) ||
      n > BigInt(Number.MAX_SAFE_INTEGER) ||
      (this.#nextNonce !== undefined && n !== BigInt(this.#nextNonce))
    )
      invalid("Pending nonce quorum mismatch");
    const estimates = await stage(() =>
      Promise.all(
        ([0, 1] as const).map((provider) =>
          transport.estimateGas(
            provider,
            {
              from: this.owner,
              to: intent.to,
              data: intent.data,
              value: "0x0",
              gas: `0x${cap.maxGas.toString(16)}`,
            },
            signal,
          ),
        ),
      ),
    );
    const parsedEstimates = estimates.map(rpcQuantity);
    const estimate =
      parsedEstimates[0]! > parsedEstimates[1]!
        ? parsedEstimates[0]!
        : parsedEstimates[1]!;
    const gas = (estimate * 120n + 99n) / 100n;
    const fees = await stage(() =>
      Promise.all(
        ([0, 1] as const).map((provider) => transport.fees(provider, signal)),
      ),
    );
    const parsedFees = fees.map((f) => {
      record(f, ["maxFeePerGas", "maxPriorityFeePerGas"]);
      const max = rpcQuantity(f.maxFeePerGas),
        priority = rpcQuantity(f.maxPriorityFeePerGas);
      if (
        max < 1n ||
        priority > max ||
        max > cap.maxFeePerGas ||
        priority > cap.maxPriorityFeePerGas
      )
        throw new ContinuityError("SESSION_LIMIT_EXCEEDED");
      return { max, priority };
    });
    const maxFeePerGas =
      parsedFees[0]!.max > parsedFees[1]!.max
        ? parsedFees[0]!.max
        : parsedFees[1]!.max;
    const maxPriorityFeePerGas =
      parsedFees[0]!.priority > parsedFees[1]!.priority
        ? parsedFees[0]!.priority
        : parsedFees[1]!.priority;
    const reservation = gas * maxFeePerGas;
    if (
      gas < 1n ||
      gas > cap.maxGas ||
      maxFeePerGas < 1n ||
      maxFeePerGas > cap.maxFeePerGas ||
      maxPriorityFeePerGas > cap.maxPriorityFeePerGas ||
      maxPriorityFeePerGas > maxFeePerGas ||
      this.#count >= cap.maxTransactions ||
      this.#reserved + reservation > cap.maxTotalFeeWei
    )
      throw new ContinuityError("SESSION_LIMIT_EXCEEDED");
    const envelope: TransactionEnvelope = Object.freeze({
      type: "eip1559",
      chainId: 10143,
      nonce: Number(n),
      to: intent.to,
      value: 0n,
      data: intent.data,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    this.assertActive();
    this.#command(c);
    ++this.#count;
    this.#reserved += reservation;
    let raw: Hex | undefined;
    try {
      raw = await this.#account.signTransaction(envelope);
      this.assertActive();
      await this.#signed(raw, envelope, this.owner);
      this.assertActive();
      const ticket: WriteTicket = {
        format: "continuity-write-ticket/v1",
        policyFingerprint: canonical(this.#policy),
        command: structuredClone(c),
        checkpoint,
        transactionHash: keccak256(raw),
        envelope: envelopeTicket(envelope),
      };
      // Preserve uncertainty before entering the transport. No subsequent path re-signs.
      this.#pending = structuredClone(ticket);
      this.assertActive();
      try {
        const returned = await this.#bounded(
          () => transport.broadcast(raw!, signal),
          signal,
        );
        if (returned !== ticket.transactionHash)
          invalid("Broadcast hash mismatch; submission uncertain");
      } catch {
        return { status: "unresolved", ticket: structuredClone(ticket) };
      }
      raw = undefined;
      return await this.#reconcile(ticket, signal);
    } finally {
      raw = undefined;
    }
  }
  async #bounded<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          abort = () =>
            reject(
              new ContinuityError(
                "FRESHNESS_UNAVAILABLE",
                "Operation deadline",
              ),
            );
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
  async #signed(raw: Hex, e: TransactionEnvelope, owner: Hex) {
    if (!raw.startsWith("0x02"))
      invalid("Only ordinary EIP-1559 transactions allowed");
    const serialized = raw as `0x02${string}`;
    const parsed = parseTransaction(serialized);
    if (
      parsed.type !== "eip1559" ||
      parsed.chainId !== e.chainId ||
      parsed.nonce !== e.nonce ||
      parsed.to?.toLowerCase() !== e.to ||
      (parsed.value ?? 0n) !== e.value ||
      parsed.data !== e.data ||
      parsed.gas !== e.gas ||
      parsed.maxFeePerGas !== e.maxFeePerGas ||
      parsed.maxPriorityFeePerGas !== e.maxPriorityFeePerGas ||
      (parsed.accessList?.length ?? 0) !== 0 ||
      (
        await recoverTransactionAddress({ serializedTransaction: serialized })
      ).toLowerCase() !== owner
    )
      invalid("Signed transaction outside frozen envelope");
  }
  #current(c: CheckpointIdentity, h: Head): boolean {
    if (
      !h.exists ||
      h.manifestDigest !== c.manifestDigest ||
      BigInt(h.version) < BigInt(c.version) ||
      (h.version === c.version && h.capsuleDigest !== c.capsuleDigest)
    )
      invalid("Committed state inconsistent with current head");
    return h.version === c.version;
  }
  reconcile(input: WriteTicket): Promise<WriteOutcome> {
    const ticket = structuredClone(input);
    return this.#serial(() => this.#reconcile(ticket));
  }
  async #reconcile(
    ticket: WriteTicket,
    operationSignal?: AbortSignal,
  ): Promise<WriteOutcome> {
    if (
      this.#policy.trustMode !== "trusted-rpc-quorum" ||
      this.#adapters.trustMode !== "trusted-rpc-quorum"
    )
      throw new ContinuityError("POLICY_INVALID");
    record(ticket, [
      "format",
      "policyFingerprint",
      "command",
      "checkpoint",
      "transactionHash",
      "envelope",
    ]);
    const checkpoint = this.#command(ticket.command, true),
      envelope = ticketEnvelope(ticket.envelope),
      intent = this.#intent(ticket.command);
    hex32(ticket.transactionHash);
    if (
      ticket.format !== "continuity-write-ticket/v1" ||
      ticket.policyFingerprint !== canonical(this.#policy) ||
      canonical(checkpoint) !== canonical(ticket.checkpoint) ||
      envelope.to !== intent.to ||
      envelope.data !== intent.data
    )
      invalid("Ticket policy or intent mismatch");
    if (this.#pending && canonical(ticket) !== canonical(this.#pending))
      throw new ContinuityError("WRITE_PENDING");
    // A restored ticket grants read-only attribution, and blocks new signing until resolved.
    this.#pending = structuredClone(ticket);
    const t = this.#adapters.transactions,
      signal = operationSignal ?? AbortSignal.timeout(this.#policy.timeoutMs);
    const call = <T>(fn: () => Promise<T>) => this.#bounded(fn, signal);
    const receipts = await call(() =>
      Promise.all([
        t.receipt(0, ticket.transactionHash, signal),
        t.receipt(1, ticket.transactionHash, signal),
      ]),
    );
    if (receipts[0] === null && receipts[1] === null) {
      const h = await call(() => this.#head(ticket.command));
      if (h.exists && h.manifestDigest !== checkpoint.manifestDigest)
        throw new ContinuityError(
          "ENROLLMENT_CONFLICT",
          "Immutable manifest conflict",
          this.pendingTicket,
        );
      if (h.exists && h.version === checkpoint.version) {
        if (h.capsuleDigest !== checkpoint.capsuleDigest)
          throw new ContinuityError(
            "WRITE_CONFLICT",
            "Conflicting checkpoint",
            this.pendingTicket,
          );
        return {
          status: "confirmed",
          checkpoint,
          proof: { kind: "finalized-state" },
          currentHead: h,
          current: true,
          unresolvedTicket: structuredClone(ticket),
        };
      }
      return { status: "unresolved", ticket: structuredClone(ticket) };
    }
    if (
      canonical(receipts[0]) !== canonical(receipts[1]) ||
      receipts[0] === null
    )
      invalid("Receipt quorum disagreement");
    const r = object(receipts[0]);
    const txs = await call(() =>
      Promise.all([
        t.transaction(0, ticket.transactionHash, signal),
        t.transaction(1, ticket.transactionHash, signal),
      ]),
    );
    if (canonical(txs[0]) !== canonical(txs[1]))
      invalid("Transaction quorum disagreement");
    const tx = object(txs[0]);
    if (
      tx.hash !== ticket.transactionHash ||
      tx.from !== this.owner ||
      tx.to !== envelope.to ||
      tx.input !== envelope.data ||
      rpcQuantity(tx.type) !== 2n ||
      rpcQuantity(tx.chainId) !== 10143n ||
      rpcQuantity(tx.nonce) !== BigInt(envelope.nonce) ||
      rpcQuantity(tx.value) !== 0n ||
      rpcQuantity(tx.gas) !== envelope.gas ||
      rpcQuantity(tx.maxFeePerGas) !== envelope.maxFeePerGas ||
      rpcQuantity(tx.maxPriorityFeePerGas) !== envelope.maxPriorityFeePerGas ||
      (tx.accessList !== undefined && canonical(tx.accessList) !== "[]") ||
      tx.authorizationList !== undefined ||
      tx.blobVersionedHashes !== undefined
    )
      invalid("Retrieved transaction outside intent");
    if (
      typeof tx.r !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(tx.r) ||
      typeof tx.s !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(tx.s)
    )
      invalid("Missing transaction signature");
    const parity = rpcQuantity(tx.yParity ?? tx.v);
    if (parity > 1n) invalid();
    const raw = serializeTransaction(envelope, {
      r: tx.r as Hex,
      s: tx.s as Hex,
      yParity: Number(parity),
    });
    if (keccak256(raw) !== ticket.transactionHash)
      invalid("Transaction hash does not match signed envelope");
    await this.#signed(raw, envelope, this.owner);
    const blockNumber = rpcQuantity(r.blockNumber),
      index = rpcQuantity(r.transactionIndex);
    hex32(r.blockHash);
    if (
      r.transactionHash !== ticket.transactionHash ||
      tx.blockHash !== r.blockHash ||
      tx.blockNumber !== r.blockNumber ||
      tx.transactionIndex !== r.transactionIndex ||
      r.from !== this.owner ||
      r.to !== envelope.to ||
      rpcQuantity(r.type) !== 2n
    )
      invalid("Receipt identity mismatch");
    const h = await call(() => this.#head(ticket.command));
    if (
      h.evidence.trustMode !== "trusted-rpc-quorum" ||
      blockNumber > BigInt(h.evidence.blockNumber) ||
      (blockNumber === BigInt(h.evidence.blockNumber) &&
        r.blockHash !== h.evidence.blockHash)
    )
      invalid("Receipt is not finalized");
    await call(() =>
      this.#historical(
        this.#policy as MonadRecoveryPolicy,
        t,
        blockNumber,
        r.blockHash as Hex,
        BigInt(
          h.evidence.trustMode === "trusted-rpc-quorum"
            ? h.evidence.blockTimestamp
            : "0",
        ),
        blockNumber === BigInt(h.evidence.blockNumber),
        signal,
      ),
    );
    const gasUsed = rpcQuantity(r.gasUsed),
      price = rpcQuantity(r.effectiveGasPrice);
    if (gasUsed > envelope.gas || price > envelope.maxFeePerGas) invalid();
    const status = rpcQuantity(r.status);
    if (status === 0n) {
      this.#pending = undefined;
      this.#nextNonce = envelope.nonce + 1;
      throw new ContinuityError("TRANSACTION_REVERTED");
    }
    if (status !== 1n || !Array.isArray(r.logs))
      invalid("Missing successful receipt events");
    const relevant = r.logs.filter((log) => {
      const l = object(log);
      if (!Array.isArray(l.topics)) invalid();
      // Any registry event from this contract must be the one expected transition.
      return l.address === envelope.to;
    });
    if (relevant.length !== 1) invalid("Expected exactly one registry event");
    const l = object(relevant[0]);
    if (
      l.removed !== false ||
      l.transactionHash !== ticket.transactionHash ||
      l.blockHash !== r.blockHash ||
      l.blockNumber !== r.blockNumber ||
      l.transactionIndex !== r.transactionIndex
    )
      invalid("Event identity mismatch");
    rpcQuantity(l.logIndex);
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: registryAbi,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
        strict: true,
      });
    } catch {
      invalid("Malformed registry event");
    }
    const event = decoded.args;
    if (
      decoded.eventName !==
        (ticket.command.operation === "create"
          ? "StreamCreated"
          : "HeadCommitted") ||
      event.owner.toLowerCase() !== checkpoint.owner ||
      event.streamId !== checkpoint.streamId ||
      String(event.version) !== checkpoint.version ||
      event.capsuleDigest !== checkpoint.capsuleDigest ||
      (decoded.eventName === "StreamCreated" &&
        decoded.args.manifestDigest !== checkpoint.manifestDigest)
    )
      invalid("Registry event does not match checkpoint");
    const expectedTopics =
      ticket.command.operation === "create"
        ? encodeEventTopics({
            abi: registryAbi,
            eventName: "StreamCreated",
            args: { owner: checkpoint.owner, streamId: checkpoint.streamId },
          })
        : encodeEventTopics({
            abi: registryAbi,
            eventName: "HeadCommitted",
            args: { owner: checkpoint.owner, streamId: checkpoint.streamId },
          });
    const expectedData =
      ticket.command.operation === "create"
        ? encodeAbiParameters(
            [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }],
            [
              checkpoint.manifestDigest,
              BigInt(checkpoint.version),
              checkpoint.capsuleDigest,
            ],
          )
        : encodeAbiParameters(
            [{ type: "uint64" }, { type: "bytes32" }],
            [BigInt(checkpoint.version), checkpoint.capsuleDigest],
          );
    if (
      canonical(l.topics) !== canonical(expectedTopics) ||
      l.data !== expectedData
    )
      invalid("Noncanonical registry event");
    const currentHead = await call(() => this.#head(ticket.command)),
      current = this.#current(checkpoint, currentHead);
    const receipt: VerifiedReceipt = {
      transactionHash: ticket.transactionHash,
      blockNumber: String(blockNumber),
      blockHash: r.blockHash,
      transactionIndex: String(index),
      status: "success",
      event: structuredClone(checkpoint),
      gasLimit: String(envelope.gas),
      maxFeePerGas: String(envelope.maxFeePerGas),
      maximumFeeWei: String(envelope.gas * envelope.maxFeePerGas),
      fullGasFeeWei: String(envelope.gas * price),
      gasUsed: String(gasUsed),
      effectiveGasPrice: String(price),
      finalized: h.evidence,
    };
    this.#pending = undefined;
    this.#nextNonce = envelope.nonce + 1;
    const outcome = {
      status: "confirmed" as const,
      checkpoint,
      proof: { kind: "finalized-receipt" as const, receipt },
      currentHead,
      current,
    };
    if (ticket.command.operation === "create")
      this.#created = structuredClone(outcome);
    return outcome;
  }
  async #historical(
    p: MonadRecoveryPolicy,
    t: TransactionTransport,
    n: bigint,
    hash: Hex,
    finalTimestamp: bigint,
    sameHeight: boolean,
    signal: AbortSignal,
  ) {
    const tag = n.toString();
    const observations = await Promise.all(
      ([0, 1] as const).map(async (provider) => {
        const a = object(await t.block(provider, tag, signal));
        const code = await t.code(provider, tag, signal);
        const b = object(await t.block(provider, tag, signal));
        if (
          a.hash !== hash ||
          b.hash !== hash ||
          rpcQuantity(a.number) !== n ||
          rpcQuantity(b.number) !== n ||
          rpcQuantity(a.timestamp) !== rpcQuantity(b.timestamp) ||
          rpcQuantity(a.timestamp) > finalTimestamp ||
          (sameHeight && rpcQuantity(a.timestamp) !== finalTimestamp) ||
          typeof code !== "string" ||
          !/^0x(?:[0-9a-f]{2})+$/.test(code) ||
          keccak256(code as Hex) !== p.registryCodeHash
        )
          invalid("Historical block or runtime identity mismatch");
        return { hash: a.hash, timestamp: a.timestamp };
      }),
    );
    if (canonical(observations[0]) !== canonical(observations[1]))
      invalid("Historical block quorum disagreement");
  }
}
