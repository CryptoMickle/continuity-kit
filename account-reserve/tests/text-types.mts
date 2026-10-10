// Compile with TypeScript's strict, noEmit, bundler-resolution settings.
// These are API-shape checks; this file is never executed as a native ceremony.
import { createTextReserveCredential, selectTextReserveCredential, prepareTextReserve } from '@continuitykit/account-reserve/text-reserve';
import type { TextReserveConfig, TextReserveCredential, TextReserveStore } from '@continuitykit/account-reserve/text-reserve';
import type { TextReserveReceiver, TextSetupState } from '@continuitykit/account-reserve/text-browser';

declare const config: TextReserveConfig;
declare const store: TextReserveStore;
declare const receiver: TextReserveReceiver;
declare const credential: TextReserveCredential;

const selected: Promise<Readonly<TextReserveCredential>> = selectTextReserveCredential({ config });
const created: Promise<Readonly<TextReserveCredential>> = createTextReserveCredential({ config, user: { name: 'Example', displayName: 'Example' } });
void selected; void created;
void prepareTextReserve({ config, recoveryCredential: credential, text: 'Example', store });
void receiver.prepare({ store, credentialMode: 'existing' });
void receiver.prepare({ store, user: { name: 'Example', displayName: 'Example' } });
void receiver.prepare({ store, credentialMode: 'create', user: { name: 'Example', displayName: 'Example' } });
const state: TextSetupState = { state: 'selecting-credential' };
void state;

// @ts-expect-error New credential creation still requires user labels.
void createTextReserveCredential({ config });
// @ts-expect-error Default mode is creation, which still requires user labels.
void receiver.prepare({ store });
// @ts-expect-error Explicit creation still requires user labels.
void receiver.prepare({ store, credentialMode: 'create' });
// @ts-expect-error No automatic mode or fallback is exposed.
void receiver.prepare({ store, credentialMode: 'automatic' });
// @ts-expect-error Metadata copies cannot claim the opaque handle type.
void prepareTextReserve({ config, recoveryCredential: { credentialId: 'example', close() {} }, text: 'Example', store });
