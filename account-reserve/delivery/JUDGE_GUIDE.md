# Inspect ContinuityKit Work Reserve

**Recover the draft, finish the work, leave account signing locked.** Work Reserve prepares an encrypted copy that a separate client can discover with an existing recovery passkey when the original application is unavailable.

The example contains a fictional design brief and an unfinished checkout deliverable for **Studio North**. Its useful outcome is an editable, exportable draft. No payment or account-unlock action is needed for that task.

## Start here

1. Start with the published [interactive playground](https://continuitykit-playground.cryptomickle.chatgpt.site/). It offers the edit → prepare → recover → finish → export sequence without a setup code, wallet or native passkey. It runs real Work encryption with fictional, browser-local credentials; it does not simulate a physical authentication success or prove an HTTP outage.
2. Inspect [Work Primary](https://continuitykit-work-primary.cryptomickle.chatgpt.site) and [Work Reserve](https://continuitykit-work-reserve.cryptomickle.chatgpt.site), then read their recorded physical result below. Public page access does not grant the existing reserve passkey or a new setup code. The local examples below provide repeatable checks without those credentials.
3. For the required Monad live product, inspect [Account Reserve Primary](https://continuitykit-account-primary.cryptomickle.chatgpt.site/?model=iris) and its [Account Reserve recovery client](https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris). Their separate testnet result demonstrates preserved account authority. The recorded payment is already claimed. The Work flow itself sends no blockchain transactions.

**Source status:** the core Work Reserve implementation, tests, portable physical proof and finished fictional exports are [published at commit `3e309345`](https://github.com/CryptoMickle/continuity-kit/tree/3e3093456ebbf7765e40967b83b120a1cbc54b97/account-reserve). The public archive was anonymously downloaded and all 183 selected publication files matched. The playground, Textarea consumer, recovery drill and combined local entitlement example are included in this updated source tree. Their commands apply to this revision, not that earlier commit. The [8 October commit `fdfd817`](https://github.com/CryptoMickle/continuity-kit/tree/fdfd817176c87a760cd026f95bb449aad4d57195/account-reserve) remains the earlier Account Reserve snapshot. The competition draft was saved and verified after reload on 9 October; videos and final submission remain deferred.

## Inspect a real editor integration

`integrations/textarea/` adapts [Anton Medvedev's Textarea](https://github.com/antonmedv/textarea)
at pinned commit `8aa2247e4d92d963059e8788624e0c0d1be8d6a3`. It executes the original
contenteditable editor and Markdown highlighter. Its unchanged upstream source and MIT
license have matching GitHub blob hashes and recorded SHA-256 digests. This is an
agent-built adapter to independently authored software, **not upstream adoption,
endorsement or external developer feedback**.

Textarea has one document and no account model. Its text becomes `deliverable`; the
adapter adds an explicit four-field envelope and a disposable unfunded example account.
It does not invent an upstream account to claim to preserve. The generated consumer
installs a local SDK tarball using a dependency lock and imports public SDK entry points.
No source-checkout or internal fixture import is needed by that consumer.

From the updated source tree, with Node 24+ and npm, choose an empty destination:

```sh
node integrations/textarea/create.mjs /absolute/path/to/textarea-work-demo
cd /absolute/path/to/textarea-work-demo
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run dev
```

Open <http://textarea-primary.localhost:5373/>. Edit the actual document, select
**Prepare work reserve**, and confirm **Prepare received snapshot** in B. After its
independent check, use B's **Take original app offline** control, close A, then open a
fresh reserve. Recover and continue the document. Textarea's **Save as txt** preserves
the document; **Export all five fields as JSON** preserves the complete Work envelope.
Reopening a fresh reserve returns the original snapshot, not the later edit.

The automated check builds a clean installed consumer, runs the upstream editor in
JSDOM, verifies A's frontend/API return HTTP 503, and recovers in two fresh Node processes
given only B's origin. It verifies all five fields, the bound owner, no requests to A
during recovery, one immutable write and no account unlock. The edited export check is
a JSON roundtrip. JSDOM does not verify browser popups, native typing, layout or downloads.
The server and credential are synthetic and memory-backed; this remains **local only**.
The build removes upstream's document-in-URL subscriptions and service worker, preserving
the editor itself. Its first-line tab title remains and may appear in browser history.
See `integrations/textarea/README.md` for every modification and limit.

## Measure the tradeoff against encrypted export

From the updated project root:

```sh
npm ci --ignore-scripts
npm run drill:work
npm run test:drill
```

This drill executes real Work SDK and Mera encryption with a synthetic credential and
two disposable local HTTP hosts. Its encrypted-file baseline protects the same work and
owner annotation with the same available credential, then actually imports that file.

| Controlled condition | Work Reserve | Encrypted file |
| --- | --- | --- |
| A unavailable; both copies retained | Recovers | Recovers |
| File missing; hosted record retained | Recovers without file | Fails: file missing |
| Reserve host unavailable or record missing; file retained | Fails | Recovers without host requests |
| Ciphertext altered | Rejects | Rejects |
| Credential unavailable | Fails | Fails |

The reviewed run passed ten checks, including a fresh SDK recovery bracketed by A=503,
all-field/owner equality, signing locked, continued edit/export readback and the unchanged
original snapshot. Read `evidence/work-drill-2026-10-09.json` or
`evidence/work-drill-2026-10-09.txt`. The new run writes its own report and fictional
artifacts under `drill/evidence/`; only the reviewed report/summary are portable evidence.

Healthy Work recovery and file import each used one credential assertion. Preparation
is reported separately: the Work path also verifies its optional account vault, while
the file baseline contains private work only. These measured API/storage operations are
not device prompt counts, human onboarding time or an equal-feature account benchmark.
This comparison establishes where each dependency model fails; it does not prove that
people prefer Work Reserve or that ordinary backup is generally inadequate.

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

## Inspect the implementation

| Question | Source to inspect |
| --- | --- |
| How is work recovered without a saved file or account address? | `sdk/work-reserve.mjs`: app-specific PRF bootstrap and opaque locator derivation |
| Are encryption and lookup purposes separate? | Distinct HKDF purposes for locator, manifest AES-GCM and work AES-GCM in `sdk/work-reserve.mjs` |
| Can work open without account signing? | Work-only recovery and explicit `openAccount` boundary; `tests/work-reserve.mjs` |
| Is the received snapshot the intended one? | Configuration, credential, owner and work bindings; readback and independent opening tests |
| Does the two-origin handoff expire and reject stale events? | `sdk/work-browser.mjs`, `tests/work-browser.mjs`, `tests/work-ui-lifecycle.mjs` |
| What is stored publicly? | Encrypted record bytes, opaque locator and used enrollment-code hash; `work-release/d1-store.mjs` and `work-release/db/` |
| Are stored copies immutable and bounded? | `tests/work-d1.mjs`, `tests/work-d1-boundaries.mjs`, release HTTP tests |
| Does exported work preserve edited fields? | `work/app.mjs` export handler, plus the recorded physical downloaded-file comparison |

For targeted local checks:

```sh
npm run typecheck:work
npm run test:work
npm run test:work-release
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

The stored work is one immutable snapshot. It is not current-state synchronization, lost-passkey recovery or a guarantee against operator failure. Opening work leaves account signing locked, but the underlying optional account vault can restore full account authority; it does not revoke the original key. The hosted demonstration uses one operator, fictional work and no funded Work account. Multiple native confirmations may occur; API-call counts are not visible prompt counts.

Demo access ends **10 November 2026 at 00:00 UTC**. Expiry cleanup is scheduled but its future execution is not yet observed. Provider recovery history may retain deleted records for up to 30 further days. Keep any intentional export locally. This is experimental software, not a production backup or custody service.

Built by Mikkel / CryptoMickle as a solo project. Source is MIT-licensed; the SDK is unpublished on npm. External adoption, audited security and competition eligibility are not claimed.

## Textarea browser follow-through — 9 October

The corrected local adapter also passed an observed Codex-browser sequence: exact
multiline paste, two-window setup, original frontend/API 503, original tab closed,
fresh B recovery, further editing and actual TXT/JSON downloads. Both downloaded
formats matched the intended text, including its terminal newline. The original
frontend/API remained 503 afterward. This uses simulated credentials in a loopback
service; it adds no physical-device or external-adoption evidence. See
`evidence/textarea-integration-2026-10-09.json` for the earlier failed trials and fixes.
