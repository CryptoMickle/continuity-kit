# Metropolis entry — ContinuityKit Account Reserve

Local submission draft, 8 October 2026. This text has not been saved in the portal. Video is deferred to a separate work block. Portal requirements were rechecked on 8 October; this is preparation, not submission.

**Project:** ContinuityKit

**Tagline:** Your app can disappear. Your account should have a way back.

**Short description:** A developer toolkit that prepares independent access to an existing passkey-derived account. Recover the same account from a separate client, without finding an export file, and use rights it already owns.

**Main category candidate:** Trust, Identity & AI Infrastructure — provisional.

**Sponsor candidate:** Mera: One Passkey, Many Keys — conditional. The current bounty requires a creative non-wallet use: the wallet cannot be the point. It also requires the same native passkey on a second device or a fresh browser profile. A fresh tab does not satisfy that stated proof requirement. The preserved secret here is an account key, so eligibility remains uncertain even though discovery and vault encryption are substantive work. Do not claim this bounty or single-ceremony onboarding as proven.

## Internal track check — not submission copy

The live Trust rubric prioritizes a primitive other applications can build on. It defines design as developer experience, not merely visual polish. The current evidence is strongest in implementation and the developer starter; market readiness and traction together account for 45% of judging and remain weak.

| Criterion | Weight | Current evidence and gap |
| --- | --- | --- |
| Technical execution | 20% | Local tests and one native public recovery/payment proof; no independent security audit or broad device validation. |
| Design & craft | 20% | Documented API, typed package, clean-consumer tests and generated starter; no measured external developer onboarding. |
| Originality & track insight | 15% | File-free prepared recovery for the same account; encrypted export remains a viable baseline, and hosted infrastructure is under one operator. |
| Founder & market readiness | 25% | A defined application class and integration hypothesis; no evidence that specific developers prefer this to building their own or using export. |
| Traction & path forward | 20% | Internal reference consumers and a proposed adoption path; no external developer interest or integration has been established. |

These weights do not support a numerical win probability or a minimum prize claim. More synthetic tests cannot substitute for independent demand. Track suitability and the Many Keys bounty are separate judgments.

## Project description

A passkey-derived account can outlive the app that created it on-chain, while the user loses the interface needed to reach it. I built ContinuityKit to give that account a prepared way back.

While the original app is available, the user creates a separate reserve credential. ContinuityKit encrypts the existing account's selected leaf key using Mera, binds it to the app and account, and stores an encrypted discovery record. Setup is only marked ready after reading the stored bytes back, independently reopening the reserve and checking a fresh signature. Later, a fresh reserve client can find and unlock the same account using the reserve credential, without a pasted address, export file or old setup tab.

The public demonstration ties recovery to a concrete on-chain right. On 8 October, a test account received a right to 0.1 test-MON. I made the original app and API return HTTP 503 and closed the setup tabs. A fresh reserve tab recovered the original beneficiary using its existing physical passkey and collected the payment once on Monad testnet. Both configured RPC providers corroborated the finalized receipt and claimed state. The signing session closed after confirmation, and the original app was restored.

The toolkit includes a small SDK, TypeScript declarations, browser setup controllers, an HTTP storage adapter and a generated starter. Two independently written account models—direct PRF and a selected BIP39/BIP32 leaf—work through the same SDK in clean local consumers. These are reference integrations I wrote, not third-party adoption. The latest local suite passed all 318 tests.

The live demo now includes an enrollment improvement that reuses the passkey creation result and removes one repeated assertion call. The native test above used Primary 3 / Reserve 2; the improvement was subsequently published as Primary 4 / Reserve 3. It has passed synthetic tests but has not been physically retested. Fewer visible system prompts are not yet demonstrated.

A correctly retained encrypted export can restore the same account. ContinuityKit's proposed advantage is removing the user's need to locate and supply that file: the prepared credential discovers and authenticates its reserve. The tradeoff is extra setup, available storage and a trusted reserve client. That tradeoff has not yet been validated with customers.

