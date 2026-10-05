# Private passport recovery: local feasibility example

The [SDK integration contract](../../delivery/SDK_INTEGRATION_CONTRACT.md) defines the host responsibilities, exact state transitions and remaining public-release boundaries for this example.

This is **ContinuityKit's own synthetic consumer example**, informed by Turnstile's public private-passport data shape. It is not a Turnstile integration, fork, endorsement, account migration or production backup. Only public sample content is used. The SDK's existing cryptography and protocol are unchanged.

From the `continuity-kit` directory, with the existing dependencies installed and Node 24 or newer:

```sh
npm run demo:passport
```

The process needs no server, network, account, authenticator, chain, funding or environment secrets. It creates memory-only synthetic A/B credentials and stores; the process ending discards that state. Do not use this example with private content: its fixture secrets are reproducible from a public seed.

The output is public result metadata: `synthetic-public-fixture`, `local-model`, checkpoint version `2`, two local signed registry writes, zero blockchain transactions, zero physical ceremonies and no Turnstile integration/adoption. Run the command above to obtain results for the exact source being evaluated; historical internal run records are not needed to run this example.

**What it exercises**

1. Validate and encode a small passport-shaped payload into the existing `Workspace` container. The sample contains a public name and two invented event-note keys.
2. Prepare a separate synthetic Continuity identity and reserve; save v1.
3. Correct a sample song title and remove another sample note; save v2. A further timestamp/whitespace-only change is suppressed by the example's memory-only trigger policy.
4. Close the primary signer/keys. A newly constructed synthetic B client receives only the fixed example policy, encrypted stores and registry reader, and never requests A's credential.
5. Have one mirror return authentic old v1 bytes for v2. B rejects it and recovers exact v2 from the other mirror. The correction is preserved and the removed note is absent from the current copy.
6. Both mirrors returning v1, both withholding v2, an unavailable registry, a different credential and an incompatible application policy all fail closed.

“Current” means the last confirmed **Continuity checkpoint**. This code does not save anything to Turnstile, monitor its saves, or atomically coordinate two systems. A future host can successfully save data while a checkpoint fails; its UI must distinguish that unprotected update from a confirmed checkpoint. Suppressing an unchanged local draft is not a freshness check against another device.

Removing a note from v2 is not erasure of v1 ciphertext or revocation of previously held keys. Recovery does not transfer ticket ownership, prove attendance, unlock doors or restore the source wallet. It produces selected private content for local use; B cannot continue A's registry-writing authority.

**Adapter scope**

The source data shape is `v`, `name`, and per-ticket `notes` with `text` and `at`. The adapter is intentionally stricter than the source application's forgiving parser: accepted values are preserved exactly; unsupported input fails instead of silently dropping fields. This example supports a 40-code-unit name, 280-code-unit note text, at most 16 notes, canonical note identifiers and an 8 KiB encoded payload. The note-count and payload limits are our example's limits, not a claim about Turnstile's capacity. It handles an empty passport. Unicode, unsupported versions/fields, duplicates and oversize payloads have targeted tests.

The wrapper format is `continuity-passport-example/v1`. It uses its own fixed application/schema/bootstrap namespace in `EXAMPLE_POLICY`. `fromCheckpoint()` validates the payload only: callers must first obtain SDK-verified content via `recoverCurrent()`. It is not a replacement for registry verification. The full versioned wrapper temporarily resides in `Workspace.draft`; no generic-payload SDK has been introduced.

The example prints neither plaintext passport contents nor key material. It does not persist them. The tests and this fixture intentionally contain public sample strings.

**What a real integration still requires**

- Agreement on useful data, update triggers, recovery-domain ownership and surviving storage. Hosting two mirrors in one process does not establish independent availability.
- A deliberate identity choice. Current SDK enrollment creates a new Continuity A credential; the B credential is also separate. A real variant adds setup/authentication and needs an approved checkpoint-fee payer. Turnstile's sessions and sponsorship are not automatically compatible.
- Validated plaintext obtained from an open host vault, then encrypted with the separate Continuity data key. Copying only the host's encrypted blob would still require its original vault key. No wallet or door key should be exported into the checkpoint.
- Full browser handoff/lifecycle handling. The synthetic authenticator cannot simply be replaced while running all calls at one browser origin.
- Retained draft/ticket and explicit reconciliation for pending or conflicting writes. This local-only exercise fails on an unexpected outcome and never retries or labels it saved. It is not a production write controller.
- Physical/testnet evidence for the actual host integration and an independent maintainer evaluation. The [separately installed journal consumer](../standalone-consumer/README.md) now exercises the private SDK package internally; it does not establish a passport integration or independent adoption.

**Source and provenance**

The public `main` ref was resolved with `git ls-remote` to **`0d36bc5b214c47cf07a9eacea2a8753610c313d0`** on 26 September 2026. Source was read, not executed. This adapter/scenario is newly written ContinuityKit code; Turnstile's source is not bundled or imported. The pinned source links below identify that historical reference, not the project's current implementation.

- [Turnstile passport model](https://github.com/vaibhav0xq/turnstile/blob/0d36bc5b214c47cf07a9eacea2a8753610c313d0/apps/web/src/app/passport-model.ts): shape and meaningful-change behavior.
- [Turnstile save/read flow](https://github.com/vaibhav0xq/turnstile/blob/0d36bc5b214c47cf07a9eacea2a8753610c313d0/apps/web/src/app/passport.ts): existing encryption, signing and sync.
- [Identity API](https://github.com/vaibhav0xq/turnstile/blob/0d36bc5b214c47cf07a9eacea2a8753610c313d0/packages/identity/src/identity.ts) and [vault](https://github.com/vaibhav0xq/turnstile/blob/0d36bc5b214c47cf07a9eacea2a8753610c313d0/packages/identity/src/vault.ts): session/key boundaries.

This mechanism test does not establish demand or justify a larger passport integration by itself. An actual maintainer must decide whether current-version checking adds enough value over a simpler encrypted export.
