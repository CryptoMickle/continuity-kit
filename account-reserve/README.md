# ContinuityKit — a prepared way back to your work

Prepare an encrypted text snapshot while the original app is available. Reopen it
from a separate client with its reserve passkey, continue writing and export the result.
The text API needs one document and three configuration fields. No wallet, account key,
signing action or invented project fields are required.

This is an experimental developer toolkit, not automatic backup. It keeps one immutable
snapshot. Later edits must be exported. A competent encrypted export also protects work;
the narrower benefit here is finding and opening a prepared copy without retaining that
export file. The reserve service and compatible passkey must still be available.

## Repeated payments through the same account

The separate [sequential-payment integration](payments/README.md) exercises a
recurring onchain obligation: collect a funded payment in A, then collect a second
payment through B with the same prepared account after A is unavailable. Both
0.01 test-MON claims are finalized on Monad testnet and verified through two fixed
RPCs. The second payment was funded after A was deliberately disabled; A returned
HTTP 503 before funding and after the second claim. The builder reported completing
the instructed B recovery/payment flow. A has since been restored, with the same
configuration and payment profile. The [evidence](evidence/payments-validation-2026-10-10.json)
separates chain verification, the builder report and controlled HTTP observations.
The integration includes a wallet-free command for verifying either exact receipt.
These are development payments, not external usage. The text API remains account-free.

The payment view checks availability before offering an existing-passkey action.
Already-collected or unverifiable obligations do not ask the user to authenticate.
This advisory read preserves all final transaction checks.

