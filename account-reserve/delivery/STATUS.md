# Sequential payments: both claims verified and A restored — 10 October 2026

The additive payment integration passed 81 relevant tests. An actual local EVM
and SDK test collected two independently funded payments with the same account;
A returned HTTP 503 before a fresh recovery in B. No recovery credential was
created and stored ciphertext was unchanged. This is synthetic local evidence.

The new SequentialPayment contract is deployed on Monad testnet at
`0x47C8c753295AC4fBe4c23D9BD2dC899F61b66564`. Its first 0.01 test-MON obligation is
funded for the existing beneficiary. Both issuer transactions are finalized and
corroborated on the two fixed RPCs. The first beneficiary claim is now finalized
in block `69905019`: `0xeba6bdebb6d0944d8d6f02d284a6c7b325e478ded63216cb1756ed2bd0aa8600`.
The operator verified the exact signed envelope, sender, amount, nonce, event,
canonical block and contract state through both RPCs. The second obligation is
now funded after a recorded operator-controlled original-app HTTP 503.
Funding hash: `0xa7a1b3a83272f2a655670a1965aaf5161375f9a7a4075402fccfef28045e8d63`, block `69912000`.
The second claim is finalized in block `69914955`:
`0xf263554671e28415d0b9aa3f76e607dce987bd903f94d981a4bab1a2615da1b2`.
The public read-only verifier returned `paymentVerified: true` using both pinned
RPCs, checking the exact signed envelope, beneficiary, amount, nonce, event,
canonical finalized block and claimed state. Both 0.01 test-MON payments settled
to the same beneficiary. The builder reported completing the instructed B flow
with "betaling mottatt"; device and prompt count were not specified or observed.

A returned HTTP 503 before funding at 19:43:38.674 UTC and again after the claim at
20:00:49.011 UTC, while B returned HTTP 200. Claim2's block timestamp is 19:59:55 UTC.
These are observations bracketing a controlled outage, not continuous monitoring.
A's original saved version 5 was redeployed with only the temporary outage flag
removed. All eight A/B routes returned HTTP 200 at 20:02:11.110 UTC; both config and
payment-profile byte hashes matched the pre-outage baseline. B was not redeployed.

The existing Account Primary and Reserve Sites now serve additive `/payments/`
pages. Legacy code, origin/RP/namespace bindings, passkeys and stored records remain
unchanged. Unknown signed outcomes close the signer and leave read-only checking;
there is no automatic resend. Do not ask the user to repeat the first claim.
The receipts establish settlement, not the physical device or prompt count.
Anonymous public-source replay of commit
`309f62e552ecb6bafbc841afcc1fe5928cd40d3b` passed 135 base, 72 payment and
119 native tests, plus application/payment/multi-app builds and installed consumers.

The new `payments/verify-claim.mjs` lets an integrator verify an explicit public
profile, right and transaction hash through the same fixed two-RPC guard without
a wallet, passkey or local journal. It distinguishes a verified payment from
pending, reverted and failed checks; only `paymentVerified: true` is success.
Nine new boundary tests passed, with a separate internal review. Both source-package
checks passed, including a fresh offline install and 64 payment tests from the
extracted archive. The CLI also verified the real first claim using the public
profile downloaded from B. It has now also verified the second public claim.
The verifier itself required no change to either Site's browser flow.

The user authorized continuing the bounded testnet proposal. Only its second
issuer funding was sent in this continuation, after fresh checks; no resend or
journal reset occurred. A is restored; no native step remains pending for this
bounded two-payment demonstration. Existing passkeys and reserve records were not
modified by these operations. No additional transaction was sent during closure.

This closes an implementation gap, not the demand gap. Test funding and claims do
not establish organic transactions, customers, sponsor acceptance or prize odds.

---

# Transaction value takes priority — 10 October 2026

The user reiterated that the previous hackathon loss was caused, in their account,
by a product that did not generate transactions. This is a user-reported lesson,
not independently verified judge feedback or a formal current eligibility rule.

The current text collection/replica work generates no blockchain transactions.
The separate Account Reserve proof records one historical testnet payment already
claimed. Code inspection confirms the demonstration is bounded to one right per
beneficiary and a right-1/nonce-0 executor. It cannot presently demonstrate recurring
transactions for the same account. Recent operator improvements do not close this gap.

Product priority now precedes further general operator polish: evaluate and build
a narrowly scoped recurring payment integration using account continuity. The
candidate is multiple separately funded obligations to the same beneficiary, with
an ordinary claim before an outage and an outstanding claim through the reserve
after A is unavailable. This is a hypothesis, not proven demand. Preserve the old
contract/executor and all public credentials; use a separate validated adapter if
the candidate proceeds. Text recovery remains a useful account-free Mera example.

The testnet authorization permits necessary development transactions. Repeated test
claims, deployment counts and arbitrary chain receipts are not external activity.
Clean public-source replay remains a release gate. No wallet transaction, hosted
change, video, pitch or final submission was performed during this priority update.

---

# Actionable operator diagnostics — 10 October 2026

The native integration now explains why an existing operator cannot start. A
read-only preflight distinguishes mismatched app/profile bindings, private file
permissions, invalid state, runtime locks, built assets and occupied local ports.
The launcher presents the same guidance before starting child services. It does
not rewrite a profile, repair permissions, delete a lock or choose another port.

**119 relevant tests passed, with no failures or skips:** the previous 107 native
regressions, 11 new diagnostic boundary cases and one installed-package case with
nine API/CLI scenarios. An independent internal review repeated the 12 diagnostic
cases; repeats are not counted as additional tests.

A freshly installed SDK generated another fresh consumer, installed offline and
built its assets. The actual diagnostic API and CLI agreed on the failure reasons.
State bytes, file permissions, inode identities, modification times and database
counters remained unchanged. Live and stale locks were retained. An unrelated
listener received no probe connections and remained usable. Startup independently
rejected a lock or occupied port introduced after a successful preflight.

Review also improved required-file handling: private files are checked before
opening and read in bounded chunks through a no-follow descriptor, then checked
for concurrent replacement or mutation. Unreadable private files now get permission
guidance, and the CLI preserves the raw state path for traversal checks. Existing
public error codes are unchanged; reports contain only fixed messages, check IDs
and validated port numbers, never secrets or arbitrary filesystem errors.

Optional port checks briefly bind and release validated loopback ports. Their
result is advisory, not a reservation or service identity check. A lock's presence
does not establish its owner or whether that owner is still running. This is
local installation and operational evidence, not physical-device acceptance,
cryptographic recovery proof, independent hosting or external adoption.

Existing public Sites, passkeys and snapshots are unchanged. No wallet transaction,
spending, video or final submission was needed. Necessary testnet transactions are
now authorized by the user for later development and verification.

Next: verify the published source can reproduce the documented native integration
from a clean checkout, and address any observed installation or operation failure.

[Native operator guide](../text-native/README.md) ·
[Validation and limits](../evidence/native-operator-diagnostics-2026-10-10.json).

---

# Managed operator backup and restore — 10 October 2026

The native package can now export every configured encrypted replica and restore
it into a new private operator state directory. The fixed app/origin/RP profile,
expiry, ciphertext and consumed quota survive. Fresh administrator invitations
replace the old ones, and outstanding upload grants are not transferred.

Backup requires a stopped managed stack and takes the launcher's exclusive lock.
Restore requires the original profile and a separately retained SHA-256 digest.
Every bounded transfer is checked before state creation; a final manifest makes
successful state usable. Existing state is never overwritten. Interrupted imports
remove only owned files and preserve unexpected competing files.

**107 relevant tests passed, with no failures or skips:** 87 native regressions,
14 new backup boundary cases, 4 deterministic race cases, one installed restoration
case and one private packaging case. Repeated independent runs are not added again.

The installed SDK generated another fresh consumer, installed offline and ran the
actual backup/restore commands. Two app snapshots were recovered and exported
exactly using the same synthetic credential after the original state path was
removed and the original app listener stopped. Recovery also succeeded after one
restored store was killed. Each collection used one SDK assertion, no recovery
writes or source grant files. Old unused grants received HTTP 403; full consumed
quota remained, with zero transferred capability rows.

Review found and fixed a package boundary flaw: the previous broad native folder
inclusion could package private runtime files. Native SDK packaging now uses an
explicit file allowlist that survives installation and repacking; source and
generated projects also exclude private state and build output. Four actual
archives with fictional secret sentinels were inspected. No real secrets were
used for that check, and no private runtime data is part of this source publication.

