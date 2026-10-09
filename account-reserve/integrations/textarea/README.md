# Textarea + Work Reserve: isolated integration

This adapter adds a prepared work reserve to **Anton Medvedev’s existing Textarea editor**.
It runs Textarea’s actual editable document, Markdown highlighter and text export code;
it is not a new lookalike editor or another claimed third-party customer.

Upstream: [antonmedv/textarea](https://github.com/antonmedv/textarea), pinned at
[`8aa2247e4d92d963059e8788624e0c0d1be8d6a3`](https://github.com/antonmedv/textarea/tree/8aa2247e4d92d963059e8788624e0c0d1be8d6a3).
The MIT license and unchanged original `index.html` are in `upstream/`.
`provenance.json` records their hashes; the build and tests refuse changed originals.
The upstream source was read before execution. No upstream build script is downloaded
or run. ContinuityKit’s adapter is also MIT-licensed under the repository license.

**Evidence boundary:** this is an agent-built integration against independently authored
application code. It is not upstream adoption, endorsement, independent developer feedback,
market traction, native passkey evidence or production hosting. Neither upstream nor any
external person was contacted. The original repository and Delveworn are unchanged.

## Run the isolated consumer

Use Node 24+ and npm. From the ContinuityKit source directory, choose an empty destination
outside the source repository:

```sh
node integrations/textarea/create.mjs /absolute/path/to/textarea-work-demo
cd /absolute/path/to/textarea-work-demo
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run dev
```

The generator copies this example and packs the local SDK into a tarball. The consumer
installs that tarball and imports only its public `/work-reserve`, `/work-browser` and
`/http-store` entry points. It cannot import the source checkout or internal SDK fixtures.
The dependency lock is retained; the generator changes only the local SDK tarball
reference/integrity and refuses an unreviewed SDK dependency change.
`sdk-package.json` records the installed candidate’s package integrity. The SDK is not
published to npm by this process. Vite and viem reuse the versions in the project; JSDOM
is a test-only dependency for executing the actual upstream editor/highlighter in a DOM.

Open <http://textarea-primary.localhost:5373/>:

1. Edit the actual Textarea document. The envelope disclosure contains the other four fields.
2. Select **Prepare work reserve**, then **Prepare received snapshot** in B. Keep both pages open until the snapshot is independently checked.
3. In B, select **Take original app offline**. A’s frontend and API now return 503.
4. Close A. Select **Open a fresh reserve**, then **Open existing work reserve**.
5. The recovered document appears in the same upstream editor. Edit it, use Textarea’s menu **Save as txt**, and/or **Export all five fields as JSON**.
6. Open a fresh B page again. It must recover the prepared snapshot, not the later exported edits. **Restore original app** reverses the local outage.

One credential and one reserve are allowed per server run. Stop/restart the local server
to discard the example and begin a deliberately new test. No native passkeys, wallet,
faucet, funding, database account or blockchain transactions are involved.
**Never deploy this teaching server:** it is one-user, loopback-only, synthetic and RAM-backed.

## Exact integration mapping

Textarea has **one plain-text document**, not accounts, clients or projects. The integration
does not pretend otherwise:

| Work field | Source |
| --- | --- |
| `deliverable` | Textarea’s real document, normalized by `readDocument()`; restore uses upstream `editor.set()` |
| `title` | Adapter envelope: Project |
| `client` | Adapter envelope: Client |
| `brief` | Adapter envelope: Brief |
| `nextStep` | Adapter envelope: Next step |

`adapter.mjs` validates the exact envelope, preserves all five strings, rejects unexpected
metadata/oversized snapshots, and serializes the complete envelope for export. No Markdown
headings are heuristically reinterpreted as metadata. Formatting syntax and Unicode remain
document text; cursor position, undo history and custom CSS are deliberately outside the
plain-text Work schema. The upstream text export contains the document only; the additional
JSON export contains every Work field.

Textarea has no account identity. This isolated demonstration supplies a new, unfunded,
disposable leaf for the SDK’s required account binding and explicitly labels it as such.
It does not demonstrate preservation of an upstream account that never existed. An
account-bearing integration would supply its existing selected account leaf instead.
Work recovery never invokes `openAccount`; its optional account context is immediately closed.

## Small integration boundary

The useful application adapter is `adapter.mjs` (capture, restore, export), the
plain-text editing bridge in `plain-text-editing.mjs`, and the SDK calls in `main.mjs`.
The remaining server, synthetic authenticator and generator
are local demonstration/test infrastructure, not code an upstream developer must copy.

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

From the source checkout, after dependencies are cached:

```sh
node --test tests/oss-work-integration.mjs
```

The test creates an empty consumer, installs the packed SDK with lifecycle scripts
disabled, and builds this app. It runs the reviewed upstream editor in JSDOM, edits
the contenteditable DOM, executes upstream’s keyboard/input/highlight path, captures
all five fields, and prepares a real encrypted Work record over loopback HTTP.
Regression cases exercise multiline clipboard paste (including a trailing newline),
upstream undo, and several browser-generated block/line-break DOM forms before capture.
They also reproduce a partial selection leaving a terminal newline, then require an
explicit select-all paste to preserve exactly one or two intended clipboard newlines.
It then closes the original editor, verifies A returns 503, and starts a **new Node
process** supplied only B’s origin. That fresh process discovers/decrypts the reserve,
renders it through the actual upstream `Editor.set`, edits and exports it. Another new
process proves the reserve remains immutable. Checks require one write/one credential,
zero A requests during recovery, no account unlock, no URL writes and no service worker.

JSDOM supplies DOM semantics; it does not emulate native typing, layout, popup policies
or physical WebAuthn. Its edit helper updates the contenteditable DOM and dispatches
the corresponding events explicitly. Browser verification of the two-window handoff
is a separate check, not inferred from this Node test. Human onboarding time and native
prompt counts are not measured.

The encrypted record and simulated authenticator share this local process. Restarting
it destroys both. Separate origins here prove application/API outage behavior, not
separate operators, providers or infrastructure survival.

## Observed browser check — 9 October 2026

The corrected integration was exercised in the Codex integrated browser on Mac. Literal
multiline clipboard text was prepared through the A/B popup, A returned 503, its tab
was closed, and a fresh B page recovered the exact text including the terminal newline.
The recovered text was edited and downloaded through the upstream TXT control and the
adapter JSON control; both files matched the intended edit. A frontend/API remained
503 after the exports. These were synthetic credentials. The initial multiline and
select-all defects were recorded as failures, corrected and retested. See
`../../evidence/textarea-integration-2026-10-09.json` for scope and source hashes.
