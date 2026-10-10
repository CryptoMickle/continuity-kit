# Sequential payment continuity — experimental

ContinuityKit keeps access to an account that already owns a payment entitlement.
A separately funded second payment can be collected through a prepared reserve
when the original application is unavailable. Both claims settle on the same
chain to the same beneficiary. Recovery itself neither earns nor creates money.

The concrete use case is a contractor or contributor collecting recurring payouts
from an application. The payer deposits each obligation; the beneficiary claims it.
This provides a useful repeated chain state transition. It remains a product
hypothesis: the tests are developer-funded examples, not customers or demand.

This directory is an additive experiment. The earlier `PaymentRight` contract,
legacy one-payment adapter, existing passkeys and ciphertext records are unchanged.
The account-free text reserve continues to work without blockchain transactions.

## Use it from an installed SDK

The experimental `@continuitykit/account-reserve/payments` export includes
TypeScript declarations and three factories: `createTestnetPaymentClient` accepts an
existing recovered account; `createTestnetPaymentReader` checks an existing local
transaction record without a credential or signer; `createTestnetPaymentVerifier`
checks an explicit transaction reference without any local record. All use the same fixed Monad
testnet RPCs and policy checks as the demonstration. They accept no transport or
endpoint override through the public entry.

Follow the [separate-app example](../integrations/payment-client/README.md) to
install the SDK tarball and connect your existing account recovery action. Its
copyable helper separates opening, explicit collection and receipt checking, and
closes the parent signing session on completion, errors, cancellation and expiry.
Raw client consumers must perform that cleanup themselves; closing an executor
alone does not close the recovered signer. A reader can update the public local
journal when a receipt is verified, but never signs or broadcasts.

The package includes only the required payment runtime and browser-safe release
helpers. Issuer tools, contract deployment, Sites workers and operational files
are excluded from this npm entry. The package remains experimental and is
distributed from the public source as a tarball; it is not published to npm.

[Installed-package validation](../evidence/payments-sdk-validation-2026-10-10.json)
records a clean anonymous replay, strict TypeScript checks and the browser module
graph. The separate consumer uses real disposable Mera signing sessions with mocked
RPC responses; its simulated sends are not additional public transactions.

## Check a reference from a fresh browser

The hosted `/payments/` view has **Verify transaction reference** below the account
controls. Select the expected payment and paste its complete hash. This action
closes any open signing session, checks public chain data and shows the exact
amount, beneficiary, contract and finalized block only after successful verification.
Changing the selected payment or reference clears the old result. Stopping the
check or leaving the page prevents a late response from appearing as success.

A separate app can use the same typed entry:

```js
import { createTestnetPaymentVerifier } from '@continuitykit/account-reserve/payments';

// profile is the application's reviewed policy; rightId and amount use bigint.
const verifier = createTestnetPaymentVerifier({ profile });
const result = await verifier.check({ rightId: 2n, hash: transactionReference });
if (result.paymentVerified) {
  console.log(result.beneficiary, result.amount, result.blockNumber);
}
```

`finalized` with `paymentVerified: true` is success. `reverted` means the claim did
not deliver the payment. `pending-or-unknown` does not yet link the supplied hash
to this account or payment. Invalid input, mismatches and network failures reject
with bounded error codes. Only the fixed testnet RPCs are used; no endpoint override
is accepted. Historical checks remain available after signing-policy expiry.

This verifier does not use a signer, passkey, Storage or Web Locks. It never changes
a local attempt record or enables retrying an unresolved payment. Use the existing
`createTestnetPaymentReader` for that browser's journal reconciliation. It checks a
reference you supply; it neither discovers history nor synchronizes devices.

## Local verification

Use Node 24 or newer. From `account-reserve/` in the public repository:

```sh
npm ci
npm run build
npm --prefix integrations/multi-app ci
node --test tests/payments-*.mjs
node payments/build-browser.mjs
```

Chain tests require an installed `anvil` binary, by default `$HOME/.foundry/bin/anvil`.
They bind only to loopback and use disposable chains. They do not send public
transactions. The continuity test uses the actual SDK with a synthetic credential,
an actual original-app HTTP 503, unchanged encrypted storage and exact balances
including gas. These are not physical-device or independent-provider proofs.

## Payment and signing boundaries

- `SequentialPayment.sol` accepts issuer-funded obligations, one outstanding
  payment per beneficiary at a time. Claiming one allows the issuer to fund another.
  Historical claims remain immutable. There is no administrator withdrawal.
- `guard.mjs` binds chain, contract runtime, issuer, beneficiary, amount, right,
  nonce, fees and expiry. Two fixed testnet RPCs corroborate finalized receipts,
  canonical blocks, actual signed transaction bytes and the claimed contract state.
