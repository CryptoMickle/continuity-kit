# ContinuityKit — source candidate

An experimental SDK for recovering private app work through a separately prepared origin, while checking which saved version the owner approved.

This archive contains the current SDK, reference UI, all JavaScript/TypeScript test files, registry contract/tests, release builders and generated database migrations. It is a private preparation artifact, not a public repository, hosted service or completed competition entry.

## Evaluate without accounts or transactions

Use Node 24+ and npm. After extracting the archive, enter `continuity-kit-source-candidate`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node delivery/source-candidate/verify.mjs
npm run demo:passport
node delivery/sdk-example.ts
npm run check
```

Dependency installation downloads the locked public packages. Both examples use public synthetic credentials and a local in-memory registry. The passport example saves a correction, recovers exact v2 after loss of A, rejects stale copies and skips an unchanged checkpoint. Look for `exactPayloadRoundTrip`, `oldCopyRejected`, `bothOldCopiesRejected` and `unchangedCheckpointSkipped` set to `true`. This demonstrates zero blockchain transactions, physical ceremonies or independent adoption.

`check` typechecks, runs the complete included JavaScript/TypeScript suite and builds the UI. Some tests bind temporary loopback ports and use disposable SQLite databases. Chain tests use offline fixtures; these commands do not contact a blockchain. The Solidity tests require Foundry separately and are not part of `npm run check`.

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

This builds A, B and the store using reserved `.invalid` origins. It does not create Sites, upload source, register domains or deploy. Keep the generated Drizzle SQL, snapshots and journal together; never apply the old combined fixture SQL and the new migration sequence to the same database. Optional local Workers/D1 checks and their exact dependency lock are in [release/validation](release/validation/README.md).

## Evidence and limitations

- Synthetic examples and automated tests establish only their explicit local behavior.
- A separate physical test on 28 September recorded v1/v2/v3 application writes on Monad testnet, fresh B-v2 recovery with A offline and stale-v1 rejection, then fresh A-v3 continuation. Enrollment needed an operator repair; both copies shared one local service. That is historical evidence, not a native test of this archive.
- The 1 October release candidate passed local asset/header checks and six workerd/D1 scenarios. Public origins, actual hosted behavior and controlled recovery with the same B passkey in a second environment remain unproved.
- Recovery needs prior preparation, a surviving recovery credential, authentic encrypted indexes/current bytes and the configured registry/RPC trust assumptions. B does not regain A's wallet authority. Two store slots in one database are not independent infrastructure.
- No independent integration, user demand, revenue or recurring transaction volume is documented. [Compare an independent encrypted export](BACKUP_COMPARISON.md) before adding a registry to a real workflow.

The organizer accepted supervised passkey demonstration plus runnable public source as an evaluation method; the actual public links, presentation and sponsor-specific proof still remain. No claim of sponsor acceptance or prize qualification follows from this source package.

## Source and attribution

Mikkel is the sole human developer. OpenAI Codex/GPT agents assisted design, implementation, tests, documentation and review; this is not an independent security audit. Mera supplies the passkey PRF/vault APIs. Original source is under the supplied MIT [license](LICENSE); [dependency notices](public/third-party-notices.txt) retain their own licenses.

`SOURCE_MANIFEST.json` lists every packaged path and SHA-256, its source path and the real base commit. Application code, tests, configurations and migrations are copied byte for byte. This README and the verification utility are separately identified packaging material. No `.env`, local service state, saved keys, installed tools, browser/account captures or outreach correspondence is included.

This is a working-tree snapshot, including uncommitted changes, without Git history. The recorded base commit does not identify all these bytes. Genuine history and a reviewed final commit must accompany a later authorized public repository. Earlier Delveworn/Market Dungeon work informed the direction; no claim of certified originality or settled third-party rights is made. The passport example references Turnstile's public data model; its identity layer is not integrated and no endorsement is implied.

Begin implementation review at [the SDK exports](src/sdk/index.ts), [protocol](src/sdk/protocol.ts), [integration boundaries](INTEGRATION.md), [contract](contracts/src/ContinuityRegistry.sol) and [specification](SPEC.md).
