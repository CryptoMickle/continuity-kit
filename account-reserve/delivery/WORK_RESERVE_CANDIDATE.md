# Private work continuation candidate — 8 October 2026

> Historical preparation document, 8 October. Superseded status as of 9 October: the separate Work Sites are published with D1, and the Mac native outage test and completed exports are verified. iPhone recovery is explicitly user-confirmed; direct device-screen/full-content evidence remains pending. See [current portable proof](../evidence/work-public-proof.json) and [judge guide](JUDGE_GUIDE.md). The proposal and pre-publication wording below are retained as history, not current deployment instructions.

Status: local development candidate. Not published, not submitted and not native-device verified. The existing public Account Reserve remains a separate protocol and proof.

## Product decision

Make the recoverable work useful without a payment. A developer can prepare a private client brief and unfinished deliverable together with the account that owns them. A fresh reserve opens the prepared work while the original app is unavailable. The person finishes the deliverable and exports it. Account signing is a separate deliberate action, unnecessary for the work task.

This improves the explanation of why a reserve exists, but does not establish demand or superiority over a competently retained encrypted export. The tradeoff remains extra enrollment, storage and a second trusted client in exchange for discovery without a saved file/address and recovery of the same account plus prepared work. Do not call this automatic backup, current-state sync, a latest checkpoint, independent hosting or production security.

## Prize fit and remaining gates

Assessment uses the logged-in organizer pages captured on 8 October 2026. It is an interpretation, not sponsor confirmation.

| Track | What this candidate adds | Still missing |
|---|---|---|
| Trust, Identity & AI | Reusable SDK for a concrete continuation task, private work and optional same-account proof | External developer demand; production readiness; full submission and deferred video |
| Mera: One Passkey, Many Keys — one $2,500 prize | Dedicated work protocol/PRF namespace, separately derived encryption purposes, work opening/edit/export without a wallet action | Public/native demonstration of this new protocol, **same passkey in a second device or fresh browser profile** recovering identical prepared work, sponsor judgment of novelty/non-wallet value |
| Mera UX — one $2,500 prize | No unsubstantiated claim added | Current preparation still includes multiple API operations; no demonstrated one-ceremony onboarding. Deprioritize |

A fresh tab does not meet the fresh browser profile condition. Earlier native evidence for Account Reserve v1, including its public testnet claim, cannot be relabeled as proof of the new work protocol. API operation counts do not predict platform prompt counts.

## Completed local implementation

- `/work-reserve`: strict bounded plain-text schema; immutable encrypted work snapshot; authenticated links to configuration, recovery credential and existing EOA vault.
- Work-only recovery never decrypts the account leaf or constructs a signer. Explicit `openAccount` verifies the vault header/work binding and actual owner before returning signing authority.
- `/work-browser`: strict two-origin handoff, version 2 messages, snapshot digest agreement, cancellation/expiry and cleanup.
- `work/`: isolated synthetic, chain-free example and RAM store. Primary shutdown makes the original frontend/API unavailable; the reserve has its own origin. Both services are on one machine.
- The original reserve-v1 SDK, public native credentials, deployed Sites and original testnet transaction remain unchanged.

See the verification artifact produced by the local run for actual build/test outcomes. Source publication, native testing, domain deployment and new enrollment are separate steps, not inferred from these local tests.

## Next release/test sequence

The separate hosted implementation and native-only client build are now prepared locally. [The native candidate](WORK_NATIVE_CANDIDATE.md) defines proposed origins, a new storage namespace, one enrollment code, expiry and the physical acceptance sequence. This is not a public deployment or native test result.

1. Review the frozen new source candidate and its security/behavior changes.
2. Prepare a separately scoped public trial with example work only, bounded storage and no payment requirement. Existing native reserves must remain accessible under their original protocol.
3. After scoped approval, publish that trial and create its dedicated recovery credential. Observe actual prompts; do not claim a reduction in advance.
4. Use the **same recovery passkey** from a genuinely fresh browser profile or second device. Supply no owner, locator, export or old session. Verify exact prepared content, work-only mode and local export. Keep proof of which profile/device was used.
5. Keep the existing public Monad account/transaction evidence accurately attributed; do not manufacture extra transactions for activity.
6. Update the entry only with demonstrated claims. Record the videos separately at the end, as requested.

No development plan guarantees a prize or a minimum payout. Better eligibility evidence is necessary; it is not evidence of likely victory.

Organizer references: [Many Keys](https://hackathon.monad.xyz/), [Trust track and submission portal](https://hackathon.monad.xyz/dashboard). Exact authenticated text is retained locally in `evidence/portal-many-keys-2026-10-08.txt`, `portal-trust-2026-10-08.txt` and `portal-mera-ux-2026-10-08.txt`.
