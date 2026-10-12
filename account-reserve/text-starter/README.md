# Account-free text starter

A small editor you own, wired to the installed ContinuityKit public SDK. It prepares an encrypted, immutable text snapshot on B, reopens it after A is unavailable, and exports your continued draft. No wallet, account signing key, funds or provider account is needed.

**Local simulation only.** These servers emulate the credential; they do not invoke a physical passkey. The default mode keeps its encrypted snapshot in RAM. The optional replica and collection modes below use two temporary SQLite databases and separate storage processes. All modes keep the synthetic credential in the parent server's RAM; stopping that server ends recovery. Never deploy these servers or `synthetic-client.mjs`. They do not establish independent infrastructure or providers.

<a id="30-minute-trial-with-your-editor"></a>

## Bounded developer trial

The question is whether this SDK makes recovery useful enough to justify adding
it to an editor you already maintain. First use the unchanged single-app starter
and fictional text to check recovery in your browser. Connect your own component
only after that works and if you have agreed to an integration trial.
No account signup, wallet, payment, hosting or physical passkey is needed.
Thirty minutes is a time limit, not a promised integration time: stop and report
the first blocker if you cannot finish. A negative result is useful.

With Git and Node.js 24+ available, start in a writable folder. Both directory
names below must be new; the generator refuses a nonempty target.

```sh
git clone https://github.com/CryptoMickle/continuity-kit.git continuitykit-trial-source
cd continuitykit-trial-source/account-reserve
git rev-parse HEAD
npm run create:text-starter -- ../../continuitykit-editor-trial
cd ../../continuitykit-editor-trial
```

