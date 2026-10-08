# Account Reserve: implemented public/testnet candidate

Publication update, 8 October 2026: the owner approved the reviewed account-reserve source release to `CryptoMickle/continuity-kit/account-reserve` with MIT for original code and preserved dependency notices. The package remains unpublished on npm. Portal submission and video are separate. Earlier pending-license/publication statements below are retained as historical preparation records, not current license status.

Updated 8 October 2026. **The bounded public native Account Reserve proof is complete on Monad testnet; all four approved transactions are finalized.** While Primary A returned HTTP 503, a fresh B tab recovered the original beneficiary with its existing physical passkey and claimed right 1 once. Both pinned RPCs corroborated the successful claim and final state. This native proof used Primary version 3 / Reserve version 2; A was restored to the same version 3 and its root/config returned HTTP 200. A separately approved enrollment optimization is now published as Primary version 4 / Reserve version 3, with no new credentials or transactions. It passed 318 local tests but has not been physically tested. The earlier transaction scope is recorded in `artifacts/public-transactions-2026-10-08/user-approval.json`; native and chain evidence is in `evidence/native-public-testnet-proof-2026-10-08.json` and `evidence/public-claim-finalized-2026-10-08.json`. Actual reduction in system prompts remains unmeasured. This proves one bounded flow, not external demand, third-party integration, production security or prize prospects. No new GitHub/npm publication or competition submission has occurred.

