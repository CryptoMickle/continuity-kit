# Inspect ContinuityKit Account Reserve

ContinuityKit prepares independent access to an existing passkey-derived account. The important check is whether the recovered account can still use a right issued **before** the original app becomes unavailable. A newly generated account cannot collect that payment.

This guide accompanies two live demonstration sites and MIT-licensed experimental source at https://github.com/CryptoMickle/continuity-kit/tree/main/account-reserve. README AI disclosure is included. The repository retains earlier history and adds this source snapshot with its actual commit date; no earlier development commits are reconstructed. Video is pending separately. The guide describes the new account reserve, not the earlier data-only ContinuityKit demo.

## Start here

1. Inspect [Primary A](https://continuitykit-account-primary.cryptomickle.chatgpt.site) and [Reserve B](https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris) for the product flow. Opening a page does not grant the existing reserve credential or a new enrollment code.
2. Check the completed public testnet result below. The payment has already been claimed; the public account is not an open, repeatable test account.
3. Reproduce locally from the source package. Its default synthetic credentials require no passkey creation, wallet, testnet faucet or real funds.

## Completed public proof — 8 October 2026

The original account had a 0.1 test-MON payment right before the outage. Primary A and its API were then made unavailable with HTTP 503, and the original/setup tabs were closed. A fresh B tab used the existing physical reserve passkey to recover the same beneficiary and collect that right once. The client showed **Payment collected** and closed its signer. A was restored afterward.

| Check | Recorded result |
| --- | --- |
| Network | Monad testnet, chain ID 10143 |
| Original and recovered beneficiary | `0x3efc5827c9f2f25f8fd4000C4BF9318154dF1B85` |
| Payment contract | `0x738F3a0E2376a8e9AFf6A4440B0dBC77c22e6B4A` |
| Claim transaction | `0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5` |
| Result | Right 1, 0.1 test-MON, `claimed=true`, finalized block 69,286,156 |
| Independent reads | Both fixed RPC providers agreed on receipt, event and contract state |

The portable summary is `evidence/public-proof.json`, required by the source packager. Its supporting local records are `evidence/native-public-testnet-proof-2026-10-08.json` and `evidence/public-claim-finalized-2026-10-08.json`. Two agreeing RPC providers are corroboration, not a light-client consensus proof. The raw operational files remain outside the source export.

**Version boundary:** the native proof used Primary 3 / Reserve 2. The current published versions, Primary 4 / Reserve 3, add a locally tested reduction in enrollment work. The publication summary is included in `evidence/public-proof.json`; the optimized setup has not been physically retested. The native test used a fresh tab in the same browser, not a separate browser profile or a direct iPhone webpage. The user reported many setup confirmations; the exact count was not measured.

## Reproduce the payment flow locally

Requirements: Node 24+, npm and Foundry `anvil`. The harness looks for `~/.foundry/bin/anvil`; set `CONTINUITY_ANVIL` to the executable's absolute path if it is installed elsewhere. From the repository's `account-reserve/` directory:

```sh
npm ci --ignore-scripts
npm run build
npm run dev
```

Open <http://continuity-primary.localhost:4573/?model=iris>.

1. Create the example account. Note its address and unclaimed payment.
2. Open the reserve window and prepare it. Wait for the stored-copy readback and independent opening to succeed.
3. In Reserve, expand **Demo controls** and press **Take original app offline**. Close Primary, then follow **Open a fresh reserve**.
4. Open the existing reserve. Compare the recovered account and pre-existing right.
5. Collect the local payment. Confirm that the signer closes after the receipt is checked.
6. Reload and reopen the reserve. The existing transaction can be checked; the client does not submit it again.

Use `?model=accrue` to inspect the second account-derivation fixture. The fixtures follow direct-PRF and selected BIP39/BIP32 leaf patterns; they are not integrations with, or endorsements from, the upstream projects. The default local chain uses ID 31337. Separate tests with simulated chain ID 10143 are also local; only the recorded public run above supplies public Monad evidence.

The local server keeps ciphertext in memory and loses it on restart. The default run is a protocol demonstration, not a durability test. Use example data only.

For the smallest developer integration without Foundry or a chain, follow **Developer first run** in the root README. It generates a clean consumer that verifies recovery with a signing challenge and closes the signer. It does not perform the payment demonstration.

## Inspect the implementation

| Question | Where to look |
| --- | --- |
| How does B find the right account without a file or address? | `sdk/PROTOCOL.txt`, `sdk/index.mjs`, `tests/sdk-discovery.mjs` |
| Is the encrypted record bound to the correct app, credential and owner? | SDK tampering, mismatch and immutable-enrollment tests |
| Is the reserve independently opened before setup succeeds? | SDK preparation readback, fresh recovery and signed-challenge checks |
| What changed in the latest enrollment path? | `createReserveCredential` and `tests/sdk-creation.mjs`; fresh recovery still uses its separate path |
| Does the restored account have the original payment right? | `chain/PaymentRight.sol`, `tests/chain-reserve.mjs` and the public receipt above |
| Can a developer consume the package without internal fixtures? | `tests/starter-package.mjs`: clean install, type/build checks and A-off recovery; `tests/sdk-package.mjs`: two account models |
| What happens after cancellation, an uncertain send or reload? | `tests/browser-flow.mjs`, `transaction.mjs`, `pending-ticket.mjs` and their tests |
| Are the HTTP and storage limits enforced? | `tests/http-boundaries.mjs`, `tests/release-store.mjs` with disposable Redis |

The latest complete local run passed **318 tests**, with no failures or skips. `npm run verify:local` orchestrates the checks and builds; full Redis verification requires `ACCOUNT_RESERVE_REDIS_BIN` to point to a Redis server binary. A skipped Redis group is not a complete run. On macOS, the verifier restricts test networking to loopback. `evidence/verification.json` records source hashes and stage results. Automated authentication is synthetic; it is distinct from the native proof above.

## Evaluate the tradeoff

A correctly retained encrypted Mera export also restores the same account. ContinuityKit adds credential-driven discovery, so the user does not need to find that file. It also adds a separate credential, storage availability and trust in the reserve client. There is no proven demand or general superiority to encrypted export.

The latest complete new enrollment uses one credential creation plus three assertion calls, or four assertions when creation requires a PRF fallback. Fresh recovery uses two assertions. These are synthetic API-call measurements, not visible system-prompt counts.

The reserve restores full account authority. It does not revoke the original key, recover from compromise, or make a malicious reserve client safe. Hosting and storage in this demonstration remain under one operator. The SDK source is MIT-licensed and unpublished on npm; external integrations, production security and commercial adoption are not claimed. The narrow demonstrated result is recovery of the same prepared account and use of its existing right after an application outage.