- `executor.mjs` stores a reservation before signing and the signed transaction
  hash before broadcasting. Unknown outcomes are checked, never automatically sent
  again. A reserved attempt without a hash requires manual reconciliation.
- `pending.mjs` coordinates cooperating tabs on one origin for the same account,
  including different contracts. Other devices and A/B origins do not share that
  local lock. Exact nonce checks and the contract provide additional boundaries.
- `testnet.mjs` separates signing from credential-free receipt checking. No
  factory reads RPCs or asks for credentials during construction.
- The new `/payments/` view opens only an existing primary or recovery passkey.
  Opening an account does not claim a payment. An explicit second action sends
  the one approved claim. Signers close on confirmation, uncertain signed outcome,
  explicit close, page exit or expiry. Native prompt count is device-dependent.

The public example is bounded to two 0.01 test-MON obligations and existing actors.
The maximum claim gas is 300,000, max fee 200 gwei, priority fee 2 gwei: a maximum
0.06 test-MON fee per claim. These are test tokens, not a production payment service.
The reserve restores full signing authority, not a restricted withdrawal token.

## Verify an existing public claim without a wallet

Both example claims are finalized on Monad testnet. Download the public profile
and check each exact transaction with the same two-RPC guard used by the app:

```sh
curl --fail --proto '=https' --tlsv1.2 \
  https://continuitykit-account-reserve.cryptomickle.chatgpt.site/payments/profile.json \
  -o payment-profile.json
node payments/verify-claim.mjs --profile payment-profile.json --right-id 1 \
  --hash 0xeba6bdebb6d0944d8d6f02d284a6c7b325e478ded63216cb1756ed2bd0aa8600
node payments/verify-claim.mjs --profile payment-profile.json --right-id 2 \
  --hash 0xf263554671e28415d0b9aa3f76e607dce987bd903f94d981a4bab1a2615da1b2
```

This reads public chain data only. It needs no signer, passkey, approval or pending
journal, writes no files, and never broadcasts. It checks the profile's exact chain,
contract, issuer, beneficiary, right, amount, nonce and fee bounds; both RPCs must
corroborate the signed transaction, canonical finalized receipt and claimed state.
An expired profile can still verify an earlier payment. A missing or unfinalized
receipt remains pending; an RPC failure or mismatch is not a successful claim.
Check the JSON `paymentVerified` field: only `true` establishes a verified payment.
Pending and reverted observations set it to `false`; invalid input or a failed
verification exits with code 1. The reported `amount` is denominated in wei.

The public profile and these source files are trust inputs. This is a reproducible
RPC check, not a light client or independent audit. A receipt proves settlement,
not which browser or device was used, nor that a passkey ceremony occurred.
The second payment was funded after the original app began returning HTTP 503.
The builder then reported completing the instructed existing-passkey recovery and
explicit payment action in B. Device and native prompt count were not specified.

| Recorded step on 10 October 2026 | UTC | Evidence |
| --- | --- | --- |
| A routes unavailable; B routes available | 19:43:38.674 | HTTP 503 / 200 |
| Second 0.01 test-MON obligation funded | 19:45:03 | Finalized block 69912000 |
| Second 0.01 test-MON claim | 19:59:55 | Finalized block 69914955 |
| A still unavailable; B available | 20:00:49.011 | HTTP 503 / 200 |
| A restored; both configurations/profiles unchanged | 20:02:11.110 | All eight routes HTTP 200 |

This is an operator-controlled outage with observations before and after the claim,
not continuous availability monitoring or independent-provider proof. The exact
claim verifier corroborates settlement, not the browser session. The original A
version was restored by removing its temporary outage flag; B was not redeployed.
See the [validation record](../evidence/payments-validation-2026-10-10.json).

## Issuer operation

`proposal.mjs` produces a deterministic public five-transaction proposal:
deploy, fund first payment, beneficiary claim, fund second payment, beneficiary claim.
The issuer runner performs only deploy and the two funding steps. It requires a
protected signer file, exact approved proposal and durable once-only journal.
The second funding additionally verifies the exact finalized first-claim hash.
There is no automatic retry/reset path. Read-only inspect, preflight and reconcile
never load the signer. Deleting or copying journals defeats local coordination.

Live proposals, approvals, signer files and journals are operational state and are
excluded from the source package. The contract build artifact contains public
bytecode only. `build-sites.mjs` is a maintenance tool for adding the browser route
to the exact pre-existing Sites workers; it is not a general hosting integration.

## Limits

Two RPC observations are not a light-client proof. A recovery site, ciphertext
storage and the existing passkey must still be available. This does not recover
an unprepared account or prove production security, external usage, sponsor
acceptance or prize eligibility. No volume or revenue claim follows from these
development transactions.
