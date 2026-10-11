# A second payment to the same account

ContinuityKit demonstrates an account collecting a newly funded payment after
its original app becomes unavailable. Two separate rights paid **0.01 test-MON
each** to the same beneficiary on Monad testnet. The second right was funded
after the first recorded HTTP 503 from the original app.

## The useful action

Consider a freelancer receiving separate milestone payments. Losing access to
the app should not prevent the same account from collecting a later payment
already funded for it. This is an example use case, not a customer deployment.

The prepared reserve restores signing authority for the original account. It
then reads the current payment state and lets the user deliberately claim an
approved right. It does not create the payment or prove that work was completed.
An issuer must fund each right separately.

Monad performs the payment function: the [contract](SequentialPayment.sol)
holds the funds, checks the beneficiary, prevents a second claim of the same
right and records settlement. The second payment is a new state transition,
not a restored copy of the first receipt. The contract transfers 0.01 test-MON
per claim; the beneficiary also pays network fees.

## Check the two existing payments

Network: **Monad testnet, chain ID 10143**.

Contract: [0x47C8c753295AC4fBe4c23D9BD2dC899F61b66564](https://testnet.monadscan.com/address/0x47C8c753295AC4fBe4c23D9BD2dC899F61b66564).

Beneficiary: `0x3efc5827c9f2f25f8fd4000C4BF9318154dF1B85`.

1. Open the [public payment reader in B](https://continuitykit-account-reserve.cryptomickle.chatgpt.site/payments/).
2. Under **Already collected a payment?**, choose **Payment 1 · 0.01 test-MON**
   in **Expected payment**. Paste this **Transaction reference**:

   ```text
   0xeba6bdebb6d0944d8d6f02d284a6c7b325e478ded63216cb1756ed2bd0aa8600
   ```

3. Select **Verify transaction reference**. Check the displayed beneficiary,
   contract, amount and finalized block **69905019**.
4. Choose **Payment 2 · 0.01 test-MON**, replace the reference, and verify again:

   ```text
   0xf263554671e28415d0b9aa3f76e607dce987bd903f94d981a4bab1a2615da1b2
   ```

   The expected finalized block is **69914955**, with the same beneficiary,
   contract and amount.

This reader needs no wallet, passkey or local payment history. Only a verified
successful payment counts; pending, reverted or failed checks do not. It does
not clear an unresolved signing attempt in the browser. Both payments are
already collected; verification sends no transaction.

For a separate explorer view: [claim 1](https://testnet.monadscan.com/tx/0xeba6bdebb6d0944d8d6f02d284a6c7b325e478ded63216cb1756ed2bd0aa8600)
and [claim 2](https://testnet.monadscan.com/tx/0xf263554671e28415d0b9aa3f76e607dce987bd903f94d981a4bab1a2615da1b2).
Both were reverified through the credential-free verifier and its two fixed
RPCs on **11 October 2026, 21:04 UTC**. That check validates the signed
transaction, expected payment, event, canonical finalized block and contract
state; two RPC observations are not an independently verified consensus proof.

## What happened during the controlled outage

Recorded sequence on **10 October 2026**, all times UTC:

| Time | Observation |
| --- | --- |
| Before 19:43 | Claim 1 was already finalized. |
| 19:43:38 | A's root, configuration and payment routes returned HTTP 503; B's corresponding routes returned HTTP 200. |
| 19:45:03 | A new right, payment 2, was funded for the same beneficiary. |
| 19:59:55 | Claim 2's finalized block timestamp. |
| 20:00:49 | A still returned HTTP 503 and B HTTP 200 in the next recorded probes. |
| 20:02:11 | A was restored; all eight routes returned HTTP 200 and configuration/profile hashes matched the baseline. |

These probes bracket the claim; they are not continuous outage monitoring.
The builder reported payment received after instructions to recover B using
the existing reserve passkey. Receipts do not establish the device, credential,
prompt count or browser path used. Those details were not independently
observed for this two-payment sequence.

The separate [local end-to-end proof](../tests/payments-continuity.mjs) exercises
SDK recovery and payment with synthetic credentials and a disposable EVM,
including unchanged stored ciphertext and no duplicate broadcast. It is local
engineering evidence, not physical-device or public-provider evidence.

## Evidence and limits

- [Public payment and outage record](../evidence/payments-validation-2026-10-10.json)
- [11 October read-only verification and evidence boundaries](../evidence/prize-readiness-2026-10-11.json)
- [Credential-free verifier](verify-claim.mjs) and [public payment profile](https://continuitykit-account-reserve.cryptomickle.chatgpt.site/payments/profile.json)
- [Developer integration example](../integrations/payment-client/README.md)

This is a solo builder's funded testnet demonstration, not customer activity,
revenue or proven demand. A and B remain under the same operator; the outage
does not prove independent-provider resilience. Recovery requires previously
prepared ciphertext, a compatible existing passkey and a trusted B origin.
The recovered reserve grants full account signing authority, while this
payment client limits its own actions to explicitly approved claims.
