# Existing-reserve payment starter

A complete browser page for collecting approved Monad **testnet** payments through
an account reserve that already exists. Generate a separate consumer, install the
packed SDK, supply your public configuration and build the page. The template
includes payment selection, availability, existing-passkey recovery, deliberate
collection, pending-transaction checks and session closure.

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

## Integration boundary

`main.mjs` imports only public SDK entries and the copied `actions.mjs` helper.
`page.mjs` renders current helper state; it never constructs arbitrary transactions.
The fixed bounded profile, chain reads, fee/nonce guards and local pending journal
remain authoritative. There is no arbitrary address or transaction form.

Production assets contain no teaching authenticator, native override, mock RPC,
issuer key, enrollment server or test-only control. Repository tests can supply
isolated doubles to the renderer; that is internal integration evidence, not a
physical-device test or a public payment.

A second funded obligation can generate another useful settlement transaction to
the same beneficiary. Opening the reserve itself generates no transaction and
creates no demand or income. Developers must establish the actual payment use
case and operate a trusted recovery origin and storage service.
