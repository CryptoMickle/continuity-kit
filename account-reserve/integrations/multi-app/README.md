# Two real editor components, one small integration interface

ContinuityKit's multi-app demonstration embeds two independently authored editors:

- **Textarea**, Anton Medvedev's editor at commit
  `8aa2247e4d92d963059e8788624e0c0d1be8d6a3`. The actual Markdown highlighter,
  selection-aware editing and undo implementation execute. The original source
  and MIT notice are retained unchanged under `vendor/textarea/`.
- **EasyMDE 2.20.0**, Jeroen Akkerman's Markdown editor, including the actual
  CodeMirror 5.65.15 runtime. The official npm tarball was checked against its
  published SHA-512 integrity. The original runtime, CSS, package metadata and
  source are retained under `vendor/easymde/`.

The surrounding apps and adapters were built by ContinuityKit. These are two
component integrations, **not upstream adoption, endorsement, independent
developer trials or paying customers**. The EasyMDE example is a demonstration
app around an upstream editor component, not a claim to have integrated an
independently operated live service. The Textarea source is the same pinned source
used in the earlier single-app integration; it is not a new third adopter.

## Build and embedding

Node 24 or newer is sufficient to build; building does not install or fetch code:

```sh
node integrations/multi-app/build.mjs /absolute/output/editor-assets
```

Or from another build module:

```js
import { buildEditorAssets } from './integrations/multi-app/build.mjs';
await buildEditorAssets({ outDir: '/absolute/output/editor-assets' });
```

Serve all seven generated files together and include `editors.css`. Import the
selected editor module after DOM creation:

```js
const { mountEditor } = await import('/editor-assets/easymde-editor.mjs');
const editor = mountEditor({
  element: document.querySelector('#editor'),
  initialText: '# A fictional brief\nDraft text.',
  onChange(text) { /* caller owns in-memory draft state */ },
});
const exactBrowserText = editor.getText();
editor.setText('# Updated fictional brief');
editor.destroy();
```

Both modules expose the same synchronous `mountEditor` interface and a frozen
`{ getText, setText, destroy }` handle. `setText` updates the editor and notifies
the callback when the underlying editor reports a change; it is not a history
erasure operation. To discard original-app state, call `destroy()` and drop the
handle and any retained draft strings. JavaScript memory cannot be reliably
zeroized. A destroyed handle refuses reads and writes.

The source editor's normal browser editing behavior applies. CodeMirror
normalizes CRLF to LF and contenteditable uses browser-generated line structures;
this adapter does not claim byte-preserving import of every possible external
text file. The snapshot must use `getText()` from the actual current editor.

## Privacy and source changes

The adapters do not fetch or save documents, send plaintext to a service, put
content in a URL, or register a service worker. Preparation and export belong to
the caller. Textarea's persistence and menu wiring are not included. Its existing
highlighter/undo functions are extracted; the build applies two explicit patches:
exposing the existing history/highlight closures for plain-text paste handling,
and correcting the upstream destroy method's event-listener receiver. The wrapper
owns delayed callbacks so disposal cancels them. Links remain inert during editing.

EasyMDE's autosave, dictionary spellchecker, image upload, remote icon download,
preview shortcuts and fullscreen shortcuts are disabled. The toolbar exposes
text formatting and undo/redo only. Preview, if called by future code, escapes
the document as literal text. Markdown HTML and image URLs are not rendered or
loaded. The official bundle still contains disabled preview/spellchecker code;
their license notices are included. This is not a security audit of upstream.

`provenance.json` records original source digests and source URLs. The build fails
if vendored originals change. The bundled dependencies' notices are in
`THIRD_PARTY_NOTICES.txt`; CodeMirror, EasyMDE, Textarea, Marked and the spellchecker
use MIT, and Typo.js uses BSD-3-Clause. Exact embedded versions other than EasyMDE
and CodeMirror were not independently identified; notice source versions are
recorded without claiming they are the bundle's resolved dependency versions.

## Test scope

```sh
cd integrations/multi-app
npm ci --ignore-scripts
npm test
```

The tests execute both actual upstream runtimes in JSDOM. They check literal
text/Unicode, Textarea highlighting and line structures, CodeMirror edits and
real toolbar undo/redo, disposal, and rejection of attempted storage, URL,
network or service-worker side effects during exercised flows. Layout and focus
have test-only shims. This is not native typing, mobile layout, a physical
passkey test or proof of external adoption. Browser testing belongs to the
composed public client.
