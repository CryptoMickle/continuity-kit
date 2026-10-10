# Account-free text starter

A small editor you own, wired to the installed ContinuityKit public SDK. It prepares an encrypted, immutable text snapshot on B, reopens it after A is unavailable, and exports your continued draft. No wallet, account signing key, funds or provider account is needed.

**Local simulation only.** These servers emulate the credential; they do not invoke a physical passkey. The default mode keeps its encrypted snapshot in RAM. The optional replica and collection modes below use two temporary SQLite databases and separate storage processes. All modes keep the synthetic credential in the parent server's RAM; stopping that server ends recovery. Never deploy these servers or `synthetic-client.mjs`. They do not establish independent infrastructure or providers.

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

## Two apps, one recovery action, two stores

From the SDK repository, generate a new empty folder:

```sh
npm run create:text-starter -- /absolute/empty/collection-demo --collection-replicas
```

Run the same install, build, doctor, test and dev commands above in that folder.
This mode uses A at `http://text-starter-primary.localhost:6173/` and B at
`http://text-starter-reserve.localhost:6174/`. The `--replicas` and
`--collection-replicas` options are mutually exclusive.

1. In A, choose **Prepare in B** for Text draft. In B, choose **Create the first
   simulation key**. Wait until preparation completes before returning to A.
2. Prepare Markdown draft from A. This time choose **Prepare with the existing
   simulated key** in B. Both copies must independently verify for each app.
3. Choose **Open my app reserves** in B. Both app namespaces are checked in one
   SDK assertion. Each app has its own editor and per-store result.
4. Close the copies, expand **Try a failure**, make A unavailable and stop Alpha.
   Open a fresh B tab and recover again: Beta must authenticate both drafts.
5. Edit either draft and export TXT or JSON. Close the copies before using any
   further failure controls; this prevents a status change from replacing edits.

The two editors present text, including Markdown source; neither renders HTML
from the recovered content. A missing, corrupt or conflicting app stays closed
without suppressing the healthy app. Two verified but different authenticated
records are a conflict, even if they contain equal text. Running processes are
shown separately from cryptographic verification.

`main.mjs` exports `mountCollection(document, window, options)` and uses the
installed `recoverTextReservesFromReplicas` API. The two fixed app policies live
in `collection-config.mjs`. Read-only adapters share two fixed B routes;
recovery has no upload capability. Whole-batch result validation precedes any
text rendering. Cancellation ignores late results. Close, page exit and the
session deadline clear the adapters, visible drafts and retained export URLs.
This is best-effort application cleanup, not guaranteed erasure of browser RAM
or already downloaded files.

Each app gets at most one admission attempt in a run. There is no automatic
key creation, write retry, repair or background recovery. To test corrupt data,
stop the chosen store, select an app and use **Alter this stopped copy**; the
control can only alter that app's recorded disposable snapshot. It cannot
restore a damaged copy. Starting the store does not repair its contents.

This mode's `npm test` checks the installed SDK against the real local stack and
four fresh recovery processes: both stores, one stopped store, one app's only
surviving copy corrupted, and both stores unavailable. A returns HTTP 503 in all
four phases. Exact exports and unchanged stored bytes/counters are checked.
The repository's `npm run test:collection-browser` additionally exercises the UI
lifecycle and installed UI with corrupt, missing and authentic-conflict fixtures.
These automated DOM tests are distinct from real-browser and physical-device
tests. The native starter and existing hosted collection are unchanged.

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

Text is limited to 16 KiB raw UTF-8 per app. Unedited recovered text, including a leading BOM and CRLF, is exported exactly. Actual textarea edits follow the browser's newline behavior. Edits do not update the prepared snapshot; export them. Each server run permits one local credential and one immutable snapshot per configured app. A failed or uncertain write consumes its grant: check the existing reserve, never retry setup automatically.

## What the automated proof establishes

`npm test` uses the installed SDK, a real local HTTP server and two fresh recovery OS processes. Those processes receive only B's origin and an empty export folder. They receive no plaintext, locator, credential ID or key. The parent confirms byte-exact UTF-8 exports with A returning 503, no recovery requests to A, and no overwrite after editing. It also checks doctor failures and the editor adapter's newline behavior. This is not a physical-browser download, human usability test or native passkey test.

## Moving beyond the simulation

Your application supplies its editor and a distinct, stable HTTPS recovery origin B. Its RP ID must match B's hostname exactly. A passkey remains bound to that domain; this starter does not migrate credentials to another domain.

Replace the local server with a reviewed operator implementation that enforces authenticated, bounded, single-use enrollment, immutable writes, size and time limits, expiry, retention and read availability. The repository's separate operator package is the reusable starting point; this teaching server is not. In the separately reviewed native frontend, remove synthetic-client imports and pass real WebAuthn support to the public SDK (or use the SDK default). Test physical devices, expiry, cancellation and missing/corrupt/offline storage before making claims.

Recovery depends on B's frontend, the existing usable credential and an intact encrypted record. A second store can improve storage resilience but does not make B's domain independent. Do not copy this unauthenticated synthetic credential endpoint into a hosted product. There are no secrets, plaintext drafts or enrollment tokens in URLs or persistent browser storage in this starter.
