import type { WebAuthnClient } from '@category-labs/mera';
import type { TextReserveConfig, TextReserveReady, TextReserveStore, TextReserveReplicasReady, TextReserveWriteReplica } from './text-reserve.js';

export type TextBrowserConfig = TextReserveConfig;
export type TextBrowserReady = TextReserveReady;
export type TextSetupState = Readonly<{
  state: 'available' | 'waiting' | 'creating-credential' | 'selecting-credential' | 'preparing' | 'ready' | 'failed';
  code?: string;
}>;
export interface TextSetupController {
  readonly completion: Promise<Readonly<TextBrowserReady>>;
  /** Cannot undo a credential or an already dispatched write. */
  cancel(): void;
}
export declare function startTextReserveSetup(options: {
  config: TextBrowserConfig;
  originalOrigin: string;
  recoveryUrl: string;
  text: string;
  signal?: AbortSignal;
  onState?: (state: TextSetupState) => void;
  /** Integer 1000–300000 ms, default five minutes. */
  timeoutMs?: number;
  window?: Window;
}): TextSetupController;
export interface TextReserveReceiver {
  readonly isEnrollment: boolean;
  /** Explicit user action; exactly one attempt per receiver. Existing mode
   * authenticates a chosen passkey and never falls back to creation. */
  prepare(options: {
    store: TextReserveStore;
    webAuthnClient?: WebAuthnClient;
    signal?: AbortSignal;
  } & ({ credentialMode?: 'create'; user: { name: string; displayName: string } }
    | { credentialMode: 'existing'; user?: { name: string; displayName: string } })): Promise<Readonly<TextBrowserReady>>;
  dispose(): void;
}
export declare function createTextReserveReceiver(options: {
  config: TextBrowserConfig;
  originalOrigin: string;
  onState?: (state: TextSetupState) => void;
  timeoutMs?: number;
  window?: Window;
}): TextReserveReceiver;

export interface TextReplicaSetupController {
  readonly completion: Promise<Readonly<TextReserveReplicasReady>>;
  /** Cancels this attempt; dispatched writes may still persist. No retry. */
  cancel(): void;
}
/** Additive multi-store handoff. Call synchronously from A's deliberate click.
 * Both pages must configure the same ordered list of 2–3 distinct public IDs.
 * A only becomes ready when every intended copy is independently verified.
 * Failures expose sanitized .replicas diagnostics and .recordMayExist; never
 * interpret a rejected/unknown preparation as permission to create a new key.
 */
export declare function startTextReserveReplicaSetup(options: {
  config: TextBrowserConfig;
  replicaIds: readonly string[];
  originalOrigin: string;
  recoveryUrl: string;
  text: string;
  signal?: AbortSignal;
  onState?: (state: TextSetupState) => void;
  timeoutMs?: number;
  window?: Window;
}): TextReplicaSetupController;
export interface TextReserveReplicaReceiver {
  readonly isEnrollment: boolean;
  /** Exactly one credential attempt. Store methods and ordered IDs are copied
   * and checked before a prompt. All copies use one immutable encrypted record,
   * and every copy must pass readback and independent discovery before ready.
   * This does not prove separate infrastructure or change the recovery origin.
   */
  prepare(options: {
    replicas: readonly TextReserveWriteReplica[];
    store?: never;
    webAuthnClient?: WebAuthnClient;
    signal?: AbortSignal;
  } & ({ credentialMode?: 'create'; user: { name: string; displayName: string } }
    | { credentialMode: 'existing'; user?: { name: string; displayName: string } })): Promise<Readonly<TextReserveReplicasReady>>;
  dispose(): void;
}
export declare function createTextReserveReplicaReceiver(options: {
  config: TextBrowserConfig;
  replicaIds: readonly string[];
  originalOrigin: string;
  onState?: (state: TextSetupState) => void;
  timeoutMs?: number;
  window?: Window;
}): TextReserveReplicaReceiver;
