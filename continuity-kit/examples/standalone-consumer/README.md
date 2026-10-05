# Standalone package consumer

This is an internal, synthetic integration example for a separate project-journal application. It imports the installed `continuity-kit` package and `continuity-kit/testing`; it never reaches into repository source. It is not an external integration, user trial, or adoption claim.

The application saves an invented decision, corrects it, and skips an unchanged snapshot. A fresh recovery client then rejects an authentic old copy from one mirror and opens the corrected checkpoint from the other. It refuses recovery when both mirrors return old bytes or the registry is unavailable.

## Run

Requires Node 24+ and the source checkout's installed development dependencies. From the repository root, build the private SDK tarball and then install it in this separate example:

```sh
npm run build:sdk
cd examples/standalone-consumer
npm install --ignore-scripts --no-audit --no-fund
npm run typecheck
npm start
```

The archive is `delivery/local-export/sdk/continuity-kit-0.1.0.tgz`. Installation may download the SDK's pinned direct dependencies, their transitive dependencies, and TypeScript. Running the example itself needs no network, HTTP service, environment secrets, account, physical passkey, chain, or funds. Keep `typecheck.ts` as a compilation fixture; do not execute it.

To use a copy outside the repository, change only the `continuity-kit` file dependency to the absolute path of the locally built tarball before installing. The executable example uses public package imports in either location. The package remains experimental and private; these instructions do not publish it to a registry.

Expected output includes `verifiedVersion: "2"`, `correctedDecisionPreserved: true`, `unchangedSnapshotsSkipped: 1`, both stale-mirror assertions, `localRegistryWrites: 2`, and `blockchainTransactions: 0`. Only result metadata is printed. All credentials, content, stores, and registry state live in memory and disappear when the process exits. The synthetic credentials are reproducible from a public seed; never use them to protect private content.

## What this proves

- A separately installed consumer can compile against the packaged declarations and run the SDK through its package exports.
- This specific application's exact-content guard avoids an unchanged checkpoint. It is consumer policy, not SDK-wide deduplication or proof of useful transaction demand.
- The current approved correction survives fresh recovery after closing the primary key/signing state, subject to a surviving good mirror and available local registry.
- An authentic old ciphertext is not automatically accepted as current.

This process does not simulate an HTTP outage or establish independent storage availability. Both mirrors and the registry are memory objects in one process. The registry records signed local-model commands, not blockchain transactions.

## Before adapting it to a real browser app

The package supplies protocol functions, not a complete browser enrollment or save controller. Real A/B enrollment requires separate configured origins and the validated origin/window-bound handoff. A failed or pending checkpoint must preserve the host draft and operation state for reconciliation; this small example aborts on an unresolved outcome without retrying. Host-save success and checkpoint confirmation remain separate facts.

The example retains the existing `{ title, plan, tasks, draft }` payload boundary. It does not introduce arbitrary-byte snapshots, import a host identity, recover wallet authority, or transfer write authority to B. See the repository's `delivery/SDK_INTEGRATION_CONTRACT.md` for the complete current contract and limitations.
