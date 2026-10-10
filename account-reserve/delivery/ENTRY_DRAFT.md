# Metropolis entry — two-app/operator update, 10 October 2026

**Current update:** the three sections below are prepared for a new draft save; this file does not itself establish portal publication. New native two-app acceptance remains pending.

**Earlier text-v1 version saved to the portal and verified after reload at 21:52 UTC, 9 October 2026.**
Five changed fields matched this draft; all 13 text fields were read back, with the
other fields preserved. A follow-up at 21:58 UTC added the successful clean public-source
installation to judge instructions, then all 13 fields were checked again. Checklist remains 5/6 because demo/pitch videos are deliberately
absent. Final submission has not been performed. Evidence:
`evidence/portal-text-draft-saved-2026-10-09.json`.

The text pages are published. On 10 October the builder reported successful recovery
and export on iPhone after the instructed Mac Safari → iPhone Safari text-v1 sequence.
Worker logs corroborate a Mac Safari upload and subsequent reads, followed by an
iPhone Safari reserve read. Same-key identity, the requested marker and exported bytes
were not independently inspected. See `evidence/text-native-acceptance-2026-10-10.json`.
The dated 9 October portal evidence above retains its original scope. This update
was saved at 09:36 UTC on 10 October; all 13 text fields were checked after reload,
the three updated values matched, and the other ten fields were preserved.
Evidence: `evidence/portal-text-native-draft-saved-2026-10-10.json`.

Project: ContinuityKit. Solo builder: Mikkel / CryptoMickle. Track: Trust, Identity &
AI Infrastructure. Sponsor: Mera: One Passkey, Many Keys. The Monad live-product URL
remains the separate Account Reserve Primary. Form completeness is not eligibility
or a prize prediction.

## One-liner

Recover a prepared private draft with a passkey and keep writing, without a wallet
or account key. ContinuityKit also has a separately demonstrated Monad account reserve.

## Project description

ContinuityKit gives unfinished private work a prepared way back when its original app is unavailable. A developer connects its text document to a separate recovery client. The user can reopen, edit and export the prepared snapshot with a reserve passkey, without a wallet or account key.

The new published entry is https://continuitykit-try-primary.cryptomickle.chatgpt.site/apps/ with recovery at https://continuitykit-try-reserve.cryptomickle.chatgpt.site/apps/. Textarea runs its pinned upstream editor; Markdown Studio runs EasyMDE/CodeMirror. The second app explicitly reuses the existing reserve passkey. Fixed app namespaces derive separate lookup and encryption keys, so one app's stored ciphertext cannot substitute for the other's. These are builder-made integrations of independently authored components, not outside adoption or endorsements. Human acceptance of the new two-app reuse sequence is still pending.

The operator package serves the same browser client with durable SQLite storage, private invitation-gated admissions and immutable encrypted records. Its reproducible installed-SDK drill prepares two texts with one synthetic credential, stops the original host before export, removes the test database, imports ciphertext into a new database and recovers both exact documents from fresh OS processes. It rejects wrong-origin access and altered ciphertext. Migration requires retaining the exact recovery origin/RP and application bindings. This is a local host/storage replacement, not a completed public-provider migration; the current chatgpt.site hostname is not proved transferable.

Mera 0.2.0 supplies discoverable, user-verified passkey PRF ceremonies. WebCrypto HKDF separates lookup, manifest and text purposes and binds the app configuration and selected credential. Preparation writes once, reads back exact bytes and independently reopens/decrypts before reporting ready. Reusing a key never silently creates a replacement or overwrites an existing app snapshot. No secret key or PRF output is stored by the server.

Earlier text-v1 acceptance is separate: on 10 October the builder reported recovery and export on iPhone after the instructed Mac Safari-to-iPhone sequence. Logs corroborate Mac upload/reads and a later iPhone reserve read; device screens, credential identity, marker and export bytes were not independently inspected. It does not prove the new two-app ceremony. Older Work Reserve additionally has recorded recovery while A returned HTTP 503.

Account Reserve separately recovered a beneficiary's existing 0.1 test-MON entitlement and claimed it once on Monad testnet, with finalized agreement from two configured RPC providers. Text recovery has no blockchain transaction; editing does not generate or earn that payment.

A working encrypted-file baseline is included. Keeping the file works when the hosted store is unavailable; hosted discovery works without retaining that file. Both are tested with the same available credential and text. One immutable snapshot is not synchronization, lost-key recovery or a replacement for competent backup.

Solo builder: Mikkel / CryptoMickle, with AI development assistance. The public sites share one operator and finite capacity. External demand, paying customers, audit and production readiness remain unproven.

## Go-to-market

The initial customer hypothesis is a small browser-app team holding private unfinished
text: drafts, notes or briefs. The integration maps its document into capture,
restore and export operations; it does not need an existing account or a fabricated
one. The team must accept responsibility for a durable recovery domain, trusted
client, storage, support and costs.

Evaluation materials are the published text pages, the synthetic playground,
MIT source, the actual Textarea text integration and the fair text export comparison.
The SDK is not published on npm. Clean-package/JSDOM success is project-generated
evidence, not measured external integration time or adoption.

A future pilot should proceed only with a willing independent maintainer who has a
specific recovery job, can integrate the public API, and chooses to retain the
integration after trying competent encrypted export. Record their actual effort,
required author help and operating responsibility. Stop if ordinary export is
preferred, device support fails, or the required recovery origin cannot be maintained.
No outreach or pilot recruitment has been performed for this plan.

