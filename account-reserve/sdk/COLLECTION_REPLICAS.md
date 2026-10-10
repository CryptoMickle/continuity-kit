# Recover several apps from surviving copies

Use `recoverTextReservesFromReplicas` when the same existing B passkey has already
prepared snapshots for several apps, and each app has two or three configured
encrypted storage copies. A single deliberate action can open the collection.
There is one SDK assertion request; the device may show several confirmations.

This is a read-only SDK capability. It does not enroll the apps, discover unknown
app IDs, copy existing storage, update snapshots or create a passkey. Each app
must retain the exact `appId`, recovery origin and RP used during preparation.
The current native starter still presents one app, and the hosted collection
still uses its existing single-store configuration.

For an installed, runnable local browser reference, generate the
[collection text starter](../text-starter/README.md#two-apps-one-recovery-action-two-stores)
with `--collection-replicas`. It binds two app policies to two real disposable
SQLite storage processes and presents per-app editors and copy diagnostics.
It uses a simulated credential; the native and hosted boundaries above remain.

## Connect the existing stores

Configure the app list and routes in trusted client code. Do not take either
from query parameters or a storage response. The HTTP adapter below makes only
same-origin requests; your B backend must explicitly route each replica to its
intended store. It must preserve immutable writes and separate setup permissions.
Recovery needs no upload grant.

```js
import { recoverTextReservesFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';

// These must be the exact original preparation bindings, not new names.
const recoveryOrigin = 'https://reserve.example';
const recoveryRpId = 'reserve.example';
const replicas = ['alpha', 'beta'].map(id => ({
  id,
  store: createReserveHttpStore({ basePath: `/api/replicas/${id}/reserve` }),
}));
const apps = ['my-text-editor-v1', 'my-markdown-editor-v1'].map(appId => ({
  config: { appId, recoveryOrigin, recoveryRpId },
  replicas,
}));
```

Each app can instead supply its own two or three storage adapters. IDs and adapter
objects must be distinct within that app. Sharing the same two adapters across
different app namespaces is supported. Distinct objects or names do not prove
different providers. The existing fixed-route operator gateway is one possible
backend; configuring multiple namespaces there is separate from the single-app
native starter's profile.

## Open directly from the user's action

The example assumes `openButton`, `cancelButton` and `output` are existing DOM
elements. Omit `webAuthnClient` to use native WebAuthn. Calling directly from the
click preserves the browser's user-action boundary; do not fetch configuration
or wait for another task first.

```js
let active;

function cancel() {
  const previous = active;
  active = undefined;
  previous?.abort();
  output.replaceChildren();
  openButton.disabled = false;
}

cancelButton.addEventListener('click', cancel);
window.addEventListener('pagehide', cancel);

openButton.addEventListener('click', async () => {
  if (active) return;
  const operation = new AbortController();
  active = operation;
  openButton.disabled = true;
  output.replaceChildren();
  try {
    const results = await recoverTextReservesFromReplicas({
      apps, signal: operation.signal,
    });
    if (active !== operation || operation.signal.aborted) return;
    for (const result of results) {
      const section = document.createElement('section');
      const title = document.createElement('h2');
      title.textContent = result.appId;
      section.append(title);
      const content = document.createElement('pre');
      content.textContent = result.status === 'recovered'
        ? result.reserve.text
        : `Could not open this app: ${result.status}.`;
      section.append(content);
      const copies = document.createElement('p');
      copies.textContent = result.replicas
        .map(copy => `${copy.id}: ${copy.status}`).join(' · ');
      section.append(copies);
      output.append(section);
    }
  } catch {
    if (active === operation && !operation.signal.aborted)
      output.textContent = 'Recovery did not finish. Keep your existing passkey.';
  } finally {
    if (active === operation) {
      active = undefined;
      openButton.disabled = false;
    }
  }
});
```

Render recovered content as text or pass it to your text editor. Do not interpret
it as HTML. Clear your own editor, export buffers and retained result references
when closing the view. The SDK returns ordinary plaintext strings and cannot
erase copies already retained by your application. Local edits do not update the
immutable snapshot; provide an explicit export action to keep them.

## Interpret results without guessing

Results preserve the configured app order. Every result has `appId`, `status`
and safe per-copy `replicas` diagnostics. Only `recovered` includes a `reserve`
with authenticated text. A successful app can still have unavailable or rejected
copies, so distinguish opening the document from full redundancy.

| App status | Meaning |
| --- | --- |
| `recovered` | At least one candidate authenticated and all authenticated candidates have identical complete record bytes. |
| `missing` | Every configured store reported absence for the selected credential and app. |
| `unavailable` | No valid candidate was obtained; at least one store was unavailable and no received candidate was rejected. |
| `rejected` | Received candidates failed verification with no valid survivor, or valid candidates conflict (`REPLICA_CONFLICT`). |

A conflicting app does not suppress a healthy sibling. Conflict is checked on
complete authenticated ciphertext, even when plaintext happens to be equal.
The API never votes, chooses the first HTTP success, repairs storage or guesses
which record is newer. A different valid passkey may yield missing results;
absence is not a reason to automatically create a replacement key.

Credential failure rejects the whole call. Cancellation and operation expiry
also reject without returning partial text. Input policy is captured before the
credential call: 1–8 unique app IDs sharing the exact origin/RP, each with 2–3
copies. Reads are concurrent, at most 24, individually bounded to ten seconds
inside the existing five-minute operation scope. No retry or write occurs.

One trusted B client can access all selected namespaces for the chosen passkey.
Per-app key separation does not protect against malicious code running on B.
The recovery origin, compatible passkey and one authentic copy must survive.
This API does not provide domain migration, lost-key recovery or a retention
guarantee. See [TEXT_PROTOCOL.txt](TEXT_PROTOCOL.txt) for the unchanged wire format.