This proves a local migration into new state, not transfer between physical
machines, native passkey compatibility or independently operated providers. The
same B origin/RP and usable credential remain required. A retained digest proves
neither author identity nor freshness; old backups and parallel restored forks
can roll back/fork effective quota. Backups must be retained outside the failed
host by the operator. Existing public Sites, passkeys and snapshots are unchanged.

Next: actionable operator diagnostics. A changed profile and insecure file
permissions currently collapse into one generic startup error. A read-only
preflight should tell an integrator which correction is needed while leaving
files, ports and runtime locks untouched.

[Operator backup guide](../text-native/README.md#back-up-and-restore-the-complete-operator) ·
[Validation and limits](../evidence/native-operator-backup-2026-10-10.json).

---

# Native collection integration package — 10 October 2026

The generated native package now supports 2–8 fixed app reserves in one recovery
view, with 2–3 encrypted storage copies. Each app keeps its original namespace;
one deliberate SDK assertion opens the collection and returns separate app results.
The v1 single-app package, persisted operator bindings and published Sites are preserved.
This is source development; no new native collection was deployed or physically tested.

**87 relevant top-level tests passed:** 60 existing native regressions, 7 new
profile/operator/host cases, 18 collection UI cases and 2 installed-package/process
integration cases. Internal independent review repeated the changed boundaries
without finding a remaining blocker; repeats are not counted as additional tests.

The installed replay started the durable operator four times using the same private
state and opened nine fresh recovery processes. Three imported the installed UI
and exercised the real SDK, actual B/gateway/SQLite reads and exact TXT/JSON Blob
exports. A was made unavailable by closing its owned listener; one store was
terminated. Healthy sibling apps remained usable when another app was corrupt or
missing. Database bytes and counters stayed unchanged during each read.

The native frontend has no teaching authenticator, issuer or failure-control routes.
App-specific permission bundles are checked before any credential gesture. The
underlying opaque storage tokens are not cryptographically app-scoped. Selecting
an existing passkey never falls back to creating one. A now has an explicit cancel
button which preserves its draft and export without waiting for the setup timeout.
Already-open work remains exportable after profile expiry; page exit clears it.

Actual browser checks confirmed the Prism layout at 390 and 1280px with no horizontal
overflow, A-to-B setup navigation, invalid permission rejection and cancellation.
No physical passkey or upload permission was requested. The temporary native preview
was stopped; existing hosted flows and credentials were untouched.

The next milestone is a complete private operator backup/restore path. Both local
replicas still share one machine; restoring the managed state elsewhere is the
remaining operational gap. This will reuse the existing low-level encrypted
database export/import rather than change the snapshot protocol.

[Integrator guide](../text-native/README.md#several-app-reserves-with-the-same-native-passkey) ·
[Validation and limits](../evidence/native-collection-package-2026-10-10.json).

---

# Collection browser reference — 10 October 2026

The text starter now has a `--collection-replicas` mode: two app drafts,
one deliberate recovery action, and two authenticated storage copies per app.
It runs as an installed public-SDK consumer with the existing Prism design.
Each app has its own editor, TXT/JSON exports and per-store outcome. A missing,
corrupt or conflicting app stays closed without hiding the healthy sibling.

Both app policies, recovery origins and store routes are fixed and validated.
Whole-batch result validation precedes any text rendering. Close, cancel, page
exit and expiry clear exact-byte editor adapters and retained export URLs.
Late operation and process-status responses cannot repopulate a closed view.
There is no automatic key creation, retry, repair or browser persistence.

The actual browser flow prepared both examples with one shared simulated key,
then recovered both in a fresh document while A returned HTTP 503 and Alpha's
storage process was stopped. Altering one app's only available ciphertext kept
that app closed while the other remained usable. Bringing the intact store back
made both drafts recoverable again. Responsive checks at 390 and 1280 CSS pixels
showed no horizontal overflow. Browser export buttons were exercised; exact
export bytes are established by the separate installed UI tests, not by a
verified browser download file.

Validation passed 75 relevant top-level tests: 19 UI behavioral cases, one
installed-package integration, five new host-boundary cases and 50 existing
focused regressions. An internal reviewer independently replayed the UI and
installed package; those repetitions are not counted again.

The installed proof generates the package from an installed SDK, installs
without network, builds and runs its doctor. Four fresh recovery processes and
six fresh DOM UI sessions exercise actual B HTTP routes, gateway and separate
SQLite processes with A unavailable. Exact original and edited TXT/JSON exports,
no recovery writes and unchanged database bytes/counters are verified. Internal
review also covers result validation, lifecycle races and the new host bounds.

This remains a local synthetic reference. It adds no hosted deployment, native
multi-app device proof, independent-provider claim or external adoption.
Published Sites, existing physical passkeys and immutable records are unchanged.
The next step is a native collection package with explicit fixed app/storage
configuration; video and final submission remain deferred until Monday.

[Collection walkthrough](../text-starter/README.md#two-apps-one-recovery-action-two-stores) ·
[Validation](../evidence/text-collection-browser-validation-2026-10-10.json).

---

# Collection recovery from surviving copies — 10 October 2026

The additive `recoverTextReservesFromReplicas` API opens 1–8 prepared app
namespaces with one existing passkey assertion, checking two or three configured
storage copies per app. Per-app key derivation and immutable text-v1 records are
unchanged. Healthy siblings remain available when another app is missing,
unavailable, corrupt or has conflicting authenticated records. Cancellation or
credential failure rejects the entire call without returning partial text.

All app policies and read methods are captured before the credential operation.
At most 24 bounded reads run concurrently; raw PRF bytes are erased before they
begin. Every candidate is authenticated inside the SDK. The operation performs
no writes, repairs, new-key creation or automatic retry. One API assertion does
not establish one physical device confirmation.

Final validation passed **231 top-level tests**: 213 existing regressions plus
17 new unit tests and one installed-package integration. The installed package
also replays those unit tests and strict TypeScript examples; they are not added
to the top-level count. Four fresh recovery processes use the actual B host,
gateway and separate SQLite storage processes. Both apps export exact TXT/JSON
after one store is terminated. Corruption of the remaining copy for one app
rejects only that app; loss of both stores produces no exports. Every recovery
phase preserves database bytes and counters and uses only B GET requests.
Original-app access was forbidden, but this test did not run an A outage server.

Internal review found and fixed an error-handling edge where a hostile provider
exception could stop waiting for sibling reads. All bounded replica callbacks
now settle before results are selected. A separate agent reviewed source, types,
integration guidance and the existing preparation guarantees. This is internal
engineering validation, not external adoption or an independent security audit.

The tests use synthetic credentials with real SDK cryptography. The native
starter still presents one app and the published collection still uses one
store. Public Sites, existing passkeys and saved reserves are unchanged. The next
milestone makes the combined capability usable in a runnable browser reference.
Video and final submission remain deferred until Monday.

[Developer recipe](../sdk/COLLECTION_REPLICAS.md) ·
[Final validation](../evidence/text-collection-replica-validation-2026-10-10.json) ·
[Installed proof](../evidence/text-collection-replica-installed-2026-10-10.json).

---

# Native operator onboarding — 10 October 2026

The native text package now creates private storage once and starts its frontends,
gateway and separate SQLite storage processes with one documented command. It
checks the original profile, private files, ports, assets and full configured read
path before reporting ready. It never automatically creates a passkey, issues an
upload permission, resets a database or repairs a snapshot.

A store failure after readiness leaves B and healthy storage running. Status
changes to degraded, or unavailable if every store stops. Initial incomplete
startup closes only owned resources; ordinary stop/restart preserves existing
ciphertext, invitations and quota. Repeated terminal signals and occupied ports
are covered, including a regression for five consecutive signal-heavy restarts.

The final native suite passed **60/60**. A separate installed-package replay ran
the documented initialization, build, start, read-only check and stop/restart
commands with unchanged stored bytes, counters and private-file timestamps. Agent
review is internal review, not an external security audit or developer adoption.

A separate integration used the installed public SDK and real encrypted text,
terminated one actual owned store, then recovered and exported exact TXT/JSON in
a fresh process using only B GET requests. No original-app request or upload
grant was used during recovery. A was not shut down in this particular drill.
When both stores stopped, recovery failed without exporting text. This test used
a synthetic credential; no physical passkey ceremony occurred.

Readiness checks compare stored responses and configuration; empty or identical
responses do not prove store identity or authenticated plaintext. The local stack
still shares a machine, gateway and recovery origin. Public Sites, their passkeys
and saved reserves are unchanged; the new package is not a hosted deployment.

[Operator guide](../text-native/README.md) ·
[Final validation](../evidence/native-operator-onboarding-2026-10-10.json) ·
[Independent installed replay](../evidence/native-operator-independent-2026-10-10.json).
Next: combine multiple-app recovery with authenticated replicas. Video and final
submission remain deferred until Monday.

---

# Native text integration package — 10 October 2026

The new `create:native-text` generator creates a standalone installed-SDK consumer
with native WebAuthn, two separately built role directories, and two or three
fixed storage routes. A validated profile binds the exact A/B origins, app ID,
recovery hostname and expiry. The teaching authenticator and fault controls are
excluded from deployable assets. Existing public Sites and reserves are unchanged.

A private operator tool prechecks each store and issues short-lived, single-use
upload grants into a new private file. B validates the bundle before a separate
passkey button; fresh recovery requires no upload permission. The public host
exposes only bounded GET/PUT reserve operations and static built assets. It does
not expose enrollment issuance or arbitrary upstream targets.

The final suite passed 30/30, including clean offline installation of the installed
generator, both builds, tampered/missing/symlinked asset rejection, profile and
grant boundaries, browser lifecycle, actual temporary SQLite stores and gateway
routing. A separate agent also passed 30/30 before the final empty-editor polish;
the final suite and frontend review cover that change. Two build/doctor defects
found during review were corrected before completion.

Browser QA verified A-to-B handoff, invalid permission rejection, fresh recovery
without a grant, and mobile layout without horizontal overflow. No native
credential was requested and no upload grant was issued during browser QA.
This package is not deployed or physically accepted; earlier native evidence
belongs to the previous public versions. Separate-provider operation is unproven.

[Guide](../text-native/README.md) ·
[Final evidence](../evidence/text-native-package-validation-2026-10-10.json) ·
[Independent replay](../evidence/text-native-package-independent-2026-10-10.json).
Video and final submission remain deferred until Monday. Next development target:
a repeatable operator launch/preflight that reduces manual configuration without
opening public admission or automatically requesting passkeys.

---

# Replica browser reference — 10 October 2026

The text starter now has an optional `--replicas` mode with a full A-to-B browser
handoff and two actual SQLite child processes. Both configured copies must pass
independent verification before preparation becomes ready. Recovery authenticates
every candidate and can open a valid survivor while another store is stopped or
returns altered ciphertext. Conflicting authenticated copies stop without text.

The browser shows per-copy verification separately from process availability.
Storage controls require the local draft to be closed first. Changing storage
clears old verification results; unknown writes never trigger automatic retries,
repair or new credential creation. Existing single-store APIs remain unchanged.

Validation: 29 final replica browser/backend/UI/installed-generator cases passed.
The default starter and existing browser/replica regressions also passed (62 cases
before the final conservative diagnostic hardening). An independent clean package
replay passed 17 browser tests plus strict TypeScript. The installed generator's
consumer ran four fresh recovery processes using only B's address/output folder,
with exact exports and write attempts blocked by the recovery transport.

Browser QA completed setup, closed the setup tabs, recovered with A unavailable
and Alpha stopped, rejected altered Alpha while opening Beta, and displayed no
plaintext when only altered Alpha remained. Restarting Beta restored recovery.
390px layout had no horizontal overflow. TXT export was requested in the browser;
its resulting download file was not confirmed. Exact TXT/JSON exports are covered
by the automated proof.

[Validation scope](../evidence/text-replica-browser-validation-2026-10-10.json) ·
[Installed SDK replay](../evidence/text-replica-browser-installed-2026-10-10.json) ·
[Walkthrough](../text-starter/README.md#optional-two-store-browser-example).
This is a disposable local synthetic reference, not a hosted/native credential
service. The parent credential, B frontend, gateway and machine remain shared.
Public Sites and existing reserves are unchanged. Next: a separately buildable
native replica integration, with no synthetic endpoint in its deployable assets.
Video and final submission remain deferred until Monday.

---

# Account-free developer starter — 10 October 2026

The new `npm run create:text-starter -- /absolute/empty/directory` generates a
standalone consumer of the public text SDK with pinned tarball and lockfile.
Its editor contract is `getText()` / `applyText(text)`. It includes A-to-B setup,
independent opening, continued editing and TXT/JSON export, plus a doctor that
checks configuration, installed SDK, build, live origins and port conflicts.

Final validation passed four package/UI cases, including two fresh recovery
processes given only B's origin/output directory, A returning HTTP 503, exact
UTF-8 exports and unchanged snapshots. A separate agent packed/installed the SDK
and ran the installed generator, offline install/build/doctor/test in empty
folders. Review found and fixed a macOS path-alias CLI bug and late pagehide
configuration state; cancellation and uncertain-write behavior are covered.

Browser QA completed the popup handoff, closed both setup tabs, reopened B while
A's page/API returned 503, recovered the original text, edited it and read back
the downloaded TXT exactly. JSON export was requested in the browser; its local
file completion was not confirmed, and exact JSON is covered by automated tests.
The final build also passed close/reopen and 390px layout checks.

[Validation scope](../evidence/text-starter-validation-2026-10-10.json) ·
[Installed-package replay](../evidence/text-starter-installed-package-2026-10-10.json) ·
[Starter guide](../text-starter/README.md).
This is a disposable synthetic local example, not a hosted/native passkey server.
The two origins share a process and RAM. Public Sites and existing reserves are
unchanged. Next: a runnable replica browser reference using durable local stores.
Video and final submission remain deferred until the user's Monday review.

---

# Authenticated replica SDK and operator gateway — 10 October 2026

Added optional preparation/recovery across two or three configured stores using
unchanged text-v1 ciphertext. Preparation only returns ready after every intended
copy passes exact readback and independent passkey decryption. Recovery uses one
assertion and authenticates every candidate; a valid survivor can open despite a
failed/corrupted peer. Divergent authenticated ciphertext rejects as a conflict,
even if the plaintext happens to match. Unknown writes are never retried.

The standalone operator package now contains a fixed-route, loopback-only gateway
for separate SQLite store processes. It forwards bounded operations, requires
separate upload capabilities and does not select, decrypt, repair or retry records.
The bundled browser UI and public Sites retain their current single-store setup.
No existing passkeys, records, domains or public storage configuration changed.

Validation: 100 SDK/collection/browser tests, eight gateway tests and six existing
operator tests passed; strict TypeScript and the two-app browser build passed.
The installed-SDK drill used real operator/gateway processes and two durable SQLite
files. Three fresh-client exports matched exactly: healthy, one process stopped,
and one persisted ciphertext corrupted. When only the corrupt copy survived,
recovery rejected with no export. Recovery clients received neither expected
plaintext nor locators; all four recovery/rejection runs used one synthetic
assertion, no creation and no writes. A separate agent reviewed the SDK.

[Process-failure proof](../evidence/text-replica-process-proof-2026-10-10.json) ·
[Validation scope](../evidence/text-replica-validation-2026-10-10.json) ·
[Operator guide](../operator/README.md#optional-replicas-for-a-custom-text-integration).
This is local engineering evidence, not native-device validation, separate-provider
independence, automatic ongoing backup, external adoption or a security audit.
Next development block: a small account-free text SDK starter. Video and final
submission remain deferred until the user's Monday review.

---

# Collection recovery published — 10 October 2026

The Reserve `/apps/` page now checks both prepared app snapshots using one
intentional SDK passkey assertion. Recovered drafts can be edited, switched and
exported on the same page. Missing, unavailable and rejected records are distinct;
one failed record does not hide a healthy sibling. This does not guarantee a
single device prompt. Existing single-app routes, passkeys, records and v1
cryptographic format are preserved.

Both Sites are version 8. Validation passed: 79 SDK tests including existing text
flows, 34 UI tests including existing app flows, seven host/editor tests, and a
separate installed-package replay with 14 tests plus strict TypeScript. Forty
read-only public checks matched the staged configuration and assets. A second
code review checked cancellation, page lifecycle and exact no-edit export,
including real EasyMDE BOM/CRLF handling. Mobile browser QA used a local synthetic
fixture; the published page was read back without invoking a native credential.

[Collection validation](../evidence/collection-validation-2026-10-10.json) ·
[Installed SDK](../evidence/collection-installed-sdk-2026-10-10.json) ·
[Public HTTP checks](../evidence/collection-public-http-2026-10-10.json).
The new collection flow has not received a builder-run physical passkey check;
earlier iPhone results below keep their original scope.

The user has prioritized substantive development until Monday 12 October, with
video and final polish afterward. Next: authenticated recovery from surviving
replicas, then an account-free text SDK starter. No external adoption or prize
outcome is claimed. Video and final submission remain deferred.

---

# Two-app reuse and operator replacement — 10 October 2026

## Native two-app acceptance completed by builder report

The builder explicitly confirmed `Test B fra iPhone` in the Markdown reserve,
then reported `textarea klar` after instructions to wait for independent setup
verification. Following fresh-B recovery, marker checks and export instructions,
the final report was **“begge gjenopprettet og eksportert”**. This completes the
builder-reported Safari-on-iPhone acceptance sequence for both editor integrations.
The flow instructed reuse of the same existing key; credential identity and
downloaded file bytes were not independently inspected.

Later iPhone server metadata corroborates a Textarea preparation sequence at
11:39 UTC (PUT 201 and two GET 200 responses) and a fresh Textarea page plus
successful read at 11:41 UTC. The earlier Markdown write/readback is retained in
the missing-snapshot incident. Redacted locators prevent cross-request identity
correlation. This is not external adoption or independent usability testing.
See [native acceptance evidence](../evidence/apps-native-acceptance-2026-10-10.json).
No runtime changed for this evidence update. Video and final submission remain deferred. The description, judge instructions and Mera explanation were saved to the portal at 11:44 UTC (13:44 Oslo). All 13 text fields matched after reload; ten were preserved. Checklist remains 5/6. [Portal readback](../evidence/apps-native-portal-saved-2026-10-10.json).

## Historical interruption — 12:48 Oslo time; followed by completion above

The builder supplied an iPhone screenshot showing a missing snapshot. Recent
server metadata shows Textarea setup admission without a subsequent reserve read
or upload, then Markdown admission followed by PUT 201 and two successful reads.
A fresh Textarea lookup later returned 404. This is consistent with incomplete
Textarea preparation; it does not establish credential identity or export success.
The builder has been asked to open Markdown directly with the existing key.
See [scoped incident](../evidence/apps-native-missing-2026-10-10.json).

A UI defect was confirmed: fresh B painted prior steps as complete without having
observed setup. The correction keeps unobserved steps neutral, names the current
app inside the recovery panel, and offers read-only links after a missing lookup.
The 26 app/editor tests pass. Cryptography, storage bindings and existing records
are unchanged. The automated and earlier text-v1 results below do not close this
new native acceptance gap.

The correction is published on both Sites as version 7. Forty public HTTP checks
passed; a fresh Textarea B page at 390px showed its app label, step 3 active and
no steps marked complete. [UI verification](../evidence/apps-progress-fix-2026-10-10.json).

## Earlier release record

The new `/apps/` routes are published on the existing Primary/Reserve Sites.
They run pinned Textarea and EasyMDE/CodeMirror editors with explicit first-key or
existing-key preparation. Old `/text/` and Work routes, record bindings, shared
limits and database schema are preserved. The native two-app ceremony remains
pending; earlier physical reports do not cover it.

The operator package and installed-SDK local replacement drill passed: original
process stopped before export, temporary original DB removed, new DB/process at
the same origin, both exact documents recovered in a fresh process. Transfer
contains no plaintext/key/invitation; tampering and wrong-origin access reject.
This is synthetic local evidence, not a public-provider migration or audit.

Description, judge instructions and Mera explanation were saved at 10:18 UTC; all 13 fields matched after reload, with ten unchanged. Checklist remains 5/6. Video and final submission remain deferred. No external adoption is claimed.

Both Sites are now version 6. Final public HTTP checks passed 40/40, including
exact compiled assets and preserved legacy routes. Actual Textarea TXT and
Markdown JSON exports were byte-checked in the browser; cancelling setup before
authentication stopped both windows. At 390px, the final Markdown editor has no
horizontal page overflow. A reproduced label-click formatting bug was corrected
and checked on the published page. No native authentication was invoked by the agent.

An anonymous download of public commit `c76a9a325efb27e8ba000c9d9dfc363ba825396f`
passed clean installs, build, 24 app/editor tests, six operator tests and standalone
package installation. The later one-line editor-label correction passed 24/24
again locally. The final clean operator archive contains the corrected build.
See [public replay](../evidence/apps-public-replay-2026-10-10.json),
[browser scope](../evidence/apps-browser-2026-10-10.json),
[HTTP proof](../evidence/apps-public-http-2026-10-10.json), and
[archive verification](../evidence/operator-delivery-artifact-2026-10-10.json).
See [operator proof](../evidence/operator-portability-2026-10-10.json) and the updated
[judge guide](JUDGE_GUIDE.md). Older dated records below retain their own scope.

---

# Text-v1 iPhone acceptance report — 10 October 2026

The builder reported **“Gjenopprettet og eksportert på iphone”** after instructions
for Mac Safari preparation and iPhone Safari recovery using the same new text passkey.
Worker logs corroborate Mac Safari admission/upload/reads at 09:29 UTC and an iPhone
Safari reserve read at 09:30 UTC. This is a builder-run acceptance report with server
corroboration, not an independently observed comparison of passkey identity, marker
or exported bytes. Record locators are redacted, so server logs cannot link the two
devices to one record. An earlier Mac integrated-browser setup ended unconfirmed;
it is not counted as successful preparation. No runtime or deployment changed.

Evidence: [text-native-acceptance-2026-10-10.json](../evidence/text-native-acceptance-2026-10-10.json).
The description, judge instructions and Mera explanation were saved to the portal at
09:36 UTC; all 13 text fields matched after reload, including ten unchanged fields.
Checklist remains 5/6 with videos absent. [Portal save](../evidence/portal-text-native-draft-saved-2026-10-10.json).
Video and final submission remain deferred. External adoption and demand remain unproved.

# Account-free text pages published — 9 October 2026

The preferred new entry is [text workspace A](https://continuitykit-try-primary.cryptomickle.chatgpt.site/text/)
and [text reserve B](https://continuitykit-try-reserve.cryptomickle.chatgpt.site/text/).
Both Sites version 3 deployments succeeded and `/text/` was observed on A and B.
A rendered at 390-pixel width; unique edited text was downloaded as TXT and JSON
and both files matched exactly. A-to-B admission reached **Create reserve passkey**.
Cancellation before native creation closed setup with the no-passkey status; fresh
B offered **Open my existing reserve**. **No native ceremony was called in these
checks. Text-v1 setup and Mac-to-iPhone recovery/export remain pending.** Earlier Work/Account
physical results below retain their scope and are not text-v1 acceptance.

[Public HTTP verification](../evidence/text-public-http-2026-10-09.json) passed
22/22 checks for configuration, preserved old routes and exact compiled assets.

Published implementation: a separate immutable text protocol and typed public APIs,
origin/source/nonce-bound browser handoff, exact UTF-8 text recovery, one write with
byte readback and independent passkey-based decryption before readiness. It creates
no EOA, account vault or signer. Its protocol-wide PRF salt is fixed; HKDF binds the
app ID, recovery origin/RP and credential ID, with separate lookup/manifest/text
purposes. [Protocol details](../sdk/TEXT_PROTOCOL.txt).

The real-editor integration in [integrations/textarea-text/](../integrations/textarea-text/README.md)
uses only the upstream Textarea document. Its clean SDK-package install/build and
synthetic/JSDOM tests passed, including A frontend/API 503, fresh-process recovery,
continued editing and TXT/JSON file readback. Browser/native passkey behavior is not
established by JSDOM. This is agent-built integration, not upstream endorsement,
external adoption or measured maintainer demand. The older account-bound Textarea
adapter and Work encrypted-export drill remain separate evidence.

The [clean public-source installation](../evidence/text-public-install-2026-10-09.json)
now passed at commit `27df242f16dc96f9752f5e6b0bd918c85ca60467` in a fresh downloaded
checkout and separate consumer. It caught and verified the repair of a README
build/test-order error. Two fresh recovery processes returned identical TXT/JSON
bytes without A requests. No development checkout was used. This agent replay does
not establish native passkey behavior or external adoption.

The new [text-v1 encrypted-file comparison](../evidence/text-drill-2026-10-09.json)
passed six conditions on both paths, using 12 fresh recovery processes and actual
A=503 checks before/after. The same text and credential protect both copies; the
baseline file is retained and independently imported before outage. Healthy recovery
uses one assertion each, with one HTTP read for reserve and none for the file.
Both edited TXT/JSON results were written/read back exactly. Four regression tests
passed. This is synthetic loopback evidence, not native acceptance or demand.

The new path reuses the existing self-service store and release: **64 records and
256 lifetime admissions shared across Work and text**, with at most 64 KiB per
record and access ending **10 November 2026, 00:00 UTC**. There is no second quota,
database schema change or migration of old reserves. Limits do not cap request
traffic or bills. Same operator and recovery-domain dependencies remain.
Expiry is not proof of deletion or cleanup execution.

The judge guide and saved portal entry lead with published text-v1 pages and mark
the native gap. Runtime source is published at commit `55321fa53f389d6772c699deb382bbfe9c0328e3`.
At 21:52 UTC on 9 October, five changed portal fields were saved and all 13 fields
read back after reload. The other fields were preserved. A follow-up at 21:58 UTC added the clean-public-install
result to judge instructions; all 13 fields were checked again. The checklist remains 5/6.
[Portal save evidence](../evidence/portal-text-draft-saved-2026-10-09.json).
Video and final submission remain deferred. Older dated records below are historical.

---

# Earlier self-service Work acceptance — 9 October 2026

The isolated public [self-service A](https://continuitykit-try-primary.cryptomickle.chatgpt.site/)
and [reserve B](https://continuitykit-try-reserve.cryptomickle.chatgpt.site/) now let a judge
prepare their own fictional snapshot without an operator code or wallet. The published
Safari correction passed 149 automated checks. The builder has confirmed setup, fresh-page
recovery with the existing passkey and edited TXT export on iPhone. Server logs corroborate
successful upload and subsequent reads; the device screen and exported bytes were not
independently inspected. This is not an independent participant trial, second-device proof
for this new credential or an A-service outage test.

Evidence: `evidence/self-service-iphone-setup-report-2026-10-09.json`.
At that checkpoint the judge guide started with this Work self-service flow. Its
native result does not establish the later text-v1 candidate. Video and final
submission remain explicitly deferred. Earlier dated records retain their original scope.

---

# Developer and judge update — 9 October 2026

The public [playground](https://continuitykit-playground.cryptomickle.chatgpt.site/) is deployed,
with real SDK encryption and explicit simulated credentials/outage. Desktop and 320/390-pixel
layouts were exercised; custom text was recovered, damaged ciphertext rejected and an edited
JSON download read back. It is not a new physical-passkey proof.

This source update adds the isolated upstream Textarea adapter, executable recovery/export
comparison and optional same-account local payment example. See `delivery/JUDGE_GUIDE.md`
for reproducible commands and individually scoped reports. The drill passed 10 checks and
9 regression tests; the local payment example passed 6 tests, including signing rejection
after closure. Public testnet and existing native Work services are unchanged.

Source publication completed at [commit `2e66b91a`](https://github.com/CryptoMickle/continuity-kit/tree/2e66b91a0e93db5cc513e82cc13f03b7f4e27739/account-reserve).
One anonymous archive check matched all 378 public blobs and all 240 staged files. The update
added 57 files and changed 7; 314 earlier blobs remained unchanged and none were deleted.
Evidence: `evidence/judge-source-publication-2026-10-09.json`.

The three prepared portal text fields were saved at 15:46 UTC on 9 October and checked after
reload. All 13 text fields matched; the Trust track, Mera selection and Monad live-product link
were retained. Checklist: **5/6; demo and pitch videos remain**. Evidence:
`evidence/portal-developer-update-saved-2026-10-09.json` and its PNG screenshot.
Video and final submission remain deferred. These completion records were written after the
source commit; the prior publication and portal records below remain historical.

---

> Work Reserve update, 9 October: the separate public Work Sites are published
> with native D1 storage. A fresh page in Codex’s integrated browser on Mac
> recovered all five original work fields and the matching prepared account
> while Primary A returned HTTP 503 before and after the visible recovery.
> Account signing stayed locked; no transaction was sent. Primary A was then
> restored and checked with HTTP 200. [Portable Work proof](../evidence/work-public-proof.json).
> Editing/export were separately verified, and the two missing copy sections were
> completed in the Mac editor with matching saved TXT/JSON exports. iPhone recovery
> with the same passkey is explicitly user-confirmed; direct device-screen/full-content
> and recorded live evidence remain pending. A fresh browser profile is untested.
> Work source is published at commit `3e3093456ebbf7765e40967b83b120a1cbc54b97`:
> https://github.com/CryptoMickle/continuity-kit/tree/3e3093456ebbf7765e40967b83b120a1cbc54b97/account-reserve.
> Anonymous download matched all 183 selected files; runtime source is unchanged
> from the validated candidate. Evidence: `evidence/work-source-publication-2026-10-09.json`.
> The portal draft was saved at 14:22 UTC on 9 October and reloaded at 14:23 UTC.
> All 13 text fields matched. Checklist: **5/6; only demo and pitch videos remain**.
> The logo, Trust track and Many Keys selection persisted; the bounty form is complete.
> Evidence: `evidence/portal-draft-saved-2026-10-09.json`. Form completion does not establish award eligibility.
> **No final submission or video was produced.** Both remain deferred.
> Historical Account Reserve milestones below retain their original scope and dates.

# Account reserve — leveransestatus

Source publication completed and anonymously verified on 8 October 2026: https://github.com/CryptoMickle/continuity-kit/tree/fdfd817176c87a760cd026f95bb449aad4d57195/account-reserve. MIT applies to original Account Reserve source; dependency notices are preserved. All 134 published file hashes matched. Earlier statements below about pending source licensing/publication are historical. The SDK remains unpublished on npm; the competition entry is not submitted and video is deferred. Evidence: `evidence/source-publication-2026-10-08.json`.

Oppdatert 8. oktober 2026. Dette er den nye kontoreserven, ikke den tidligere publiserte notatbackupen. Video er uttrykkelig utsatt.

**Den avgrensede offentlige prøven er fullført på Monad testnet.** Mens Primary A svarte HTTP 503, gjenopprettet en fersk B-fane den opprinnelige kontoen med eksisterende fysisk passkey og innløste rettighet 1 én gang. Begge faste RPC-er bekreftet samme vellykkede transaksjon, mottaker og sluttstatus. A ble deretter gjenåpnet og kontrollert med HTTP 200. Samlet native bevis fra Primary 3 / Reserve 2: `evidence/native-public-testnet-proof-2026-10-08.json`. En etterfølgende godkjent oppsettsretting er nå publisert som Primary 4 / Reserve 3, uten nye nøkler eller transaksjoner. Rettingen er lokalt verifisert med 318 tester; faktisk reduksjon i systembekreftelser er ikke målt. Dette dokumenterer én fungerende reserveflyt, ikke generell etterspørsel, produksjonssikkerhet eller premieutsikter.

## Implementert og prøvd lokalt

- Et eget SDK for forberedelse og gjenfinning av en kryptert reserve med Mera. En fersk B-klient finner reserven fra den eksisterende B-legitimasjonen, uten innlimt kontoadresse eller eksportfil.
- To selvstendig skrevne referansemodeller: direkte PRF-konto og ett utvalgt BIP39/BIP32-kontoblad. SDK-pakken er installert og prøvd i to rene lokale forbrukerprosjekter. Dette er ikke eksterne integrasjoner.
- En betalingsrettighet opprettes før reserven. Etter at A er utilgjengelig, finner B samme konto og utfører den allerede opptjente rettigheten. En annen konto avvises. Native overføring er prøvd på disponibel lokal EVM-kjede.
- Nettleserflyten er prøvd for begge modellene. Etter betaling og omlasting tilbyr klienten kontroll av samme transaksjon, ikke en ny sending. Signeringsøkten lukkes etter bekreftelse.
- SDK-, kontrakt-, handoff-, transaksjons-, HTTP- og Redis-kontroller. Redis-testene bruker en faktisk disponibel Redis-prosess; testnet-klienten prøves med kontrollerte RPC-svar. Samlet bevis og kildehasher ligger i `evidence/verification.json` og tilhørende logger.

Siste samlede kjøring etter oppsettsrettingen: **318 beståtte tester, 0 feil, 0 hoppet over** (135 kjerne/pakke, 71 utviklerpakke, 6 HTTP og 106 publiseringskandidat-tester). Alle seks stadier bestod, inkludert faktisk Redis-Lua-prøve. Nettverket var begrenset til loopback på OS-nivå. Kjøringen omfatter gjenbruk av opprettelsesresultatet og nettleserens delte kø mot de to faste testnettilbyderne. Dette er lokal, syntetisk verifikasjon; publisering og den tidligere offentlige native prøven er dokumentert separat nedenfor. Kjøringene på 290 og 303 tester er historiske.

Den automatiserte testpakken bruker syntetisk autentisering; den separate native prøven er beskrevet nedenfor. Fysiske system-/Face ID-bekreftelser er ikke utledet fra antall API-kall. Den nye utformingen er kontrollert i nettleseren ved 320, 390 og 1280 px, uten horisontal overflyt. Fysisk iPhone-prøve er fortsatt uprøvd for denne nye klienten. Se `evidence/design-review.json` for lokal flyt og omfang.

Det valgte Prism-designet er integrert i hovedappen og utviklerpakken: store gjennomgående fargelinjer, avrundede flater og egen reserveillustrasjon. Hovedhandlingen kommer før illustrasjonen på mobil. Tidligere visuell kontroll er dokumentert i `evidence/prism-integration.json`. Demokontroller er samlet under **Demo controls**. Tilgang, flere mulige passkey-bekreftelser og demoens slettedato er forklart ved handlingen; de skjules ikke av den nye utformingen.

## Ny utviklerpakke — 8. oktober

- TypeScript-deklarasjoner for kjernen og egne `/browser`, `/http-store` og `/preflight`-innganger. Ingen protokollendring.
- Oppsettskontroller for A/B med kontroll av konto, domene, vindu og engangsverdi; avbrudd og usikker lagring gir ikke falsk klarmelding.
- Ferdig HTTP-lagringsadapter med avgrensede svar, én skriveprøve per tillatelse og ingen automatisk gjentakelse.
- Lokal startpakke genereres med `npm run create:starter -- /absolutt/tom-mappe`. Krever Node/npm, men ingen databasekonto, Foundry, midler eller kjede. Forbrukeren bruker bare installerte, dokumenterte pakkeinnganger.
- Ren mappe ble generert, pakken installert offline, TypeScript inkludert deklarasjonene kontrollert, nettsiden bygget og samme konto gjenopprettet etter A503. Ingen interne testhjelpere kopieres. Automatisert kjøretid er ikke målt menneskelig onboardingtid.
- Den genererte pakken ble også prøvd i nettleseren: A-konto, separat B-oppsett, A av, A-fane lukket, fersk B, samme konto, signert lokal utfordring og lukket signeringsøkt. Ingen transaksjon inngår i startpakken. Visningsbredder 320, 390 og 1280 px hadde ingen horisontal overflyt; ingen konsollfeil ble sett.
- Veiledning: `starter/README.md`. Automatisk bevis: `evidence/onboarding.txt`; separat nettleserbevis: `evidence/onboarding-browser.json`.

Startpakkens visning er deretter bearbeidet med varmere flater, en egen reserveillustrasjon, én tydelig handlingsflate og sammenfoldede tekniske detaljer. Tekst og instruksjoner følger nå oppsettets faktiske status; etter gjenoppretting står det at signeringsøkten er lukket. Synlig merking av syntetisk prøve, RAM-lagring og signeringsmyndighet er bevart. Gjenoppretting av samme eksempelkonto er kontrollert på nytt etter endringen. Visningen er inspisert på skrivebord og ved 390 og 320 px uten horisontal overflyt. Se `evidence/starter-design-review.json`; den tidligere komplette bortfallsprøven er fortsatt separat historisk bevis.

Startpakken er fortsatt lokal og eksperimentell. Den er ikke publisert på npm og har ingen valgt redistribusjonslisens. Native lokal prøve og en separat offentlig B-gjenoppretting med A-bortfall og testnetinnløsning er dokumentert nedenfor. Startpakkens RAM-server og syntetiske autentisering skal aldri publiseres.

## Feilretting og fysisk testpakke — 8. oktober

- Native forespørsler får en tidsgrense og avbrudd helt ned til nettleserens passkey-grensesnitt. Forsinkede resultater etter avbrudd forkastes; kontrollerte nøkkelbuffere nullstilles. Dette er ikke en påstand om garantert sletting av alle JavaScript-minnekopier eller validert støtte på alle enheter.
- A kan åpnes igjen med eksisterende nøkkel. B har en eksplisitt handling for videreføring med eksisterende reservenøkkel. En allerede lagret reserve bekreftes lesende; uklar lagring overskrives eller gjentas ikke automatisk.
- Feil under lesekontroll før signering låser ikke betalingsforsøket. Etter signering bevares forsøket, og stopp før sending skilles fra en sendt transaksjon uten kvittering.
- Separat fysisk testpakke: en isolert lokal operatørmappe. Fil- og programhasher er kontrollert med `--verify-only`. Serveren er deretter **godkjent og startet** i fysisk modus; native opprettelse og reserveklargjøring er observert. Brukeren rapporterte fem bekreftelser under reserveoppsettet. Fersk B har nå gjenopprettet samme konto etter verifisert A-bortfall, og klienten viste bekreftet lokal utbetaling og lukket signeringsøkt. Kjedekvittering og kontraktstatus er kontrollert lesende: vellykket claim(1), blokk 3, samme mottaker, 0,001 lokale testenheter og claimed=true. Én reserveskriving og én kringkastingsprøve; begge syntetiske tellere er null. Se `evidence/physical-run-2026-10-08.json`, `evidence/physical-preparation.json` og `PHYSICAL_TEST.md`.
- Nettleserprøve på separat port 4973/4974: avbrutt oppsett, samme A åpnet igjen, ny reserve, deretter videreføring med eksisterende B uten ekstra skriving. A returnerte 503, gamle prøvefaner ble lukket, fersk B gjenopprettet samme konto og hentet eksisterende betaling. Etter omlasting var tellingen fortsatt én reserveskriving og én sending; samme kvittering og lukket signeringsøkt. Se `evidence/prephysical-browser.json`.
- Eksisterende RAM-demoer på 4573/4574 og 4673/4674 er ikke startet på nytt.

## Ferdigstilt lokal operatør- og friksjonsblokk — 8. oktober

- Operatøren håndterer deploy, gass til mottaker og utstedelse separat. Den krever et eksakt transaksjonsforslag og en eksplisitt godkjenning før signeringsfilen åpnes. Forsøket lagres før signering, og transaksjonshashen før én sending. Etter tapt svar kontrolleres samme hash uten ny signering eller sending.
- Den opprinnelige blokken hadde 32 beståtte operatørtester. Etter en offentlig RPC-feil med HTTP 429 er operatøren utvidet med kø per tilbyder, minst 250 ms mellom forespørsler, lesende forhåndskontroll og begrenset feildiagnostikk. Ingen automatisk gjentakelse eller alternativ RPC er lagt til. Én eksplisitt `resume-unsigned` kan videreføre et intakt usignert journalforsøk med samme forslag, reserverte gassgrense og en egen uforanderlig revisjonspost; eksisterende signert forsøk kan bare kontrolleres. **41/41 avgrensede operatørtester bestod**, inkludert feil før signering, uendret journal, avvist ny videreføring og hash lagret før sending. Se `deploy/operator-validation.json` for lokal kjedeprøve. To klienter mot én lokal kjede beviser ikke uavhengige offentlige tilbydere.
- Reserveoppsett og gjenoppretting viser nå faktisk fremdrift og tydelig stoppstatus. Fullførte trinn foldes sammen. En konto kan åpnes før den offentlige kontrakten er på plass; brukeren kan kontrollere betalingsberedskap uten å miste den eksisterende nøkkelen. Antall native bekreftelser er ikke redusert eller lovet redusert.
- Den oppdaterte klienten er prøvd med syntetiske nøkler: separat reserve, A utilgjengelig, fersk B, samme konto, bekreftet lokal utbetaling og lukket signeringsøkt. Mobilvisning ved 320 og 390 px hadde ikke horisontal overflyt. Se `evidence/setup-progress-browser.json`. Den frosne fysiske prøven på 4873/4874 er urørt.
- Kildeeksporten bruker en eksplisitt bevisliste og utelater rå driftslogger, private innstillinger og transaksjonsjournaler. Personlige maskinstier erstattes bare i eksportkopier av leveransedokumentene. `npm run prepare:approval -- /ny/tom/mappe` fryser kildearkiv og deaktiverte klientpakker etter kontroll av test- og filhasher; dette oppretter ingen offentlig ressurs eller godkjenning.

## Klargjort leveranse og fullført kjedeprøve

- Separate Primary- og Reserve-Worker-pakker for Sites, med deaktivert standardprofil. De konkrete Primary- og Reserve-versjonene er nå offentlig publisert med de godkjente bindingene på B.
- Kryptert reserve-API med engangskapasitet for innmelding, atomisk opprettelse, 16-posters kvote og 64 KiB per post. Ny Redis-namespace holdes atskilt fra tidligere ContinuityKit-data. Utløp sletter den nye reserven; dette er synlig i klienten.
- Fastlåst Monad-testnetklient og separat Paris-kompilert kontrakt. De fire godkjente transaksjonene deploy, testgass, opptjent rettighet og innløsning er finalisert. Den avgrensede offentlige reserveprøven og kvitteringene står nedenfor.
- Innleveringstekst i `ENTRY_DRAFT.md`, dommerveiledning i `JUDGE_GUIDE.md`, fysisk prøve i `PHYSICAL_TEST.md` og konkret releasebeskrivelse i `PUBLIC_RELEASE_CANDIDATE.md`.
- Lokal kildepakke og filhasher bygges med `npm run pack:candidate`. Ingen lisens, npm-publisering eller GitHub-kildepublisering er valgt/utført gjennom denne leveransen. Opplasting av de avgrensede Sites-kildene er dokumentert nedenfor.

## Godkjent publisering fullført — 8. oktober

- **Primary er offentlig publisert:** https://continuitykit-account-primary.cryptomickle.chatgpt.site — versjon 4, miljørevisjon 2, vellykket deployment `appgdep_6ac7ec8f2088819193469b47065a5876`, kilderevisjon `b0d29fda812348698ed2e8906935d398b2b22dae`. Dette er den særskilt godkjente oppsettsrettingen. Den tidligere gjenåpningen etter bortfallsprøven og HTTP 200-kontrollen kl. 15:08:15 UTC gjaldt versjon 3.
- **Reserve er offentlig publisert:** https://continuitykit-account-reserve.cryptomickle.chatgpt.site — versjon 3, vellykket deployment `appgdep_6ac7ecdd01248191a425276773d938c5`, kilderevisjon `07989371b6dcb1e41aa028c81f1d06701f83dd26`. Miljørevisjon 1 er uendret med de tre avtalte `RESERVE_*`-bindingene; Redis-token og innmeldingshasher er hemmelige serververdier. Tidligere publiseringsversjoner er bevart som historisk bevis. Nytt publiseringsbevis: `evidence/enrollment-reuse-publication-2026-10-08.json`.
- Første Primary-deploy stoppet fordi Worker-klokken var null ved moduloppstart. Profilkontrollen kjøres nå ved forespørselen; 45-dagersgrensen, vertskontrollen og utløp er bevart. Hele den lokale verifikasjonen er kjørt på nytt, med resultatet ovenfor.
- **Én forespørsel til den offisielle gratis testnet-fauceten er utført.** Begge faste RPC-er bekreftet senere **5 test-MON** til ny issuer `0xda66935B528737205acf44bd347123a2FdD86916` i lesekontrollen 8. oktober kl. 13:27:40 UTC. Den tidligere HTTP-feilen hos den andre RPC-en gjelder faucet-øyeblikksbildet. Ingen automatisk ny faucet-forespørsel skal sendes.
- Den godkjente nye lagringsdelen er `account-reserve-660a8c6ea140bb95da482829aa5b2b1e`, med sletting **10. november 2026 kl. 01:00 norsk tid**, én klargjort engangstillatelse og teknisk kvote 16 poster à 64 KiB. Serverbindingen er fullført gjennom den godkjente innloggede Vercel-visningen og en minnebasert localhost-overføring; databasetokenet ble ikke skrevet til hemmelighetsfiler eller chat. Tidligere Sites, lagringsdel og den frosne fysiske prøven er urørt.
- **Ny offentlig A-konto er observert klar etter brukerens bekreftelse.** Mottaker er `0x3efc5827c9f2f25f8fd4000C4BF9318154dF1B85`; enhet og antall systembekreftelser er ikke dokumentert. B-oppsettet er nå observert fullført og uavhengig kontrollert for samme mottaker; brukeren rapporterte svært mange bekreftelser, uten eksakt antall. Kontrakten `0x738F3a0E2376a8e9AFf6A4440B0dBC77c22e6B4A` er nå deployert og finalisert; øvrig transaksjonsstatus står nedenfor.

Den første godkjenningen omfattet de to nye offentlige Sites, den avgrensede serverbindingen, to nye eksempelpasskeys og én separat gratis faucet-forespørsel. Mikkel har deretter svart **«jeg godtar»** på det konkrete firetransaksjonsforslaget og midlertidig bortfall/gjenåpning av bare nye Primary A. Denne separate godkjenningen er dokumentert i `artifacts/public-transactions-2026-10-08/user-approval.json`. Ingen ekstra konto, ekstra transaksjon, ekte penger, kildepublisering eller innlevering inngår. `artifacts/public-preparation-2026-10-08/phase-one-review.json` er bevart uendret som historisk øyeblikksbilde før godkjenningen; feltene der er ikke nåstatus.

Publiseringsbevis: `evidence/publication-2026-10-08.json`. A-kontoen er dokumentert i `artifacts/public-transactions-2026-10-08/review.json`. Det godkjente eksakte firetransaksjonsforslaget er `proposal.json` i samme mappe, SHA-256 `3606cb6606fa3f9ed1d2032c7251148180643c4b2bceae9836552cb824be4dd2`; `approval.json` er den avgrensede operatørbindingen. `readonly-preflight.json` viste ved kl. 13:27:40 UTC samsvar mellom begge RPC-er: issuer hadde 5 test-MON; mottaker og kontrakt null saldo; alle tre nonce 0 og tom kode. Innledende deploy-estimat var 379 811 gass, 455 774 med 20 % margin. Dette er et historisk øyeblikksbilde før utførelse; alle trinn kontrolleres ferskt før signering.

Første deploy-forsøk stoppet etter reservering og før journalført signert hash. En separat lesende reproduksjon viste HTTP 429 fra sekundær-RPC-en. Originaljournalen ble bevart; etter retting og lokale tester ble samme godkjente deploy videreført én gang med opprinnelig gassgrense. Se `readonly-sequence-diagnostic.json`, `paced-readonly-preflight.json`, `deploy-resume-result.json` og `deploy-finalized.json` i transaksjonsmappen. Den senere offentlige bortfalls-, gjenopprettings- og innløsningsprøven er nå fullført.

### Offentlig kjedestatus — 8. oktober kl. 15:07:59 UTC

| Godkjent trinn | Verifisert status | Bevis |
| --- | --- | --- |
| Deploy | Finalisert, blokk 69 270 636 | `artifacts/public-transactions-2026-10-08/deploy-finalized.json` |
| 0,06 test-MON til mottakers gass | Finalisert, blokk 69 270 839 | `artifacts/public-transactions-2026-10-08/fund-finalized.json` |
| Lås rettighet 1 med 0,10 test-MON | Finalisert, blokk 69 271 058 | `artifacts/public-transactions-2026-10-08/issue-finalized.json` |
| Innløsning etter fersk B-gjenoppretting | Finalisert, blokk 69 286 156 | `evidence/public-claim-finalized-2026-10-08.json` |

Begge faste RPC-er har bekreftet alle fire transaksjoner og tilhørende kontrakttilstand. Målt operatørgebyr er **0,062471634 test-MON**, claim-gebyr **0,007339716 test-MON**, samlet **0,069811350 test-MON**. Ingen ekte penger inngår. Innløsningen er `0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5`: rettighet 1, samme opprinnelige mottaker, 0,10 test-MON og `claimed=true`. Klienten viste **Payment collected** og lukket signeringsøkt. Bevis: `evidence/public-testnet-setup-2026-10-08.json`, `evidence/public-claim-finalized-2026-10-08.json` og `evidence/public-claim-success-2026-10-08.jpg`. To samsvarende RPC-er er bekreftelse fra to konfigurerte tilbydere, ikke en lettklient som selv verifiserer konsensus.

## Gjenstående før innleveringsklart bidrag

1. **Oppsettfriksjon og avgrensning:** rettingen som fjerner ett gjentatt WebAuthn-kall under nytt reserveoppsett er publisert som Primary 4 / Reserve 3. 318 tester og seks kontrolltrinn bestod; det forbedrede oppsettet er ikke fysisk prøvd. Mange native bekreftelser ble rapportert for den tidligere publiserte flyten; ny prompttelling og bred enhetsstøtte er ikke dokumentert. Den ferske B-fanen i den offentlige prøven beviser ikke gjenoppretting fra en annen nettleserprofil eller direkte iPhone-side. Ikke lov ett trykk, produksjonssikkerhet eller generell brukervennlighet.
2. **Kildepakke og konkurransepåstand:** dommertekst og innleveringsutkast er oppdatert, det offentlige beviset er samlet i `evidence/public-proof.json`, og gjeldende portal-, track- og sponsorvilkår er lest. Se `REQUIREMENTS_2026-10-08.md`. Logoen er klargjort i korrekt format. Ekstern etterspørsel, reell tredjepartsintegrasjon og premiepassform er fortsatt ikke bevist.
3. **Kildepublisering og innlevering:** velg lisens og innhent avgrenset godkjenning for gjennomgått kildepublisering og endelig innsending. Ingen ny GitHub-/npm-publisering eller konkurranseinnsending er utført. Video gjøres separat til slutt.

## Konkurransepåstanden må holdes smal

Den dokumenterte fordelen i den lokale og denne offentlige testnetprøven er filfri gjenfinning av en forberedt reserve for samme eksisterende konto, med bruk av en allerede utstedt rettighet etter A-bortfall. En korrekt beholdt kryptert eksport virker også. Denne løsningen krever mer oppsett, egen reserveklient og tilgjengelig lagring; generell brukervennlighet, etterspørsel, bedre sikkerhet og betalingsvilje er ikke bevist.

Many Keys er en sponsorhypotese, ikke en godkjent premiekategori for dette prosjektet. Hvis dommeren vurderer dette som bare wallet-backup/signering, er passformen svak. Ikke skjul at den bevarte hemmeligheten er en kontonøkkel. Ingen premie eller minsteutbetaling på USD 2500 er garantert.

Den nye portalkontrollen bekrefter at Many Keys krever samme native passkey på en annen enhet eller i en fersk nettleserprofil. Den observerte ferske fanen oppfyller ikke dette beviskravet. Den alternative Mera-UX-premien krever én passkey-seremoni under onboarding; dette er ikke dokumentert for kontoreserven. Trust-sporet vekter marked og traction samlet 45 %, og interne testresultater erstatter ikke disse delene.

## Kilde- og innleveringskontroll — 8. oktober

`ENTRY_DRAFT.md` og `JUDGE_GUIDE.md` beskriver nå den nye kontoreserven og skiller den native prøven på Primary 3 / Reserve 2 fra den senere oppsettsrettingen på Primary 4 / Reserve 3. En kontrollert logo på 1024 × 1024 px / 249 425 byte og deklarasjon av AI-assistanse er lagt til. De opprinnelige driftsbevisene er bevart; den offentlige bevisfilen inneholder bare utvalgte, etterprøvbare opplysninger.

Eksportverktøyet stopper ved manglende obligatorisk bevis, mistenkelige hemmelighetsfiler og symbolske/harde lenker. **8 egne eksporttester bestod**, i tillegg til den oppdaterte samlede kjøringen med **318 tester og seks beståtte stadier**. Dette er en begrenset eksportkontroll, ikke en garanti for at vilkårlig kildekode er uten hemmeligheter.

Portalen viste innlevering **0/5**, mens dashboardets **3/5** gjaldt profil/team/prosjekt. Fristen var **14. oktober kl. 05.59 norsk tid**. Regelverket krever offentlig GitHub-kode med åpen lisens, attribusjon og reell byggehistorikk, selv om skjemahjelpen også nevner privat deling. Lisens, offentlig kildepublisering og lagring av oppdatert bidrag er gjenstående handlinger. Ingen av disse er utført i denne lokale klargjøringen. Video er fortsatt utsatt.

B gjenoppretter full EOA-myndighet. A tilbakekalles ikke, kopierte nøkler kan ikke ugyldiggjøres av denne protokollen, og testresultater fjerner ikke personlig juridisk ansvar. Ingen ekte midler eller mainnet inngår.

## Nettleserretting — lokal klargjøringshistorikk 8. oktober

`release/paced-rpc.mjs` samordner appens lesekontroller og claim-klient i én kø per fast RPC på samme side, med minst 250 ms mellom forespørsler. Ingen automatisk ny sending eller alternativ tilbyder er lagt til. Dette reduserer appens egne forespørselsutbrudd, men garanterer ikke fravær av HTTP 429 på tvers av faner eller ved belastning hos tilbyderen. Feil etter signering beholder sperren mot ny sending. Den lokale klargjøringen er dokumentert i `evidence/browser-pacing-fix-2026-10-08.json`; publiseringen og prøven fulgte som beskrevet nedenfor.

Brukerens rapport om svært mange native bekreftelser er registrert som uløst friksjon. Fersk B-gjenoppretting har to WebAuthn-operasjoner; faktisk antall systembekreftelser varierer. Den separate forbedringen nedenfor unngår å hente det samme PRF-resultatet på nytt under førstegangsoppsett. Den ble publisert etter egen godkjenning og inngikk ikke i den tidligere nettverksrettingen.

## Offentlig nettverksretting og fullført bortfallsprøve

Brukeren godkjente den avgrensede rettingen med «ja». Primary versjon 3 og Reserve versjon 2 ble publisert; samme opprinnelser, nøkler, lagringsdel, kontrakt og grenser ble bevart. Under den godkjente midlertidige utkoblingen svarte A med HTTP 503 / `PRIMARY_OFFLINE`. Gamle oppsettsfaner ble lukket; fersk B-fane 10 gjenopprettet opprinnelig mottaker med eksisterende fysisk nøkkel og sendte den ene godkjente innløsningen. B viste **Payment collected** og lukket signeringsøkt. Deretter ble bare A-utkoblingsbindingen fjernet og samme versjon 3 gjenåpnet med miljørevisjon 2. HTTP 200 på både forsiden og konfigurasjonen bekreftet gjenåpningen kl. 15:08:15 UTC. Se `evidence/browser-pacing-publication-2026-10-08.json`, `evidence/public-outage-2026-10-08.json`, `evidence/public-claim-finalized-2026-10-08.json` og `evidence/public-primary-restored-http-2026-10-08.json`. Utkoblingsfilens felter om ventende gjenoppretting og claim er et historisk øyeblikksbilde før fullføringen.

## Redusert oppsettsarbeid — godkjent og publisert

`createReserveCredential` bruker opprettelsens PRF-resultat til å avlede midlertidig oppslags- og krypteringsmateriale. Det eksakte engangsobjektet kan brukes til forberedelsen innen samme avgrensede oppsett. Rå PRF-buffere nullstilles; avbrudd, utløp og feil stopper videre bruk. Hovedappen og utviklerpakken benytter denne veien. Eksisterende nøkkel fortsetter gjennom den tidligere kontrollveien.

Nytt B-oppsett bruker **én opprettelse og tre assertion-kall**, eller **én opprettelse og fire assertion-kall** når plattformen ikke leverer PRF-resultatet direkte ved opprettelsen. Begge variantene sparer ett assertion-kall fra tidligere fullstendig oppsett. Uavhengig kontroll etter lagring og fersk gjenoppretting er beholdt; sistnevnte bruker to assertion-kall. Dette er målte API-kall i syntetiske tester, ikke observerte Face ID-/systembekreftelser.

318 tester bestod: 135 kjernetester, 71 onboardingtester, 6 HTTP-kontroller og 106 release-tester, i tillegg til appbygg og begge Worker-bygg. Kodegjennomgang fant ingen blokkeringer. Etter brukerens «Ja» rapporterte Sites vellykket publisering av Primary 4 / Reserve 3 med uendrede miljørevisjoner 2 / 1. Se `evidence/verification.json`, `evidence/enrollment-reuse-2026-10-08.json`, `evidence/enrollment-reuse-publication-2026-10-08.json` og `delivery/ENROLLMENT_REUSE_REVIEW.md`. Den frosne gjennomgangspakken er bevart. Ingen ny fysisk nøkkel, fysisk oppsettsprøve eller offentlig transaksjon er utført for denne rettingen; SDK-en er fortsatt ikke publisert på npm.
