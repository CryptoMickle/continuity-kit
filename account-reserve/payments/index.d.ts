import type { Address, Hash, TransactionReceipt } from 'viem';
import type { RecoveredReserve } from '../sdk/index.js';

/** An explicitly approved funded obligation. No payment discovery or scheduling. */
export interface PaymentIntent {
  readonly rightId: bigint;
  /** Positive amount in wei, at most one test-MON. */
  readonly amount: bigint;
  /** Exact beneficiary transaction nonce. */
  readonly nonce: number;
}

/** Experimental policy for the fixed pair of Monad testnet RPCs.
 * The caller supplies a trusted contract/runtime, issuer and beneficiary.
 * Contains 1–8 ordered rights with increasing IDs and consecutive nonces.
 * Runtime validation captures the policy; a JSON profile must first convert
 * decimal rightId/amount strings to bigint. This is not a mainnet adapter. */
export interface PaymentProfile {
  readonly chainId: 10143;
  readonly address: Address;
  readonly owner: Address;
  readonly issuer: Address;
  readonly expectedRuntimeCodeHash: Hash;
  /** Canonical ISO timestamp. Expiry blocks new signing, not receipt checks. */
  readonly expiresAt: string;
  readonly claims: readonly PaymentIntent[];
}

/** Compatible with the account SDK's RecoveredReserve. The recovered signer
 * has full account authority; this adapter deliberately exposes fixed claims. */
export type PaymentRecoveredAccount = Pick<RecoveredReserve, 'owner' | 'account' | 'close'>;

/** Defaults to this origin's localStorage. Only public intent/hash metadata is
 * persisted, never keys or signed bytes. Do not clear it to retry an attempt. */
export interface PaymentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PaymentLock {
  readonly name: string;
  readonly mode: 'exclusive' | 'shared';
}

/** Defaults to navigator.locks. Custom implementations must provide actual
 * exclusive serialization for cooperating clients of the same origin/account.
 * This is not a cross-device lock or protection against hostile storage. */
