# ContinuityKit — source candidate

Recover an approved private checkpoint through a separate recovery client, and detect when storage offers an older copy. The experimental SDK uses Mera for private recovery material and Monad for owner-approved version/digest records. A registry cannot restore lost bytes.

This archive contains an explicitly selected working-tree snapshot of the SDK, reference UI, JavaScript/TypeScript tests, registry contract/tests, release builders and generated database migrations. Its manifest identifies the exact packaged bytes. Preparing this archive does not publish it or change the separately hosted application.

## Evaluate without accounts or transactions

Use Node 24+ and npm. After extracting the archive, enter `continuity-kit-source-candidate`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node delivery/source-candidate/verify.mjs
npm run build:sdk
npm run verify:sdk
```

Source installation downloads locked public packages. The verifier installs the compiled SDK in a temporary separate project and runs the journal-correction example. If the consumer needs public dependencies absent from npm's offline cache, use `npm run verify:sdk -- --allow-downloads` once. This permits dependency downloads during installation, not network requests from the synthetic recovery example.

The result should report `verifiedVersion: "2"`, `correctedDecisionPreserved: true`, `unchangedSnapshotsSkipped: 1`, `oneStaleMirrorRejected: true`, `bothStaleMirrorsFailedClosed: true` and `unavailableRegistryFailedClosed: true`. Only two signed local-model writes occur, with zero blockchain transactions and zero physical ceremonies. The same public types are checked in NodeNext and bundler module modes. This is an internal integration check, not an external adopter.

For protocol source examples and the full regression suite:

```sh
npm run demo:passport
node delivery/sdk-example.ts
npm run check
```

`check` typechecks, runs the complete included JavaScript/TypeScript suite and builds the UI. Some tests bind temporary loopback ports and use disposable SQLite databases. Chain tests use offline fixtures; these commands do not contact a blockchain. The Solidity tests require Foundry separately and are not part of `npm run check`.

For a compiled package consumed outside the source tree, follow [the SDK package guide](delivery/SDK_PACKAGE.md) and [standalone consumer](examples/standalone-consumer/README.md). `npm run build:sdk` prepares a private local archive; `npm run verify:sdk` checks installation, public types and the synthetic recovery scenario in a separate consumer. This verifies the package boundary internally. It is not an external integration or adoption claim.

The optional real-Redis tests require a local Redis server binary: run `REDIS_SERVER_BIN=/absolute/path/to/redis-server npm run check`. They start disposable Unix-socket servers with public synthetic bytes, never an external database. Without that variable, the two real-Redis integration groups are explicitly skipped; the adapter's transport/error tests still run. The server and temporary data are removed afterward. No Redis binary is bundled or installed by the test suite. To measure command counts including Lua subcommands, run `REDIS_SERVER_BIN=/absolute/path/to/redis-server npm run measure:redis -- --out delivery/local-export/new-cost-measurement` after creating `delivery/local-export` if needed. This is a synthetic local benchmark, not live billing evidence.

## Browser trial

The source retains its original addresses and bytes. To avoid interfering with an existing physical localhost run, generate the isolated, synthetic trial using the included builder (Python 3.9+):

```sh
python3 delivery/browser-evaluation/build-package.py --out delivery/local-export/my-browser-trial
```

Extract its `continuity-kit-browser-trial.tar.gz` into another directory. In that extracted directory, run `npm ci --ignore-scripts --no-audit --no-fund`, then `npm start`. Open [the guided trial](http://trial-recovery.localhost:4374/try.html). Close any earlier trial using ports 4373–4375 first. This separate package substitutes only local hostnames/ports, fixes synthetic mode, denies native credential permissions and keeps its data in RAM. It requires no physical passkey or account. Use invented content only.

The trial's `PACKAGE_MANIFEST.json` records its build date and source hashes. The Git base reference is `null` when built from an extracted archive without Git history. Generated trial outputs do not update this source candidate or constitute new evidence by themselves.

Do not use `dev:testnet`, deployment/repair panels or historical run configurations for this evaluation. They are included to make the source and tests reviewable, not as instructions or authority to repeat a transaction. All earlier operator allowances are consumed.

## Reproduce the release candidate locally

```sh
mkdir -p delivery/local-export
node scripts/build-release.mjs --profile release/profile.example.json --out delivery/local-export/my-release
node scripts/check-release-hosts.mjs delivery/local-export/my-release
```

For the separate external-storage candidate, append `--storage upstash` to the builder and use a new output directory. The [store worker](src/release/redis-worker.ts) and [handler](src/release/redis-handler.ts) define its server-only configuration. Credentials must never be included in client source, profiles or archives. The local build does not create a database, configure runtime secrets, modify existing D1 migration history or publish a service. Private operator logs and old hosting approval documents are intentionally excluded from this developer package.

This builds A, B and the store using reserved `.invalid` origins. It does not create Sites, upload source, register domains or deploy. Keep the generated Drizzle SQL, snapshots and journal together; never apply the old combined fixture SQL and the new migration sequence to the same database. Optional local Workers/D1 checks and their exact dependency lock are in [release/validation](release/validation/README.md).

## Evidence and limitations

- Synthetic examples and automated tests establish only their explicit local behavior.
- On 3 October, the separate public demonstration completed two Monad-testnet writes (v1 and corrected v2), restoration through the existing primary credential and fresh recovery through the existing recovery credential. Public receipt fields and exact v2 content matched the independently checked registry state. This is evidence for that bounded public demonstration, not for every build or integration.
- On 5 October, a controlled Primary-host outage returned HTTP 503 for its root and application asset while Recovery stayed available. The user's iPhone screenshot showed successful v2 recovery between the successful outage controls. A later screenshot of the same already-open copy, supplied after Primary was restored, showed the exact corrected-v2 marker. These screenshots support the bounded result; they are not a continuous ceremony or browser/network trace, a certified fresh profile, or proof of universal device support.
- Primary was restored to the same saved application version after the outage. No new credential or blockchain write was used for that test. The earlier two-confirmation observation belongs to the 3 October run; the 5 October confirmation count was not recorded.
- The frozen public client candidate passed 300 JavaScript/TypeScript tests, including 43 targeted UI tests, plus typechecking and build checks before publication. That dated result must not be reported as a test run of a later source snapshot. Run this archive's checks and retain their actual results separately.
- Recovery needs prior preparation, a surviving recovery credential, authentic encrypted indexes/current bytes and the configured registry/RPC trust assumptions. B does not regain A's wallet authority. Two store slots in one database are not independent infrastructure.
- No independent integration, user demand, revenue or recurring transaction volume is documented. [Compare an independent encrypted export](BACKUP_COMPARISON.md) before adding a registry to a real workflow.

The separate demonstration is hosted at [Primary](https://continuitykit-primary.cryptomickle.chatgpt.site) and [Recovery](https://continuitykit-recovery.cryptomickle.chatgpt.site/?mode=physical), using example content and bounded presenter access. It is not an anonymous backup service. Configured demo access ends on 10 November 2026 at 00:00 UTC; that does not delete stored copies, stop billing or guarantee availability until that date. Existing passkeys and checkpoints remain bound to their original configuration. Do not reuse them for a different profile.

The organizer's response, last reviewed on 3 October, accepted supervised passkey demonstration plus runnable public source as an evaluation method. Video deliverables and sponsor-specific live demonstration remain separate tasks. No claim of sponsor acceptance or prize qualification follows from this source package.

## Source versus deployed runtime

The public source repository's recorded 1 October snapshot predates the 3 October client update. This new local archive does not update that repository. A later authorized source publication must preserve that distinction and identify the actual published commit.

The frozen public client asset is `/assets/index-C04IsxDj.js`, with SHA-256 `e37138a98b3a5faebb324440fb6f755751464bdcd9926ddd0239e6f838382ae1`. A source manifest proves source-file identity, not that a rebuild reproduces that asset. The release build also depends on the exact reviewed profile, locked dependencies and build tooling. The included `.invalid` example profile deliberately produces a different local candidate. Claim matching deployed artifacts only after rebuilding with the original profile and comparing the actual output bytes; a match does not establish a fresh native authentication test.

The byte-preserving exporter and its explicit file list are included under `delivery/source-candidate/`. They exclude environment files, local service state, generated build archives, browser/account captures and correspondence. `build.py` uses the enclosing Git repository only to record a base-reference identifier; it does not export history. From a source checkout with Git history, create a new local snapshot with:

```sh
python3 delivery/source-candidate/build.py --date YYYY-MM-DD --out delivery/local-export/new-source-candidate
```

Use the actual preparation date and a new directory. The exporter refuses an existing output. An extracted archive without its enclosing Git history is verified with `verify.mjs`; it is not a substitute for that history when preparing another source snapshot. The historical Git-publication preparation script is intentionally excluded because its old release text and history workflow are not the current publication procedure.

## Source and attribution

Mikkel is the sole human developer. OpenAI Codex/GPT agents assisted design, implementation, tests, documentation and review; this is not an independent security audit. Mera supplies the passkey PRF/vault APIs. Original source is under the supplied MIT [license](LICENSE); [dependency notices](public/third-party-notices.txt) retain their own licenses.

`SOURCE_MANIFEST.json` lists every packaged path and SHA-256, its source path and the real base commit. Application code, tests, configurations and migrations are copied byte for byte. This README and the verification utility are separately identified packaging material. No `.env`, local service state, saved keys, installed tools, browser/account captures or outreach correspondence is included.

This is a working-tree snapshot, including uncommitted changes, without Git history. The recorded base commit does not identify all these bytes. Genuine history and a reviewed final commit must accompany a later authorized public repository. Earlier Delveworn/Market Dungeon work informed the direction; no claim of certified originality or settled third-party rights is made. The passport example references Turnstile's public data model; its identity layer is not integrated and no endorsement is implied.

Begin implementation review at [the SDK exports](src/sdk/index.ts), [protocol](src/sdk/protocol.ts), [integration boundaries](INTEGRATION.md), [contract](contracts/src/ContinuityRegistry.sol) and [specification](SPEC.md).
