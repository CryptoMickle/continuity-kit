# ContinuityKit account reserve

Experimental developer toolkit for preparing independent access to an **existing** passkey-derived EOA. This is a new protocol with a local reference application and a separately approved public Monad testnet demonstration. It does not replace the previously published, data-only ContinuityKit demo.

A reference application earns a small, valueless payment before preparing its reserve. After that application's frontend, API and RPC endpoint become unavailable, a fresh reserve client discovers the encrypted package from a recovery credential, authenticates the original account binding and collects the already-existing payment. A replacement account cannot collect it.

The local demo uses a synthetic authenticator by default and a disposable Anvil chain. There are no external RPCs or real funds. Ciphertext survives browser reloads but **not server restarts**. Both origins and the chain run on one machine; shutting down A is an application-outage experiment, not proof of independent hosting.

## Developer first run — no chain required

For the smallest complete integration, generate a **separate** project from the
local package. The destination must be empty; existing files are never replaced.

```sh
npm run create:starter -- /absolute/path/to/new-reserve-starter
cd /absolute/path/to/new-reserve-starter
npm install --ignore-scripts
npm run typecheck
npm test
npm run dev
```

Open <http://reserve-demo-primary.localhost:4673/>. Create the synthetic example
account, activate and prepare its reserve, turn A off, then open a fresh B and
verify the same account. No wallet, Foundry, database account or test funds are
needed. This starter verifies a local signing challenge and closes the signer;
the original payment demo below remains the separate transaction proof.

The starter imports only the installed public SDK, never internal test fixtures.
It includes reusable browser setup controllers, a same-origin HTTP adapter,
read-only environment diagnostics and TypeScript declarations. See
[the complete integration guide](starter/README.md). Native credentials remain an
explicit separate test; default mode is synthetic. The teaching server is
loopback-only and loses its data on restart. Do not deploy it.

Public entry points are the core package, `/browser`, `/http-store` and
`/preflight`. `npm run test:onboarding` generates an empty consumer, installs the
tarball offline, checks its types/build and verifies fresh recovery through its
own HTTP server with A unavailable. This is internal integration evidence, not
external adoption or a measured human onboarding time. The experimental SDK source is MIT-licensed and remains unpublished on npm.
`private: true` prevents accidental registry publication.

## Run the local demonstration

Requirements: Node 24+, npm, and installed Foundry `anvil`. Install dependencies from the included lockfile:

```sh
npm ci --ignore-scripts
npm run build
npm run dev
```

Open <http://continuity-primary.localhost:4573/?model=iris>.

1. Create an example account with its pre-existing local test payment.
2. Open the independent reserve window and prepare it. Wait for the independent check.
3. Take the original app offline using the reserve client's local test control.
4. Close the original tab. Follow **Open a fresh reserve** to discard the preparation state.
5. Open the existing reserve and collect the payment. The client closes its signer after confirmation.

Repeat with `?model=accrue` for a different source-derived account model. These are independently written reference fixtures, **not Iris/Accrue integrations, users or endorsements**. The first composes a direct PRF account; the second selects the BIP39/BIP32 worker leaf `m/44'/60'/0'/0/1`. It does not escrow the mnemonic or HD root.

No physical passkeys are created in the default mode. The separate `--physical-approved` flag enables actual WebAuthn only for a specifically approved local test; the human completes system prompts. Old localhost/public ContinuityKit credentials do not apply to these new RP IDs.

## Small SDK surface

Pack locally with `npm pack --ignore-scripts`. This package is experimental and MIT-licensed; it has not been published to npm.

```js
import { createReserveCredential, prepareReserve, recoverReserve } from '@continuitykit/account-reserve';

const config = {
  appId: 'example-app',
  originalRpId: 'app.example.com',
  recoveryRpId: 'reserve.example.net',
  derivation: 'app-account-v1',
};

let recoveryCredential;
try {
  // On B, call from the user's setup action to retain browser user activation.
  recoveryCredential = await createReserveCredential({
    config,
    user: { name: 'My account reserve', displayName: 'My account reserve' },
  });
  // Prepare once with the already-derived leaf. Keep the exact object.
  await prepareReserve({
    privateKey, // Uint8Array(32), retained only as long as necessary by caller
    policy: { ...config, expectedOwner },
    recoveryCredential, // one-use object; do not spread, serialize or copy it
    store, // get(locator) and atomic putIfAbsent(locator, bytes)
  });
} finally {
  recoveryCredential?.close();
  privateKey.fill(0);
}

// Fresh B: no expectedOwner, locator, credential identifier or file input.
const reserve = await recoverReserve({ config, store });
try {
  // reserve.owner and reserve.account are authenticated against the sealed binding.
  // Expose only the integrating app's fixed, explicitly approved operation.
} finally {
  reserve.close();
}
```

