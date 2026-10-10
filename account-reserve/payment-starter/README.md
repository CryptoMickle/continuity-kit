# Existing-reserve payment starter

A complete browser page for collecting approved Monad **testnet** payments through
an account reserve that already exists. Generate a separate consumer, install the
packed SDK, supply your public configuration and build the page. The template
includes payment selection, availability, existing-passkey recovery, deliberate
collection, pending-transaction checks, supplied-reference verification and session closure.

This is an experimental integration reference. It does not create a reserve,
passkey, issuer, contract or payment. It does not include storage hosting, deploy
anything or demonstrate customer adoption. Both the existing reserve and funded
payment obligations are prerequisites.

## Generate and install

Node 24+ and npm are required. From the ContinuityKit source package:

```sh
npm ci
npm run create:payment-starter -- /absolute/empty/payment-consumer
cd /absolute/empty/payment-consumer
npm ci
cp profile.example.json profile.json
```

The destination must be empty and outside the SDK source directory. The generator
copies reviewed template files and the canonical payment helper, packs the SDK
into a local `.tgz`, and writes a lockfile. It does not install or launch anything.
The SDK is pinned to that archive; this is not an npm-registry release. A generated
consumer can also run the installed generator from
`node_modules/@continuitykit/account-reserve/scripts/create-payment-starter.mjs`.

## Configure the existing reserve

Replace every example in `profile.json` with values from your own approved setup.
The example is deliberately inert. Never add a private key, passkey identifier,
upload grant, RPC secret or wallet seed to this file. The build emits it as public
`payment-config.json`.

| Field | Required source |
| --- | --- |
| `originalOrigin`, `recoveryOrigin` | Exact origins used for the existing account reserve; no path, query or trailing slash |
| `reserve.appId`, `reserve.derivation` | The unchanged app and derivation values used when preparing that reserve |
| `reserve.originalRpId`, `reserve.recoveryRpId` | Exact corresponding origin hostnames; distinct from each other |
| `storeBasePath` | Existing root-relative same-origin ciphertext read endpoint, such as `/api/reserve` |
| `payment.chainId` | `10143`, Monad testnet only |
| `payment.address`, `owner`, `issuer`, `expectedRuntimeCodeHash` | The explicitly approved payment contract, beneficiary, issuer and runtime code hash |
| `payment.expiresAt` | The approved signing deadline as an ISO timestamp |
| `payment.claims` | One to eight distinct approved rights; canonical decimal-string `rightId` and `amount` (wei), and the approved numeric `nonce` |

A reserve prepared at a public B origin cannot be opened at localhost or at another
hostname. Do not change RP IDs, app ID or derivation to make a configuration check
pass: that does not migrate a credential or decrypt the old reserve. Keep the
original origin and storage bindings. HTTPS is required outside localhost.

The same-origin reader must implement the SDK's existing `GET <storeBasePath>/<locator>`
response protocol: a bounded JSON object with base64url `bytes`. The browser uses
the public HTTP-store adapter with credentials omitted and exposes only its `get`
method to recovery. No upload or enrollment capability is provided.

## Check, build and preview

```sh
npm run doctor -- --profile profile.json --origin https://your-existing-reserve.example
npm run build -- --profile profile.json --out ./dist
npm test -- --profile profile.json --out ./dist
npm run serve -- --out ./dist --port 5180
```

Doctor checks configuration and the explicitly declared recovery origin without
network access or authentication. It cannot establish physical passkey support,
deployed routing, storage durability, payment funding or control of an origin.
An expired profile remains usable for reading existing transaction receipts; new
signing stays blocked. `npm test` checks the installed SDK/helper and the built static preview without
authentication or RPC.

The static preview server listens only on loopback. It has no reserve endpoint, cannot proxy ciphertext, and disables native
credentials and external RPC in the preview. A build configured for a different origin shows a
configuration error there **before** passkey use. To use the real reserve, serve the
built assets at the exact configured B origin with the existing read endpoint.
Review this change as part of your own deployment; the starter never publishes it.
The build refuses to replace an existing output directory. Choose a new output
name for each build.

## The payment flow

