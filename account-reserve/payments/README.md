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
- `testnet.mjs` separates signing from credential-free receipt checking. Neither
  factory reads RPCs or asks for credentials during construction.
- The new `/payments/` view opens only an existing primary or recovery passkey.
  Opening an account does not claim a payment. An explicit second action sends
  the one approved claim. Signers close on confirmation, uncertain signed outcome,
  explicit close, page exit or expiry. Native prompt count is device-dependent.

The public example is bounded to two 0.01 test-MON obligations and existing actors.
The maximum claim gas is 300,000, max fee 200 gwei, priority fee 2 gwei: a maximum
0.06 test-MON fee per claim. These are test tokens, not a production payment service.
The reserve restores full signing authority, not a restricted withdrawal token.

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