| Site | Current publication state |
| --- | --- |
| [Primary A](https://continuitykit-account-primary.cryptomickle.chatgpt.site) | Public version 4; successful deployment `appgdep_6ac7ec8f2088819193469b47065a5876`; source `b0d29fda812348698ed2e8906935d398b2b22dae`; unchanged environment revision 2. Sites reported success at 19:18:56 UTC. |
| [Reserve B](https://continuitykit-account-reserve.cryptomickle.chatgpt.site) | Public version 3; successful deployment `appgdep_6ac7ecdd01248191a425276773d938c5`; source `07989371b6dcb1e41aa028c81f1d06701f83dd26`; unchanged environment revision 1 with the three approved secret/server `RESERVE_*` bindings. Sites reported success at 19:20:14 UTC. |

Current deployment evidence is saved in `evidence/enrollment-reuse-publication-2026-10-08.json`; earlier deployment evidence remains in `evidence/publication-2026-10-08.json`. At 13:26:42 UTC, A's physical-mode UI showed the account ready with beneficiary `0x3efc5827c9f2f25f8fd4000C4BF9318154dF1B85`, following the user's confirmation. Device and prompt count were not established. See `artifacts/public-transactions-2026-10-08/review.json`.

The approved single official faucet request was made to `0xda66935B528737205acf44bd347123a2FdD86916`. Both pinned RPCs confirmed **5 test-MON** in the historical pre-execution read-only snapshot at 13:27:40 UTC; the second provider's earlier HTTP failure remains part of the faucet snapshot. Do not repeat the faucet request automatically. Transaction permission comes from the later explicit approval, not from receipt of faucet funds.

## Implemented topology

Two separate Sites Worker packages are built: Primary A and Reserve B. A serves
its client. B serves its client and a same-origin encrypted-record API. **The
browser calls two fixed Monad testnet RPC endpoints directly. There is no hosted
RPC proxy.** The Worker rejects `/rpc`, local control and synthetic APIs.

Fresh B recovery loads its own configuration, derives an opaque locator from its
B passkey, fetches ciphertext from its own `/api/reserve/:locator`, restores the
original EOA and reads its right on the configured chain. The claim executor uses
the two pinned RPCs directly. No A API, upload capability, old tab, saved export,
pasted owner or locator is needed during fresh recovery. A's origin is an
authenticated policy value and handoff boundary, not a B network dependency.
Hosting/storage would still share an operator/provider; origin separation does
not establish independent infrastructure or guaranteed durability.

The approved deployment destination is **two new Sites**, with a new
namespace in the existing dedicated ContinuityKit Redis resource. Its
server-only credential is now bound to the new B. Old data-demo Sites and their
namespace stay unchanged. Delveworn's deployment/database remain outside scope.
The actual new origins and project IDs are now assigned in `evidence/sites-registration-2026-10-08.json`. Both A and B are now publicly live. Durable local identities are in `sites/primary/.openai/hosting.json` and `sites/recovery/.openai/hosting.json`.

Separate RPs keep this full-account-signing reserve distinct from the old
data-only product. Existing credentials are not migrated or rebound. The hosted
UI currently selects the Iris-style direct-PRF example; Accrue remains an
independently composed local derivation fixture. Neither is an integration into
the original third-party application.

## Implemented modules

Paths in this section are relative to `account-continuity/`.

| Module/artifact | Current behavior |
| --- | --- |
| `release/client-profile.mjs` | Strict `account-reserve-public/v1` profile: chain 10143, nonzero distinct contract/issuer, expected runtime hash, distinct exact HTTPS A/B origins, namespace `account-reserve-<32 lowercase hex>`, canonical expiry at most 45 days ahead, exactly two approved RPC strings and a fixed claim scope. Disabled configuration fails closed. `physicalPasskeysVerified` is metadata, not physical evidence. |
| `release/host-worker.mjs`, `worker-entry.mjs` | Embedded assets and `/api/config`; B-only reserve handler; exact request-origin check; GET-only client routes; no-store/nosniff/referrer headers and asset CSP permitting self plus the two RPCs. Only A respects `ACCOUNT_RESERVE_PRIMARY_OFFLINE=true`. Profile validation runs at request time because a deployed Worker can expose an epoch-zero startup clock; the exact 45-day limit remains. Disabled/invalid host returns 503; expired host returns 410. No public outage, funding, issuer or RPC route. |
| `release/profile.mjs` | Strict store profile with one exact B origin, random 32-hex release ID and absolute expiry. Derives `accountreserve:v1:<releaseId>`. Canonical 43-character locator/token validation; 65,536-byte decoded record limit. |
| `release/handler.mjs` | B-origin `GET`/`PUT /api/reserve/:locator`. GET needs no enrollment capability. PUT requires exact same-origin JSON, a bounded canonical body and an approved bearer capability matched to a configured SHA-256 hash. Invalid origin, method, route/query, encoding and capability fail closed. |
| `release/redis-store.mjs` | New `account-reserve-ciphertext/v1` schema. One Redis hash holds ciphertext, consumed-ticket bindings and schema/expiry metadata. A Lua operation atomically creates a record and consumes its ticket. No overwrite; at most 16 records of 64 KiB. Redis server time checks expiry; `PEXPIREAT` schedules expiration of this release hash. |
| `release/redis-rest.mjs` | Server-only token and one explicitly allowed HTTPS endpoint. 128-KiB request/response bounds; maximum 10-second timeout; redirects rejected; no write retries; sanitized errors; two-second warm-instance cooldown. No endpoint discovery or token logging. |
| `release/browser-store.mjs` | Same-origin ciphertext adapter. Enrollment capability held in memory, consumed before its one PUT attempt and then cleared; ambiguous writes are not retried. Fresh recovery supplies no capability and uses GET. SDK readiness still requires exact readback and independent recovery/signature checks. |
| `release/prepare-release.mjs` | Offline helper creates a new protected directory, disabled server configuration and separate 0600 enrollment-secret file. Prints paths only. Generates a new release ID and at most 16 one-write capabilities. Normal Sites building does not generate these capabilities; secret files are not for publication. |
| `release/testnet-executor.mjs` | Separate 10143 wrapper with fixed direct RPCs, `claim(1)`, zero transaction value and an expected 0.10 test-MON right. Both providers check chain/runtime; before prepare/broadcast also check issuer/right/owner mapping, owner code, nonce 0, balance, fee ceiling and estimates. Uses the maximum estimate plus 20%, capped at 300,000 gas. Receipt acceptance additionally requires matching receipts/logs, canonical receipt-block hashes, both finalized heads reaching that block, and matching claimed state on both providers. |
| `transaction.mjs`, `pending-ticket.mjs` | Ordinary API remains 31337-only; guarded internal entry supports testnet. Exact signed envelope/signer validation. Public attempt/hash tickets plus same-origin locks survive reload. Ambiguous sends reconcile the pinned hash instead of signing again. No private key or raw signed bytes in persisted tickets. No cross-device lock or restriction on the EOA's full authority is claimed. |
| `deploy/proposal.mjs`, contract artifact | Separate offline Solidity 0.8.30/Paris artifact, issuer-immutable runtime calculation and no-network proposal builder. Predicts CREATE address from supplied public issuer/nonce; emits four unsigned envelopes. Unverified origins/namespace/expiry are blank; `enabled` is false. Existing local 31337 artifact remains separate. |
| `deploy/operator.mjs`, `operator-journal.mjs` | Executes one of the three issuer setup transactions per explicit call after exact proposal-bound approval. Checks both providers, current state, fee/value coverage and native gas estimates; journals a reservation before signing and the exact hash before one send. Later steps require finalized prior steps. Existing attempts only reconcile; no automatic reset, replacement or resend. |
| `deploy/operator-runner.mjs` | Concrete fixed-testnet binding. Defaults to local inspection without RPC requests or signer reads. Read-only reconciliation uses the two fixed RPCs. Explicit execution validates approval before loading a caller-selected protected issuer file. Transports disable retries, redirects, CCIP Read and client cache; no URL or chain override. |
| `app-setup.mjs`, `app-progress.mjs` | Hosted A displays its account address and a waiting state while deployment/payment is unverified. Reserve setup remains unavailable until the existing payment is checked. Setup/recovery stages describe actual progress and stop without a false completion claim; stage counts are not counts of physical prompts. |
| `scripts/build-sites.mjs` | Builds UI and bundled Worker entrypoints at `artifacts/sites-{primary,recovery}/dist/server/index.js`. Writes `artifacts/sites-candidate.json` with Worker hashes and unpublished status. Uses the runtime's exact Redis-origin validator and checks enabled configuration locally without storage I/O. Defaults to `release/disabled-profile.json`; no Site registration, upload or deployment. |
| `scripts/package-candidate.mjs` | Exports the selected source directories and an explicit evidence allowlist. Excludes raw operational logs, hidden/build/cache entries and secret/server/journal JSON files. Stages export copies, preserves originals, rejects personal workstation paths and records original/exported file hashes and archive hash. |
| `scripts/prepare-approval.mjs` | Copies a verified source archive/manifest and the two disabled Workers into a new local review directory after checking successful verification stages and current source/archive/Worker hashes. Produces `review.json` with `approved:false` and `publicExecutionReady:false`. Creates no cloud resources, credentials, signer or execution approval. |

The replaceable local build manifest `artifacts/sites-candidate.json` currently carries
`configured-local-only-unpublished`, a staging-tool label rather than live publication
status. The configured Workers were rebuilt after verification with the same enabled
profile, and their hashes match the deployed Workers. The manifest is not an immutable
release snapshot or publication authority; `evidence/publication-2026-10-08.json`
records the actual successful deployments. Durable hosting identities are recorded
separately. The configured build validates the enabled profile and exact HTTPS Redis
origin. B requires matching `RESERVE_REDIS_REST_URL` plus secret runtime server bindings
`RESERVE_REDIS_REST_TOKEN` and `RESERVE_ENROLLMENT_TICKET_HASHES`, now applied in revision 1.

Local and hosted branches share UI source; local-route strings may remain in the
compiled bundle. Hosted mode selects physical WebAuthn, the release-store adapter
and direct testnet clients. The Worker does not expose the local routes. Do not
claim those strings are absent merely because their routes are unavailable.
The public native flow worked in the observed browser and exact configuration.
This does not establish exhaustive platform-header behavior, universal native
compatibility, another browser profile or direct iPhone-page recovery.

## Storage lifetime and enrollment

Public configuration uses `account-reserve-<releaseId>`; the Redis key is
`accountreserve:v1:<releaseId>`. Both represent the same new random release ID,
separate from the old `ck:demo:...` data-demo namespace.

Unlike the old data demo's access-only deadline, **this candidate schedules its
release hash to expire at `expiresAt`**. Host, handler and Redis server time also
deny expired use. It is temporary demonstration storage, not lasting backup.
Logical expiration does not prove erasure from all provider backups, cancel
billing, revoke copied EOA keys or remove chain history. The approved new deadline is
`2026-11-10T00:00:00.000Z`; it is distinct from the old data demo retention policy.

An enrollment grant is `{hash, locator}`. A fixed locator prebinds it; `*` permits
its first successful write to atomically bind one locator. Neither permits a
second object. The raw capability is a one-write bearer permission, not ownership
attestation; stealing it can deny enrollment. Only hashes are installed on B.
The setup capability is not put in a URL, ciphertext, browser storage or recovery
GET. Removing all server grants denies new writes while recovery reads continue
until expiry.

The 16-record bound assumes the authoritative hash is not reset, evicted, rolled
back or maliciously altered. It does not cap billing: public reads and rejected
hosting traffic can incur charges. Maximum raw ciphertext is 1 MiB plus encoding,
metadata and provider overhead. Namespace separation does not isolate billing,
availability or administrators; resource exhaustion could affect the old demo.
Never flush or migrate the shared database for this candidate.

## Existing resources and remaining provisioning

Sites inventory and the dedicated Redis resource were checked read-only on 8 October. That earlier inventory preceded registration. Both new account Sites are registered; A and B are now publicly live. Registration history is in `evidence/sites-registration-2026-10-08.json`. The provider reports the database available, eviction and automatic upgrades disabled, and current displayed spend $0.00 with budget $20. This does not cap total project costs or establish provider backups. See local `evidence/cloud-readiness-2026-10-08.json`.

| Resource | Saved location/status | Candidate treatment |
| --- | --- | --- |
| Old Primary | `https://continuitykit-primary.cryptomickle.chatgpt.site`; project `appgprj_6abe580345bc819185dd4ccc548435fa` | Preserve unchanged. |
| Old Recovery | `https://continuitykit-recovery.cryptomickle.chatgpt.site`; project `appgprj_6abe581e54048191b6471b503b39e6d6` | Preserve unchanged; not the new B. |
| Old store | `https://continuitykit-reserve-store.cryptomickle.chatgpt.site`; project `appgprj_6abfa4acd4008191bd7c8abf3866b3ce` | Preserve old Worker/profile/namespace. New B hosts its own API. |
| Dedicated Redis | `continuity-kit-metropolis`; Vercel `store_Jksti3ISuW3zAy8t`; Upstash `9a70dbd2-d301-4b8c-a135-26d9308b5618` | Read-only verification 8 October: available, eviction=false, autoUpgrade=false. No new database provisioned. |
| Provider budget | USD20/month cap checked 2 October, before taxes/fees | Budget $20 and displayed spend $0.00 observed again 8 October; not a full-project cost guarantee. |
| Old registry | Testnet `0x3fc9997e62e56ba17225a47c32ad9406313dc98a` | Data registry, not PaymentRight. Preserve unchanged. |
| Direct RPCs | `https://testnet-rpc.monad.xyz`, `https://rpc-testnet.monadinfra.com` | Both corroborated finalized receipts and state for all four transactions; direct browser flow succeeded in this run. No arbitrary fallback or general provider-availability guarantee. |
| New A/B Sites | Primary `appgprj_6ac78a8c349c819185815701e765f8be`; Reserve `appgprj_6ac78aa73a208191a5d2b5441b961416` | Primary version 4 with environment revision 2; Reserve version 3 with environment revision 1. Enrollment optimization published; native setup of that optimization remains untested. Earlier native preparation, fresh B recovery and claim completed on Primary 3 / Reserve 2. |
| New PaymentRight | Paris artifact at `0x738F3a0E2376a8e9AFf6A4440B0dBC77c22e6B4A` | Public deployment/runtime and right 1's successful claim corroborated by both pinned RPCs. |

Provenance: old `continuity-kit/delivery/local-export/upstash-live-2026-10-02/publication-final.json`
and dated `continuity-kit/PROJECT_STATE.md` entries. The failed 1 October D1 Site
is not the functioning Redis resource. Local preparation requires no old
deployment change, account creation, credential extraction or database mutation.

## Four-transaction ceilings

The proposed public proof uses one new Iris-style A account, one prepared B reserve
and a distinct test-only issuer. The proposal explicitly funds beneficiary gas;
it does not assume A already has gas or obtains another faucet allocation.

| Action | Count | Gas ceiling | Maximum fee at 200 gwei | Value |
| --- | --- | --- | --- | --- |
| Deploy PaymentRight | 1 | 1,000,000 | 0.20 test-MON | 0 |
| Fund fixed beneficiary gas | 1 | 30,000 | 0.006 test-MON | 0.06 test-MON to beneficiary |
| Issue fixed right | 1 | 300,000 | 0.06 test-MON | 0.10 test-MON to contract |
| Recovered signer claims | 1 | 300,000 | 0.06 test-MON | 0 transaction value; contract pays 0.10 test-MON |
| Total | 4 | 1,630,000 | **0.326 test-MON fee ceiling** | **0.10 escrow plus 0.06 gas transfer** |

Maximum issuer starting coverage is 0.426 test-MON: its three fees (0.266), escrow
(0.10) and gas transfer (0.06). The final claim fee is paid from that transfer.
Summing all fee-and-value envelopes gives 0.486, counting the same 0.06 first as a
transfer and again as the possible claim fee. These are the explicitly approved ceilings, not
current estimates or cash costs. Priority is capped at 2 gwei; actual
gas must fit fresh native estimates plus 20%. No automatic cap increase, extra
transaction or alternate funding service is implied.

`deploy/proposal.mjs` binds actors, nonces, bytecode, predicted CREATE address and
issuer-patched runtime. The exact beneficiary-bound proposal is now
`artifacts/public-transactions-2026-10-08/proposal.json`, proposal SHA-256
`3606cb6606fa3f9ed1d2032c7251148180643c4b2bceae9836552cb824be4dd2`,
explicitly approved by the user's “jeg godtar”; `user-approval.json` records that scope and `approval.json` binds the operator. Its contract/runtime, issuer, chain, RPCs and claim scope match
the published profile. `readonly-preflight.json` in the same directory records
both RPCs agreeing at 13:27:40 UTC: issuer balance 5 test-MON, beneficiary and
predicted-contract balances zero, and all three actors' nonces zero/code empty.
The initial deploy estimate was 379,811 gas, or 455,774 with the required 20%
margin. These are dated observations, not execution clearance. Later estimates
require preceding confirmed state, and every step needs fresh checks. Public
deployment/runtime is now corroborated by the finalized deploy receipt; see the execution snapshot below. Deployment/funding/issuance
use the bounded operator described below. The public host has no issuer
wallet. This approval is limited to the existing actors, exact four envelopes and new-A outage/restoration; it does not authorize extra credentials, Sites, transactions or unrelated production changes.

## Public execution snapshot — 8 October, 15:07:59 UTC

All four approved transactions are finalized according to both fixed RPCs.

| Role | Finalized block | Transaction hash |
| --- | --- | --- |
| Deploy | 69270636 | `0x7afdffb436cc2d967bd4fae3679be649b3b5d6a049a1016491d31dc49ab5319d` |
| Fund beneficiary with 0.06 test-MON | 69270839 | `0x5af2c8ab295815ca03424f521437840922d53988848bfa2a762999e001985606` |
| Issue right 1 with 0.10 test-MON | 69271058 | `0xfe6493c65a85d13a47dbe3a3a9d2d0bc4ead3034af78bac9226f2432dab3e97b` |
| Claim after native B recovery | 69286156 | `0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5` |

Observed operator fees total **0.062471634 test-MON**; claim fee **0.007339716 test-MON**; all four fees **0.069811350 test-MON**. See `evidence/public-testnet-setup-2026-10-08.json`, the three operator receipts under `artifacts/public-transactions-2026-10-08/`, and `evidence/public-claim-finalized-2026-10-08.json`. The latter verifies the exact signed claim, canonical finalized receipt block, `RightClaimed(1)`, original beneficiary, 0.10 test-MON, runtime/issuer and `claimed=true`; contract balance is zero. Fresh B recovered the original account while A returned 503, and displayed **Payment collected** with the signing session closed. A was then restored; see `evidence/public-primary-restored-http-2026-10-08.json`. No additional transaction or repeat claim is required.

## Implemented operator and execution boundary

The operator rebuilds the supplied proposal from the current candidate artifact
and binds approval to the SHA-256 of the complete proposal, the three issuer
roles, exact RPC list, network and a canonical expiry within 24 hours. The fourth
transaction remains the recovered beneficiary's claim. An approval file's
`approvedByUser:true` is a caller assertion, not proof of consent; local development
approval must not be converted into permission to execute publicly.

`operator-runner.mjs` provides distinct read-only and execution commands. Default `inspect` reads
local public proposal/journal state, makes no RPC requests and creates no journal
directory. `reconcile` only reads the chain for the existing pinned attempt; `preflight` checks current state/fees without a signer, reservation or broadcast.
`execute` additionally requires the exact-proposal confirmation flag, approval
file, selected role and explicit issuer-file path. The runner validates approval
before reading an owned, single-link, nonsymlink 0600 signer JSON file. Keep that
file outside the source tree as `issuer.secrets.json`; it is never part of this
source export or review packet. Ordinary `execute` with an existing attempt bypasses signer loading and
permits reconciliation only. Explicit `resume-unsigned` is separately bounded: an intact unsigned reservation, same exact approval/proposal and original reserved gas, fresh preflight, exclusive journal lock and one append-only resume audit. A consumed resume cannot sign again; a signed attempt only reconciles without loading a signer. No journal entry is deleted or replaced. See the implementation and focused tests for this newly added command; older frozen packets predate it.

Each new step checks fresh provider heads, matching numbered canonical blocks,
account code/nonces, contract runtime and issuer, payment state, conservative
remaining funds, current fee caps and native gas estimates plus 20%. Normal block
advancement and provider lag are allowed. A durable journal reserves the attempt
before signing and persists the exact signed hash before one broadcast call.
Tickets use `.journal.json` and contain public metadata, never a private key or
raw signed transaction. Failures after reservation retain the attempt; ambiguous
delivery is investigated by hash, not by automatic signing or sending again.

The first public deploy attempt stopped with an unsigned reservation. A separate read-only sequence reproduced HTTP 429 from `rpc-testnet.monadinfra.com`. Each pinned endpoint now queues all requests with a minimum 250 ms start interval, preserving zero transport retries and the same URLs. Failures propagate without replay; reads and the single broadcast share the queue. CLI diagnostics reveal only stage and bounded error names/codes/status, not messages, bodies, keys or signed bytes. The original deployment reservation was retained and explicitly resumed once after 41/41 focused operator tests passed. This test run is separate from the earlier full 290-test run. Evidence: `readonly-sequence-diagnostic.json`, `paced-readonly-preflight.json` and the append-only deploy resume journal under `artifacts/public-transactions-2026-10-08/`.

Reconciliation checks both receipts, the exact signed envelope/recovered issuer,
canonical receipt block finalized by both providers, runtime and transaction-
specific state/events. One invocation never advances to another role. Local
Anvil verification and runner boundary tests exercise this behavior;
`deploy/operator-validation.json` records local setup and restart reconciliation.
The two local clients share one backend. This is not public-provider independence,
live Monad compatibility or public execution evidence.

Historical reference only: old registry deployment had a saved 320,291-gas
estimate, 384,350 signed limit and 0.0392037 test-MON fee. Old data create/commit
writes totaled 0.015508182 test-MON on 3 October. Different contracts/methods/blocks
cannot price this escrow. `deploy/local-validation.json` records disposable local
Paris Anvil with numeric chain 10143, synthetic credentials and local units;
it is not public Monad evidence.

## Evidence and remaining gates

Implemented local tests cover the reserve SDK, Iris/Accrue derivation fixtures,
funded local rights, HTTP boundaries, pending tickets, store policy, hosted Worker
behavior, client profiles and the bounded setup operator/runner. Paris validation
starts with an unfunded beneficiary, transfers gas, checks patched runtime,
restores the same signer and claims the original right once. This is engineering
evidence, not physical or
provider interoperability, external adoption or an audit. The latest recorded
aggregate verification is listed below; the documentation edit does not rerun it.

The completed `finalizedReceipt` path compares both providers' receipt fields and
logs, checks their canonical receipt-block hashes, and waits until both finalized
heads reach that block. It verifies `getRight(1)` and `rightForOwner(owner)` at the
receipt block: same owner, 0.10 test-MON and `claimed=true`; it then rechecks the
canonical block hash after those state reads. Missing/unfinalized evidence stays
pending; disagreement fails closed. The shared executor still validates the exact
claim event and successful receipt. This is trusted two-RPC corroboration, not a
cryptographic consensus proof or independently verified provider operation.
The claim-receipt path has controlled-RPC coverage and now a public finalized claim receipt, distinguished from the local tests in the execution snapshot above.

Remaining delivery work and limits:

- Preserve the completed four-transaction journals, native proof and restored A. No repeat claim or extra transaction is part of this proof.
- Native setup still produced many confirmations; the exact count is unknown. Recovery uses two WebAuthn operations. Do not claim one prompt, universal-device support or an original-app integration.
- Preserve the approved origins, namespace and deletion deadline. Shared infrastructure, durability, provider rate limits and the absence of a hard total-project billing cap remain limitations.
- Update judging/source materials with this narrow result. External demand, genuine third-party integration, production security and any minimum prize remain unproven. GitHub/npm publication, license selection, submission and video remain separate work.

One native local fresh-tab test and local claim succeeded on 8 October in the
Codex in-app browser on Mac after A was unavailable and the earlier tabs closed.
The local receipt and claimed state were checked independently. The user reported
five reserve-setup confirmations. This does not establish another browser profile,
direct iPhone-page recovery or a universal prompt count. The frozen physical
snapshot remains separate from subsequent UI progress changes; see
`evidence/native-proof-public.json`. The later public native outage-and-claim
proof is separately recorded in `evidence/native-public-testnet-proof-2026-10-08.json`.
It does not establish a different browser profile, direct iPhone recovery or
universal compatibility. Competition submission remains unperformed.

## Local review-packet preparation

After full verification and a fresh source export, run
`node scripts/prepare-approval.mjs /path/to/new-review-directory`. The helper
requires all six expected verification stages to have passed, checks their saved
source hashes against current files, checks export source hashes/archive hash,
and checks both disabled Worker hashes. It refuses an existing output directory.
It copies `source.tgz`, `source-manifest.json`, `primary-disabled-worker.mjs` and
`recovery-disabled-worker.mjs`, then writes their hashes and outstanding choices
to `review.json`. Source or documentation changes require repackaging before a
new packet; changes covered by verification hashes require new verification.

The packet is a local review handoff. Its status is `local-review-only`, with
`approved:false`, `publicExecutionReady:false`, unassigned Site IDs/origins,
unchosen expiry and unassigned transaction actors. Proposed Site names/slugs are
requests, not owned hosting identities. The packet supplies neither an enabled
release nor an operator approval file. Actual returned origins, profile, secrets,
namespace/TTL and actors must be resolved through the separately approved stages;
the enabled artifact then needs its own checks before public release.

## Concrete publication approval packet

The next external-action request should identify exact reviewable artifacts and
actions, not ask for a blanket permission to continue:

1. **Source:** a new public Account Reserve source bundle, checked against the
   final regenerated `artifacts/manifest.json` and its archive hash. Preserve the
   old repository/demo; no replacement, migration or broad parent-workspace
   publication is included. Review the explicit file list for private data,
   credentials, enrollment-secret files, local build paths and unnecessary caches.
   `scripts/package-candidate.mjs` uses an explicit evidence allowlist instead of
   copying raw operational logs/cloud responses or the private native-session
   record. It excludes hidden entries, `cache`, `out`, `node_modules`, `dist` and
   `.secrets.json`, `.server.json` and `.journal.json` files, and disables macOS
   resource-fork metadata. Export copies of delivery documents replace local
   project/snapshot paths; remaining personal workstation paths fail packaging.
   Originals are preserved. The manifest distinguishes source hashes, exported
   hashes and transformed files. This is not an arbitrary-secret detector: review
   the final file list/content, then regenerate the archive and review packet.
2. **License:** recommend MIT for the user's own new SDK/source. That project-wide
   licensing decision has not yet been selected or activated. Existing SPDX
   notices on the small owned test contract do not choose a license for the whole
   SDK. Preserve dependency/upstream licenses and attribution; do not relicense
   third-party material or present source-inspected fixtures as upstream code.
3. **Hosting/storage:** exactly two new Sites with returned project IDs and
   pinned A/B URLs, the reviewed Worker hashes, the specified existing dedicated
   database, one new namespace, maximum 16 records/64 KiB, a chosen absolute TTL,
   capability handling and current provider cap. No old Site or existing-namespace
   change, automatic budget increase or other new resource is implied.
4. **Native/testnet:** the exact new A/B credentials and actors, approved funding
   source, four unsigned envelopes/bytecode/runtime hash and ceilings above, plus
   bounded A-outage/restore. Establish actual A/B origins and the Primary-derived
   beneficiary before finalizing the transaction proposal. The implemented
   operator runs the three approved setup roles; B handles the separate claim.
   Neither a configuration flag nor the generated review packet authorizes signing.
5. **Submission:** treat the final entry save/submit and any media upload as
   separately identified actions with their reviewed text/links. The local
   `delivery/STATUS.md` and `delivery/JUDGE_GUIDE.md` describe evidence and judging
   flow; they do not themselves authorize publication or submission.

## References

- Candidate modules: `release/{host-worker,worker-entry,client-profile,profile,handler,redis-store,redis-rest,browser-store,prepare-release,testnet-executor}.mjs`
- Client/core: `app.mjs`, `app-setup.mjs`, `app-progress.mjs`, `transaction.mjs`, `pending-ticket.mjs`, `sdk/index.mjs`
- Packaging: `scripts/{build-sites,package-candidate,prepare-approval}.mjs`, `release/disabled-profile.json`, `artifacts/sites-candidate.json`
- Publication/evidence coordination: `artifacts/manifest.json`, `delivery/STATUS.md`, `delivery/JUDGE_GUIDE.md`
- Chain candidate: `deploy/{PaymentRight.sol,PaymentRight.paris.json,proposal.mjs,foundry.toml,local-validation.json}`
- Operator: `deploy/{operator,operator-journal,operator-runner}.mjs`, `deploy/README.md`, `deploy/operator-validation.json`
- Local tests: `tests/{release-chain,release-client,release-host,release-store,http-boundaries,transaction-pending,operator-flow,operator-runner}.mjs`
- Historical evidence: `continuity-kit/delivery/local-export/upstash-live-2026-10-02/publication-final.json`, `continuity-kit/evidence/testnet-deployment-verified.json`, `continuity-kit/testnet/PUBLIC_RUN_2026-10-03.md`

## Verification checkpoint: 8 October 2026, 13:16:03 UTC

After the startup-clock fix, the saved full run passed all six stages with **290 passing tests, zero failures and zero skips**: 122 core/package, 69 onboarding, 6 HTTP-boundary and 93 release tests. This rerun supplied the correct disposable `ACCOUNT_RESERVE_REDIS_BIN` and included the real Redis Lua lifecycle suite. UI and both disabled Sites builds passed under the OS-enforced loopback-only network policy. The added host regressions cover epoch-zero construction, normal first requests, fail-closed invalid profiles, the exact 45-day boundary and expiry before/after handler caching. Source hashes and stage results are in `evidence/verification.json`; counts are in the corresponding text logs. **This full run predates the resume/pacing/diagnostic operator changes.** Those changes passed a separate 41/41 focused operator run against an owned local Anvil and synthetic keys. No new full-suite result is claimed.

A/B origins, namespace, expiry, issuer and beneficiary are fixed. The four exact application transactions and bounded new-A outage/restoration were explicitly approved and are now complete, as recorded in the current execution snapshot. The checkpoint above remains historical local-test evidence.

## Concrete bootstrap candidate — 8 October, after registration

This supersedes the unassigned bootstrap inputs above. Both A and B are publicly live, and the separate beneficiary-bound transaction proposal is now constructed. The frozen bootstrap packet remains the unchanged preapproval snapshot; the table below reports current preparation status. The exact enabled local profile is `artifacts/public-preparation-2026-10-08/client-profile.json` and the reviewed public action scope is `phase-one-review.json` in the same directory.

| Input | Prepared value |
| --- | --- |
| A origin | `https://continuitykit-account-primary.cryptomickle.chatgpt.site` |
| B origin | `https://continuitykit-account-reserve.cryptomickle.chatgpt.site` |
| Disposable issuer, generated offline | `0xda66935B528737205acf44bd347123a2FdD86916` |
| Proposal's initial issuer nonce | `0` — historical pre-execution observation; current execution advances it |
| Deployed contract | `0x738F3a0E2376a8e9AFf6A4440B0dBC77c22e6B4A`; deploy finalized on both pinned RPCs |
| Namespace | `account-reserve-660a8c6ea140bb95da482829aa5b2b1e` |
| Approved expiry | `2026-11-10T00:00:00.000Z`; deletes new demonstration records |
| Enrollment | Physical A/B preparation, fresh B recovery during A outage and claim are complete for the same beneficiary. The one-write grant is consumed; its hash and the provider token remain secret server bindings on B, environment revision 1. |
| Faucet result | One approved request performed; both RPCs confirmed 5 test-MON at 13:27:40 UTC. Separate from the four application transactions. |
| Beneficiary | `0x3efc5827c9f2f25f8fd4000C4BF9318154dF1B85`, observed in physical A UI after user confirmation; bound into the separately approved transaction proposal |

The issuer secret and raw enrollment capability are kept outside the source tree. The dedicated database token was transferred through the authorized signed-in Vercel UI and a memory-only localhost bridge into B’s secret environment binding; the transfer wrote no token to files or chat. The earlier read-only preflight's zero issuer balance predates the faucet request; its later 5 test-MON balance predates transaction execution. The complete bounded native/public flow is now evidenced separately: preparation, A503, fresh B recovery, one finalized claim and restored A. It is not production-security or adoption evidence.

`stage-sites.mjs` stages only matching, verified builds into the two registered checkouts. It preserves the exact hosting manifests, rejects mismatched identities/origins/hashes and unexpected or secret-named files, and creates a dependency-free build that rechecks its frozen Worker hash. The native source/upload/save workflow has completed for both Sites. Both are now publicly deployed; B uses environment revision 1.

The historical complete verification is reported above; all 290 tests passed before the later operator changes, including the real Redis suite and 10 staging checks. The subsequent configured local Worker checks verified root/config, origin rejection, absence of local control/RPC routes, A-only outage and B's missing-binding failure using a dummy server token and no network calls. These are separate from the 41 focused operator tests and public transaction evidence.

The user explicitly approved the two new Sites, public audience, existing dedicated database binding/new namespace/expiry, new A/B example credentials and separate free-faucet request. The immutable phase-one review remains unchanged; its original `approved:false` field records preparation, not a revocation of later approval. The user's subsequent “jeg godtar” expressly approves the exact beneficiary-bound four-transaction proposal and temporary new-A outage/restoration, recorded in `user-approval.json`. This is the transaction authority; profile enablement, faucet funding and older demo permissions are not. No extra account, transaction, source publication or submission is included. Preserve the existing actors and namespace.

## Current verification and completed native public proof — 8 October

The latest full local verification supersedes the historical 290- and 303-test checkpoints: **318 tests passed, zero failed, zero skipped** across all six required stages (135 core/package, 71 onboarding, 6 HTTP boundaries, 106 release). It includes one-use enrollment-result reuse, operator pacing/resume and the shared browser RPC queue. The actual disposable Redis suite ran, with OS-enforced loopback-only networking. Tested source hashes are in `evidence/verification.json`; the frozen review packet retains the documentation and code tested before publication.

After the earlier A/B preparation snapshot, old setup tabs were closed and A returned 503. Fresh B tab 10 recovered the exact original beneficiary with the existing physical key; the single approved claim finalized and B displayed **Payment collected** with its signing session closed. A was restored to version 3/environment revision 2; root and config both returned HTTP 200. Evidence: `evidence/native-public-testnet-proof-2026-10-08.json`, `evidence/public-claim-finalized-2026-10-08.json` and `evidence/public-primary-restored-http-2026-10-08.json`. The earlier `native-public-test-next.json` and outage file remain historical intermediate snapshots. The user reported very many confirmations; exact device-specific counts and reduced friction remain unproven.

The shared per-page FIFO for each pinned RPC, at least 250 ms apart and without retries or alternative endpoints, was first published in Primary version 3 and Reserve version 2 and remains in the current versions. Readiness reads, claim validation and wallet traffic use the same queues. It does not synchronize different tabs/devices or guarantee provider availability. A post-signing failure still preserves the existing hash and blocks another send. That approved update introduced no new account, passkey, namespace, transaction authority or expiry. See `evidence/browser-pacing-fix-2026-10-08.json` and `evidence/browser-pacing-publication-2026-10-08.json`.

## Enrollment optimization publication — 8 October

The user separately approved publishing the frozen `artifacts/enrollment-reuse-review-2026-10-08/` packet with “Ja”. Sites reported both deployments successful as Primary 4 / Reserve 3, using the unchanged environment revisions 2 / 1. Domains, server bindings, storage namespace, expiry, contract and claim limits are unchanged. Publication evidence is `evidence/enrollment-reuse-publication-2026-10-08.json`; the immutable review packet remains the preapproval snapshot.

New enrollment reuses derived material from credential creation once, removing one redundant assertion API call. Synthetic tests count one creation plus three assertions with direct PRF output, or one creation plus four assertions with a PRF fallback. Independent stored-byte readback and recovery/signature checks remain; fresh recovery still uses two assertions. These are API-call counts, not measured device prompts. No new physical setup, passkey, account or transaction was performed for this publication. The SDK and starter remain unpublished on npm; GitHub source publication, competition submission and video are separate unfinished actions.