Use `webAuthnClient` only for a deliberate adapter or synthetic tests. Omit it for the native WebAuthn adapter used by Mera. Operations forward `AbortSignal` and a bounded timeout to native credential calls; cancellation discards late results and clears SDK-owned byte buffers. This is not a guarantee that every platform prompt closes immediately or that an in-flight store write is undone. `STORE_WRITE_UNKNOWN` means reconcile the existing reserve, never blindly repeat enrollment.

`createReserveCredential` derives the enrollment locator and a nonextractable manifest key from the creation result, then clears its raw PRF bytes. Its one-use object is bound to the complete configuration and expires within five minutes. Close it if setup is abandoned; use the same `signal` for creation and preparation. An expired, cancelled, consumed or mismatched object rejects without silently requesting another credential. Existing credential metadata remains supported by `prepareReserve` through its original assertion path. Fresh recovery always uses the independent two-assertion path and never this temporary setup state.

The immutable enrollment protocol is documented in [sdk/PROTOCOL.txt](sdk/PROTOCOL.txt). One newly dedicated recovery credential binds to one account per app namespace. Rotation, re-binding, multi-account selection and account-key revocation are intentionally unsupported.

## Evidence and fair comparison

`npm test` runs SDK tamper/failure tests, two clean offline package consumers, local payment-contract tests and two complete recovered-signer tests. `npm run verify:local` also checks HTTP, the release candidate and both disabled Worker builds; set `ACCOUNT_RESERVE_REDIS_BIN` to a Redis server binary for the real-storage tests. Read [SECURITY.md](SECURITY.md), [delivery/STATUS.md](delivery/STATUS.md) and [the inspection guide](delivery/JUDGE_GUIDE.md) for the evidence boundary.

A correctly retained encrypted Mera export **also works** for both account models. The original synthetic comparison uses four assertion API calls for reserve preparation (including the independent check) and two for recovery; export uses one for each. Credential creation is separate in that comparison. The creation helper removes one repeated assertion from a complete new enrollment: one creation plus three assertions when creation supplies PRF output, or one creation plus four assertions when it requires a fallback assertion. Fresh recovery still uses two. These are API-call counts, **not Face ID/prompt counts**. This optimization is published in the reference demo (Primary version 4 / Reserve version 3); it has not been physically tested. The SDK remains unpublished on npm. The candidate removes the required user-supplied export file and owner hint but adds setup, network storage and another trusted client. It is not generally proven superior to encrypted export. The portable publication summary is in `evidence/public-proof.json`; the earlier native proof belongs to Primary version 3 / Reserve version 2.

The portable [public proof](evidence/public-proof.json) includes the completed testnet claim, historical native-test conditions and the later published enrollment update. Original operational records referenced by local delivery logs are deliberately excluded from the source archive. For source-export checks, run `node --test tests/source-export.mjs`; these are additional to the 318 runtime and integration tests.

## Provenance and AI disclosure

Mikkel / CryptoMickle is the sole human builder. OpenAI Codex and GPT agents assisted product exploration, implementation, tests, design, documentation and review. Automated agents are not external users, independent integrators or additional human team members.

The submitted direction is the account-reserve work developed during the 2026 Metropolis build period. It follows the earlier ContinuityKit data-recovery experiment and reuses its product name and presentation direction. The earlier app recovers content against an on-chain version registry; this package instead preserves an existing account's selected key and demonstrates its original authority. The old app and its tests are not included or counted as evidence for this protocol. The current source export is a snapshot, not a Git commit history. The source release preserves the existing repository history and adds this snapshot with its actual commit date; it does not reconstruct earlier development commits.

The local fixtures follow the account patterns identified in [Iris](https://github.com/vmlechko/Iris/blob/main/lib/account.ts) and [Accrue at a pinned revision](https://github.com/pauleke65/accrue/blob/ab1d8580f339addaa02ea118e89ba4b89627e926/lib/mera-account.ts). No upstream app source or assets are vendored. The protocol uses unmodified published Mera 0.2.0 APIs, viem 2.56.9, Web Crypto and scure BIP39/BIP32. Existing local experiments are recorded in `../mera-account-exit/`; that directory is not a runtime SDK dependency.

Dependency and artwork provenance are recorded in [third-party notices](delivery/THIRD_PARTY_NOTICES.md). This Account Reserve source is licensed under [MIT](LICENSE). Dependencies retain their own license terms and notices. The [submission requirements](delivery/REQUIREMENTS_2026-10-08.md) distinguish the prepared materials from the remaining competition submission steps.