The design restores full account authority; it does not revoke the original key or repair a compromised key. The hosted demonstration uses one operator and test funds only. The native proof used a fresh tab in the same browser; a separate browser profile and direct iPhone webpage remain unverified for this account-reserve flow. This is an experimental prototype, not a production custody or backup service.

Built by Mikkel / CryptoMickle as a solo project. No external users, integrations, endorsements or commercial traction are claimed.

## Go-to-market draft

The intended users are developers of passkey-derived account applications whose users need a prepared exit route if the original app disappears. The first integration is deliberately narrow: one selected account leaf, one immutable encrypted reserve and one fixed application action.

The generated starter lets a developer inspect setup, disable the original app and recover the same account without obtaining test funds or creating a database account. It is validated in clean local consumers; this does not establish a measured human onboarding time or external adoption. The SDK source is MIT-licensed and remains unpublished on npm.

The commercial hypothesis is a developer package and integration support. Demand, pricing and willingness to pay remain unproven. The next useful evidence would be an independent developer judging whether file-free reserve discovery justifies the extra setup compared with encrypted export. Transaction activity would come from the integrating applications' existing useful actions; recovery is infrequent. The demonstration payment proves preserved account authority, not a high-volume transaction business.

## Mera implementation

The reserve credential supplies app-specific PRF material. HKDF separates opaque record lookup from authenticated-manifest encryption. The manifest binds the original and recovery domains, account derivation, credential and owner. Unmodified Mera secret-vault APIs protect the existing leaf key under a fresh vault salt. Fresh recovery authenticates these bindings and checks the decrypted key's address before returning a signer. The payment then tests whether that signer controls the account that already owns the right.

## Access instructions draft

Inspect Primary at https://continuitykit-account-primary.cryptomickle.chatgpt.site and Reserve at https://continuitykit-account-reserve.cryptomickle.chatgpt.site/?model=iris. Opening these pages does not grant the existing reserve credential or a new enrollment code. The prepared account's payment has already been claimed; it is historical evidence, not an open faucet.

The public claim is `0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5` on Monad testnet, finalized block 69,286,156. A portable evidence summary is prepared at `evidence/public-proof.json`. Follow `delivery/JUDGE_GUIDE.md` to inspect the evidence and reproduce the full sequence locally with synthetic credentials and a disposable chain. The smaller generated developer starter needs no chain and verifies the recovered account with a signing challenge. Source: https://github.com/CryptoMickle/continuity-kit/tree/main/account-reserve. The repository retains its earlier history; this new source is an actual-date snapshot, not reconstructed development commits.

## Portal completion checklist

| Field or requirement | Current state |
| --- | --- |
| Name / tagline | Draft above; portal limits 120 / 200 characters. The saved tagline still describes the earlier direction. |
| Description / go-to-market / access instructions | Drafts above; each portal field allows 8,000 characters. |
| GitHub source | MIT-licensed source prepared for the approved public release under `account-reserve/` in `CryptoMickle/continuity-kit`. Rules §§4.1 and 7.2 require public licensed source, build-window commit history and README AI disclosure. The form also mentions private sharing, but that does not resolve the stricter rules. The old data-only repository is not a substitute. |
| Live deployment | The two account-reserve sites above; Monad testnet. |
| Technical video | Deferred; portal asks for a working product demonstration, at most 3 minutes, not slides or code. |
| Pitch video | Deferred; at most 2 minutes. |
| Logo | Prepared `delivery/assets/continuitykit-logo.png`: 1024 × 1024 PNG, 249,425 bytes. Meets the form's 2 MB / 500 px / 4-million-pixel limits. Not uploaded. |
| Category / sponsor | Provisional; the Many Keys proof and non-wallet-fit gaps remain. |
| Portal state | Submission form: 0/5. Dashboard onboarding: 3/5. These are different progress indicators; neither means this new entry was saved or submitted. |
| Final submission | Deadline observed in portal: 14 October 2026, 05:59 GMT+2 (Europe/Oslo). Recheck before submission; final approval remains required. |
| Judging / results | Current dashboard: judging 14 October–3 November; winners from 4 November. Rules v3 instead say judging 14–27 October and winners 3 November. Preserve this discrepancy; keep the demo available through the later judging date. |
