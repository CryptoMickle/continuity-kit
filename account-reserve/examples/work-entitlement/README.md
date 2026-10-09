# One fictional job: recover work, optionally collect an existing payment

This **local reference consumer** joins the Work SDK and the existing `PaymentRight`
fixture without changing either. It is not a deployed feature or a new public-chain proof.

Studio North has already approved a fictional discovery-workshop fee. An unfinished
checkout-copy handoff remains in the original work app. The example issues that fixed
payment right to the job's existing account **before** it prepares the Work reserve and
retires the original session. Afterward:

1. The existing synthetic recovery credential discovers the encrypted snapshot.
2. The private brief opens while account signing remains locked.
3. The missing confirmation copy is completed and exported locally.
4. **Optionally**, a separate deliberate action unlocks the same reserved account and
   claims its already-issued local payment once. The signer closes afterward.

Completing/exporting the copy neither earns nor issues the payment. The contract verifies
the fixed beneficiary and one-time collection, not job completion or customer approval.
This example associates one job with that beneficiary; it adds no contract-level job schema.

## Run from the account-reserve repository root

Prerequisites: Node 24+, the repository's locked dependencies, and Anvil at
`~/.foundry/bin/anvil` (or set `CONTINUITY_ANVIL` to its local binary path). If dependencies
are not present, use the repository's ordinary locked install first. These commands do not
install or download anything:

```sh
node examples/work-entitlement/run.mjs
node examples/work-entitlement/run.mjs --claim-existing-payment
node --test tests/work-entitlement.mjs
```

The first command stops after work recovery/export. Its pre-issued payment stays unclaimed.
The second starts a **new disposable example**, performs the same work flow, and explicitly
opts into collecting that new local payment. Each run stops its Anvil process on completion.
It cannot target an external RPC: the existing harness starts its own loopback Anvil on
chain 31337, with no default unlocked accounts and no fork.

On macOS, enforce the repository's loopback-only network sandbox as well:

```sh
/usr/bin/sandbox-exec -f scripts/loopback-only.sb node examples/work-entitlement/run.mjs --claim-existing-payment
/usr/bin/sandbox-exec -f scripts/loopback-only.sb node --test tests/work-entitlement.mjs
```

The runner writes only fictional plaintext exports and a sanitized local report under
`examples/work-entitlement/output/` (ignored). It overwrites that disposable output on the
next run. No private key, PRF output or credential metadata is written there. Local hashes
in the report belong to the just-destroyed Anvil instance; they are not Monad explorer links.

## Integration boundaries

- `scenario.mjs` calls the public `prepareWorkReserve`, `recoverWorkReserve` and explicit
  `openAccount` operations. Its synthetic authenticator is reused from the repository's
  test support and persists only in RAM. No device prompt or native passkey is involved.
- The original signer is ended and its caller-owned key buffer wiped. Original work access
  is then unavailable through the local primary model. This is **not** an HTTP 503, domain
  deletion, independent-process, browser-profile or hardware failure demonstration.
- Fresh Work recovery receives only the app configuration, a read-only encrypted store and
  a recovery-authentication adapter. It does not receive the original private key, owner,
  saved locator or original application's account session.
- Work discovery is allowed while account-vault PRF access is actively denied. Only the
  explicit claim action opens that gate. This illustrates application action separation;
  the same passkey still has potential authority to unlock the full EOA account.
- The existing fixture contract and harness are reused unchanged. Setup deploys and funds
  a disposable local contract. Issuance/deployment are local setup transactions; Work
  recovery/edit/export send no transaction, and the optional payment claim is separate.
- One immutable prepared snapshot survives. Edits affect only exported text/JSON. Recovering
  again returns the original unfinished draft, not the exported edit.

## What the test verifies

The reserve binds the work to the beneficiary of a right issued before the outage; original
access/signing stops; Work recovery works with account unlock forbidden; editing/exporting
does not alter the right or the beneficiary's nonce; an unrelated account is rejected by
`WrongBeneficiary`; optional collection transfers exactly the pre-issued amount less gas;
and the contract rejects another collection with `AlreadyClaimed`.
The test and optional-payment runner also attempt a new message signature through the
returned, closed account interface and require Mera's `SESSION_ENDED` rejection.

The example does **not** prove actual demand, external integration, new native-passkey
behavior, Monad throughput, public deployment compatibility or independent storage survival.
It does not reinterpret the separate historical Account Reserve testnet receipt as evidence
for this combined flow. No new financial protocol, escrow rules, submission, public deployment,
real funds, public-chain transactions or native credentials are part of these commands.
