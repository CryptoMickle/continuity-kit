# ContinuityKit integration contract

Updated 5 October 2026. Experimental SDK, not a published npm package or production service. A private, compiled local package and [standalone consumer](../examples/standalone-consumer/README.md) now exercise package installation, public types and synthetic recovery outside the source tree. See [package instructions](SDK_PACKAGE.md). The earlier [passport-recovery](../examples/passport-recovery/README.md) remains a source-based example. Neither is an external adopter or an integration with another application's identity system.

## What the host integrates

ContinuityKit protects a deliberately selected snapshot of private application content. Before losing the original application, the user prepares a second credential at recovery origin B. Later, B can discover encrypted recovery metadata and open the exact checkpoint accepted by the configured version registry. It returns content for local editing/export. It cannot recreate missing bytes, restore the original signing credential, or write as A.

The host supplies:

| Input / responsibility        | Current contract                                                                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plaintext snapshot            | Obtain validated content from an already open host workspace. Encrypt it in the client with Continuity's data key. An opaque host-vault ciphertext is insufficient if its original key disappears with A. Exclude wallet/door/access secrets.                     |
| Versioned codec               | Encode/decode the supported host subset losslessly, reject unsupported versions/fields, and enforce size bounds. There is no generic arbitrary-byte payload API today.                                                                                            |
| Frozen recovery policy        | Application, schema, deployment and stable bootstrap namespace; exact A/B origins and disjoint RP scopes; two mirror URLs; registry identity and trust mode. B receives these from its trusted build/configuration, not from unauthenticated storage.             |
| Separate origins and setup    | A runs `createPrimary`; B runs `prepareBackup`; A validates/finalizes the returned backup. Use the validated origin/window-bound handoff. The single-process synthetic example does not implement a production host handoff.                                      |
| Storage and registry adapters | `RecoveryAdapters` provides two mirrors and a registry reader. `PrimaryAdapters` additionally provides either the signed local model writer or a transaction transport plus session limits. Recovery never needs the primary writer.                              |
| Save policy and UI            | Capture meaningful changes, serialize saves, retain unconfirmed drafts/tickets, handle conflicts and explicitly distinguish host-save success from checkpoint confirmation. No automatic save-on-every-keystroke.                                                 |
| Identity, fees and lifecycle  | Current primary enrollment uses a new Continuity credential and derived owner, with a separate B credential. Host login, sponsored gas and existing wallet/session APIs are not imported automatically. Close primary signing/key state when leaving the session. |

Sources: [types](../src/sdk/types.ts), [policy](../src/sdk/policy.ts), [protocol](../src/sdk/protocol.ts), [account](../src/sdk/account.ts), [handoff](../src/handoff.ts), [main reference client](../src/main.ts).

## Payload and codec boundary

`Workspace` is exactly `{ title, plan, tasks, draft }`. `tasks` is an array of `{ id, text, done }`. Unknown fields fail validation. Limits: title 200, plan 16,000, draft 64,000 UTF-16 code units; at most 200 tasks, each with a unique nonempty id up to 100 code units and text up to 2,000. Strings must be well formed. Encoded encrypted capsules must also fit the policy's byte limit (local default 1 MiB); character limits are not a promise that arbitrary content fits the capsule.

The passport adapter stores an explicitly versioned envelope in `Workspace.draft`. It supports a 40-code-unit name, at most 16 notes with 280-code-unit text and an 8 KiB encoded payload. Those are this example's limits, not Turnstile's. It validates canonical note IDs and round-trips accepted Unicode/content exactly. `fromCheckpoint` validates the payload only: call it on `Recovered.content` obtained from SDK verification, never on unverified downloaded JSON.

`hasMeaningfulChange` in that adapter ignores timestamps and surrounding whitespace for its specific product policy. The primary reference UI instead compares **exact full Workspace content** with its last accepted snapshot. Spaces, task changes and ordering can matter. Neither policy is a freshness check against another device. Direct `saveCheckpoint` callers still need their own change guard; the low-level SDK does not deduplicate identical plaintext. New encryption bytes alone are not useful activity.

## Three separate milestones

| State                      | What may be said                                                                                                                             | What must not be inferred                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Host saved                 | The host's own save operation succeeded.                                                                                                     | No Continuity operation is implied; there is no atomic host/chain transaction.                                           |
| Encrypted reserve uploaded | The required encrypted objects were uploaded and read back exactly from both configured stores.                                              | The owner-approved registry pointer may still be absent or old. Old copies can remain available.                         |
| Checkpoint confirmed       | The SDK accepted the exact checkpoint against the configured registry evidence. In testnet mode, label the evidence as finalized RPC quorum. | Not automatically the latest host save; not proof of durable independent hosting, correctness of the content, or demand. |

