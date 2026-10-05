# Installable experimental SDK

This private local package contains compiled ESM JavaScript and TypeScript declarations. It is not published to npm. Use Node 24 or newer. It provides the existing ContinuityKit protocol; packaging does not change the deployed app or its recovery format.

From the source checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:sdk
npm run verify:sdk
```

`build:sdk` writes `delivery/local-export/sdk/continuity-kit-0.1.0.tgz` and a SHA-256 manifest. The archive contains only SDK modules, type declarations, a manifest with pinned direct dependencies, license, notices and this guide. Dependencies are installed separately, not bundled; consumer transitive resolution may differ from the source lockfile. `private: true` prevents accidental npm publication. It does not contain the reference UI, server configuration, credentials or saved work.

Install the archive in your own ESM project:

```sh
npm install --ignore-scripts --no-audit --no-fund /absolute/path/to/continuity-kit-0.1.0.tgz
```

```ts
import { discoverRecovery, recoverCurrent } from "continuity-kit";
import type { RecoveryAdapters, RecoveryPolicy, PasskeyAdapter } from "continuity-kit";

export async function openCurrent(
  policy: RecoveryPolicy,
  passkeys: PasskeyAdapter,
  adapters: RecoveryAdapters,
) {
  const discovered = await discoverRecovery(policy, passkeys, adapters);
  return recoverCurrent(discovered, passkeys, adapters);
}
```

The package has no default configuration for production. The host must prepare recovery in advance, supply the policy and storage/registry adapters, handle pending writes and run real passkey actions on the proper origins. `Workspace` remains the supported payload; this is not a generic arbitrary-data SDK. Recovery returns the last accepted checkpoint, not an assurance that the host's latest edits were saved. An unavailable current copy must not be replaced with an old copy labeled current.

For disposable **synthetic examples only**, explicitly import:

```ts
import { SyntheticWebAuthnClient } from "continuity-kit/testing";
```

This test client uses public, reproducible secrets. Never protect private content with it. It is excluded from the root export. In-memory stores and the local-model registry are examples, not independent storage or blockchain evidence. Physical Mera WebAuthn support and an actual Monad integration are separate requirements.

`verify:sdk` installs the archive in a temporary standalone consumer, checks its public types and runs a synthetic changed-checkpoint/recovery scenario. Dependency installation defaults to npm's offline cache and refuses lifecycle scripts. If required public dependencies are missing from the cache, explicitly permit their download with `npm run verify:sdk -- --allow-downloads`. The runtime example disables fetch, makes no blockchain transactions, creates no physical passkeys and logs only checks/counters. This is internal engineering verification, not an independent developer evaluation or adoption.

In the source repository, `examples/standalone-consumer` is the complete package-consuming example. `delivery/SDK_INTEGRATION_CONTRACT.md` documents identity, handoff, schema, save outcomes and lifecycle responsibilities. The SDK remains experimental and unaudited; the public demonstration's two stored copies share one database/operator.
