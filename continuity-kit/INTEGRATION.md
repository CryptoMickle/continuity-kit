# Integrate one meaningful checkpoint

The experimental SDK has a private, locally installable JavaScript/TypeScript package; it is not published to npm. Start with [the standalone consumer](examples/standalone-consumer/README.md) and [package instructions](delivery/SDK_PACKAGE.md). The consumer imports `continuity-kit`, without reaching into this repository. Source reviewers can inspect [the SDK exports](src/sdk/index.ts).

The first example is a project journal: correct an approved decision, save one new checkpoint, close primary state and recover the correction with a newly constructed recovery client. One stale storage response is rejected; when neither copy is current, recovery fails explicitly. This internal synthetic scenario checks the package boundary and a concrete save policy, not external adoption or actual blockchain usage.

The SDK currently accepts the validated `Workspace` shape: `{ title, plan, tasks, draft }`. The earlier [passport adapter](examples/passport-recovery/adapter.ts) demonstrates a small versioned payload in `draft`, not an existing integration or a generic byte-storage API.

The host selects plaintext from an already opened workspace, decides when a meaningful change deserves a checkpoint, and passes it to ContinuityKit for encryption. Copying only another application's ciphertext will not help if that application's key disappears too. Current setup creates separate Continuity primary and recovery credentials; it does not reuse the host's login automatically.

| Step | API | Result to handle |
| --- | --- | --- |
| Create primary state in A | `createPrimary` | In-memory constrained signing/key state |
| Prepare independent credential in B | `prepareBackup` | Immutable encrypted recovery manifest/index |
| Store and register v1 | `finalizeEnrollment` | `prepared` or `pending` |
| Save a meaningful update | `saveCheckpoint` | `saved`, `pending` or `superseded` |
| Restore A | `restorePrimary` | Same primary owner plus recovered content |
| Discover and open from B | `discoverRecovery`, `recoverCurrent` | Verified current checkpoint; reader/mirror adapters only |
| Continue outside A | `createLocalCopy`, `exportLocalCopy` | Local edit/plaintext export, without A's signing authority |

See [the runnable SDK example](delivery/sdk-example.ts) and [payload scenario](examples/passport-recovery/scenario.ts). Their synthetic credentials allow both origins to be modeled in one process. Real setup must run on separate RP origins using the [validated window handoff](src/handoff.ts), not by replacing the fixture and calling everything on one browser page.

Host-save success and confirmed checkpoint success are distinct. Retain an unconfirmed draft and its transaction ticket; reconcile the same operation instead of blindly signing again. A `saved` result can still contain an unresolved ticket that prevents further writes. The reference UI compares exact content against the verified saved snapshot; low-level SDK callers supply their own change guard. The passport example intentionally ignores timestamp/outer-whitespace-only changes.

The fixed policy binds application/schema/deployment identity, A/B RP scopes, mirrors and registry. Do not learn this policy from untrusted storage or change it after enrollment. Recovery trusts the configured registry/RPC view, the recovery client, the surviving credential and available encrypted bytes. The public-host candidate's two slots still share one database.

On missing current bytes, report `CURRENT_DATA_UNAVAILABLE`. On unavailable current-version evidence, report `FRESHNESS_UNAVAILABLE`. On user cancellation, permit an explicit retry; on unsupported PRF, explain the incompatibility. Do not silently label an old version current. Close primary state at logout/expiry; never persist keys or plaintext as integration metadata. Exports are deliberately plaintext.

Recovery does not restore a wallet, transfer tickets, establish the truth of content or erase old ciphertext. Stable hosting, key-loss/rotation, production operations, independent durability and compatibility with a host's identity/fee layer remain integration work.
