# Metropolis entry — text-v1 draft, updated 10 October 2026

**Saved to the portal and verified after reload at 21:52 UTC, 9 October 2026.**
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

An unfinished draft should remain useful when the app holding it disappears.
ContinuityKit lets a developer prepare an encrypted text snapshot that a separate
client can later discover, open, edit and export using a surviving recovery passkey.
The new text path creates no EOA, account vault or signing session.

The preferred published entry is the text workspace at
https://continuitykit-try-primary.cryptomickle.chatgpt.site/text/ and its reserve at
https://continuitykit-try-reserve.cryptomickle.chatgpt.site/text/. Both pages were
observed live. A rendered at mobile width and exported edited TXT/JSON that matched
exactly; admission and cancellation before native creation were checked. No passkey
ceremony was called in those automated UI checks. On 10 October the builder reported
successful iPhone recovery and export after the instructed Mac Safari → iPhone Safari
same-passkey text-v1 sequence. Server logs corroborate admission, upload and two reads
from Mac Safari at 09:29 UTC, then a successful iPhone Safari reserve read at 09:30 UTC.
The device screens, same-key identity, requested marker and exported bytes were not
independently inspected; redacted log locators cannot link both devices to one record.
See evidence/text-native-acceptance-2026-10-10.json. This is builder acceptance with
server corroboration, not external adoption. Closing A is not an HTTP outage.

The packaged text SDK is integrated into an isolated copy of Anton Medvedev's
MIT-licensed Textarea editor. The actual editor supplies one document, without
invented project fields or an account. A clean consumer installs the SDK tarball and
uses its public text APIs. Local checks execute the upstream editor in JSDOM, make
A's frontend/API return 503, recover in fresh OS processes given only B's origin,
continue editing, and read back TXT/JSON bytes. The credential and server are
synthetic; the file picker is emulated. This is an agent-built integration into
independently authored code, not upstream adoption or endorsement.

Mera 0.2.0 supplies discoverable, user-verified passkey PRF ceremonies. WebCrypto HKDF
binds the protocol, application configuration and selected credential, with separate
purposes for discovery, manifest encryption and text encryption. Preparation writes
once, compares the stored bytes and performs a new discoverable assertion and
independent decryption before reporting ready. Recovery returns text and integrity
metadata only. An interrupted write is checked through recovery, never retried by
automatically creating another passkey.

Earlier proofs remain separate. The older Work v1 flow recovered all five fields in
a fresh Mac Codex-browser page while A's frontend/API returned 503 before and after;
account signing stayed locked. Same-passkey iPhone recovery of that prepared
project/client is user-reported. The earlier self-service Work flow also has
builder-reported iPhone setup, fresh-page recovery and edited TXT export, with
backend upload/read corroboration. Neither result proves native text-v1 acceptance.

Account Reserve separately recovered a beneficiary already entitled to 0.1 test-MON
and collected that right once on Monad testnet. Two configured RPC providers agreed
on the finalized receipt and claimed state. A separate local Work/payment example
uses a disposable chain; text recovery itself has no blockchain action, and editing
a draft does not earn that payment.

A functioning encrypted-file baseline protects the same text with the same available
credential and is saved/imported before outage. The new text-v1 drill executes six
conditions on both paths in 12 fresh recovery processes, with actual local A=503
before and after. Hosted discovery works without the file; a retained file works
without the reserve store. Healthy recovery uses one assertion each, with one HTTP
read for reserve and none for the file. Both edited TXT/JSON outputs are read back
exactly. Four regression tests passed. These are synthetic results, not native
prompt counts, measured human effort or evidence of preference.

This is a solo project developed with AI assistance. One immutable snapshot is not
automatic synchronization or lost-passkey recovery. Both hosted sites/storage have
one operator. External demand, willingness to pay, security audit and production
readiness remain unproven.

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

PREFERRED PUBLISHED TEXT ENTRY — BUILDER-REPORTED IPHONE RECOVERY AND EXPORT
https://continuitykit-try-primary.cryptomickle.chatgpt.site/text/
https://continuitykit-try-reserve.cryptomickle.chatgpt.site/text/
Edit fictional text in A; prepare in B with one new
reserve passkey; wait for the independent check; close/discard A's window state;
open fresh B and recover, continue and export. No operator code, account key, wallet,
faucet or funds. Multiple native confirmations may occur. Closing A is not an outage.

