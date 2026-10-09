# Metropolis entry — developer update, 9 October 2026

Prepared replacement for three portal fields. The prior portal copy was saved and checked at 14:22–14:23 UTC; these new description, go-to-market and access sections are not claimed saved here. The later operational save record is separate. Video and final submission remain deferred.

Project: ContinuityKit. Solo builder: Mikkel / CryptoMickle. Track: Trust, Identity & AI Infrastructure. Sponsor: Mera: One Passkey, Many Keys. Form completeness is not eligibility or a prize prediction.

The required Monad live-product URL remains the separate Account Reserve Primary. The synthetic playground is the easiest first evaluation, not a Monad deployment.

## One-liner

Recover prepared private work with a passkey and keep account signing locked. ContinuityKit pairs a work reserve with separately verified Monad account recovery.

## Project description

A client brief should remain useful when the app holding it disappears. I built ContinuityKit so a developer can give users a prepared way to continue their work from a separate client.

Try the public interactive playground without a setup code, passkey or wallet: change a draft, prepare it, discard the original, recover and export. It runs the actual Work SDK encryption with a clearly labelled simulated credential and outage. It is an evaluation tool, not physical-device proof.

Work Reserve stores one immutable encrypted snapshot of a private brief and unfinished deliverable. Later, the existing recovery credential finds and opens it without a backup file, pasted account address or original browser session. The user can finish the work and export a local copy. Reading, editing and exporting do not decrypt the account key or send a transaction. A separate deliberate action can unlock the same account; this grants full account authority, not a narrowly delegated signer.

The hosted Work demonstration uses physical passkeys, fictional work and a new unfunded account. On 9 October, a fresh Codex-browser page on Mac recovered all five prepared fields and the expected account while the original frontend and API returned HTTP 503 before and after. Signing remained locked. The original service was restored afterward. The missing checkout copy was later finished and downloaded as matching TXT and JSON. Safari/iPhone recovery using the same passkey and matching project/client is user-confirmed; independent device-screen/full-content and judge-visible live proof remain pending.

I also integrated the packaged SDK into an isolated copy of Anton Medvedev's MIT-licensed Textarea editor, pinned to its upstream commit. The actual editor supplies the document; an explicit adapter supplies four project fields. Clean-consumer tests install the SDK tarball, build, prepare over HTTP, make the original app return 503 and recover in a fresh Node process. This is an integration I built into independently authored code, not upstream adoption, endorsement or customer traction.

A one-command developer drill executes ten checks rather than displaying canned outcomes. It compares Work recovery with a functioning Mera-encrypted export of the same work using the same available credential. Both recover when their copies survive. Work succeeds without the export file; a retained file succeeds when reserve storage is unavailable. Both reject altered ciphertext and fail without the credential. This demonstrates a tradeoff, not universal superiority or demand.

Mera 0.2.0 provides passkey PRF and secret-vault primitives. App-specific HKDF purposes separate discovery, manifest encryption and work encryption. The record binds the work, configuration, credential and separately encrypted account vault. Preparation reads back and independently opens the stored bytes before reporting readiness. Hosted ciphertext lives in the recovery site's D1 database; both sites remain under one operator.

The separately demonstrated Account Reserve recovered a beneficiary already entitled to 0.1 test-MON and collected that payment once on Monad testnet. Two RPC providers agreed on the finalized receipt and claimed state. A new local reference consumer now joins work recovery and optional collection of a pre-issued payment under the same account. That joined sequence uses a disposable local chain; it is not a new public Monad result, and completing an export does not earn the payment.

This is a solo project by Mikkel / CryptoMickle, developed with AI assistance. Source, typed SDK, integration, reproducible drill, contract fixture and scoped evidence are included. One prepared snapshot is not automatic backup, synchronization or lost-passkey recovery. Customer demand, willingness to pay, independent security audit and production readiness remain unproven.

## Go-to-market

The initial developer use case is a small web app holding private drafts, client briefs or unfinished deliverables. The integration maps a bounded snapshot and an existing selected account leaf to the Work SDK. Users get a separate place to open prepared work and take it away.

Distribution begins with the no-credential public playground, MIT source, an actual isolated Textarea adapter and a one-command recovery drill. The Textarea consumer installs the packaged SDK in a clean project and uses only public package exports. This is project-authored integration work; upstream adoption or an independently motivated integrator is not claimed. The SDK is not published on npm.

An integrating developer can run the existing app, map its data, test an actual local HTTP outage, inspect a fresh-process recovery and compare against a functional encrypted export. The benchmark deliberately includes conditions in which the retained file wins. These artifacts reduce evaluation friction; no human onboarding-time or conversion-rate claim is made.

