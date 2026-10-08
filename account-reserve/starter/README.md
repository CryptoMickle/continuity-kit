# ContinuityKit integration starter

A runnable consumer of the **installed** experimental account-reserve package.
It imports only documented SDK entry points. No source from the demo or internal
test fixtures is needed. This is a local evaluation package, not an npm release
or a production-ready recovery service. Account Reserve source is MIT-licensed;
third-party license terms remain applicable.

## First working run

Requirements: Node 24+ and npm. **No Foundry, database account, wallet, test funds
or blockchain is required.** From this generated directory:

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm run dev
```

Open <http://reserve-demo-primary.localhost:4673/>. All credentials are simulated
by this local server by default; no physical passkey is requested.

1. Select **Create example account**, then **Activate reserve**.
2. In B, select **Prepare this reserve**. Wait for independent verification.
3. Expand **Try it without the original app**, take A offline, then close its tab.
4. Select **Open a fresh reserve**, then **Open existing reserve**.
5. Compare the account address. A fresh local challenge is verified and the
   recovered signer is closed. No transaction is sent.

In another terminal, `npm run doctor` checks A/B configuration reachability
without creating credentials, writing a reserve, or printing enrollment tokens.
Browser checks are visible on the page. A green static check does **not** establish
physical PRF support, durable storage, or a prepared reserve.

One reserve can be enrolled per server run. RAM data is lost on server restart.
If setup is interrupted, keep the existing credential and use **Check existing
reserve**. Do not automatically create another credential or repeat a write.
For an entirely new disposable synthetic trial, deliberately stop/restart this
server. Never deploy `server.mjs`, `synthetic-client.mjs` or `loopback-fetch.mjs`.

## What to connect in your own application

Start with a Mera web app that has access to its existing 32-byte EVM leaf key.
The starter derives a direct account from PRF output; this is an **example**.
Preserve your existing derivation exactly. Do not change an HD path, rederive a
different account, escrow an HD root, or treat an arbitrary wallet signer as an
exportable key. The SDK checks that the leaf matches the expected owner.

The original application needs one deliberate setup action:

```js
import { startReserveSetup } from '@continuitykit/account-reserve/browser';

// Inside the button click, before awaiting anything (browser popup policy):
const setup = startReserveSetup({
  config, recoveryUrl: 'https://reserve.example.net/',
  privateKey: existingLeaf, expectedOwner: existingOwner.toLowerCase(),
  onState: ({ state, code }) => renderProgress(state, code),
});
existingLeaf.fill(0); // controller owns a separate temporary copy
await setup.completion; // only resolves after B independently reopened it
```

The reserve page captures its handshake on page load; creation only starts from
the user's setup click:

```js
import { createReserveReceiver } from '@continuitykit/account-reserve/browser';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { recoverReserve } from '@continuitykit/account-reserve';

const receiver = createReserveReceiver({ config, originalOrigin });
// On an explicit setup click, with a one-write grant from your operator:
const store = createReserveHttpStore({ enrollmentToken });
try {
  await receiver.prepare({ store, user: { name: 'My reserve', displayName: 'My reserve' } });
} finally { store.clearEnrollmentCapability(); }

// On a fresh recovery click: no A endpoint, address, locator or file input.
const opened = await recoverReserve({ config, store: createReserveHttpStore() });
try {
  // Verify/show the owner, then expose only your intended, approved operation.
  // This account has FULL signing authority; a UI wrapper is not key revocation.
} finally { opened.close(); }
```

Omit `webAuthnClient` in your real browser integration to use native Mera.
Call `setup.cancel()` / `receiver.dispose()` and clear caller-owned key buffers
on page exit. The included `main.mjs` shows the complete runnable lifecycle.
Callbacks contain public status only, not keys or transport payloads.

The receiver reuses derived material from its own credential creation once,
within the setup deadline. It still writes and reads back the encrypted reserve,
then independently opens it and checks a fresh signature before reporting ready.
Synthetic tests count one creation plus three assertion calls, or four assertions
when creation needs a PRF fallback. Fresh recovery requires two assertions.
These counts do not predict Face ID prompts. The same optimization is published
in the reference demo (Primary version 4 / Reserve version 3), but has not yet
been tested on physical devices. This starter and SDK remain local evaluation
packages, unpublished on npm; the demo deployment is not an SDK release.

## Server/storage contract

The SDK adapter calls same-origin `GET /api/reserve/:locator` and
`PUT /api/reserve/:locator`. It does not host a server or bypass its write policy.

- GET: 200 `{ "bytes": "<canonical base64url>" }`; 404 if missing; 503 if unavailable.
- PUT: Authorization `Bearer <one-write grant>`, JSON `{ "bytes": "..." }`.
  Atomically create only: 201 `{ "created": true }`, 409 if already present.
- Store only ciphertext, at most 64 KiB. No private key goes to this API.
- Enforce grants, quotas, expected origins, durability, deletion policy and rate
  limits on the server. Never ship Redis/database credentials to the browser.
- A timeout after PUT means **unknown**, not permission to retry. Fresh recovery
  uses reads only. `clearEnrollmentCapability()` removes the adapter's token.

The included server is an in-memory teaching implementation of this contract.
For production, provision B and durable storage independently of A and preserve
the fixed B domain. This starter does not provision hosting, issue production
grants, configure billing protections or select a data-retention policy.

## Types, support and evidence

`integration-types.ts` checks all public entry points. `smoke.mjs` runs a synthetic
account roundtrip through real loopback HTTP using the installed SDK. It shuts
off A, creates a fresh B client with no account hints, verifies the same owner,
and verifies the signer is closed. It does **not** test browser popup transport
or actual OS prompts; those need the browser walkthrough above.

Default mode has no real device support claim. To deliberately perform a
separately approved physical local test, build then run
`node server.mjs --physical-approved`. That disables synthetic endpoints and
requests new dedicated credentials from explicit UI actions. Use only a new
disposable example account. Never migrate earlier demo credentials here.

A correctly retained encrypted export also recovers the account. This starter
reduces integration code; it does not prove user demand, independent infrastructure
survival, fewer physical prompts, security audit, or superiority to exports.
