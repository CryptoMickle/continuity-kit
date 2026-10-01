# What is added beyond an independent encrypted export?

The example starts with v1, then corrects a note and removes another in v2. A disappears. A fresh B must recover from what survives. The same data and failures below apply to all approaches; no assumption that blockchain is uniquely capable of solving the problem is made.

| What survives | Encrypted export plus a separately available recovery key | ContinuityKit with a trusted, current registry view | Executed evidence in this package |
| --- | --- | --- | --- |
| Exact v2 export/ciphertext | Can recover v2 without A, provided the independent format/client/key are usable | Can recover v2 and check its digest against the confirmed checkpoint | Continuity local-model roundtrip only; a separate export tool is not implemented |
| One authentic v1 copy and one v2 copy | Can open both if its format supports it; selecting the newest visible authenticated revision is possible | Rejects v1 as the registered current copy and opens exact v2 | `oldCopyRejected`, `exactPayloadRoundTrip` |
| Only authentic v1 is offered, while v2 was previously confirmed | Can open v1. Without a separately retained current-version commitment, it cannot establish that a newer version is being withheld | Knows the offered copy is not the confirmed current version; reports current data unavailable | `bothOldCopiesRejected` |
| Every v2 copy is lost | Cannot recover v2 | Cannot recover v2; the registry contains a commitment, not the content | `missingCurrentRejected` |
| Registry unavailable but an export and its key survive | Can open that export without registry access; latestness remains unproved | The current SDK refuses to claim/recover the current checkpoint | `unavailableRegistryRejected` |
| User's passkey/key is lost or the recovery origin is also unavailable | Depends on the independent recovery mechanism | The tested prepared B path is not available; the registry does not replace the key or client | No physical domain-loss/key-loss trial in this package |

The export column is a **reasoned baseline**, not results from running Notesnook, Cryptee or a newly built backup system. The Continuity results are assertions in the pinned synthetic scenario. They use a local signed registry; they do not establish that a live chain/RPC deployment remains current or available.

An authenticated revision number inside a backup establishes that copy's revision, not the absence of a later hidden revision. A separately retained latest digest, an independent trusted version service or suitable existing chain state can supply the extra knowledge too. A blockchain changes the authority/availability assumptions; it does not eliminate them. Both controlled memory stores in this example also share one failure domain.

The decision is whether independent current-version checking is valuable enough for a specific workflow to justify the extra enrollment, storage, public metadata, fees and recovery dependencies. Frequent typing is not itself a useful reason to submit a transaction. This example records exactly two meaningful local writes and suppresses the unchanged save; it demonstrates **zero** blockchain activity or real recurring demand.

Mera's [security model](https://github.com/category-labs/mera/blob/main/docs/src/content/docs/concepts/security-model.mdx) describes RP-domain binding and the need for export before a planned domain migration. An export path addresses that part of the problem. The possible extra value assessed here is current-version checking after independent recovery, not merely saying that an app may disappear. Documentation was checked on 27 September 2026; it is not an endorsement of ContinuityKit.