The commercial hypothesis is an integration toolkit and implementation support. There are no proven paying customers, retention, product-market fit or high-volume transaction business. The product decision is whether credential-driven discovery and a usable continuation client justify setup and storage dependency for a specific app. Work recovery itself does not require a blockchain transaction; optional recovery of existing account rights supplies the separately demonstrated Monad use case.

## Judge access instructions

START WITH THE PUBLIC PLAYGROUND
https://continuitykit-playground.cryptomickle.chatgpt.site/
No setup code, passkey, wallet or funds are needed. Edit a line, prepare, take the simulated original offline, recover and export. Real SDK encryption; explicitly synthetic browser-local credentials/outage. Reloading clears this fictional example. This is not physical-device evidence.

SOURCE AND REPRODUCIBLE DEVELOPER CHECKS
https://github.com/CryptoMickle/continuity-kit/tree/main/account-reserve
Read delivery/JUDGE_GUIDE.md. integrations/textarea/ contains a real adapter into pinned MIT upstream editor code, built by this project without upstream endorsement. drill/ contains the one-command recovery and functional encrypted-export comparison. examples/work-entitlement/ joins work recovery and an optional existing payment on a disposable local chain. These synthetic checks do not replace native proof.

PHYSICAL WORK REFERENCE
https://continuitykit-work-primary.cryptomickle.chatgpt.site/
https://continuitykit-work-reserve.cryptomickle.chatgpt.site/
Existing prepared passkey required. Public viewing does not provide that key or a new enrollment code; do not create an unrelated key expecting the recorded work. Mac outage recovery and finished fictional TXT/JSON exports are recorded in evidence/work-public-proof.json and delivery/examples/. iPhone Safari using the same passkey and matching project/client is user-confirmed; recorded screen/full-content proof remains pending.

SEPARATE MONAD LIVE PRODUCT
https://continuitykit-account-primary.cryptomickle.chatgpt.site/?model=iris
https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris
Claim: 0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5, Monad testnet 10143, finalized block 69,286,156. evidence/public-proof.json. The 0.1 test-MON right is already claimed, not an open faucet. This receipt is separate from Work and the new local combined scenario.

Physical Work access ends 10 November 2026, 00:00 UTC. Both sites/storage have one operator. One immutable prepared snapshot; no automatic sync, lost-passkey recovery or audited production guarantee. Video and final submission are deferred.

## Mera non-account explanation

Mera 0.2.0 supplies the passkey PRF and secret-vault primitives. Work Reserve uses the namespace account-continuity/work-reserve-v1; its bootstrap salt also includes the application ID. Distinct HKDF purposes derive the opaque lookup material, manifest AES-GCM key and work AES-GCM key. The account leaf is protected in a separately salted Mera vault. The work operation decrypts and validates the private brief and draft without decrypting that leaf.

The non-account result is useful work: reopen a prepared client brief, finish the missing checkout copy and export a local deliverable. The retained example contains a fictional project and client; it is not a real client delivery. Opening, editing and exporting Work sends no blockchain transaction. The toolkit's separate Account Reserve Monad testnet demonstration is evidence of account recovery, not the purpose of this Mera work namespace.

The server stores encrypted record bytes and enrollment metadata, not plaintext work or PRF output. A requested export intentionally creates a plaintext local copy. The original and recovery editors necessarily handle plaintext in memory, and both clients must be trusted. Storage and both sites remain under one operator.

On 9 October, directly observed Mac recovery restored all five prepared fields while the original page and API returned HTTP 503 before and after. The same prepared project and client were also opened in Safari on iPhone using the existing passkey; that second-device result is self-reported. Direct device-screen/full-content comparison and a judge-visible live demonstration remain pending. The observed fresh-page Mac test is not a fresh-browser-profile test. I am not claiming a single native confirmation or an independently verified second-device full-content match.

Portable evidence, source and the completed fictional TXT/JSON export are included in the public repository. The Work flow is one immutable prepared snapshot, not automatic backup or sync.

## Remaining submission boundary

Technical demo and pitch video URLs remain empty. Same-passkey iPhone recovery is user-confirmed, but recorded screen/full-content and judge-visible live evidence remain pending. There is no fresh-browser-profile claim, external adoption, measured onboarding time, security audit or demand proof. Final submission is explicitly deferred.

The portal was observed on 9 October with a deadline of 14 October 2026, 05:59 GMT+2. Recheck before final submission. Existing physical Work demo access ends 10 November, 00:00 UTC; scheduled cleanup has not yet executed.