The commercial hypothesis is an integration toolkit and implementation support.
There are no verified paying customers or product-market fit. The shared demo limits
bound stored records and admitted uploads, not HTTP traffic or bills; actual Sites
pricing is unverified. See delivery/ADOPTION_PLAN.md for current direct-Cloudflare
planning rates and the explicit unknowns.

## Judge access instructions

NEW TWO-APP ENTRY
https://continuitykit-try-primary.cryptomickle.chatgpt.site/apps/
https://continuitykit-try-reserve.cryptomickle.chatgpt.site/apps/
1. Choose Textarea, write a fictional draft and prepare it in B. Use an existing reserve passkey on this B site, or create a first one. Wait for independent verification.
2. Choose Markdown Studio, write a different draft and choose USE EXISTING RESERVE PASSKEY in B. Select exactly the same key; do not create another.
3. Close A and open the B chooser in a fresh page. Select each app, recover with the same key, edit and export. Recovery/export does not update the saved snapshot. Native confirmations may be multiple. New two-app native acceptance is pending; the software isolation and failure tests pass.

EARLIER NATIVE TEXT RESULT
https://continuitykit-try-primary.cryptomickle.chatgpt.site/text/
https://continuitykit-try-reserve.cryptomickle.chatgpt.site/text/
The builder reported iPhone recovery/export on 10 October after the instructed Mac-to-iPhone sequence. Server logs corroborate Mac upload and iPhone reads. Screens, key identity and file bytes were not independently inspected. See evidence/text-native-acceptance-2026-10-10.json. These records remain on their original route.

REPLAY THE OPERATOR REPLACEMENT
https://github.com/CryptoMickle/continuity-kit/tree/main/account-reserve
From that directory with Node 24+: npm ci --ignore-scripts; npm run build:apps; npm run test:operator.
The test installs a separate SDK package, stops/removes the old host/store and recovers two exact documents from a replacement database with one synthetic key. It checks corrupted ciphertext and wrong origins. See operator/README.md, delivery/JUDGE_GUIDE.md and evidence/operator-portability-2026-10-10.json. Local replay is not a public-provider migration, human trial or audit.

SEPARATE MONAD LIVE PRODUCT
https://continuitykit-account-primary.cryptomickle.chatgpt.site/?model=iris
https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris
Claim: 0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5; testnet 10143, finalized block 69,286,156. evidence/public-proof.json. The 0.1 test-MON right is already claimed, not an open faucet or text activity.

Fictional examples only. All public Work/text/app routes share 64 records and 256 lifetime admissions. Access ends 10 November 2026, 00:00 UTC. Same operator/provider; expiry is not proof of deletion. Closing A is not an HTTP outage. Video and final submission remain deferred.

## Mera non-account explanation

One reserve passkey protects separate, useful private documents for two independently authored editor integrations: Textarea and EasyMDE/CodeMirror. B explicitly selects the existing key for the second app, with no new-credential fallback. Each app has a distinct fixed appId, opaque locator, manifest key and text key. Recovery returns text/integrity data only: no EOA, account vault, owner address or signing session.

Mera 0.2.0 performs the discoverable user-verified passkey PRF ceremonies. WebCrypto performs HKDF and AES-256-GCM. The protocol is account-continuity/text-reserve-v1. Its PRF salt is the fixed SHA-256(protocol + /prf), not an app-specific salt. HKDF salt hashes canonical protocol/configuration/credential-ID data; appId, exact recovery origin/RP and distinct purpose labels separate key domains. This preserves earlier text-v1 record compatibility. Same-origin B code is trusted for all app domains; this is not isolation from malicious B code.

Preparation receives an explicit short-lived one-use key handle, writes at most once, checks exact ciphertext readback and performs a new discoverable assertion/decryption before readiness. Existing app records cannot be overwritten. Denied selection, cancellation or unknown write does not create another credential or silently retry. Device prompt counts vary.

Automated proof: one synthetic credential creates two distinct immutable app records; substitution fails; both reopen after the original operator process/store are replaced. The installed public SDK runs in fresh processes; transfer contains ciphertext/public binding, never plaintext, passkey secrets or PRF output. This is local software evidence, not native passkey or provider-independence proof.

Native evidence retained separately: on 10 October the builder reported iPhone recovery/export of text-v1 after the instructed Mac Safari-to-iPhone same-key sequence. Logs corroborate Mac upload/reads then iPhone reads. Same-key identity, marker and exported bytes were not independently inspected; redacted locators cannot link those requests. New two-app native reuse remains pending. See evidence/text-native-acceptance-2026-10-10.json and evidence/operator-portability-2026-10-10.json.

This is a prepared immutable snapshot, not automatic sync or lost-passkey recovery. Compatible PRF, the surviving key, exact B origin, trusted client and surviving ciphertext remain required.

## Remaining submission boundary

The 10 October acceptance update was saved at 09:36 UTC and verified after reload.
Text sites are published; source commands refer
to the current tree. Native text-v1 iPhone recovery/export is builder-reported with
the server corroboration and limitations above. Technical demo and
pitch videos remain absent; final submission is explicitly deferred. No external
adoption, measured human onboarding time, independent audit or demand proof is claimed.

The portal was observed on 9 October with a deadline of 14 October 2026, 05:59 GMT+2;
recheck before final submission. Demo access expiry is separate from retention cleanup,
and no future cleanup execution is claimed.