A fresh browser can now verify either payment from its transaction reference, without
opening a passkey or relying on a local transaction log. The [reference verifier](payments/README.md#check-a-reference-from-a-fresh-browser) checks the exact expected payment and never
changes an unresolved sending attempt.

The experimental `@continuitykit/account-reserve/payments` entry lets a separate
application import the typed client and credential-free receipt reader from the
installed SDK. The [integration example](integrations/payment-client/README.md)
connects an existing account session, separates authentication from collection,
and demonstrates explicit signer cleanup. No issuer tools or deployment state are
exposed through that browser entry. [A clean public-source replay](evidence/payments-sdk-validation-2026-10-10.json)
passed the installed consumer, strict types, browser build and session-lifecycle checks.

## Start with your own text editor

The [text starter](text-starter/README.md) generates a separate, installable
consumer of the public text SDK. Its editor boundary is two functions:
`getText()` captures the document; `applyText(text)` restores it. It includes
the two-origin setup handoff, recovery, continued editing and TXT/JSON export.

```sh
npm run create:text-starter -- /absolute/empty/text-demo
cd /absolute/empty/text-demo
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run doctor
npm test
npm run dev
```

The generated package uses a pinned local SDK tarball and dependency lock.
The doctor checks the installed package, configuration and build; `npm test`
checks recovery/export from a fresh client while the original origin returns
HTTP 503. The browser gives the same deliberate outage control.

This is a **synthetic, disposable localhost example**. It never creates a native
passkey, and restarting its server discards its simulated credential and snapshot.
Do not deploy the teaching server. A real integration needs an owned recovery
origin, native WebAuthn and operated storage/admission; the
[operator package](operator/README.md) is the separate durable-storage reference.
The starter does not silently migrate existing reserves or turn the public demo
into a production service.

The [installed-generator replay](evidence/text-starter-installed-package-2026-10-10.json)
and [final validation](evidence/text-starter-validation-2026-10-10.json) record
the clean install, deliberate A outage, fresh recovery and exact exports.

For a runnable browser flow backed by **two separate SQLite storage processes**,
generate with `npm run create:text-starter -- /absolute/empty/replica-demo --replicas`.
It uses A on port 6073 and B on 6074, plus the same install/build/doctor/test/dev
steps. The UI can stop a storage process and deliberately alter its disposable
encrypted copy. It authenticates the survivor in the client; a running process
alone is never shown as a verified copy. Both stores must verify before setup
is complete. See the [two-store walkthrough](text-starter/README.md#optional-two-store-browser-example).

This optional package reuses the operator gateway and unchanged SQLite runtime.
It still simulates the credential locally and shares one machine, frontend and
gateway. It does not change hosted Sites or establish independent providers.

For **two apps in one recovery view**, use `--collection-replicas` instead.
The [collection walkthrough](text-starter/README.md#two-apps-one-recovery-action-two-stores)
uses A on 6173 and B on 6174, one shared simulated credential and separate
per-app encryption. It shows the actual outcome for every app and storage copy,
supports local editing and export, and includes deliberate A/storage failures.
This is a runnable installed-SDK reference with the existing Prism design;
it does not add a hosted native collection deployment.

For an integration using **real browser passkeys**, the separate
[native text package](text-native/README.md) builds A and B against explicit
origins, an exact recovery hostname and two or three fixed storage routes:

```sh
npm run create:native-text -- /absolute/empty/native-text
cd /absolute/empty/native-text
npm ci --ignore-scripts
# Configure profile.json from the example with your owned origins.
npm run build -- --profile profile.json
npm run doctor -- --profile profile.json
```

The operator issues one private, short-lived upload permission per store. The
browser checks the bundle before a separate, deliberate passkey action; fresh
recovery needs no upload permission. Deployable assets exclude the teaching
authenticator and failure controls. The host exposes only fixed reserve routes.
The doctor verifies profile, role, asset hashes and referenced files without
requesting a credential. The package now initializes private storage once, starts
its frontends and separate storage processes with one command, and checks the
whole configured read path without writing. A failed store after startup leaves
the surviving recovery route running. Follow the guide for owned origins and TLS.

This is a separately buildable native integration, **not a newly deployed or
physically verified service**. Existing public Sites and passkeys are unchanged.
[Native integration validation](evidence/text-native-package-validation-2026-10-10.json) ·
[Operator startup and recovery validation](evidence/native-operator-onboarding-2026-10-10.json).

For several apps, use `profile.collection.example.json` and follow the
[native collection guide](text-native/README.md#several-app-reserves-with-the-same-native-passkey).
It builds a native recovery view for 2–8 fixed apps and 2–3 encrypted storage
copies, with one existing-passkey SDK assertion and separate editor/export
results per app. It preserves v1 packages and does not migrate an existing
profile or change hosted Sites. [Validation and limits](evidence/native-collection-package-2026-10-10.json).

The native package also has a [complete operator backup/restore path](text-native/README.md#back-up-and-restore-the-complete-operator).
Stop the managed stack, export all encrypted replicas and their fixed policy,
then restore into fresh private state using a separately retained SHA-256 digest.
Ciphertext and consumed quota survive; administrator invitations are renewed and
old upload grants are discarded. The same B hostname and existing passkey are
still required. This is an explicit operator migration, not an automatic offsite
backup or protection against losing the recovery origin or credential.

Before starting that operator, `operator:diagnose` distinguishes a mismatched
original profile, unsafe private-file permissions, a present runtime lock and
optionally occupied local ports. It gives corrective guidance without repairing
state or stopping another process. `operator:start` runs the same preflight and
then performs its own startup checks. See the [operator guide](text-native/README.md#start-the-operator-stack).

To run the repository's generator/UI regressions, first install the root and
shared test harness dependencies into your normal npm cache:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix integrations/multi-app ci --ignore-scripts --no-audit --no-fund
npm run test:text-starter
npm run test:replica-browser
npm run test:replica-starter
npm run test:native-text
```

The regression suite installs generated consumers offline and respects npm's
configured cache. `SDK_TEST_NPM_CACHE` optionally selects a separate test cache.

## One reserve passkey, two real editor integrations

[Open the two-app demo](https://continuitykit-try-primary.cryptomickle.chatgpt.site/apps/).
Prepare a fictional Textarea draft in B. For Markdown Studio, explicitly choose
**Use existing reserve passkey**. Each app has a fixed, distinct HKDF namespace and
one immutable snapshot; the same B origin is trusted with both. Earlier `/text/`
and Work reserves stay at their existing routes and retain their original bindings.

Textarea runs the pinned upstream editor; Markdown Studio runs EasyMDE 2.20.0 and
CodeMirror. Both are builder-made integrations of independently authored components,
not external customers or endorsements. No wallet or chain action is added.
The protocol's format, fixed PRF salt and old derivation inputs are unchanged.
On 10 October, the builder reported recovering and exporting both app reserves in
Safari on iPhone after following the setup flow that reuses an existing passkey.
The Markdown marker `Test B fra iPhone` was explicitly confirmed; the final report
covered both recovery/export checks. Credential identity and exported file contents
were not independently inspected. An initial incomplete Textarea setup was resumed
before this completion report. [Scoped native evidence](evidence/apps-native-acceptance-2026-10-10.json).

An [operator package](operator/README.md) serves the same client and durable SQLite
storage without Sites/Vercel/D1. Its installed-SDK [replacement drill](evidence/operator-portability-2026-10-10.json)
stopped the old process, removed its test database, imported ciphertext into a new
database and recovered both exact documents in a fresh process. One synthetic
credential was created; the second app reused it. Tampering and wrong-origin access
were rejected. This is reproducible local evidence, not physical authentication or
a completed public-provider migration. Retaining the exact recovery origin/RP,
app IDs and operator-controlled domain is required. Existing chatgpt.site demo
hostnames are not proved transferable.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix integrations/multi-app ci --ignore-scripts --no-audit --no-fund
npm run build:apps
npm run test:apps
npm run test:operator
node operator/create.mjs /absolute/empty/operator-package
```

See [editor provenance](integrations/multi-app/README.md), [protocol](sdk/TEXT_PROTOCOL.txt)
and [operator responsibilities](operator/README.md). Public Work, text and multi-app
routes share the same existing 64-record and 256-admission limits. No new quota,
database schema, pricing plan or blockchain transaction was introduced.

The [clean public-source replay](evidence/apps-public-replay-2026-10-10.json)
passed both documented installs, the browser build, 24 app/editor tests, six
operator tests and installation of the generated standalone operator package at
the recorded commit. The later editor-label correction was rebuilt, passed the
same 24 app/editor tests and was checked in the published 390px layout.
[Live HTTP checks](evidence/apps-public-http-2026-10-10.json) passed 40 conditions,
including exact compiled asset matches and preservation of the earlier routes.
These are agent-run engineering checks, not human adoption or native passkey proof.

## Open several app reserves with one recovery action

The additive `recoverTextReserves` API opens a bounded list of prepared text
namespaces using one discoverable passkey assertion. The B `/apps/` collection
view shows each app's result and lets users switch editors, continue drafts and
export them in the same page. Existing single-app links and records remain valid.
One SDK assertion does not guarantee one device confirmation.

```js
import { recoverTextReserves } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';

// Invoke directly from a user action on the configured recovery origin.
const results = await recoverTextReserves({
  configs: trustedApps.map(app => app.config),
  store: createReserveHttpStore(),
  signal: pageLifetime.signal,
});
for (const result of results) {
  if (result.status === 'recovered') showDraft(result.appId, result.reserve.text);
  else showReadFailure(result.appId, result.status);
}
```

Choose 1–8 distinct appIds on the same exact recovery origin/RP. There are no
writes, new passkeys or retained cryptographic sessions. Missing, unavailable
and rejected app copies are reported separately; cancellation rejects the entire
operation. App-specific derivation and v1 ciphertext are unchanged. The caller
still trusts the shared recovery page with all requested documents.

`npm run test:collection` covers the SDK and page lifecycle. The
[installed-package replay](evidence/collection-installed-sdk-2026-10-10.json)
checks a fresh offline consumer and strict TypeScript usage. These are synthetic
engineering checks. Earlier builder-reported iPhone tests do not establish the
new collection view's physical prompt count or independent usability.

## Recover when one storage copy fails

The optional replica API checks two or three configured copies of the **same
immutable encrypted snapshot**. It uses one passkey assertion, authenticates each
candidate in the client and returns a valid survivor when another copy is missing,
unavailable or fails verification. Different authenticated records stop recovery;
the protocol does not guess which one is newer.

```js
import { recoverTextReserveFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';

// These fixed routes belong to your trusted recovery-origin integration.
const replicas = ['alpha', 'beta'].map(id => ({
  id, store: createReserveHttpStore({ basePath: `/api/replicas/${id}/reserve` }),
}));
const { reserve, replicas: checkedCopies } = await recoverTextReserveFromReplicas({
  config, replicas, signal: pageLifetime.signal,
});
showDraft(reserve.text);
showCopyStatus(checkedCopies);
```

`prepareTextReserveReplicas` encrypts once and writes each intended store at most
once. Full readiness requires exact readback and independent passkey verification
of every copy. An uncertain or partial write is reported with `recordMayExist`;
the integration must not retry automatically or create another key.

For A-to-B setup, the additive browser helpers `startTextReserveReplicaSetup`
and `createTextReserveReplicaReceiver` bind the exact ordered `replicaIds` on both
pages. Different app IDs or replica policies fail before a credential prompt.
The sender only becomes ready after every intended copy verifies. The ordinary
single-store helpers and existing records retain their original behavior.

The [operator package](operator/README.md#optional-replicas-for-a-custom-text-integration)
includes an optional fixed-route gateway for separate SQLite store processes.
Each store has its own upload permission and quota. The packaged two-app UI and
public Sites demo keep their single-store configuration; this SDK capability
does not silently migrate existing reserves or change native passkey behavior.

```sh
npm run build:apps
npm run test:replicas
node scripts/text-replica-drill.mjs /absolute/path/replica-proof.json
```

The drill exercises the installed SDK and real child processes with separate
durable databases, including process shutdown, corrupted ciphertext and exact
export. It uses synthetic credentials on one machine. Independent hosting
providers, native-device acceptance and protection against loss of the recovery
domain are not established by this local test.

## Open several apps when storage copies fail

`recoverTextReservesFromReplicas` combines collection recovery with authenticated
replicas. Configure 1–8 prepared apps on the same exact recovery origin/RP, each
with two or three storage adapters. One discoverable assertion derives the
existing per-app keys and checks every candidate. A failed or conflicting app
does not hide healthy siblings; cancellation rejects the whole operation.

```js
import { recoverTextReservesFromReplicas } from '@continuitykit/account-reserve/text-reserve';

// Call directly from B's deliberate recovery button. Bind routes and configs
// in trusted client code; no upload permission is needed for this read.
const results = await recoverTextReservesFromReplicas({
  apps: trustedApps.map(app => ({ config: app.config, replicas: app.replicas })),
  signal: pageLifetime.signal,
});
for (const result of results) {
  if (result.status === 'recovered') showDraft(result.appId, result.reserve.text);
  else showReadFailure(result.appId, result.status);
  showCopyStatus(result.appId, result.replicas);
}
```

[Integration recipe and result handling](sdk/COLLECTION_REPLICAS.md) covers
same-origin routes, user actions, cancellation, text-only rendering and limits.
This adds no enrollment, synchronization, repair or key migration. Conflicting
authenticated records fail for that app, even if their text is equal. Existing
APIs, passkeys and text-v1 records are unchanged. It makes one SDK assertion;
device confirmation counts may differ.

The native starter also supports a fixed multi-app profile; the hosted collection remains
single-store. The combined capability is verified through installed-SDK local
storage tests; it is not a new hosted multi-app deployment or native acceptance.
Run `npm run test:collection-replicas` for the combined API and installed replay.
[Validation scope](evidence/text-collection-replica-validation-2026-10-10.json).
[Recorded process-failure proof](evidence/text-replica-process-proof-2026-10-10.json)
and [scoped validation](evidence/text-replica-validation-2026-10-10.json).

## Earlier account-free text candidate

[Open original workspace A](https://continuitykit-try-primary.cryptomickle.chatgpt.site/text/)
→ edit fictional text → prepare in B → reopen
[reserve B](https://continuitykit-try-reserve.cryptomickle.chatgpt.site/text/) with the same
passkey → continue and export. No operator code is needed. Keep both windows open until
the independent check finishes. The device may require several confirmations.

On 10 October, the builder reported **recovery and export on iPhone** after receiving
the Mac Safari → iPhone Safari same-passkey test instructions. Worker logs corroborate
a Mac Safari upload and later iPhone Safari reserve read. The device screens, same-key
identity, requested text marker and exported bytes were not independently inspected;
redacted record locators prevent independently linking those requests to the same record.
[Scoped native acceptance report](evidence/text-native-acceptance-2026-10-10.json).
Earlier physical Work tests below are different protocols. The public Sites retain the old Work flow at `/`; existing records,
credentials, database schema and limits are preserved. Text mode has a separate format
and PRF domain. Both modes share 64 snapshots and 256 lifetime upload permissions.
Access ends 10 November 2026 at 00:00 UTC. [Instructions and limits](self-service/README.md).

## Integrate an actual editor

The [Textarea text adapter](integrations/textarea-text/README.md) executes Anton
Medvedev's pinned MIT editor and consumes only the packaged public text SDK. It adds no
example account and no fabricated work fields. The upstream source and license are
preserved, with privacy-related URL sharing disabled in the generated consumer.
This is an agent-built integration, not upstream adoption or endorsement.

From this source tree, with Node 24+ and npm, choose an empty destination:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node integrations/textarea-text/create.mjs /absolute/path/to/textarea-text-demo
cd /absolute/path/to/textarea-text-demo
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run dev
```

Open <http://textarea-text-primary.localhost:5473/>. This local consumer uses a synthetic
credential and disposable storage. Its automated check covers a clean package install,
the real upstream editor in JSDOM, A's frontend/API returning 503, two fresh recovery
processes with zero A requests, native-editor paste/undo behavior and exact TXT/JSON file
readback. These are reproducible software checks, not physical-device evidence or measured
human onboarding time. [Protocol specification](sdk/TEXT_PROTOCOL.txt).

A separate agent downloaded [public commit `27df242`](https://github.com/CryptoMickle/continuity-kit/tree/27df242f16dc96f9752f5e6b0bd918c85ca60467/account-reserve)
into a new directory and completed the documented build/test order in another empty
consumer. It used no local development files. Two fresh recovery processes returned
matching text and real TXT/JSON file bytes with zero requests to A. The first replay
caught a build-before-test documentation defect, now corrected and replayed from
public source. [Full scoped report](evidence/text-public-install-2026-10-09.json).
This is independent agent replay, not independent human adoption or native validation.

## Evaluate the evidence

- [Judge guide](delivery/JUDGE_GUIDE.md): current entry and precisely scoped proofs.
- [Export comparison](delivery/EXPORT_COMPARISON.md): both approaches' failure modes.
- [Adoption and operating plan](delivery/ADOPTION_PLAN.md): narrow target, pilot criteria,
  cost assumptions and unmet demand evidence.
- [Earlier playground](https://continuitykit-playground.cryptomickle.chatgpt.site/):
  browser-local Work simulation, not the text candidate or native passkey proof.
- [Separate Monad proof](evidence/public-proof.json): an existing account's pre-issued
  testnet payment was claimed once after recovery. Text recovery sends no transaction.

The text API improves integration fit. It does not establish demand, production security
or a competitive advantage over a retained encrypted export. Videos and final submission
remain deferred. Older references below are retained for reproducibility and attribution.

## Earlier five-field Work reference

With Node 24+ and npm installed, from this source package:

```sh
npm ci --ignore-scripts
npm run build:work
npm run dev:work
```

Open <http://work-primary.localhost:5073/>. Prepare the fictional brief in the reserve,
take A offline with the local control, open a fresh B page, finish the two missing
messages and export. No database account, wallet, chain or funds are needed for this
local run. It uses a synthetic authenticator and RAM storage; restarting the server
loses the example. [Run and integration guide](work/README.md).

## Earlier Work demonstration and scoped physical evidence

- [Work Primary](https://continuitykit-work-primary.cryptomickle.chatgpt.site/)
- [Work Reserve](https://continuitykit-work-reserve.cryptomickle.chatgpt.site/)
- [Portable Work proof](evidence/work-public-proof.json)
- [Finished fictional copy handoff](delivery/examples/finished-checkout.txt)
- [Judge guide](delivery/JUDGE_GUIDE.md)

On 9 October, a deliberately reloaded reserve page in Codex’s integrated browser on
Mac recovered all five prepared work fields and the matching account while Primary A
returned HTTP 503 before and after the observation. Account signing stayed locked.
Primary A was then restored and checked with HTTP 200. The two missing copy sections
were later completed in that recovered editor and actual TXT/JSON exports matched.

The user also explicitly confirmed recovery in Safari on iPhone using the same existing
passkey and reported the matching project/client. This is user-confirmed second-device
evidence; a device-screen/full-content capture and recorded live demonstration remain
pending. The Mac test is a fresh page, not a new browser profile.

The public Work services use native passkeys and bounded D1 storage under one operator.
Opening the public page does not provide the existing passkey or a new setup code.
The demonstration uses fictional data, no funds and no Work blockchain transactions.
Access ends 10 November 2026 at 00:00 UTC; scheduled cleanup is not claimed as executed.
It is not a production backup service or proof of survival after hosting/provider loss.

The Work implementation, portable evidence and finished fictional export are
[published at commit `3e309345`](https://github.com/CryptoMickle/continuity-kit/tree/3e3093456ebbf7765e40967b83b120a1cbc54b97/account-reserve).
An anonymous download matched all 183 selected publication files; runtime source
was unchanged from the validated candidate. The 8 October Account Reserve snapshot
remains preserved in repository history. The competition draft was saved and reloaded
on 9 October: all 13 text fields matched, and its checklist is 5/6 with videos remaining.
Videos and final submission are still deferred. See the local publication and portal
records in `evidence/work-source-publication-2026-10-09.json` and
`evidence/portal-draft-saved-2026-10-09.json`; these later operational records are not
part of the published source snapshot.

## Account SDK starter — separate chain-free reference

For the smallest complete integration, generate a **separate** project from the
local package. The destination must be empty; existing files are never replaced.

```sh
npm run create:starter -- /absolute/path/to/new-reserve-starter
cd /absolute/path/to/new-reserve-starter
npm install --ignore-scripts
npm run typecheck
npm test
npm run dev
```

Open <http://reserve-demo-primary.localhost:4673/>. Create the synthetic example
account, activate and prepare its reserve, turn A off, then open a fresh B and
verify the same account. No wallet, Foundry, database account or test funds are
needed. This starter verifies a local signing challenge and closes the signer;
the original payment demo below remains the separate transaction proof.

The starter imports only the installed public SDK, never internal test fixtures.
It includes reusable browser setup controllers, a same-origin HTTP adapter,
read-only environment diagnostics and TypeScript declarations. See
[the complete integration guide](starter/README.md). Native credentials remain an
explicit separate test; default mode is synthetic. The teaching server is
loopback-only and loses its data on restart. Do not deploy it.

Public entry points include the core package, `/browser`, `/http-store`,
`/preflight`, `/work-reserve`, `/work-browser`, `/text-reserve` and `/text-browser`. `npm run test:onboarding` generates an empty consumer, installs the
tarball offline, checks its types/build and verifies fresh recovery through its
own HTTP server with A unavailable. This is internal integration evidence, not
external adoption or a measured human onboarding time. The experimental SDK source is MIT-licensed and remains unpublished on npm.
`private: true` prevents accidental registry publication.

## Earlier account/payment demonstration

Requirements: Node 24+, npm, and installed Foundry `anvil`. Install dependencies from the included lockfile:

```sh
npm ci --ignore-scripts
npm run build
npm run dev
```

Open <http://continuity-primary.localhost:4573/?model=iris>.

1. Create an example account with its pre-existing local test payment.
2. Open the independent reserve window and prepare it. Wait for the independent check.
3. Take the original app offline using the reserve client's local test control.
4. Close the original tab. Follow **Open a fresh reserve** to discard the preparation state.
5. Open the existing reserve and collect the payment. The client closes its signer after confirmation.

Repeat with `?model=accrue` for a different source-derived account model. These are independently written reference fixtures, **not Iris/Accrue integrations, users or endorsements**. The first composes a direct PRF account; the second selects the BIP39/BIP32 worker leaf `m/44'/60'/0'/0/1`. It does not escrow the mnemonic or HD root.

No physical passkeys are created in the default mode. The separate `--physical-approved` flag enables actual WebAuthn only for a specifically approved local test; the human completes system prompts. Old localhost/public ContinuityKit credentials do not apply to these new RP IDs.

## Small SDK surface

Pack locally with `npm pack --ignore-scripts`. This package is experimental and MIT-licensed; it has not been published to npm.

```js
import { createReserveCredential, prepareReserve, recoverReserve } from '@continuitykit/account-reserve';

const config = {
  appId: 'example-app',
  originalRpId: 'app.example.com',
  recoveryRpId: 'reserve.example.net',
  derivation: 'app-account-v1',
};

let recoveryCredential;
try {
  // On B, call from the user's setup action to retain browser user activation.
  recoveryCredential = await createReserveCredential({
    config,
    user: { name: 'My account reserve', displayName: 'My account reserve' },
  });
  // Prepare once with the already-derived leaf. Keep the exact object.
  await prepareReserve({
    privateKey, // Uint8Array(32), retained only as long as necessary by caller
    policy: { ...config, expectedOwner },
    recoveryCredential, // one-use object; do not spread, serialize or copy it
    store, // get(locator) and atomic putIfAbsent(locator, bytes)
  });
} finally {
  recoveryCredential?.close();
  privateKey.fill(0);
}

// Fresh B: no expectedOwner, locator, credential identifier or file input.
const reserve = await recoverReserve({ config, store });
try {
  // reserve.owner and reserve.account are authenticated against the sealed binding.
  // Expose only the integrating app's fixed, explicitly approved operation.
} finally {
  reserve.close();
}
```

Use `webAuthnClient` only for a deliberate adapter or synthetic tests. Omit it for the native WebAuthn adapter used by Mera. Operations forward `AbortSignal` and a bounded timeout to native credential calls; cancellation discards late results and clears SDK-owned byte buffers. This is not a guarantee that every platform prompt closes immediately or that an in-flight store write is undone. `STORE_WRITE_UNKNOWN` means reconcile the existing reserve, never blindly repeat enrollment.

`createReserveCredential` derives the enrollment locator and a nonextractable manifest key from the creation result, then clears its raw PRF bytes. Its one-use object is bound to the complete configuration and expires within five minutes. Close it if setup is abandoned; use the same `signal` for creation and preparation. An expired, cancelled, consumed or mismatched object rejects without silently requesting another credential. Existing credential metadata remains supported by `prepareReserve` through its original assertion path. Fresh recovery always uses the independent two-assertion path and never this temporary setup state.

The immutable enrollment protocol is documented in [sdk/PROTOCOL.txt](sdk/PROTOCOL.txt). One newly dedicated recovery credential binds to one account per app namespace. Rotation, re-binding, multi-account selection and account-key revocation are intentionally unsupported.

## Account Reserve evidence and fair comparison

`npm test` runs SDK tamper/failure tests, two clean offline package consumers, local payment-contract tests and two complete recovered-signer tests. `npm run verify:local` also checks HTTP, the release candidate and both disabled Worker builds; set `ACCOUNT_RESERVE_REDIS_BIN` to a Redis server binary for the real-storage tests. Read [SECURITY.md](SECURITY.md), [delivery/STATUS.md](delivery/STATUS.md) and [the inspection guide](delivery/JUDGE_GUIDE.md) for the evidence boundary.

A correctly retained encrypted Mera export **also works** for both account models. The original synthetic comparison uses four assertion API calls for reserve preparation (including the independent check) and two for recovery; export uses one for each. Credential creation is separate in that comparison. The creation helper removes one repeated assertion from a complete new enrollment: one creation plus three assertions when creation supplies PRF output, or one creation plus four assertions when it requires a fallback assertion. Fresh recovery still uses two. These are API-call counts, **not Face ID/prompt counts**. This optimization is published in the reference demo (Primary version 4 / Reserve version 3); it has not been physically tested. The SDK remains unpublished on npm. The candidate removes the required user-supplied export file and owner hint but adds setup, network storage and another trusted client. It is not generally proven superior to encrypted export. The portable publication summary is in `evidence/public-proof.json`; the earlier native proof belongs to Primary version 3 / Reserve version 2.

The portable [public proof](evidence/public-proof.json) includes the completed testnet claim, historical native-test conditions and the later published enrollment update. Original operational records referenced by local delivery logs are deliberately excluded from the source archive. For source-export checks, run `node --test tests/source-export.mjs`; these are additional to the 318 runtime and integration tests.

## Provenance and AI disclosure

Mikkel / CryptoMickle is the sole human builder. OpenAI Codex and GPT agents assisted product exploration, implementation, tests, design, documentation and review. Automated agents are not external users, independent integrators or additional human team members.

The current Work Reserve direction extends the account-reserve work developed during the 2026 Metropolis build period. It adds encrypted unfinished work and a work-only recovery path; account unlock remains separate. The earlier ContinuityKit data-recovery experiment uses an on-chain version registry and is a different protocol. Its product name and presentation direction are reused, but its tests are not counted as proof of Work Reserve. The current source export is a snapshot, not a Git commit history. The source release preserves the existing repository history and adds this snapshot with its actual commit date; it does not reconstruct earlier development commits.

The local fixtures follow the account patterns identified in [Iris](https://github.com/vmlechko/Iris/blob/main/lib/account.ts) and [Accrue at a pinned revision](https://github.com/pauleke65/accrue/blob/ab1d8580f339addaa02ea118e89ba4b89627e926/lib/mera-account.ts). No Iris or Accrue source or assets are vendored; the separately identified Textarea integration retains its pinned MIT upstream source. The protocol uses unmodified published Mera 0.2.0 APIs, viem 2.56.9, Web Crypto and scure BIP39/BIP32. Existing local experiments are recorded in `../mera-account-exit/`; that directory is not a runtime SDK dependency.

Dependency and artwork provenance are recorded in [third-party notices](delivery/THIRD_PARTY_NOTICES.md). This Account Reserve source is licensed under [MIT](LICENSE). Dependencies retain their own license terms and notices. The [submission requirements](delivery/REQUIREMENTS_2026-10-08.md) distinguish the prepared materials from the remaining competition submission steps.
