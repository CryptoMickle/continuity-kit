# Private work reserve — isolated D1 candidate

> Historical preparation document, 8 October. Superseded status as of 9 October: the separate Work Sites are published with D1, and the Mac native outage test and completed exports are verified. iPhone recovery is explicitly user-confirmed; direct device-screen/full-content evidence remains pending. See [current portable proof](../evidence/work-public-proof.json) and [judge guide](JUDGE_GUIDE.md). The proposal and pre-publication wording below are retained as history, not current deployment instructions.

Prepared 9 October 2026. This replaces the **storage proposal only** in WORK_NATIVE_CANDIDATE.md. The dated Redis candidate remains historical evidence. Existing Account Reserve v1 and Delveworn are outside this change.

## Fixed scope

Reuse the two already-created work Sites and their assigned origins in work-release/proposed-profile.json. Only the recovery Site receives a native Sites D1 binding named DB. The primary Site has no database. No old Redis credential is read, copied or required. No old reserve is migrated.

The same one-passkey work protocol, immutable encrypted snapshot, app binding and unfunded example account remain. The browser holds no provider credential. Enrollment requires an operator-issued single-use code; fresh recovery requires the existing reserve passkey, not that code. Reading or editing work does not open a signer. No blockchain transaction is added by this change.

The isolated namespace has a maximum of 16 immutable records, each at most 65,536 bytes before base64 encoding. Ciphertext, its random locator and the used enrollment-code hash occupy one row. A transactional D1 batch binds the release metadata and inserts the row; constraints and guarded queries enforce unique locators, unique code consumption and the quota. Unknown write results are not retried. A fresh read can recover an already-committed copy.

Schema: work-release/db/schema.ts. Generated and locally applied migration: work-release/drizzle/0000_fixed_mockingbird.sql. Production schema changes must use appended generated migrations after any migration is applied. Runtime requests never create tables.

## Retention: a material difference from the Redis proposal

Access ends **10 November 2026 at 00:00 UTC / 01:00 Oslo**. The database clock guards reads and writes. The recovery Worker has a narrowly scoped expiry cleanup: POST /api/retention/cleanup with an empty JSON body. Before the fixed deadline it refuses deletion. Afterward it can delete only this deployment's already-expired namespace. Callers cannot supply a namespace, date or live-record selection. Origin checks are browser hygiene, not caller authentication; this maintenance operation is deliberately limited by time and immutable scope.

Deletion of active records requires execution of cleanup; deploying this endpoint does **not** establish a scheduled deletion. No future cleanup execution is claimed. A release header remains to prevent accidental extension/reuse and contains no ciphertext, passkey, owner address or enrollment code.

Cloudflare D1 Time Travel is always enabled and retains recovery history for 7 or 30 days, depending on the platform plan. Use **up to 30 further days after active deletion** as the conservative disclosure; this is not a promise that every provider log or copy is erased on that date. The Sites plan's exact retention and billing are not established by Cloudflare's direct-customer pricing page. Do not promise zero cost or immediate erasure of every copy. Source: https://developers.cloudflare.com/d1/reference/time-travel/

The old approval specified expiry and deletion at the deadline. Accept this changed retention explicitly before issuing an enrollment grant or storing an example. Until then the new native-storage release remains a prepared candidate. Fictional example content only; no sensitive or real client work.

## Cost and separation

No external database subscription, Vercel plan change or paid service order is part of this candidate. D1 provisioning would be managed by the existing Sites platform. The small record quota limits stored data; it does not cap arbitrary public request traffic or prove a monetary billing cap. No authoritative Sites D1 price or account-specific charge guarantee was available in the inspected tools/docs.

## Verification and remaining acceptance

The local D1 suites run SQL against Miniflare's actual D1 implementation. Separate compiled-bundle checks execute both application Workers in workerd, apply the generated migration locally and verify routing and the expiry guard. None of this is public deployment or physical passkey proof. The final review artifact records exact hashes and results.

Developer-tool audit: production-only dependencies have zero reported vulnerabilities at this check. Full audit reports seven package findings in Drizzle Kit/esbuild and Miniflare/sharp/undici development dependencies. Those tools are not imported by the hosted Worker. Tests run with external networking blocked; no untrusted image inputs or development server are used. No forced dependency upgrade was performed.

Remaining: agree the retention/cost disclosure, provision and deploy D1 on the existing recovery Site, verify hosted binding/migrations and public request boundaries, establish and verify an unattended cleanup path or explicitly accept operator-run cleanup, then issue one setup code and perform one Mac/iPhone native proof. Preserve all existing passkeys and public account proof. Video is separate.
