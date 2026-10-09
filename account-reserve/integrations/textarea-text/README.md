# Textarea + Text Reserve: isolated text-only integration

This adapter adds an immutable text reserve to **Anton Medvedev’s existing Textarea editor**. It executes the actual editable document, Markdown highlighter and text export code. Textarea owns one document: this example requires only that text, without invented project fields, account identities or signing keys.

Upstream: [antonmedv/textarea](https://github.com/antonmedv/textarea), pinned at [`8aa2247e4d92d963059e8788624e0c0d1be8d6a3`](https://github.com/antonmedv/textarea/tree/8aa2247e4d92d963059e8788624e0c0d1be8d6a3). The unchanged original HTML and MIT license are in `upstream/`; `provenance.json` records their checked hashes. No upstream build script is downloaded or run. ContinuityKit’s adapter is MIT-licensed under the repository license.

This is an agent-built integration against independently authored application code. It is not upstream adoption, endorsement, independent developer feedback, native passkey evidence or production hosting. Neither upstream nor any external person was contacted. The existing Work Reserve Textarea example in `../textarea/` remains separate and unchanged.

## Run the isolated consumer

Use Node 24+ and npm. From the ContinuityKit source checkout, choose an empty directory outside the repository:

```sh
node integrations/textarea-text/create.mjs /absolute/path/to/textarea-text-demo
cd /absolute/path/to/textarea-text-demo
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run dev
```

The generator copies the reviewed example and packs the local SDK. The consumer installs that tarball and imports only public `/text-reserve`, `/text-browser` and `/http-store` entry points. `sdk-package.json` records package integrity. It cannot import the source checkout or internal SDK fixtures. The dependency lock is retained; the generator updates only the local package reference/integrity and rejects changed SDK dependencies. Nothing is published to npm. JSDOM is a test-only dependency; Vite builds the browser assets. The text APIs have no account-library imports or account context; the package also contains its separate account APIs.

Open <http://textarea-text-primary.localhost:5473/>:

1. Edit the actual Textarea document.
2. Select **Prepare text reserve**, then **Prepare received text** in B. Keep both pages open until the independent readback succeeds.
3. In B, select **Take original app offline**. A’s frontend and API now return 503.
4. Close A. Open a fresh B page and select **Open existing text reserve**.
5. Continue editing in Textarea. Export TXT or JSON, or use the upstream menu’s **Save as txt**.
6. A fresh B page still opens the original prepared snapshot. Later edits and exports never overwrite it. **Restore original app** reverses the local outage.

One simulated credential and one reserve are allowed per server run. Stop/restart to discard this local example and start a deliberately new test. There are no native passkeys, accounts, wallets, faucets or transactions in this loopback example. **Never deploy this server:** it is single-user, synthetic and RAM-backed. Restarting destroys both the encrypted record and simulated authenticator. Separate origins demonstrate frontend/API outage behavior, not separate operators or infrastructure survival.

## Application boundary

`adapter.mjs` captures, restores and exports the single document. Its snapshot is the unchanged validated string (up to 16 KiB UTF-8). Malformed surrogate strings are rejected. Markdown syntax, Unicode and intended newlines remain text. Cursor position, undo history and custom CSS are outside the text schema.

`main.mjs` opens B from an explicit A action and prepares the received text only after an explicit B action. The browser helper authenticates source, origin, nonce and message channel. It never transfers account keys. The SDK encrypts and independently reopens the stored bytes before confirming readiness. Recovery returns text and integrity metadata with no retained account or signing context. A canceled or uncertain preparation offers **Check existing reserve** rather than automatically creating another credential or writing again.

Exports use the current document: TXT contains exact text and JSON contains `{ "text": "…" }`. Intentional exports are plaintext. The reserve remains the prepared snapshot. Live text remains in the editor and undo history; dropping references cannot guarantee erasure of JavaScript strings or browser memory.

The server, synthetic authenticator, generator and JSDOM host are demonstration/test infrastructure. An application integrator needs the small capture/restore boundary, the browser SDK calls, a real WebAuthn client and an appropriately operated storage service. This example does not supply a production admission service or native browser acceptance evidence.

## Disclosed upstream bridge

The build applies these explicit changes to an in-memory copy of upstream HTML:

1. Insert `controls.html` before the original contenteditable article, label the existing
   menu button **Textarea menu** for accessibility, and load `main.mjs`.
2. Turn the original inspected inline script into a bundled module, exporting its
   existing `editor` and `article` references and the bridge's `readDocument()`.
3. Remove the five event subscriptions that load/save document content through the URL
   fragment, remove service-worker registration/manifest, and hide **Share link**/**New**.
4. Expose `Editor`'s existing history-recording and debounced highlighting closures
   as two bridge hooks. Attach the explicit plain-text paste/normalization bridge.
   Keep input-triggered title updates. The highlighter and text/HTML export
   implementations are unchanged; exported text is normalized before they run.

See `upstream-build.mjs` for every exact replacement. Each replacement must match once,
and the original file digest must match first. This makes an upstream change a review
failure, not a silently altered integration.

Browser QA exposed a real integration defect: a plain-text paste can produce `div`
and `br` elements, while upstream's `textContent` reads omit their visual line breaks.
`plain-text-editing.mjs` prevents the default paste, inserts the literal `text/plain`
clipboard string with a DOM Range, and records before/after snapshots using upstream's
undo history. It retains the caret and uses the existing highlighter. It also converts
browser-generated `br`/`div`/`p` editing structure into newline text before input/key
handlers and snapshot/export reads. Empty block lines and final caret-placeholder
breaks are handled explicitly. A break at the end of an inline span is preserved
when text follows elsewhere in the same block. Heading spans and CSS sizes do not
add extra newlines.
This is a disclosed integration patch, not a claim that unmodified upstream handles
every browser's editing representation. Arbitrary rich-text HTML is outside this
plain-text adapter's model.

The bridge handles Ctrl/Command+A inside the document with an explicit DOM
`selectAllChildren` selection. This includes a terminal newline that browser default
selection can omit. Paste replaces that exact range; partial selections retain
unselected characters, and intentional clipboard whitespace is never trimmed.

The URL behavior matters: upstream compresses text into the URL fragment; compression
is not encryption. This variant prevents the document body being saved in a URL fragment
or written into history URLs.
It does not describe upstream’s ordinary share-by-link feature as a security defect.
Plaintext still exists in the live editor, undo history and any intentional export.
Upstream still derives the tab title from the first line; that title can appear in browser history.

## What the automated test establishes

After dependencies have been cached, from the source checkout:

```sh
node --test tests/oss-text-integration.mjs
```

The test creates an empty consumer outside the repository, installs the packed public SDK offline with lifecycle scripts disabled, and builds it. It runs the pinned upstream editor in JSDOM and preserves the existing paste/undo, block-line-break, Unicode and select-all terminal-newline regression cases. The SDK prepares and independently reopens one encrypted text record over loopback HTTP.

The original editor is closed. Both A frontend and API must return actual 503 responses. A new OS process receives only B’s origin: no text, locator, credential identifier or setup object. That process discovers and decrypts the snapshot, restores it through upstream `Editor.set`, edits it, invokes the upstream TXT menu handler using an emulated file picker, and checks both TXT and JSON bytes by writing and reading temporary files. Another new process proves edits did not mutate the snapshot. Assertions require one creation, one write, no A requests during recovery, no account result, no plaintext URL writes and no service-worker registration.

JSDOM provides DOM semantics; it does not exercise native typing, browser layout, popup policies or physical WebAuthn. The file-picker destination is emulated; filesystem readback is real. These are local automated integration results, not physical browser download or passkey results. Human onboarding time and native prompt counts are unmeasured. Browser handoff security and cancellation have separate focused SDK tests in `tests/text-browser.mjs`.
