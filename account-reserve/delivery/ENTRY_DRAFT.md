# Metropolis entry — ContinuityKit Work Reserve

Submission copy, 9 October 2026. Final submission and video are deferred; portal draft status is tracked separately. This draft leads with Work Reserve; the earlier Account Reserve supplies separate Monad evidence.

**Project:** ContinuityKit

**Tagline:** Your work has a way back. Pick up where the app left off.

**Short description:** A developer toolkit for a prepared, encrypted work reserve. Recover a private draft in a separate client, finish it and export it while the original app is unavailable. Account signing stays locked.

**Main category candidate:** Trust, Identity & AI Infrastructure.

**Sponsor candidate:** Mera: One Passkey, Many Keys — conditional. The work namespace performs non-account encryption and recovery. The user has confirmed opening the same prepared project in Safari on iPhone with the existing passkey. Direct device-screen, full-content and judge-visible live demonstration evidence remain to be captured with the deferred video. No eligibility decision or prize is assumed.

**Monad live-product link:** [Account Reserve Primary](https://continuitykit-account-primary.cryptomickle.chatgpt.site/?model=iris), with [Account Reserve recovery](https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris). This is the separately demonstrated Monad testnet account flow. Work Reserve is the private-work continuation flow and sends no blockchain transactions.

## Project description

A client brief should remain useful when the app holding it disappears. I built ContinuityKit so a developer can give users a prepared way to continue their work from a separate client.

The example is a small design project: a private brief and an unfinished checkout draft for a fictional furniture studio. While the original workspace is available, the user prepares one immutable encrypted snapshot with a recovery passkey. Later, that credential finds and opens the snapshot in the reserve client. There is no backup file to locate, account address to paste or old setup tab to keep. The user can finish the missing copy and export a local deliverable.

Work access is separate from account authority. Opening, editing and exporting the draft does not decrypt the account key, create a signer or send a transaction. An optional, deliberate action can separately verify the same account. The public Work demonstration uses a new unfunded example account and fictional content only.

The Work flow has been physically tested on Mac. On 9 October, the original site's page and API returned HTTP 503 before and after recovery was directly observed in a fresh application page in the Codex browser. The existing reserve passkey restored all five prepared fields and the expected account binding, with account signing still locked. The original site was then restored and returned HTTP 200. A separate Safari-on-Mac test produced a downloaded text file containing a new edit with all other prepared content preserved.

I then used the recovered editor to finish the example's address-error and order-confirmation copy. The downloaded text and JSON files contained identical work and preserved the original brief. Account access had already expired; editing and export still worked. This is a finished fictional copy handoff with implementation placeholders, not a delivered client project. Export took place after the original service was restored. The user also confirmed opening the matching project and client in Safari on iPhone using the existing passkey; that second-device result is user-reported, with independent screen and full-content evidence still pending.

The toolkit uses Mera's PRF material for a dedicated work namespace. HKDF separates the discovery locator, manifest encryption and work encryption. The encrypted record binds the work to the application configuration, recovery credential and separately encrypted account vault. Setup reads the stored bytes back and independently opens the reserve before reporting success. Fresh work recovery checks those bindings without unlocking the account signer. The hosted example stores ciphertext in a separate recovery site's D1 database; both sites remain under one operator.

ContinuityKit also includes an earlier Account Reserve flow with a concrete Monad testnet result. On 8 October, an account already entitled to 0.1 test-MON was recovered while its original app was unavailable and collected that payment once. Two configured RPC providers agreed on the finalized receipt and claimed state. That is evidence for recovered account authority, not a transaction performed by Work Reserve. The Work demonstration sends no blockchain transactions.

A retained encrypted export is a credible alternative. The proposed advantage here is credential-driven discovery plus a usable continuation client: users return to prepared work without supplying their backup file. The cost is enrollment, storage availability and trust in the reserve code. This is one prepared snapshot, not automatic backup or synchronization. Changes made after preparation are not silently protected, and edits in the recovery client must be exported.

I built the SDK, typed interfaces, two-origin setup flow, storage boundary, reference applications and tests as a solo project. The earlier account SDK has a generated developer starter and two independently written account-model fixtures. These are internal reference consumers, not external adoption. Developer demand, willingness to pay and production security remain unproven.

Built by Mikkel / CryptoMickle. No external users, endorsements or third-party integrations are claimed.

## Go-to-market draft

The initial developer use case is a small web application holding private drafts, client briefs or other unfinished deliverables. An integration supplies a bounded work snapshot and an existing account leaf to the reserve SDK. The user gets an independent place to open the prepared work, continue editing and take it away.

The developer package has a chain-free local Work example with simulated credentials. It makes the core sequence reproducible without a wallet, faucet, database subscription or native passkey setup. A separate hosted demonstration exercises physical passkeys and durable encrypted storage. The SDK is MIT-licensed and unpublished on npm; the Work source, tests and portable evidence are included in this repository.

The commercial hypothesis is an integration toolkit and implementation support. The relevant comparison is the developer's own encrypted export and restore flow. There is no demonstrated customer preference for this extra setup, and no claim of a high-volume transaction business. The next product decision depends on whether credential-driven discovery and a working exit client justify their operational cost for a specific integrating application.

## Mera: non-account use

Mera 0.2.0 supplies the passkey PRF and secret-vault primitives. Work Reserve uses the namespace `account-continuity/work-reserve-v1`; its bootstrap salt also includes the application ID. Distinct HKDF purposes derive the opaque lookup material, manifest AES-GCM key and work AES-GCM key. The account leaf is protected in a separately salted Mera vault. The work operation decrypts and validates the brief and draft without decrypting that leaf.

The server stores encrypted record bytes and enrollment metadata, not plaintext work or PRF output. A user-requested export intentionally creates a plaintext local copy. This is not a claim that plaintext never exists: the original and recovery editors necessarily handle it in memory, and both clients must be trusted.

The non-account result is recovering and editing the private work. Payment is not required to demonstrate it. The user has confirmed same-passkey iPhone recovery and identified the matching project and client. The remaining sponsor evidence is a judge-visible live demonstration with the device and recovered content visible. The directly observed fresh-page Mac test is not a fresh-profile test, and the iPhone report has not independently established full-content equality.

## Access instructions draft

The required Monad live-product link is [Account Reserve Primary](https://continuitykit-account-primary.cryptomickle.chatgpt.site/?model=iris); its separate [Account Reserve recovery client](https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris) demonstrates prepared account access. The recorded testnet payment is already claimed. The private Work flow below is distinct and does not send a transaction.

Start with [Work Primary](https://continuitykit-work-primary.cryptomickle.chatgpt.site) and [Work Reserve](https://continuitykit-work-reserve.cryptomickle.chatgpt.site). The hosted demo is a bounded physical-passkey trial. Viewing the pages does not give a visitor the existing reserve credential or a new enrollment code. Use the accompanying local example for a repeatable walkthrough without those credentials.

Follow `delivery/JUDGE_GUIDE.md` for the Work sequence, evidence boundaries and the separate Monad result. The recorded Work recovery restores the project **A calmer checkout** and fictional client **Studio North**, while displaying **Work recovered. Account signing is locked. No transaction sent.** Inspect the resulting copy handoff in `delivery/examples/finished-checkout.txt` or `.json`. The snapshot remains immutable; a later recovery returns the prepared draft, not that exported edit. This source tree includes the portable Work evidence at `evidence/work-public-proof.json`.

The separate Account Reserve claim is `0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5` on Monad testnet, finalized block 69,286,156. Its portable evidence is `evidence/public-proof.json`. The payment has already been claimed; it is historical evidence, not an open faucet.

The [Work source](../README.md), tests, demonstration instructions and portable evidence are included in this source tree. The [8 October Account Reserve snapshot](https://github.com/CryptoMickle/continuity-kit/tree/fdfd817176c87a760cd026f95bb449aad4d57195/account-reserve) remains available separately in repository history. The repository retains its actual commit history, with no reconstructed development commits.

## Submission readiness — internal, not portal copy

The 9 October [Many Keys page](https://hackathon.monad.xyz/tracks/mera-one-passkey-many-keys) offers one $2,500 prize and explicitly requires non-account work plus a live same-passkey second-device or fresh-profile test. The Trust track's previously captured rubric also gives substantial weight to market readiness and traction. Technical evidence does not establish those qualities, and no minimum payout can be promised.

| Item | Current state |
| --- | --- |
| Work app-outage recovery | Observed on Mac in a fresh Codex browser page; A page/API 503 before and after; restored A 200. |
| Edited local export | Safari-on-Mac requested edit verified. Completed fictional checkout copy subsequently downloaded through the Mac Codex browser as matching TXT and JSON; account access was expired. Original app was already restored during completion/export. |
| Same passkey, second device / fresh profile | User explicitly confirmed Safari on iPhone with the existing passkey and matching project/client. Direct device-screen/full-content comparison and judge-visible live demonstration remain pending. |
| Public Work source | Work implementation, tests, portable evidence and fictional finished exports are included in this repository. The earlier Account Reserve remains preserved in history. |
| Public source requirements | Previously checked rules require licensed source, build-window commit history and README AI disclosure. Verify the new public package meets them before submission. |
| Portal copy | Final submission is deferred. Portal draft save/readback is tracked separately from source publication. Name/tagline limits were 120/200 characters; description, go-to-market and access fields allowed 8,000 each at the prior check. |
| Logo | Prepared `delivery/assets/continuitykit-logo.png`, 1024 × 1024, 249,425 bytes. Upload not claimed. |
| Video | Deferred. Prior form asked for a product demonstration of at most 3 minutes and a pitch of at most 2 minutes; the Many Keys page lists an optional Mera demonstration of at most 2 minutes. |
| Deadline | 9 October bounty-page observation: 14 October 2026, 05:59 GMT+2. Recheck the submission portal before final submission. |
| Availability | Work demo access ends 10 November 2026, 00:00 UTC. Scheduled expiry cleanup has not yet executed. Provider recovery history may retain deleted records for up to 30 further days. |

Known limits: one immutable snapshot; multiple native confirmations possible; no loss-of-passkey recovery; same-operator hosting and storage; no shared-infrastructure-failure proof; no independent security audit. The underlying account vault can restore full account authority if deliberately opened; it does not revoke the original key. Use fictional data and no real funds.