export interface PaymentLocks {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: (lock: PaymentLock | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface PaymentPersistence {
  readonly storage?: PaymentStorage;
  readonly locks?: PaymentLocks;
}

export interface PaymentClientOptions extends PaymentPersistence {
  readonly profile: PaymentProfile;
  readonly recovered: PaymentRecoveredAccount;
}

export interface PaymentReaderOptions extends PaymentPersistence {
  readonly profile: PaymentProfile;
}

/** A pinned transaction hash. A missing receipt means confirmation is pending;
 * it is not permission to sign or send again. A returned receipt has passed the
 * adapter's two-RPC finalized receipt, signed-envelope, event and state checks. */
export interface PaymentResult {
  readonly hash: Hash;
  readonly receipt?: TransactionReceipt;
}

export interface PaymentExecutor {
  /** Deliberate signing action for this one approved intent. It first persists
   * an attempt; ambiguous or failed attempts are never automatically resent. */
  claim(): Promise<PaymentResult>;
  /** Reconcile only. Requires an existing journal entry; never signs or sends. */
  check(): Promise<PaymentResult>;
  /** Stop this executor's later actions. Does not close the recovered signer
   * or retract a broadcast already handed to the transport. */
  close(): void;
  readonly hash: Hash | undefined;
  /** Local attempt state, not an independent chain-finality claim. */
  readonly deliveryStatus: 'not-attempted' | 'attempted' | 'unknown' | 'confirmed';
}

export interface PaymentClient {
  /** Select an exact right already listed in the captured profile. */
  forRight(rightId: bigint): PaymentExecutor;
  /** Closes all its executors and the supplied recovered account. The caller
   * must invoke this in finally/pagehide/its session-expiry handling. Neither
   * successful claims nor raw executor.close() automatically close the signer. */
  close(): void;
}

export interface PaymentReader {
  /** Needs no account/passkey. Checks a locally recorded hash and may persist
   * its verified confirmation. A reserved attempt without a hash fails closed. */
  check(rightId: bigint): Promise<PaymentResult>;
}

/** One options argument only; no RPC URL or transport override. Importing and
 * constructing the adapter performs no network or credential operation. */
export declare function createTestnetPaymentClient(options: PaymentClientOptions): PaymentClient;
export declare function createTestnetPaymentReader(options: PaymentReaderOptions): PaymentReader;

export interface PaymentVerifierOptions {
  readonly profile: PaymentProfile;
}

export interface PaymentVerificationInput {
  readonly rightId: bigint;
  /** Exact transaction hash supplied by the caller; no history discovery. */
  readonly hash: Hash;
}

export interface PaymentVerificationIdentity {
  readonly chainId: 10143;
  readonly contract: Address;
  readonly beneficiary: Address;
  readonly rightId: bigint;
  /** Approved obligation amount in wei. Reverted/pending results do not mean
   * this amount was delivered. Only paymentVerified:true establishes payment. */
  readonly amount: bigint;
  readonly hash: Hash;
  readonly readOnly: true;
}

/** Frozen scalar summary. No receipt or journal mutation is implied. RPC
 * failures and mismatches reject instead of being reported as pending. */
export type PaymentVerificationResult = PaymentVerificationIdentity & (
  | { readonly status: 'finalized'; readonly finalized: true; readonly paymentVerified: true; readonly blockNumber: bigint; readonly blockHash: Hash }
  | { readonly status: 'reverted'; readonly finalized: true; readonly paymentVerified: false; readonly blockNumber: bigint; readonly blockHash: Hash }
  | { readonly status: 'pending-or-unknown'; readonly finalized: false; readonly paymentVerified: false }
);

export interface PaymentVerifier {
  /** Exact one-argument read. Uses neither credentials, Storage nor Web Locks.
   * Validates the approved right and signed transaction using both fixed RPCs.
   * An expired profile can still verify its historical payments. Does not
   * create, clear or reconcile local attempt entries or authorize a new send. */
  check(input: PaymentVerificationInput): Promise<PaymentVerificationResult>;
}

/** Stateless experimental verifier; exact profile-only options. Construction
 * performs no network or credential operation. No RPC override is accepted. */
export declare function createTestnetPaymentVerifier(options: PaymentVerifierOptions): PaymentVerifier;

export interface PaymentAvailabilityOptions {
  readonly profile: PaymentProfile;
}
export interface PaymentAvailabilityInput {
  readonly rightId: bigint;
}
export interface PaymentAvailabilityIdentity {
  readonly chainId: 10143;
  readonly contract: Address;
  readonly beneficiary: Address;
  readonly rightId: bigint;
  /** Approved obligation; no status here establishes that it was delivered. */
  readonly amount: bigint;
  readonly readOnly: true;
  readonly paymentVerified: false;
  /** Local ISO completion time, not a chain timestamp or a validity promise. */
  readonly observedAt: string;
  /** Corroborated canonical finalized snapshot used for contract state. */
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
}
export type PaymentAvailabilityReason = 'not-issued' | 'expired' | 'nonce-mismatch' | 'insufficient-gas' | 'fee-cap-exceeded' | 'gas-limit-exceeded' | 'state-changed';
export type PaymentAvailabilityResult = PaymentAvailabilityIdentity & (
  | { readonly status: 'funded' }
  | { readonly status: 'already-collected' }
  | { readonly status: 'not-available'; readonly reason: PaymentAvailabilityReason }
);
export interface PaymentAvailability {
  /** No signer, credentials, Storage or Web Locks. A funded result observed a
   * funded finalized right plus current nonce/fee/gas preflight; it does not
   * reserve anything or authorize signing. Later signing rechecks all policy.
   * Already-collected is contract state, not a verified payment receipt, and
   * remains readable after expiry. RPC failure or disagreement rejects. */
  check(input: PaymentAvailabilityInput): Promise<PaymentAvailabilityResult>;
}
/** Exact profile-only construction; fixed RPCs, no requests until check(). */
export declare function createTestnetPaymentAvailability(options: PaymentAvailabilityOptions): PaymentAvailability;