10 October acceptance: the builder reported successful iPhone recovery and export
after the instructed Mac Safari → iPhone Safari same-passkey text sequence. Server
logs corroborate Mac Safari upload/reads and a subsequent iPhone Safari reserve read.
The screens, marker, same-key identity and exported bytes were not independently
inspected; record locators are redacted. See evidence/text-native-acceptance-2026-10-10.json.

PUBLISHED SYNTHETIC PREVIEW
https://continuitykit-playground.cryptomickle.chatgpt.site/
No setup code, passkey or wallet. Real Work SDK encryption with explicitly synthetic
browser-local credentials/outage. This older preview is not text-v1 native proof.

SOURCE AND LOCAL DEVELOPER CHECKS
https://github.com/CryptoMickle/continuity-kit/tree/main/account-reserve
A separate agent downloaded revision 27df242f16dc96f9752f5e6b0bd918c85ca60467 into a fresh checkout and passed the documented install, build and consumer test. Two fresh recovery processes returned identical TXT/JSON bytes with zero requests to A. See evidence/text-public-install-2026-10-09.json. This is automated evaluation, not outside adoption or native-device proof.
Read delivery/JUDGE_GUIDE.md. integrations/textarea-text/
contains the account-free real-editor adapter. integrations/textarea/ retains the
older account-bound example. scripts/text-recovery-drill.mjs reproduces the current
text encrypted-file comparison; the older Work drill remains supplemental evidence.
Local checks do not replace native proof or establish outside adoption.

EARLIER SELF-SERVICE WORK AND PHYSICAL WORK REFERENCES
https://continuitykit-try-primary.cryptomickle.chatgpt.site/
https://continuitykit-try-reserve.cryptomickle.chatgpt.site/
https://continuitykit-work-primary.cryptomickle.chatgpt.site/
https://continuitykit-work-reserve.cryptomickle.chatgpt.site/
The homepage self-service Work flow uses an unfunded example account; its recorded
Safari acceptance belongs to Work v1. The older Work sites require their existing
passkey or an operator-issued enrollment code. Their physical outage evidence is in
evidence/work-public-proof.json. Those reserves do not migrate into text-v1.

SEPARATE MONAD LIVE PRODUCT
https://continuitykit-account-primary.cryptomickle.chatgpt.site/?model=iris
https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris
Claim: 0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5,
Monad testnet 10143, finalized block 69,286,156. evidence/public-proof.json.
The 0.1 test-MON right is already claimed; this is not an open faucet or text activity.

Text-v1 and homepage self-service Work share 64 encrypted records and 256 lifetime
admissions, not separate quotas per mode. Access ends 10 November 2026 at 00:00 UTC.
Expiry does not establish deletion. Both sites/storage have one operator. The native
text report is builder-run and scoped above. Video and final submission remain deferred.

## Mera non-account explanation

The useful result is an unfinished document reopened, edited and exported without
creating or recovering an account key. Mera 0.2.0 performs the passkey PRF ceremonies;
WebCrypto performs HKDF and AES-256-GCM. The text protocol is
account-continuity/text-reserve-v1.

Its PRF salt is a fixed protocol-wide SHA-256 of that name plus /prf. It is not an
app-specific PRF salt. HKDF's salt hashes canonical data containing the protocol
label, complete configuration and selected credential ID. Configuration binds the
app ID, exact recovery origin and RP ID. Distinct HKDF purpose labels derive the
opaque lookup material, manifest key and text key. Authenticated encryption binds
those inputs and the exact text digest; the document is accepted only after format,
policy, credential, authentication and UTF-8 checks. The independent read before
readiness uses a new discoverable assertion, not retained creation keys.

No account leaf, secret account vault, owner address or signing session exists in
text-v1. One passkey supports distinct useful non-wallet cryptographic purposes.
Prompt count varies by device; creation may require a fallback assertion, and the
independent check requires another assertion. On 10 October the builder reported
iPhone recovery and export after the instructed Mac Safari → iPhone Safari same-key
sequence. Worker logs corroborate Mac Safari upload/reads and a later iPhone Safari
reserve read. This is a separate text-v1 acceptance report, not evidence inherited
from Work or synthetic tests. Same-key identity, marker and exported bytes were not
independently inspected; redacted locators prevent server-side same-record linkage.
The report is in evidence/text-native-acceptance-2026-10-10.json.

Storage receives encrypted records and enrollment metadata. The editors see plaintext
in memory, and intentional exports create plaintext local copies. The recovery origin
and client remain trusted dependencies. This is one prepared immutable snapshot,
with no automatic sync, lost-passkey recovery or guaranteed provider independence.

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