1. Choose an approved payment. The page makes no RPC or passkey call on load.
2. **Check availability** performs a bounded public read. A funded result is short
   lived and advisory; final transaction guards run again before sending.
3. **Open existing reserve** requests the prepared B passkey. It opens full account
   signing authority for a short in-memory session, not a restricted payment key.
4. Review amount, beneficiary, contract and fee limit. **Collect payment** is the
   separate action that can send the approved claim. The session closes afterward.
5. If confirmation is uncertain, use **Check existing transaction** in the same
   browser. Keep its transaction record; changing a payment or passkey does not
   clear unresolved account state. The starter does not retry a send automatically.

Changing payment, closing the session or leaving the page invalidates readiness
and closes the signer. Cancellation prevents late native results from becoming a
usable session. It cannot undo a transaction already broadcast. Device prompts
vary; one deliberate action is not a promise of one native confirmation.

## Check a reference from another browser

Choose the approved payment, paste its full transaction hash under **Check a
transaction reference**, then press **Verify reference**. This separate public
read needs no local transaction history, reserve opening or passkey. It stays
available after the signing deadline. A browser without WebAuthn or the recovery
cryptography APIs can still check references on the exact configured secure B
origin. Account opening and collection remain disabled there; a notice explains
the missing recovery support. Wrong origins, insecure contexts and missing
required HTTP/text APIs still stop the page before it mounts.

Only an exact finalized payment is shown as verified. Pending or unknown,
unsuccessful transactions, mismatched evidence and unavailable verification have
separate results. A verified reference does **not** reconcile this browser’s
journal, clear an unresolved attempt or authorize another send. Use **Check
existing transaction** for that journal's recorded attempt.

Reference checking closes any existing or pending signing session first and is
unavailable while a claim is in flight. Editing the hash, changing payment,
stopping the check or leaving the page discards its displayed result and ignores
late replies. The bounded read can still finish in the background; another
reference check waits for it to settle. No hash is loaded from the URL or saved by
this form, and no reference is checked automatically.

## Integration boundary

`main.mjs` imports only public SDK entries and the copied `actions.mjs` helper.
`page.mjs` renders current helper state and a separate public receipt verifier; it
never constructs arbitrary transactions or uses reference verification to alter
the helper’s transaction journal.
The fixed bounded profile, chain reads, fee/nonce guards and local pending journal
remain authoritative. The reference form accepts only a transaction hash for a configured payment; it
cannot select an arbitrary beneficiary or construct a transaction.

Production assets contain no teaching authenticator, native override, mock RPC,
issuer key, enrollment server or test-only control. Repository tests can supply
isolated doubles to the renderer; that is internal integration evidence, not a
physical-device test or a public payment.

A second funded obligation can generate another useful settlement transaction to
the same beneficiary. Opening the reserve itself generates no transaction and
creates no demand or income. Developers must establish the actual payment use
case and operate a trusted recovery origin and storage service.

## Repository regression checks

The generated consumer's `npm test` has no DOM-test dependency. To run the separate
repository UI regressions, install their pinned test-only dependency too:

```sh
npm ci --ignore-scripts
npm ci --prefix integrations/multi-app --ignore-scripts
npm run test:payment-starter
```

Those UI tests run controlled fixtures. They are not included in the generated
page or its runtime dependencies and do not invoke native credentials or payments.

The separate whole-template recovery test also requires a locally installed Anvil
binary (default `~/.foundry/bin/anvil`, or `CONTINUITY_ANVIL`):

```sh
npm run test:payment-survival
```

It generates and installs a fresh consumer, builds its production assets, then
executes the unchanged source entrypoint and page using test-only browser emulation.
The compiled assets are checked for preservation; their browser bundle is not
executed by this source-module test.
An encrypted reserve is served by a disposable B endpoint while A is unavailable.
The two fixed public RPC names are redirected by the test to one owned local
Anvil chain with actual chain ID `10143`; no public RPC is contacted. An existing
credential is emulated through the native browser API boundary. The test covers
a dropped response after a real local claim and a fresh-page receipt check with
no signer. Its session observer and browser/RPC adapters live outside production
assets. This is controlled integration evidence, not a physical passkey test,
independent-provider verification or external adoption.
