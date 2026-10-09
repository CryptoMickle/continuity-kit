# Metropolis — verified submission requirements

Source publication completed and anonymously verified on 8 October 2026: https://github.com/CryptoMickle/continuity-kit/tree/fdfd817176c87a760cd026f95bb449aad4d57195/account-reserve. MIT applies to original Account Reserve source; dependency notices are preserved. All 134 published file hashes matched. Earlier statements below about pending source licensing/publication are historical. The SDK remains unpublished on npm; the competition entry is not submitted and video is deferred. Evidence: `evidence/source-publication-2026-10-08.json`.

Read-only portal review on 8 October 2026. No field, track, bounty, setting or submission was saved. This is a delivery checklist, not confirmation of eligibility or prize prospects. Video remains a separate final work block.

## Official sources and observed state

- [Dashboard and Rules & Guidelines](https://hackathon.monad.xyz/dashboard): deadline 14 October 2026, 05:59 GMT+2 (03:59 UTC / Europe/Oslo). Dashboard judging is 14 October–3 November; winners from 4 November. The existing demo's 10 November expiry is later than that displayed judging window; expiry configuration is not an availability guarantee.
- [Submission form](https://hackathon.monad.xyz/project?tab=submission): submission 0/5, no primary track, old data-recovery tagline, last-saved time 3 October 12:45 UTC. Dashboard 3/5 describes profile/team/project progress and is a different checklist.
- [Trust, Identity & AI Infrastructure](https://hackathon.monad.xyz/tracks/trust-identity-ai): infrastructure other applications build on; three prizes of USD 10,000.
- [Mera: One Passkey, Many Keys](https://hackathon.monad.xyz/tracks/mera-one-passkey-many-keys): one USD 2,500 prize; creative non-wallet PRF use and live recovery on a second device or fresh browser profile.
- [Best Mera-Powered UX on Monad](https://hackathon.monad.xyz/tracks/best-mera-powered-ux-on-monad): one USD 2,500 prize; one-prompt onboarding, scoped prompt-free signing and a stateless test. This is not a fallback eligibility claim: the current reserve setup requires multiple operations and has not demonstrated one-prompt onboarding. Capture: `evidence/portal-mera-ux-2026-10-08.txt`.

Local source captures: `evidence/portal-submission-2026-10-08.txt`, `portal-dashboard-2026-10-08.txt`, `portal-trust-2026-10-08.txt`, `portal-many-keys-2026-10-08.txt` and `portal-rules-2026-10-08.txt`. These authenticated-page captures stay in the local review workspace rather than the public source export.

## Required deliverables

| Item | Requirement observed | Prepared status / remaining work |
| --- | --- | --- |
| Working product | Monad mainnet or testnet; explain purpose, include contract/transactions | Separate live Account Primary/Reserve sites, completed testnet claim and portable `evidence/public-proof.json` |
| Source | Rules §§4.1/7.2 require public GitHub, OSI-approved license, setup README, attribution, build-window history | Reviewed source candidate prepared. Account-reserve license, actual Git publication and URL verification remain open |
| AI disclosure | Rules §4.1 requires README disclosure | Added to root README; solo human builder distinguished from assisting agents |
| Originality | Identify existing foundation and substantial new work | README distinguishes earlier content-backup work from the new account-reserve protocol; preserve authentic repository history |
| Name / tagline | 120 / 200 characters | `ENTRY_DRAFT.md` within limits; saved portal tagline still needs replacement |
| Description / go-to-market / access | Up to 8,000 characters each | Reviewed drafts; no unsupported adoption, integration or device claims |
| Main track | Exactly one | Recommend Trust, Identity & AI Infrastructure; not saved |
| Logo | Form: PNG/JPG/WEBP, at most 2 MB, at least 500 px, at most 4 million pixels | `assets/continuitykit-logo.png`: 1024 × 1024, 249,425 bytes; existing brand artwork |
| Technical video | At most 3 minutes, publicly accessible, actual product and Monad interaction | Deferred by user; not completed |
| Pitch video | Form: at most 2 minutes | Deferred by user; not completed |
| Sponsor answers | Meet each selected sponsor's actual conditions | Many Keys remains conditional; no sponsor acceptance or minimum payout claim |
| Final save | Saved version at deadline is judged | No current-turn portal save; remaining approved publication and final submission required |

## Conflicting source details

- The form permits public GitHub or a repository shared with the organizer. Rules §§4.1/7.2 explicitly require public source and an open-source license. Use the stricter public/licensed route; do not assume private sharing waives the rules.
- The Trust page allows a 3 MB logo; the form permits 2 MB. The prepared logo satisfies the smaller limit.
- Rules v3, labelled 3 September, list judging through 27 October and winners 3 November. The current dashboard lists judging through 3 November and winners from 4 November. Preserve this discrepancy; plan availability against the later date.
- Rules v3 show five equally weighted general criteria. The Trust page has its own rubric below. The saved organizer response from 30 September said track rubrics take precedence; that response was not refreshed in this review. The live track rubric is used for strategy, without silently rewriting the general terms.

## Competitive assessment

The Trust rubric is technical excellence 20%, design/craft 20%, originality 15%, founder/market fit 25%, and traction/path to market 20%. Strong internal tests improve technical evidence; they do not satisfy the 45% market/traction portion. There is no independent integrator, customer demand or revenue evidence. Reducing human testing was a scope choice, not evidence that the product has market fit.

Many Keys explicitly asks for non-wallet value and says the wallet cannot be the point. This package protects an account key. Calling it a vault does not settle that eligibility question. The public native run used a fresh tab in the same browser, so it also does not establish the required second-device/fresh-profile proof. Do not present USD 2,500 as a secured or guaranteed outcome, or perform another native ceremony solely to conceal the unresolved fit issue.

The demonstrated differentiation is credential-based discovery of a prepared reserve without the user finding an export file. A correctly retained encrypted export also works. The additional setup, storage availability and reserve-client trust must remain explicit.

## Source publication recommendation — pending approval

Publish the reviewed new package additively under `account-reserve/` in the existing `CryptoMickle/continuity-kit` repository, with a short root README introduction directing judges to that folder. Keep the earlier `continuity-kit/` source and existing history. Use an actual new commit date; do not manufacture prior commits from logs or claim the snapshot is the build history.

Recommend extending the existing repository's MIT choice to owned account-reserve source, while retaining dependencies' own notices. The existing public repository's README and MIT license were read on 8 October; they currently describe the old data-only product. This recommendation is not a license grant for the new local SDK and is not a legal compliance opinion. No `LICENSE` has been activated for this new package and nothing has been pushed in this work block.

Before publication, approve the exact source manifest, destination, license and additive README change together. The publication gate is distinct from submitting the competition entry and from making a video. The experimental SDK remains private on npm; npm publication is not necessary for a judge to run the source.
