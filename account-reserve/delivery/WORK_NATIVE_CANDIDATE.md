# Private work reserve — native test candidate

> Historical preparation document, 8 October. Superseded status as of 9 October: the separate Work Sites are published with D1, and the Mac native outage test and completed exports are verified. iPhone recovery is explicitly user-confirmed; direct device-screen/full-content evidence remains pending. See [current portable proof](../evidence/work-public-proof.json) and [judge guide](JUDGE_GUIDE.md). The proposal and pre-publication wording below are retained as history, not current deployment instructions.

Prepared 8 October 2026. **Local, unpublished candidate.** No Site IDs are assigned, no new enrollment code has been issued, and no native result is claimed for this protocol. Final hashes and test results are recorded in `artifacts/work-native-review-2026-10-08/` after verification.

## What the user would approve

Publish two new, separate Sites for this bounded example. Requested names are `continuitykit-work-primary` and `continuitykit-work-reserve`; the origins in `work-release/proposed-profile.json` are proposals until the hosting service assigns and confirms them. If the assigned origins differ, rebuild and recheck their exact RP/origin bindings before any credential is created.

Use the existing ContinuityKit Redis service, with a new namespace `accountreserve:v1:70b323ddd108a14ca1c8c9288ccabac8`. No new database or paid plan is proposed. Copy the existing server-only Redis binding to the new reserve service through the hosting tools; it must never appear in a browser, URL, source archive or chat. Existing services, namespaces and stored reserves remain separate. Both sites and storage are still under one operator.

Issue one new single-use enrollment code, then let Mikkel complete the native recovery-passkey ceremony. The original example workspace generates an unfunded disposable account locally and requires no A passkey. Its fictional client brief and unfinished draft are encrypted in one immutable reserve. The code is checked before the native creation click; no automatic code, passkey or write retry is performed. Device prompts may still be multiple.

Temporarily make only the new primary service unavailable for the recovery test, then restore it. Open the same reserve with the same B passkey on a second device or a genuinely fresh browser profile. Recovery needs no setup code, account address, file or old browser session. Opening/editing/exporting work does not open a signer. An optional explicit account check signs only a local challenge; it sends no transaction.

The storage bound is 16 immutable records of at most 64 KiB each, with absolute expiry and deletion on **10 November 2026 at 00:00 UTC / 01:00 Oslo**. One code permits only one record; the larger technical quota is not an invitation to enroll more credentials. Passkeys saved by the device are not removed by the storage expiry. Keep only fictional example content in this trial.

This scope includes no faucet request, funding, payment, blockchain transaction, npm/GitHub publication, competition submission or video. Existing Account Reserve v1 proof remains separately attributed.

## Implemented controls

- `work-release/` wraps the existing bounded Redis transport and atomic immutable writer without changing their v1 behavior. Request-time validation handles Worker startup clocks safely.
- `/api/config` exposes only public fixed app/origin/RP/expiry settings. Enrollment codes are never returned by a GET.
- The B-only enrollment check validates the exact origin, request size, code hash, namespace, quota and expiry using read-only Redis commands. A ready response does not reserve capacity: the final atomic write remains authoritative if another action consumes the code meanwhile.
- A successful check enables a separate deliberate native click for at most 60 seconds. Invalid, consumed or expired codes fail before key creation. Closure-held code state is cleared when used, cancelled, expired or the page leaves.
- Hosted builds remove the synthetic authenticator. Synthetic, local control and RPC endpoints are absent. The browser's connection policy is self-only.
- The client can continue editing and exporting an already recovered local draft when account access expires. It cannot silently unlock the signing account.

## Local build and verification

Verification completed on 8 October: all **11 stages passed**, comprising **396 passing tests, zero failed and zero skipped**, plus the builds and TypeScript check. Another **8 source-export tests passed**. The new hosted-work group accounts for 30 tests, including actual disposable Redis Lua and a complete SDK-to-Worker storage/recovery cycle. The existing six-stage account release suite remains passing.

The updated local synthetic browser flow was also repeated: new example preparation, A unavailable, A tab closed, fresh B document, matching recovered brief/draft and account signing still locked. Widths 320, 390 and 1280 had no horizontal overflow; no console errors were observed in the recovered tab. This is neither native proof nor a fresh browser profile test. The previous export download check remains separately recorded in `artifacts/work-reserve-review-2026-10-08/browser-review.json`; it was not repeated here.

`npm run verify:local` checks the original account flow, the new work protocol, hosted boundaries and actual Redis Lua against disposable local infrastructure. Native assertions in those tests remain simulated. The default `npm run build:work-sites` produces disabled Workers; the explicit proposed profile produces configured local bundles but still performs no upload or deployment.

```sh
npm run build:work-sites -- work-release/proposed-profile.json https://mutual-calf-226520.upstash.io
```

The URL here is the public REST service origin, not a credential. Secrets are runtime-only. The candidate manifest records Worker hashes and makes the unpublished state explicit. Use the frozen source and hashes when preparing an approved release; do not stage a silently changed working tree.

## Acceptance evidence still required

1. Check both assigned origins, headers, native-only configuration and runtime bindings after publication.
2. Record successful preparation of the exact fictional work, with the observed device/browser and prompt count if known. Treat uncertain writes as uncertain; do not start over automatically.
3. Verify A returns 503. On the second device or fresh browser profile, use the existing B passkey and confirm identical prepared work with no account signer open. A fresh tab in the same profile is insufficient for this competition condition.
4. Finish and export the draft. Record that export is a local copy and does not update the immutable stored snapshot. Restore and check A.
5. Attribute the new work proof separately from the existing Monad account/payment proof. Update prize and submission claims only after these observations exist. Video remains deferred.

The candidate makes the non-wallet work task concrete. It does not establish customer demand, superiority over all encrypted backups, sponsor acceptance or any minimum prize payment.
