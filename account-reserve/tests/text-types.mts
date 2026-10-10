// Compile with TypeScript's strict, noEmit, bundler-resolution settings.
// These are API-shape checks; this file is never executed as a native ceremony.
import { createTextReserveCredential, selectTextReserveCredential, prepareTextReserve, recoverTextReserves, recoverTextReserveFromReplicas, prepareTextReserveReplicas } from '@continuitykit/account-reserve/text-reserve';
import type { TextReserveConfig, TextReserveCredential, TextReserveStore, TextReserveReader, TextReserveCollectionResult } from '@continuitykit/account-reserve/text-reserve';
import type { TextReserveReceiver, TextSetupState } from '@continuitykit/account-reserve/text-browser';

declare const config: TextReserveConfig;
declare const store: TextReserveStore;
declare const receiver: TextReserveReceiver;
declare const credential: TextReserveCredential;
declare const reader: TextReserveReader;

const selected: Promise<Readonly<TextReserveCredential>> = selectTextReserveCredential({ config });
const created: Promise<Readonly<TextReserveCredential>> = createTextReserveCredential({ config, user: { name: 'Example', displayName: 'Example' } });
void selected; void created;
void prepareTextReserve({ config, recoveryCredential: credential, text: 'Example', store });
void receiver.prepare({ store, credentialMode: 'existing' });
void receiver.prepare({ store, user: { name: 'Example', displayName: 'Example' } });
void receiver.prepare({ store, credentialMode: 'create', user: { name: 'Example', displayName: 'Example' } });
const state: TextSetupState = { state: 'selecting-credential' };
void state;
const collection: Promise<readonly TextReserveCollectionResult[]> = recoverTextReserves({ configs: [config] as const, store: reader });
void collection.then(results => {
  // @ts-expect-error The collection is readonly.
  results.push({ appId: 'example', status: 'missing', code: 'RESERVE_MISSING' });
  for (const result of results) {
    // @ts-expect-error An individual result is readonly.
    result.appId = 'mutated';
    if (result.status === 'recovered') {
      const text: string = result.reserve.text;
      void text;
      // @ts-expect-error No live session is returned.
      result.reserve.session;
    } else {
      const code: string = result.code;
      void code;
      // @ts-expect-error Failed results have no reserve or locator.
      result.reserve;
      // @ts-expect-error Failed results have no credential identity.
      result.credentialId;
    }
  }
});

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
// @ts-expect-error A collection requires a list of configs, not a single config.
void recoverTextReserves({ config, store: reader });
// @ts-expect-error Caller-supplied credential metadata is not a recovery option.
void recoverTextReserves({ configs: [config], store: reader, credentialId: 'example' });
// @ts-expect-error No key creation or automatic fallback is exposed.
void recoverTextReserves({ configs: [config], store: reader, credentialMode: 'create' });

void recoverTextReserveFromReplicas({ config, replicas: [{ id: 'alpha', store: reader }, { id: 'beta', store: reader }] }).then(result => {
  const text: string = result.reserve.text;
  void text;
  // @ts-expect-error No signer/session exists in replica recovery.
  result.reserve.session;
  // @ts-expect-error Replica diagnostics never expose plaintext.
  result.replicas[0].text;
  // @ts-expect-error Replica diagnostics are readonly.
  result.replicas[0].status = 'verified';
});
void prepareTextReserveReplicas({ config, recoveryCredential: credential, text: 'Example', replicas: [{ id: 'alpha', store }, { id: 'beta', store }] });
// @ts-expect-error Replica enrollment needs immutable-write stores.
void prepareTextReserveReplicas({ config, recoveryCredential: credential, text: 'Example', replicas: [{ id: 'alpha', store: reader }, { id: 'beta', store: reader }] });
// @ts-expect-error Ordinary metadata cannot substitute for a private one-use handle.
void prepareTextReserveReplicas({ config, recoveryCredential: { credentialId: 'copied', close() {} }, text: 'Example', replicas: [{ id: 'alpha', store }, { id: 'beta', store }] });