Example: host saves correction H2; Continuity upload succeeds but the write is pending. Show “H2 saved in this app; reserve confirmation pending.” B may still open the previously confirmed checkpoint C1. Do not label H2 protected or send another transaction just because a receipt timed out. After C2 is accepted, H3 typed meanwhile remains an unsaved/unprotected draft.

## SDK calls and outcome handling

1. **Enroll:** `createPrimary(policy, passkeys, primaryAdapters)` → origin-bound B `prepareBackup(policy, passkeys, {context, dataKey}, isActive)` → A `finalizeEnrollment(primary, backup, capturedWorkspace, adapters)`. The data key passes in memory through the validated origin/window-bound handoff; never send A's signing key to B. `PreparedBackup` alone means the B material is prepared, not that v1 is registered. Enrollment intent/bytes become immutable; do not reuse a credential for a different manifest.
2. **Open A:** `restorePrimary(policy, passkeys, primaryAdapters)` returns `{state, recovered}`. Install a clone of verified `recovered.content` as the baseline only after protecting any unsaved draft the restore would replace. If enrollment reconciliation returns only a head/state, it has not returned verified plaintext. The UI now requires opening that saved checkpoint before another save.
3. **Save:** `saveCheckpoint(state, capturedWorkspace, recoveryAdapters)` uses `state.writer` and returns the outcomes below. Keep both the accepted baseline and captured submitted draft distinct from later edits. The SDK retains the pending draft in RAM; a durable restart/resume controller is not supplied.
4. **Reconcile:** `reconcileCheckpoint(state, ticket, adapters)` or `reconcileEnrollment(primary, ticket, adapters)` reads existing status; it does not sign/resubmit. The checkpoint path requires the matching retained SDK state. Exporting a ticket is useful evidence, not a complete resumable encrypted workspace.
5. **Recover B:** `discoverRecovery(policy, passkeys, recoveryAdapters)` authenticates discovery/context; `recoverCurrent(discovered, passkeys, recoveryAdapters)` opens current content and returns `Recovered`. Pass no A credential, signer, remembered owner or local export file. Close/discard old clients when demonstrating fresh recovery.

| Save outcome                             | Host action                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`                                | Retain `ticket`, state and captured draft. Show uncertainty, block additional writes, offer read-only reconciliation.                                                   |
| `saved` without `unresolvedTicket`       | Advance the accepted baseline to the returned `recovered.content`. Preserve any newer edits. Display the version and evidence scope.                                    |
| `saved` with `unresolvedTicket`          | Exact state is accepted, but transaction attribution remains unresolved. Keep writes blocked and reconcile that ticket; do not claim an independently verified receipt. |
| `superseded`                             | This checkpoint committed and was replaced. Preserve the local draft and request the current content before presenting it as current. No automatic overwrite/merge.     |
| Exception with a writer pending ticket   | Treat as uncertain, not as “nothing was sent.” Retain the ticket and reconcile.                                                                                         |
| Definite conflict / reverted transaction | Keep the draft; show the error, inspect current state and let the user resolve it. Do not silently retry against a new version.                                         |

Pre-write upload failures can retain exact pending bytes even without a ticket. An explicit retry of that intent must preserve the captured draft; changing it is not a substitute for resolving the retained operation. The consumer scenario deliberately aborts on non-final outcomes; it is a mechanism example, not a full write controller.

`Recovered` includes `content`, `context`, `manifestDigest`, `version`, `capsuleDigest`, `evidence` and rejected-mirror diagnostics. `createLocalCopy` clones content and preserves a source receipt; edits to the local copy do not change the receipt. `exportLocalCopy` produces **plaintext JSON**, so export only on an explicit user action. B cannot continue A's registry history. Recovery may fail explicitly if current bytes or accepted freshness evidence are unavailable; an old authentic copy must not be mislabeled current.

## Minimal integration acceptance

- Codec rejects unsupported input, round-trips corrections/deletions exactly and has tested bounds.
- Unchanged content causes zero writes; host-save success plus checkpoint failure remains visibly unprotected.
- Pending/conflicting operations preserve drafts and never cause an automatic second write.
- A is unavailable and old sessions are discarded; fresh B returns exact C2, rejects authentic stale C1, and fails when C2 is missing or freshness cannot be accepted.
- Physical credentials, local model and actual chain evidence are labeled separately. The passport example passes a synthetic model exercise, not external integration or adoption.

Live-service authentication, abuse limits, durable operations/restarts, stable hosting, key loss/rotation and production support are outside the delivered SDK guarantee. The compiled package does not include the reference browser handoff UI or a complete host save controller. Publishing a host application requires a separate deployment and operational review; the local HTTP harness is not a production service.
