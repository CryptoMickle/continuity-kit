import type { WebAuthnClient } from '@category-labs/mera';
import type { ReserveConfig, ReserveStore } from './index.js';
import type { WorkReserveReady, ContinuityWork } from './work-reserve.js';

export type ReserveSetupState = Readonly<{
  state: 'available' | 'waiting' | 'creating-credential' | 'preparing' | 'ready' | 'failed';
  code?: string;
}>;
export interface ReserveSetupController {
  readonly completion: Promise<Readonly<WorkReserveReady>>;
  /** Cancels completion; cannot undo a credential or store write already made. */
  cancel(): void;
}
export declare function startWorkReserveSetup(options: {
  config: ReserveConfig;
  recoveryUrl: string;
  privateKey: Uint8Array;
  work: ContinuityWork;
  expectedOwner: `0x${string}`;
  signal?: AbortSignal;
  onState?: (state: ReserveSetupState) => void;
  /** Integer 1000–300000ms, default five minutes. */
  timeoutMs?: number;
  /** Browser window injection for an explicit test host. */
  window?: Window;
}): ReserveSetupController;
export interface ReserveReceiver {
  readonly isEnrollment: boolean;
  /** Call only from a deliberate user action. Exactly one attempt per receiver. */
  prepare(options: {
    store: ReserveStore;
    user: { name: string; displayName: string };
    webAuthnClient?: WebAuthnClient;
    signal?: AbortSignal;
  }): Promise<Readonly<WorkReserveReady>>;
  dispose(): void;
}
export declare function createWorkReserveReceiver(options: {
  config: ReserveConfig;
  originalOrigin: string;
  onState?: (state: ReserveSetupState) => void;
  timeoutMs?: number;
  window?: Window;
}): ReserveReceiver;
