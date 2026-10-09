import type { WebAuthnClient } from '@category-labs/mera';
import type { TextReserveConfig, TextReserveReady, TextReserveStore } from './text-reserve.js';

export type TextBrowserConfig = TextReserveConfig;
export type TextBrowserReady = TextReserveReady;
export type TextSetupState = Readonly<{
  state: 'available' | 'waiting' | 'creating-credential' | 'preparing' | 'ready' | 'failed';
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
  /** Explicit user action; exactly one attempt per receiver. */
  prepare(options: {
    store: TextReserveStore;
    user: { name: string; displayName: string };
    webAuthnClient?: WebAuthnClient;
    signal?: AbortSignal;
  }): Promise<Readonly<TextBrowserReady>>;
  dispose(): void;
}
export declare function createTextReserveReceiver(options: {
  config: TextBrowserConfig;
  originalOrigin: string;
  onState?: (state: TextSetupState) => void;
  timeoutMs?: number;
  window?: Window;
}): TextReserveReceiver;
