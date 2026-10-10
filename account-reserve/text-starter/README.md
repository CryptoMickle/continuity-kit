# Account-free text starter

A small editor you own, wired to the installed ContinuityKit public SDK. It prepares an encrypted, immutable text snapshot on B, reopens it after A is unavailable, and exports your continued draft. No wallet, account signing key, funds or provider account is needed.

**Local simulation only.** This server emulates the credential; it does not invoke a physical passkey. The default mode keeps its encrypted snapshot in RAM. The optional replica mode below uses two temporary SQLite databases and separate storage processes. Both modes keep the synthetic credential in the parent server's RAM; stopping that server ends recovery. Never deploy these servers or `synthetic-client.mjs`. They do not establish independent infrastructure or providers.

## Run from this generated folder

Use Node.js 24 or later.

```sh
npm ci --ignore-scripts
npm run build
npm run doctor
npm test
npm run dev
```

The lockfile pins the SDK tarball integrity and dependency versions. If packages are already cached, `npm ci --offline --ignore-scripts` works without network. A cache miss requires ordinary `npm ci --ignore-scripts`; the generator and tests never silently fall back to network.

Open `http://text-starter-primary.localhost:5973/` in your browser. Write fictional text, choose **Prepare a reserve in B**, and confirm **Prepare this snapshot** in B. Keep A open until setup succeeds. Then use B's **Make A unavailable** control and **Open B in a fresh tab**. Open the existing reserve, edit it and export `.txt` or `.json`. A really returns HTTP 503 for both its page and API while disabled.

Ports occupied? Use the same two overrides for both commands:

```sh
npm run doctor -- --primary-port=5975 --recovery-port=5976
npm run dev -- --primary-port=5975 --recovery-port=5976
```

`npm run doctor -- --live` checks a running starter. Restore A in B first if you deliberately made A unavailable. A stopped local server cannot be recovered: this is intentionally disposable.

## Optional two-store browser example

Generate a separate empty folder with `npm run create:text-starter -- /absolute/empty/replica-demo --replicas` from the SDK repository. Run the same install/build/doctor/test/dev commands above in that folder. The generated package selects the replica server, doctor and smoke proof; it does not silently run the default single-store test.

Open `http://text-starter-primary.localhost:6073/`. B is `http://text-starter-reserve.localhost:6074/`. Prepare a fictional draft in B and wait for **both** copies to verify. Then:

1. Choose **Close this copy** so storage controls cannot replace visible edits.
2. Choose **Make A unavailable**, expand **Test storage failures**, and **Stop Alpha**.
3. Open B in a fresh tab and choose **Open my existing reserve**. Alpha is unavailable; Beta must pass client verification before any text opens.
4. To test altered data, close the copy, corrupt the stopped Alpha copy and start Alpha again. Reopening must reject Alpha and use verified Beta.
5. With the copy closed, stop Beta. Reopening now fails without displaying text. Start Beta again to recover the still-intact snapshot. No automatic repair occurs.

The failure controls affect only this run's disposable files. SQLite writes survive a storage child process stopping/restarting. Stopping the parent deletes the temporary files and clears its simulated credential. B's frontend, gateway, authenticator and machine remain shared dependencies. This is a browser integration example, not separate-provider or disaster-recovery proof.

The additive `/text-browser` helpers are `startTextReserveReplicaSetup` and `createTextReserveReplicaReceiver`. Both pages configure the same ordered `replicaIds`; B binds a separate single-use HTTP store capability to each ID. The handoff rejects a mismatched app or replica policy before a credential ceremony and only tells A “ready” after every intended copy passes independent verification. Fresh recovery calls `recoverTextReserveFromReplicas` without any upload capability.

The replica `npm test` uses the installed public SDK, real child processes and separate SQLite files. Four fresh recovery processes receive only B's address and an export directory. They prove exact TXT/JSON exports with both copies, a stopped store, and an altered copy; when no valid copy remains, nothing is exported. Recovery transport rejects write attempts. This is automated synthetic evidence; browser tests and physical passkey tests have separate scopes.

## Connect your own editor

`adapter.mjs` is the editor boundary:

```js
const editor = {
  getText: () => myEditor.getValue(),
  applyText: text => myEditor.setValue(text),
};
// A: captureText(editor) goes into startTextReserveSetup(...).
// B: restoreText(recovered.text, editor) opens the authenticated snapshot.
// Both: exportText(editor, 'txt') returns the current local draft.
```

`main.mjs` shows the complete integration. Call `startTextReserveSetup` directly inside A's click handler so its B popup is allowed. On B, `createTextReserveReceiver().prepare(...)` handles the explicit setup. Fresh B uses `recoverTextReserve(...)` and a read-only HTTP store with no enrollment capability. Imports use only the installed `/text-browser`, `/text-reserve` and `/http-store` entrypoints.

Text is limited to 16 KiB raw UTF-8. Unedited recovered text, including a leading BOM and CRLF, is exported exactly. Actual textarea edits follow the browser's newline behavior. Edits do not update the prepared snapshot; export them. Each server run permits one local credential and one immutable snapshot. A failed or uncertain write consumes its grant: check the existing reserve, never retry setup automatically.

## What the automated proof establishes

`npm test` uses the installed SDK, a real local HTTP server and two fresh recovery OS processes. Those processes receive only B's origin and an empty export folder. They receive no plaintext, locator, credential ID or key. The parent confirms byte-exact UTF-8 exports with A returning 503, no recovery requests to A, and no overwrite after editing. It also checks doctor failures and the editor adapter's newline behavior. This is not a physical-browser download, human usability test or native passkey test.

## Moving beyond the simulation

Your application supplies its editor and a distinct, stable HTTPS recovery origin B. Its RP ID must match B's hostname exactly. A passkey remains bound to that domain; this starter does not migrate credentials to another domain.

Replace the local server with a reviewed operator implementation that enforces authenticated, bounded, single-use enrollment, immutable writes, size and time limits, expiry, retention and read availability. The repository's separate operator package is the reusable starting point; this teaching server is not. In the separately reviewed native frontend, remove synthetic-client imports and pass real WebAuthn support to the public SDK (or use the SDK default). Test physical devices, expiry, cancellation and missing/corrupt/offline storage before making claims.

Recovery depends on B's frontend, the existing usable credential and an intact encrypted record. A second store can improve storage resilience but does not make B's domain independent. Do not copy this unauthenticated synthetic credential endpoint into a hosted product. There are no secrets, plaintext drafts or enrollment tokens in URLs or persistent browser storage in this starter.
