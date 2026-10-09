# Inspect ContinuityKit Text Reserve

**Recover the draft and finish the work, without an account key.** The preferred
text path prepares one encrypted document that a separate client can discover
with its recovery passkey. It creates no wallet, EOA, account vault or signing session.

**Release boundary:** both `/text/` pages are published as Sites version 3 and were
observed live. A rendered at 390-pixel mobile width; edited text was downloaded as
TXT and JSON and matched exactly. The A-to-B admission reached **Create reserve
passkey**; cancellation before that action closed setup without calling native
WebAuthn. Fresh B offered **Open my existing reserve**. Native text-v1 preparation
and Mac-to-iPhone recovery/export remain pending. Earlier Work/Account native
results do not establish this new protocol's physical-device support.

[Public HTTP verification](../evidence/text-public-http-2026-10-09.json) passed
22/22 checks, including configuration, preserved older routes and exact compiled
asset matches. This verifies the deployed pages/assets, not native recovery.

## Start here

1. Preferred published entry: [text workspace A](https://continuitykit-try-primary.cryptomickle.chatgpt.site/text/) and [text reserve B](https://continuitykit-try-reserve.cryptomickle.chatgpt.site/text/). Write fictional text, choose **Prepare this text in B**, then explicitly create the reserve passkey in B. Wait for independent verification, close or discard A's window state, reopen a fresh B page and recover, edit and export TXT/JSON. This native sequence still needs acceptance evidence. Closing A does not prove an HTTP outage. This text namespace does not migrate earlier Work reserves.
2. For a quick preview, use the published [interactive playground](https://continuitykit-playground.cryptomickle.chatgpt.site/). It offers the edit → prepare → recover → finish → export sequence without a setup code, wallet or native passkey. It runs real Work encryption with fictional, browser-local credentials; it does not simulate a physical authentication success or prove an HTTP outage.
3. Earlier account-bound paths remain separate: the [self-service Work A homepage](https://continuitykit-try-primary.cryptomickle.chatgpt.site/) and [Work B homepage](https://continuitykit-try-reserve.cryptomickle.chatgpt.site/) still use an unfunded example account. The older [Work Primary](https://continuitykit-work-primary.cryptomickle.chatgpt.site) and [Work Reserve](https://continuitykit-work-reserve.cryptomickle.chatgpt.site) require their existing passkey or operator-issued enrollment code. Their recorded native results appear below.
4. For the Monad live product, inspect [Account Reserve Primary](https://continuitykit-account-primary.cryptomickle.chatgpt.site/?model=iris) and its [Account Reserve recovery client](https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris). Their separate testnet result demonstrates preserved account authority. The recorded payment is already claimed. Text recovery sends no blockchain transaction.

The text path and earlier self-service Work flow share **one 64-record / 256-lifetime-
admission allowance**, not a separate quota per mode. Each encrypted record is at most
64 KiB; accepted text is at most 16 KiB UTF-8. Access ends **10 November 2026 at
00:00 UTC**. Expiry does not itself delete records. Both sites and storage have one
operator; the quota is not a traffic or billing cap. See [operating bounds](ADOPTION_PLAN.md).

**Source status:** this revision contains text-v1, `integrations/textarea-text/` and
the new text recovery/export drill. Its publication record is separate from the
live Sites deployment. The earlier core Work implementation and physical
proof are [published at commit `3e309345`](https://github.com/CryptoMickle/continuity-kit/tree/3e3093456ebbf7765e40967b83b120a1cbc54b97/account-reserve);
the [8 October commit `fdfd817`](https://github.com/CryptoMickle/continuity-kit/tree/fdfd817176c87a760cd026f95bb449aad4d57195/account-reserve)
is the earlier Account snapshot. New commands apply to this current revision, not
those immutable commits. The saved portal draft predates the text candidate; this
documentation update does not change it. Videos and final submission remain deferred.

Live page views: [desktop A](../evidence/text-public-primary-2026-10-09.png) and
[390-pixel A](../evidence/text-public-mobile-2026-10-09.png). These images show the
published interface, not a completed passkey recovery.

## Earlier self-service Work acceptance — separate from text-v1

On 9 October, after the published Safari correction, the builder reported completing setup,
fresh-page recovery using the same passkey, continued editing and TXT export in Safari on
iPhone. Server logs corroborate admission, upload and later reserve reads (HTTP 201/200).
The physical screen and exported bytes were not independently inspected. This is a
builder-run acceptance test, not outside adoption, second-device recovery or an HTTP
outage of A. The older separate native outage/second-device results retain their scope below.
Evidence: [`self-service-iphone-setup-report-2026-10-09.json`](../evidence/self-service-iphone-setup-report-2026-10-09.json).
The self-service correction passed 149 automated checks and is published at
[commit `e528f14`](https://github.com/CryptoMickle/continuity-kit/commit/e528f14fdffe0b176ad8f2b8a24d065b753fab3f).

## Inspect a real editor integration

`integrations/textarea-text/` adapts [Anton Medvedev's Textarea](https://github.com/antonmedv/textarea)
at pinned commit `8aa2247e4d92d963059e8788624e0c0d1be8d6a3`. It executes the original
contenteditable editor and Markdown highlighter. Its unchanged upstream source and MIT
license have matching GitHub blob hashes and recorded SHA-256 digests. This is an
agent-built adapter to independently authored software, **not upstream adoption,
endorsement or external developer feedback**.

Textarea has one document and no account model. The new adapter supplies only that
text: no invented project fields, disposable account or signing key. The generated
consumer installs a local SDK tarball using a dependency lock and imports public
`/text-reserve`, `/text-browser` and `/http-store` entry points. No source-checkout or
internal fixture import is needed. The earlier account-bound adapter remains in
`integrations/textarea/` as a separate reference.

From the updated source tree, with Node 24+ and npm, choose an empty destination:

```sh
node integrations/textarea-text/create.mjs /absolute/path/to/textarea-text-demo
cd /absolute/path/to/textarea-text-demo
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run dev
```

Open <http://textarea-text-primary.localhost:5473/>. Edit the actual document, select
**Prepare text reserve**, and confirm **Prepare received text** in B. After its
independent check, use B's **Take original app offline** control, close A, then open a
fresh reserve. Recover and continue the document. Textarea's **Save as txt** preserves
the document; JSON export preserves the current text.
Reopening a fresh reserve returns the original snapshot, not the later edit.

The automated check builds a clean installed consumer, runs the upstream editor in
JSDOM, verifies A's frontend/API return HTTP 503, and recovers in two fresh Node processes
given only B's origin. It verifies exact text, no requests to A during recovery, one
immutable write and no account result. It invokes the upstream TXT handler with an
emulated file picker and writes/reads the TXT and JSON bytes. JSDOM does not verify
browser popups, native typing, layout or physical browser downloads.
The server and credential are synthetic and memory-backed; this remains **local only**.
The build removes upstream's document-in-URL subscriptions and service worker, preserving
the editor itself. Its first-line tab title remains and may appear in browser history.
See [the text integration instructions](../integrations/textarea-text/README.md) for
every modification and limit. These local synthetic checks passed; native text-v1
setup, recovery and export remain pending.

## What Mera does for the text

Mera 0.2.0 supplies the discoverable, user-verified passkey PRF ceremonies. Text-v1
uses a fixed **protocol-wide** PRF salt, SHA-256 of
`account-continuity/text-reserve-v1/prf`. Application separation happens in HKDF:
its salt hashes the canonical protocol label, full configuration and credential ID;
distinct purpose labels derive lookup material, manifest encryption and text encryption.
The configuration includes the app ID, exact recovery origin and recovery RP ID.
The PRF salt itself is not app-specific. [Protocol details](../sdk/TEXT_PROTOCOL.txt)

Preparation writes once, compares the readback bytes, then independently discovers
and decrypts using a new assertion before returning ready. Recovery returns text and
integrity metadata only. There is no account leaf, account vault or signing session
to unlock. Both editors necessarily see plaintext; intentional exports are plaintext.

## Measure the tradeoff against encrypted export

The [new text-v1 report](../evidence/text-drill-2026-10-09.json) compares the same text
and synthetic credential against a functional encrypted file. Six conditions run
through both paths in **12 fresh recovery processes**, with real loopback A=503
checks before and after each attempt. The file is actually retained on disk and
independently imported before the outage. Four regression tests passed. See the
[complete comparison and limits](EXPORT_COMPARISON.md).

From the updated project root:

```sh
npm ci --ignore-scripts
node scripts/text-recovery-drill.mjs
node --test tests/text-recovery-drill.mjs
```

| Controlled condition | Text Reserve | Encrypted file |
| --- | --- | --- |
| A unavailable; both copies retained | Recovers | Recovers |
| File missing; hosted record retained | Recovers without file | Fails: file missing |
| Reserve host unavailable or record missing; file retained | Fails | Recovers without host requests |
| Ciphertext altered | Rejects | Rejects |
| Credential unavailable | Fails | Fails |

Healthy text recovery and file import each used one assertion. Reserve recovery
made one HTTP read; file recovery needed no HTTP request. After the shared creation,
reserve preparation/verification used one assertion and the file used two: the
reserve reused creation-time PRF output, while the file evaluated its separate salt
and then performed an independent import. These are API calls, not native prompt
counts or a measured human-effort advantage. Both edited TXT/JSON outputs were
written and read back with exact equality. No account or signer was involved.

New runs write under `drill/text-evidence/`. The file format is a comparison fixture,
not a supported production backup API. Neither method recovers a lost passkey;
the retained file wins when reserve storage is unavailable. The earlier
[Work v1 drill](../evidence/work-drill-2026-10-09.json) remains supplemental evidence
with different account-vault setup requirements. Neither report establishes demand.

## Optional existing payment, through the same recovered account

`examples/work-entitlement/` joins the real Work SDK to the unchanged local `PaymentRight`
fixture. A fictional job's payment right is issued to its existing account before reserve
preparation. Work then opens, is edited and exported with account signing locked. Only a
separate explicit action unlocks the same account to collect that pre-existing right once.
The signer closes afterward and rejects further signing.

With the repository's locked dependencies and Foundry Anvil installed locally:

```sh
npm run demo:work-entitlement
npm run demo:work-entitlement -- --claim-existing-payment
npm run test:work-entitlement
```

The first command stops after work export. The second creates a **new disposable local
run** and opts into its payment claim. All chain activity uses local Anvil, chain 31337;
there is no public RPC, native passkey, deployed combined flow or real money. The example
does not claim that editing earns payment or proves a completed job: the fixed right
already existed. Read `evidence/work-entitlement-local-2026-10-09.json` for six passing
tests and the scoped local runner result. The original access failure is a local interface
rejection, not an HTTP or domain outage. This is separate from the historical public
Account Reserve proof below.

## Observed physical Work result — 9 October 2026

The original site's frontend and configuration API returned HTTP 503 before recovery. In a freshly loaded reserve page in the **Codex integrated browser on Mac**, the existing physical passkey restored the prepared project. The editor and all five fields were directly observed. The page showed **Work recovered. Account signing is locked. No transaction sent.** A second network probe still found the original frontend and API unavailable. The original service was then restored and checked at HTTP 200.

| Check | Result |
| --- | --- |
| Project / fictional client | A calmer checkout / Studio North |
| Recovered data | Project, client, brief, working draft and next step exactly matched the prepared snapshot |
| Bound account | `0x386b5eff74b0e22e0f1c2de4ff84929d96be6e09` |
| Signing authority during work recovery | Locked; account key not opened by the work action |
| Original service | Frontend and API 503 before and after the observed recovery; restored to 200 |
| Separate edit/export check | Downloaded text from the user-reported Mac Safari run contained the requested added sentence; all remaining content matched the prior export |
| Finished fictional deliverable | Missing address-error and confirmation copy completed in the recovered Mac editor; downloaded TXT and JSON match; account access was already expired |
| Work blockchain transactions | Zero |

The portable Work summary is `evidence/work-public-proof.json`; its source is the retained local outage record `evidence/work-native-outage-proof-2026-10-09.json`. This source tree includes `evidence/work-recovered-2026-10-09.jpg`. The Safari export proves an edit survived into the downloaded file; its device/browser attribution comes from the user's report. It does not independently establish the timing of that earlier recovery relative to the first outage attempt. The later observed Codex-browser outage test supplies the bracketed outage evidence.

Inspect the finished fictional handoff at `delivery/examples/finished-checkout.txt` or `delivery/examples/finished-checkout.json`. Both were downloaded through the recovered editor's visible export controls and compared exactly; `evidence/work-finished-export-2026-10-09.json` records the check. The project, client and original brief are preserved. The new copy fills the two missing messages and marks the order-data placeholders for implementation review. This completion/export happened after Primary was restored, with account access expired. It is not a real client delivery or a claim that export was observed during the outage.

**Second-device boundary:** the user explicitly confirmed Safari on iPhone with the same existing passkey and reported the matching project **A calmer checkout** and client **Studio North**. This is a user-confirmed result, not an independently observed device screen or full-content comparison. A judge-visible live demonstration remains for the deferred video. The [Mera Many Keys bounty](https://hackathon.monad.xyz/tracks/mera-one-passkey-many-keys), read on 9 October, explicitly asks for the same passkey on a second device or fresh browser profile. The directly observed Mac fresh page alone would not satisfy that condition. This guide makes no eligibility or prize claim.

## Reproduce the Work sequence locally

Requirements: Node 24+ and npm. No Foundry, chain, wallet, faucet or database account is needed for this example. From the new source candidate's project directory:

```sh
npm ci --ignore-scripts
npm run build:work
npm run dev:work
```

Open <http://work-primary.localhost:5073/>. This run deliberately uses simulated credentials and an in-memory store; it is not physical passkey evidence.

1. Read the client brief and unfinished **Working draft**. Select **Create example account**, then **Prepare work reserve**.
2. Keep both windows open until the stored snapshot has been reopened and checked. Preparation preserves the draft as it exists at that moment.
3. In the reserve window, expand **Try it without the original app** and select **Take original app offline**. Check the original URL returns unavailable and close its tab.
4. Choose **Open a fresh reserve**, then **Open existing work reserve**. The recovered project should be **A calmer checkout**, with signing **Locked**.
5. Finish the missing address-error message and confirmation-page copy in **Working draft**. Select **Export finished draft**, open the downloaded text file and verify your changes. **Export JSON** is also available.
6. Reopen a fresh reserve once more. It must return the original prepared snapshot. Exported edits do not overwrite it.

The local service keeps simulated credentials and encrypted records in memory. Restarting it deletes both. Both origins run on one computer; the availability switch tests loss of the original app, not independent infrastructure survival. Use fictional content only.

For a physical run against the hosted demonstration, new preparation requires an operator-issued single-use code and native passkey confirmation. Existing recovery needs the prepared passkey, not the setup code. The site cannot itself prove another site's outage; the recorded physical test uses separate network checks. Do not create replacement credentials to recover an existing snapshot.

## Inspect the text implementation

| Question | Source to inspect |
| --- | --- |
| How is text recovered without a saved file or locator? | `sdk/text-reserve.mjs`: discoverable PRF, configuration-bound HKDF and opaque locator |
| Are encryption and lookup purposes separate? | Distinct locator, manifest AES-GCM and text AES-GCM labels; `sdk/TEXT_PROTOCOL.txt` |
| Is there an account key? | No account/vault/signer API in text-v1; `tests/text-reserve.mjs` |
| Is the received snapshot the intended one? | Configuration, credential and text-digest bindings; byte readback and independent opening |
| Does the handoff reject stale or forged events? | `sdk/text-browser.mjs`, `tests/text-browser.mjs` |
| Are both modes in the same bounded store? | `self-service/backend/store.mjs`, `self-service/backend/profile.mjs`, `tests/self-service-backend.mjs` |
| Does the UI preserve native action and cancellation? | `self-service/text/app.mjs`, `tests/self-service-text-ui.mjs` |
| Does a real editor integrate? | `integrations/textarea-text/`, `tests/oss-text-integration.mjs`; synthetic/JSDOM evidence |

For targeted local checks:

```sh
npm run test:text
npm run test:oss-text
node --test tests/self-service-text-host.mjs tests/self-service-text-ui.mjs
```

`npm run verify:local` covers the wider project, including the older account and payment fixtures. Its chain stages require Foundry `anvil`; complete Redis integration coverage requires `ACCOUNT_RESERVE_REDIS_BIN`. Read the produced `evidence/verification.json` and stage outputs rather than treating an exit code with skipped tests as full coverage. Miniflare tests exercise local D1 behavior. None of these simulated tests substitutes for the native or cross-device checks.

## Separate Monad account-continuity proof — 8 October 2026

The earlier Account Reserve demonstrates a complementary capability. A beneficiary already held a 0.1 test-MON right before the original app became unavailable. A fresh reserve tab used its existing physical passkey to recover the same account and collect that right once. The signer closed after confirmation, and the original app was restored.

| Check | Recorded result |
| --- | --- |
| Network | Monad testnet, chain ID 10143 |
| Original and recovered beneficiary | `0x3efc5827c9f2f25f8fd4000C4BF9318154dF1B85` |
| Payment contract | `0x738F3a0E2376a8e9AFf6A4440B0dBC77c22e6B4A` |
| Claim transaction | `0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5` |
| Result | Right 1, 0.1 test-MON, `claimed=true`, finalized block 69,286,156 |
| Verification | Two configured RPCs agreed on receipt, event and contract state; not a light-client proof |

The portable record is `evidence/public-proof.json`. Its native proof belongs to **Account Primary 3 / Reserve 2**. The later **Account Primary 4 / Reserve 3** enrollment optimization was locally tested but not physically retested. The native account test used a fresh tab in the same browser. These account versions and credentials are separate from the Work demonstration.

The [Account Primary](https://continuitykit-account-primary.cryptomickle.chatgpt.site) and [Account Reserve](https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris) pages remain separate supporting references. The payment was already collected; it is not an open or repeatable public faucet. Do not call it Work transaction activity.

To reproduce only that older synthetic payment sequence, use the root `npm run build` and `npm run dev` commands with Foundry `anvil` installed, then open <http://continuity-primary.localhost:4573/?model=iris>. `CONTINUITY_ANVIL` may specify the executable's absolute path. The `iris` and `accrue` selectors name independently written account-pattern fixtures, not upstream integrations or endorsements. The default disposable chain ID is 31337; local tests using ID 10143 are still local tests.

## The tradeoff to judge

A correctly retained encrypted export can also preserve this work. ContinuityKit adds a credential-discoverable reserve and a continuation client, in return for enrollment, available storage and another trusted client. Demand and superiority to an ordinary export are not established.

The stored text is one immutable snapshot. It is not current-state synchronization,
lost-passkey recovery or a guarantee against operator failure. Text-v1 has no account
vault. The separate Work v1 account vault can restore full account authority and does
not revoke the original key. The hosted demonstration has one operator and fictional
data. Multiple native confirmations may occur; API counts are not prompt counts.

Demo access ends **10 November 2026 at 00:00 UTC**. Access expiry and cleanup are
separate; this guide does not establish cleanup execution. Provider recovery history
may retain deleted records for up to 30 further days. Keep intentional exports locally.
This is experimental software, not a production backup or custody service.

Built by Mikkel / CryptoMickle as a solo project. Source is MIT-licensed; the SDK is unpublished on npm. External adoption, audited security and competition eligibility are not claimed.

## Earlier Work Textarea browser follow-through — 9 October

The earlier `integrations/textarea/` Work adapter passed an observed Codex-browser sequence: exact
multiline paste, two-window setup, original frontend/API 503, original tab closed,
fresh B recovery, further editing and actual TXT/JSON downloads. Both downloaded
formats matched the intended text, including its terminal newline. The original
frontend/API remained 503 afterward. This uses simulated credentials in a loopback
service; it adds no physical-device or external-adoption evidence. See
`evidence/textarea-integration-2026-10-09.json` for the earlier failed trials and fixes.