Record the printed source commit. The generated folder is outside the cloned
source and contains its own pinned SDK tarball and lockfile. Do not run the
template's install directly in the repository's `text-starter` directory.
The [public generator](https://github.com/CryptoMickle/continuity-kit/blob/main/account-reserve/scripts/create-text-starter.mjs)
and [editor adapter](https://github.com/CryptoMickle/continuity-kit/blob/main/account-reserve/text-starter/adapter.mjs)
show exactly what is supplied.

1. Install with `npm ci --ignore-scripts`. Keep the supplied editor for this
   first browser check; no component integration is required yet.
2. Run `npm run build`, `npm run doctor`, `npm test`, then `npm run dev` from the
   generated folder. Rebuild after changing your editor: the server serves
   `dist/`, not live source. These checks validate the supplied infrastructure;
   the browser steps below check the actual browser flow.
3. Open A at `http://text-starter-primary.localhost:5973/`. Write a short fictional
   draft in your editor and export its original TXT for comparison. Choose
   **Prepare a reserve in B**, then **Prepare this snapshot** in B. Wait for the
   successful preparation message before continuing. Finish preparation within
   five minutes of starting from A; expiry closes that attempt.
4. In B, choose **Make A unavailable** and **Open B in a fresh tab**. Keep the
   local server running. In the fresh B tab, choose **Open my existing reserve**;
   A's page/API must remain unavailable. Export TXT before editing and compare
   it with the original, then make a visible edit and export the edited copy.
   The original snapshot stays unchanged.
5. Stop at success or at 30 minutes. Report the result below; no positive quote,
   public repository or ongoing adoption is required. Share only fictional
   exports and code you are allowed to disclose. A screenshot alone cannot show
   that your own component was integrated.

```text
Source commit / Node version / browser:
Editor or component integrated (or unchanged starter only):
Existing app/workflow this would protect:
Changed code: small diff or shareable snippet
Outcome: completed / blocked / stopped at time limit
Actual elapsed minutes, including setup:
First blocker or most confusing step (exact error if present):
A unavailable + fresh B recovered: yes / no / not reached
Unedited TXT matched original; edited export kept the change: yes / no / not reached
Files, if completed: original TXT, recovered TXT, edited TXT or JSON
Why choose this over an encrypted export and re-import — or why not?
Would you keep this integration after the trial? yes / no / undecided; reason
Permission to quote this result or name your project: yes / no
```

After the unchanged starter succeeds, an optional separate integration trial can
connect your existing component as described below. Save the integration diff and
repeat recovery/export; renaming the sample editor does not count as integration.

This can establish one external **local integration trial** only if that work is done. Running the
unchanged starter is an evaluation; neither outcome establishes native passkey
compatibility, production security, paying users or retained adoption. If a
reciprocal review was agreed, keep it separate and equally bounded.

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

## If the browser flow stops

Stop at the first failure. Keep A open and export the fictional draft there.
Do not delete the generated folder, create another credential or restart the
server to diagnose an uncertain result. The simulated credential is in RAM:
stopping the server loses it, even in replica modes.

The local B error now includes safe request details: fixed path, method,
`action=create/get`, HTTP status and a recognized error name. Send only that
line, your source commit, Node/browser versions and the step you clicked.
Do not send request bodies, successful `/api/synthetic` responses, credential
IDs, PRF output, enrollment tokens or anything after `#` in a setup URL.

- `404 CREDENTIAL_MISSING` means this server could not find the requested
  simulated credential. The route exists. A newly opened B tab checks recovery;
  it does not prepare a reserve. Return to A and preserve its draft first.
- `404 ROUTE_UNAVAILABLE` means the server did not recognize that route for the
  request. This is different from a missing credential. Use the exact B address
  printed by the running server; report the diagnostic before another attempt.
- `421 HOST_REJECTED` or `403 ORIGIN_REJECTED`: use the printed `.localhost`
  names and ports, not bare `localhost`, a LAN IP or a replacement hostname.
  Keep the Host/Origin checks and loopback binding enabled.
- `409 ONE_LOCAL_CREDENTIAL_PER_RUN`: a simulated key already exists. Use
  **Open my existing reserve** to check it. Do not create another key.
- `SETUP_EXPIRED`: the five-minute attempt is closed. **Restore A** restores
  availability only; it does not renew setup. Export from the original A tab
  and check B for an existing reserve before deliberately starting over.
- No HTTP status or an unrecognized response leaves the outcome uncertain;
  it does not prove that nothing was saved. Check the existing reserve first.

`npm run doctor -- --live` runs Node loopback requests with the expected Host.
It checks the running server from that terminal, not browser DNS, Windows/WSL
forwarding, popup handling or a physical passkey. A passing doctor or `npm test`
does not establish that those browser steps work. With a Windows browser and
Ubuntu/WSL server, keep the exact printed addresses; do not expose the server
on `0.0.0.0` or weaken request checks as a workaround.

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

For the generated page, replace the `textareaAdapter($('draft'))` initialization
in `main.mjs` with your mounted component's adapter. That page also calls
`editor.clear()` on close and navigation: add `clear: () => myEditor.setValue('')`
to the adapter and clear any component-owned history on disposal. Its controls
currently set `#draft.disabled`; keep that element contract for a textarea, or
wire the same locked/editable state into your component. The two text methods
are the SDK boundary, not a claim that every editor is a two-line drop-in. Keep
the supplied handoff, cancellation and capability handling in place.

`main.mjs` shows the complete integration. Call `startTextReserveSetup` directly inside A's click handler so its B popup is allowed. On B, `createTextReserveReceiver().prepare(...)` handles the explicit setup. Fresh B uses `recoverTextReserve(...)` and a read-only HTTP store with no enrollment capability. Imports use only the installed `/text-browser`, `/text-reserve` and `/http-store` entrypoints.

Text is limited to 16 KiB raw UTF-8 per app. The supplied `textareaAdapter`
preserves the original recovered text while its displayed value is unchanged,
including a leading BOM and CRLF. If your editor normalizes text on assignment,
keep equivalent raw-source/displayed-baseline handling; the two method names
alone do not guarantee byte-exact export. Actual textarea edits follow the
browser's newline behavior. Edits do not update the prepared snapshot; export
them. Each server run permits one local credential and one immutable snapshot
per configured app. A failed or uncertain write consumes its grant: check the
existing reserve, never retry setup automatically.

## What the automated proof establishes

`npm test` uses the installed SDK, a real local HTTP server and two fresh recovery OS processes. Those processes receive only B's origin and an empty export folder. They receive no plaintext, locator, credential ID or key. The parent confirms byte-exact UTF-8 exports with A returning 503, no recovery requests to A, and no overwrite after editing. It also checks doctor failures and the editor adapter's newline behavior. This is not a physical-browser download, human usability test or native passkey test.

## Moving beyond the simulation

Your application supplies its editor and a distinct, stable HTTPS recovery origin B. Its RP ID must match B's hostname exactly. A passkey remains bound to that domain; this starter does not migrate credentials to another domain.

Replace the local server with a reviewed operator implementation that enforces authenticated, bounded, single-use enrollment, immutable writes, size and time limits, expiry, retention and read availability. The repository's separate operator package is the reusable starting point; this teaching server is not. In the separately reviewed native frontend, remove synthetic-client imports and pass real WebAuthn support to the public SDK (or use the SDK default). Test physical devices, expiry, cancellation and missing/corrupt/offline storage before making claims.

Recovery depends on B's frontend, the existing usable credential and an intact encrypted record. A second store can improve storage resilience but does not make B's domain independent. Do not copy this unauthenticated synthetic credential endpoint into a hosted product. There are no secrets, plaintext drafts or enrollment tokens in URLs or persistent browser storage in this starter.
