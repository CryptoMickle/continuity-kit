# ContinuityKit protocol v1

Status: implemented local protocol, with P2, V1 and T1 AI-assisted reviews, 26 September 2026. The physical local A/B core has passed; the subsequent T1 SDK integration and separate deployment executor passed 170 local tests and separate source review. See EVIDENCE.md for precisely tested behavior; this is not a security audit or a real-chain success claim. The current user mandate permits local implementation and tests; older planning documents' build prohibition has been superseded. The user has additionally approved the local Mac/iPhone passkey test for primary.localhost and recovery.localhost with synthetic content. Other account creation, terms acceptance, outside messages, public deployment, testnet signing/deployment and submission still require approval of those concrete actions. Use synthetic content and no real funds.

## 1. Product contract

**Recover private application work when its original application becomes unavailable, provided a separate recovery passkey and surviving encrypted copies were prepared beforehand.** The first integrator is a developer building a Mera application; the demonstration content is a small private workspace with a title, plan, task list and draft.

A is the primary application and Mera account RP. B is a separately hosted recovery client on a different RP, enrolled while A works. A owns a Monad version-registry stream. B recovers app content, permits local edits and exports a local file. B does not recover A's signing authority or continue A's registry history.

The mandatory demonstration is: enroll B; commit checkpoints v1 and v2; stop our A and its backend; discard all old browser/application state; open B with a surviving B passkey; discover metadata automatically; reject a still-valid v1 offered as current; obtain surviving v2 and open its content. In a second case with no v2 bytes, report the known current version as unavailable. No original-origin request, manually supplied recovery secret, remembered owner address or saved local file is allowed in that recovery path.

| Requirement | Evidence required | Current limit |
| --- | --- | --- |
| Main track: useful infrastructure and meaningful Monad role | Small reusable SDK; separate client; actual registry-backed stale-copy rejection | Local registry fixtures do not establish Monad integration or external adoption. |
| Mera Many Keys | Useful non-wallet data encryption; isolated key purposes; actual B-passkey recovery in a fresh supported environment | Local PRF fixtures are explicitly simulations. Hardware interoperability is unproven until measured. |
| Mera UX | A uses Mera as its account layer; measured onboarding ceremony count; scoped expiring signing session; same A address, full private-workspace access and actual new testnet transaction after clearing state | This is a separate test while A remains available. A new B credential is not A-account recovery. A one-ceremony onboarding claim requires physical evidence on the supported setup. |
| Honest recovery UX | Cancellation, unsupported PRF, corrupt metadata, stale data, missing current data and unavailable freshness source have distinct outcomes | Never label a local working copy as an authorized continuation of the registry. |

The frozen strategy and saved sponsor text remain the source of competition requirements. Prize stacking, contradictory judging weights and sponsor interpretation remain unresolved; this specification does not resolve eligibility.

## 2. Trust model and v1 restrictions

Trusted components are the code delivered by A and B during enrollment, B during recovery, the browser and authenticator, the standard cryptographic implementations, and the selected registry reader's stated chain trust assumption. A's later **unavailability** is modeled; compromised A/B JavaScript is not. Both clients see plaintext app keys in memory. A copied key cannot be revoked by deleting a wrapper.

An adversary may completely control all blob/index storage: read, alter, swap, replay, delete, reorder and withhold bytes; send arbitrary cross-origin messages; race legitimate checkpoint writes; and present arbitrary metadata claiming another owner, application, chain or registry. Storage authentication/CAS may improve availability but supplies no security authority. Storage can always cause denial of service. Traffic and public chain records may reveal timing, stream ownership, size and version counts.

V1 has one immutable recovery enrollment and one stream per newly created A/B credential pair. It does not reuse either credential for another stream, regenerate its recovery record/manifest, rotate keys, migrate registries, transfer ownership, revoke a copied data key or discover the user's globally newest enrollment. Each new enrollment creates new credentials and a stream. Selecting an old credential selects its old, clearly identified enrollment, not a replacement enrollment. These restrictions are essential: a fresh client cannot distinguish two previously valid, differently bound records under the same lookup key merely because one was returned first.

A malicious or stale chain view can defeat freshness. V1 does not implement a light client. Its real-chain reader explicitly trusts independently configured RPC services and consensus finality; two agreeing RPCs are not a cryptographic proof. RPC disagreement, missing code, wrong network, unsupported finality policy or inability to obtain a current accepted head fails closed. Local fixture results must state `local-model`, not authenticated Monad evidence.

## 3. Bootstrap policy and immutable context

B ships with a versioned, trusted `RecoveryPolicy`, supplied by the application build, never by downloaded storage. For the first demo it contains one allowed deployment:

- `protocol = "continuity-kit/v1"`, a stable application ID and a content schema ID;
- exact A/B HTTPS origins and exact A/B RP IDs (local fixture policies are separately named);
- expected chain ID, registry address and verified non-upgradeable registry runtime-code hash;
- a deployment ID and fixed registry ABI;
- approved RPC endpoints, chain finality policy and bounded freshness/timeouts;
- approved storage adapter identities and endpoints, limits, and the bootstrap PRF namespace.

The final testnet address/code hash is a required later policy input. No placeholder may silently become a production/testnet authority. Scheme, hostname and explicit non-default port are part of an origin. Different ports alone do not establish different RP IDs. No storage-provided RPC endpoint, contract address, origin, script URL or schema loader is followed.

`Context` is a strict object containing the policy's protocol/application/schema/deployment fields, exact origins and RP IDs, chain ID, registry address, registry code hash, `owner` (the A Mera EOA address), and `streamId` (32 random bytes). Registry keys are `(owner, streamId)`. Normalize addresses to one lowercase 20-byte hexadecimal representation; encode chain IDs and uint64 versions as canonical decimal strings. Chain ID alone is not a unique deployment identifier.

The expected owner and stream are established by A's authenticated enrollment handoff, then sealed into B's immutable manifest. Fresh B does **not** ask untrusted storage to tell it an authoritative owner. It authenticates the manifest with a key obtainable only from the selected B credential. It then checks every policy-fixed context field and looks up that exact owner and stream. A successful owner-authorized registry creation must pin the same manifest digest. Neither a self-consistent inner owner field nor a valid arbitrary contract read is sufficient on its own.

## 4. Cryptography and wire objects

Use Web Crypto SHA-256, HKDF-SHA-256 and AES-256-GCM, and Mera's existing secret-vault functions. Generate random bytes with `crypto.getRandomValues`. No password KDF, custom cipher, key reuse across purposes or new signature scheme is introduced. AES-GCM uses fresh 96-bit random nonces and 128-bit tags. The bounded demo has at most 100,000 writes per data key; a production lifetime/rotation design is outside v1.

All hashed/encrypted protocol objects use one deterministic, documented JSON encoding (RFC 8785 canonical JSON, UTF-8, no BOM). Parsers reject unknown fields, duplicate keys, noncanonical byte encodings, unsupported versions, oversized input and malformed types. Protocol numbers other than fixed version tags are decimal strings. Bytes use canonical unpadded base64url, except Ethereum identifiers. Hash the exact canonical bytes; do not silently parse and reserialize attacker-controlled input before verifying its digest. A canonical-wire round-trip comparison may enforce the encoding after strict size/type validation. Treat content as data: no executable HTML, scripts or dynamic schema downloads.

Default limits: manifest 64 KiB, secret payload 8 KiB, capsule 1 MiB, at most two configured mirrors, 10-second per-source timeout. Oversized or excessive responses fail before costly parsing or cryptography.

### 4.1 B discovery keys

The public bootstrap salt is available before any metadata:

```text
lookupSalt = SHA256(UTF8("continuity-kit/v1/bootstrap") || 0x00 || UTF8(policy.bootstrapNamespace))
P = B-passkey PRF(lookupSalt)
Klookup = HKDF-SHA256(P, SHA256(UTF8("continuity-kit/v1/hkdf")), UTF8("locator"), 32)
Kmanifest = HKDF-SHA256(P, SHA256(UTF8("continuity-kit/v1/hkdf")), UTF8("manifest-aes-gcm"), 32)
locator = base64url(SHA256(UTF8("continuity-kit/v1/locator") || 0x00 || Klookup))
```

`bootstrapNamespace` is a frozen build-time value for this B recovery product, stable across data versions and normal client updates. It cannot depend on a stored salt, unknown owner or unknown stream. Changing it without a deliberately supported migration breaks discovery. The independently derived manifest key is never transmitted with the locator. The locator is an opaque retrieval identifier, not a storage authorization credential; a service seeing it still cannot forge its contents.

Fresh B calls `getPasskeyPrfOutput` with its trusted RP ID, `lookupSalt`, and **no credential metadata**. The selected credential ID is retained in memory for comparison with the subsequently authenticated manifest. At enrollment, the same call is pinned to the just-created credential. A uses its own Mera account namespace. No A-wallet secret is sent to B.

### 4.2 Recovery manifest and wrapped key

A generates `dataKey`, a random 32-byte non-wallet AES key. The secret passed to the B Mera vault is canonical bytes of:

```text
WrappedKey = { format: "continuity-key/v1", context: Context, dataKey: Base64url32 }
Manifest = { format: "continuity-manifest/v1", context: Context, vault: MeraPasskeySecretVaultV1 }
manifestDigest = SHA256(canonicalBytes(Manifest))
```

The whole canonical manifest, including vault metadata, is AES-GCM encrypted under `Kmanifest`. Additional authenticated data is the canonical object `{format:"continuity-index/v1", bootstrapNamespace, bRpId, locator}`. The stored index envelope contains only fixed format/version, nonce and ciphertext. It does not select a key derivation, network, owner or registry. No unauthenticated field is copied into authoritative context.

Mera's vault encrypts arbitrary secret bytes with its own fresh PRF salt. Its outer credential and salt fields are not themselves AES-GCM AAD. ContinuityKit's authenticated outer manifest covers those fields; the decrypted `WrappedKey.context` must additionally equal the already authenticated manifest context exactly. The vault's credential ID must equal the ID returned by the discovery ceremony, before any unlock request. Use `parseSecretVault` after authenticating/validating the manifest and before invoking the vault unlock.

The manifest never contains its own digest or a mutable current-head pointer. The registry pins `manifestDigest`; capsules reference that digest. This is acyclic: context → wrapped vault → manifest → manifest digest → checkpoint → registry head. Only the index envelope nonce/ciphertext protects the manifest; registry creation happens after that manifest exists.

Serialize/encrypt the manifest once. Persist those exact bytes to both mirrors. A retry reuses those bytes rather than generating another manifest/vault. If enrollment state is lost before completion, start over with a new B credential. Even with misleading "not found" replies, the SDK must not create a second manifest under an existing B credential. Storage `putIfAbsent` is useful but does not enforce this cryptographic invariant against a malicious provider.

### 4.3 Checkpoints

```text
Header = {
  format: "continuity-checkpoint/v1", contextHash: SHA256(ContextBytes),
  manifestDigest, owner, streamId, version, schemaId
}
Payload = { format: "continuity-content/v1", content: ValidatedWorkspace }
Capsule = { header: Header, nonce: Base64url12, ciphertext: Base64url }
capsuleDigest = SHA256(canonicalBytes(Capsule))
```

Encrypt canonical payload bytes with `dataKey` and canonical `Header` as AES-GCM AAD. The content schema defines plain text fields and task identifiers, not executable content. A current chain digest authenticates the entire capsule bytes as the owner-approved checkpoint. The AEAD verifies possession of the data key and its bound context; it does not, on its own, prove currentness or A-owner authorization because B also holds the data key. Both checks are required before current content is returned.

## 5. Enrollment flow and binding

Enrollment is an explicit user action while A is available. Account onboarding and backup preparation are separate actions; measure their ceremonies separately.

1. A derives/opens its Mera account, obtains its actual signer address and creates a new random `streamId` and `dataKey`. It obtains the full `Context` from trusted policy plus those values.
2. A opens the exact configured B enrollment URL in a fresh window (`_blank`, preserving its opener) and retains the resulting window reference. Never reuse a named window from an earlier setup. An enrollment URL without a live opener reports a setup error, not a recovery prompt. B accepts only its actual `window.opener` from the exact configured A origin. Both sides register bounded message listeners, require exact `event.origin`, `event.source` and message shape, and use exact `targetOrigin`, never `*`.
3. A and B exchange independent 32-byte session nonces. Every subsequent message carries both nonces and a monotonic, expected protocol step; expire the session after five minutes and consume it once. Ignore unsolicited, duplicate, reordered, wrong-source or wrong-origin messages. The nonce is a handoff binding; do not claim Mera signs that entire transcript. Mera generates its own WebAuthn challenges internally.
4. The `continuity-handoff/v2` offer contains public context only. B validates every policy-fixed context field and displays the source application and intended recovery profile. The user's B creation gesture sends a bound begin request. A irreversibly marks creation as possibly started **before** sending the one-use grant containing that context and data key. Only that grant allows B to call native creation. Do not put a key in URL parameters, fragments, logs, analytics, network storage or persistent browser storage. Earlier v1 handoff messages are rejected; stored recovery objects remain protocol v1.
5. B creates a **new** dedicated discoverable passkey using `createSecretVaultWithNewPasskey`, wrapping `WrappedKey`. It evaluates that credential at the fixed bootstrap salt, derives locator/manifest key, builds and encrypts its immutable manifest, and sends the encrypted index bytes, locator and manifest/digest back to the same A session. A verifies the returned context and digest equal the intended enrollment. B's vault key is never an A signing key.
6. A builds its immutable primary recovery record as specified in section 9. Upload that record, B's immutable index and the initial capsule to both configured mirrors, then read back and verify exact bytes/digests. A's real account calls registry `create(streamId, manifestDigest, initialCapsuleDigest)`. The contract infers owner from `msg.sender`; a caller cannot register for another owner.
7. After the confirmed registry read shows that exact owner/stream/manifest/v1 digest, B reads the index and verifies the enrollment against the registry. Only then show "reserve prepared". Failed storage or transaction steps leave enrollment incomplete. Do not advertise recovery of uncommitted content.
8. Discard handoff session nonces and sensitive byte buffers when no longer needed. Best-effort buffer clearing does not guarantee JavaScript garbage collection erases all copies. No secret logging.

A registry creation confirms owner control and binds the immutable manifest; it does not attest to the human's intentions or to availability of stored bytes. Fresh B's owner anchor is the authenticated manifest from this consented enrollment. A compromised trusted enrollment client remains outside the threat model.

### 5.1 Bounded pause before B creation

The primary tab can retain its exact unfinished enrollment through a pause **before A grants B creation**. One private `SetupDraft` controller owns an AES-GCM encrypted RAM snapshot of the original context and random data key. Its wrapping key is HKDF-SHA256 of A's purpose-separated primary record key with info `pre-backup-pause-aes-gcm`. AAD binds the full frozen policy, exact A credential ID and original transaction-session limits. No snapshot, wrapping key or plaintext is written to browser/server storage. The visible unsaved workspace remains in the primary tab's ordinary memory.

The controller's monotonic phase is outside the ciphertext. It has no snapshot export/import or arbitrary-blob resume API. Module-private permanent reservations prevent independent controllers for an account or its writer, including resumed accounts. Only one resume may be in progress. A live controller may pause only with zero signing attempts, zero reserved fees, no ticket, no prepared enrollment bytes and no prior B grant. Pause closes the old channel and writer and clears its plaintext keys. Handoff expiry before the grant, explicit pause and idle signer expiry use this same operation.

Continuing is an explicit existing-A authentication, pinned to the retained credential. Policy and session limits are compared before and after that asynchronous operation; the derived owner must match. The exact original context/data key are reopened, never generated anew. A new signer gets the same bounds after authentication; no consumed transaction budget is reset because only untouched pre-B accounts qualify. A fresh popup/channel gets fresh nonces. Closing the controller during authentication invalidates late completion.

After a B grant, pause/resume is permanently unavailable, even if its delivery or native creation result is unknown. Native cancellation can follow successful credential creation. B therefore permits one creation attempt per bound handoff and rejects late completion after channel expiry or page termination. Pending transactions retain their existing read-only reconciliation path; this feature neither renews such sessions nor resubmits them.

This is **same-tab interruption handling**, not durable onboarding recovery. Reload/crash/tab close loses the RAM authority. `pagehide` permanently retires it so back/forward cache revival cannot reopen it. No encrypted mirror record, storage absence, zero nonce or old encrypted snapshot can recreate its pre-grant eligibility. Already expired setups that erased their random keys cannot benefit retroactively. Completed A/B recovery remains independent of this controller and all old tabs.

### 5.2 Local operator completion after a reviewed pre-signing failure

The ordinary SDK/UI still has no durable enrollment resume. A separate local testnet operator in `testnet/complete-prepared.ts` can complete an already uploaded exact v1 only after the earlier attempt has been independently reviewed as failing before signing. An absent registry head or zero nonce alone is not evidence of that condition and does not authorize retry. This capability is not exported from the SDK or offered by the ordinary app.

The 28 September repair panel pins the previously observed owner, stream, manifest digest and capsule digest in its source. Existing A authentication must derive that exact owner. It requires two identical encrypted primary records, authenticates their context/owner/manifest using A's existing record key, then requires two identical pinned capsules, verifies their digest, full v1 header, authenticated encryption and workspace schema. It neither creates a credential nor rewrites any stored object. A bounded one-transaction writer remains in RAM after preview; other plaintext key buffers are cleared. Preview content is explicitly uncommitted. This path does not authenticate B and cannot claim an independently checked reserve until existing B recovery succeeds later.

A separate user gesture consumes one completion attempt irreversibly. It rechecks storage bytes, requires an absent strict-quorum head and nonce zero at both providers, and guards nonce zero again at the writer's immediate signing stage. Only the pinned create-v1 command is exposed, with zero value, one transaction and a 0.06 test-MON fee cap inside the existing aggregate run authorization. Unknown submission retains the public ticket for read-only reconciliation; no automatic resign/resubmit. Closing/reloading cannot reset the operator's external authorization ledger. Page termination invalidates late authentication and closes the signer. The original A/B grant and same-tab pause rules are unchanged; this does not recreate pre-grant eligibility or an erased unpersisted setup.

## 6. Registry and checkpoint writes

The registry is deliberately small and non-upgradeable. Its mapping is keyed by owner and random stream ID. An initialized record contains immutable `manifestDigest`, positive `uint64 version` and current `capsuleDigest`. Zero identifiers/digests, duplicate creation, absent streams, overflowing versions and no-change updates are rejected.

```text
create(streamId, manifestDigest, initialCapsuleDigest) -> version 1 for msg.sender
commit(streamId, expectedVersion, expectedDigest, nextDigest) -> version + 1 for msg.sender
getHead(owner, streamId) -> exists, manifestDigest, version, capsuleDigest
```

`commit` checks **both** current version and digest against its expected values. It changes only the caller's stream. Emit events sufficient to identify owner, stream, version and digest; no plaintext app content, keys, passkey IDs, locators or arbitrary fetch URLs are stored on chain. A guessed stream ID does not confer authority.

Saving a checkpoint reads an accepted current head, encrypts version `head.version + 1`, uploads and verifies both digest-addressed copies, and only then submits the compare-and-swap update. Two writers starting at v1 cannot silently overwrite each other; one succeeds and the other gets `WRITE_CONFLICT`, retains its unsaved local work and requires an explicit resolution. Unreferenced blobs from unsuccessful writes have no authority. A successful upload is not a successful checkpoint. A successful transaction is not a promise of perpetual storage.

The adapter validates receipt status and the committed identity/digest. A subsequent head read determines what is current now; another valid write may already have advanced it. If the receipt is unavailable, reconcile against the exact registry state instead of blindly retrying with a changed expectation.

The SDK exposes `saveCheckpoint` outcomes `saved`, `superseded` and `pending`, and enrollment outcomes `prepared` and `pending`. Only a validated current checkpoint can be shown as saved. A proven transaction followed by a later accepted version is superseded, not a failed transaction or permission to overwrite the later work. Missing receipts with exact accepted target state can prove the checkpoint through `finalized-state`; the unresolved transaction ticket still blocks more writes until nonce/history uncertainty is resolved. Keep drafts and exact pending bytes; never treat a broad transport-error catch as proof of success.

## 7. Fresh B recovery algorithm

1. Load trusted B policy. Ask the authenticator for a discoverable credential at the fixed B RP/bootstrap salt. Derive `locator` and `Kmanifest`; keep the selected credential ID in memory.
2. Request the locator from each approved index mirror. Bound size/time, decrypt with fixed algorithm and AAD, validate canonical manifest structure, exact policy context and selected credential ID. Ignore malformed/tampered copies and try the remaining mirror. If two decryptable manifests differ, stop with `ENROLLMENT_CONFLICT`; do not pick one. An exact replay of the one immutable manifest is expected.
3. Compute `manifestDigest` and read `(manifest.context.owner, manifest.context.streamId)` from the **policy's** registry and chain, under the configured current-head trust policy. Require existence and equality of the on-chain immutable manifest digest. Reject a mismatched owner, context, registry deployment, manifest digest or chain view. Do not try a different authority suggested by the failed input.
4. The accepted head supplies the expected version and capsule digest. Fetch exactly that digest from approved blob mirrors. No mutable storage index can override that head. Hash each response's exact bytes; a response with a different digest is rejected. The test's valid v1 is therefore rejected when the accepted head is v2 even though v1 decrypts under the correct data key.
5. Parse the current capsule; require exact header context hash, manifest digest, owner, stream, schema and version. Parse the authenticated Mera vault and call `decryptSecretVaultWithPasskey` at the policy's B RP, pinned to the same credential. Require `WrappedKey.context` to exactly match. Verify/decrypt capsule AEAD; validate content schema before handing it to a client.
6. Re-read the accepted current head before declaring success. If it changed, discard the current-result designation and restart the bounded fetch/check procedure. Limit to three advances before returning `HEAD_MOVED` so continuous writers cannot cause an infinite recovery loop. A completed result is "current at accepted block X/version Y", never a promise that nobody can write after the check.
7. Return verified content plus owner/stream/version/digest/accepted-block evidence. Editing creates a visibly local working copy; export is a deliberate plaintext-file action. B's SDK exposes no A wallet signer or registry-write operation.

If the current digest's bytes are absent or all copies are invalid, return `CURRENT_DATA_UNAVAILABLE` with the known version/digest. Do not silently open an older capsule. If no trustworthy current-head read is available, return `FRESHNESS_UNAVAILABLE`; do not call a successfully decrypted old copy current. A wrong passkey normally produces a different locator and "no matching recovery material"; indistinguishability from missing/deleted index data is honest. Do not diagnose key loss from a storage 404.

The real-chain adapter validates configured chain identity and registry code, and evaluates the registry record and relevant checks at one accepted block. It includes block number/hash, observation time and its trust mode in evidence. Finality policy is a configured, verified adapter detail; no arbitrary `latest` response or old cached head may be promoted to "authenticated current". Recovery permits a bounded finalized-chain lag disclosed in the UI/evidence. Testnet reads remain unverified until an actual deployment/read is performed.

### Why discovery is not circular

| Required recovery input | Surviving source |
| --- | --- |
| B origin/RP, bootstrap salt and namespace | Trusted independently available B build |
| Selected credential | Authenticator's discoverable-credential chooser |
| Locator and manifest decryption key | Fixed-namespace PRF output and standard HKDF |
| Owner, stream, full context and vault metadata | Authenticated immutable manifest at that locator |
| Authoritative chain/registry/endpoints | B policy; exact manifest context must agree |
| Current version and digest | Owner-authorized registry record at an accepted current block |
| Data key | Mera vault unlocked with the selected B credential and stored random PRF salt |
| Ciphertext bytes | Surviving approved blob mirror at the current digest |

No preexisting local credential ID, mutable pointer, private file, A session or manual owner input is required. Losing both index copies makes recovery unavailable even if the data blobs survive; the passkey does not recreate unknown random vault salts.

## 8. SDK boundaries to implement

Pin these project interfaces before splitting implementation; names below define responsibilities rather than claiming a Mera API. All byte inputs are copied or explicitly ownership-transferred, size bounded and validated. Recoverable errors use a typed discriminated union, not success-shaped empty content.

| Interface/operation | Contract |
| --- | --- |
| `PasskeyAdapter.createBackup(secret, policy)` | Create new B credential and Mera vault; no existing-credential rebinding. |
| `PasskeyAdapter.discover(policy, credential?)` | Evaluate fixed bootstrap salt; return exact credential ID and 32-byte PRF output. Omit credential on fresh recovery. |
| `PasskeyAdapter.unwrap(vault, policy)` | Parse validated vault, pin credential and unlock bytes with Mera. |
| `MirrorStore.putIndexIfAbsent(locator, bytes)` / `getIndex(locator)` | Untrusted exact index bytes; conflict and network failure are explicit. |
| `MirrorStore.putBlob(digest, bytes)` / `getBlob(digest)` | Untrusted digest-addressed bytes; caller verifies every returned digest. |
| `RegistryReader.getHead(policy, owner, streamId)` | Validated record plus accepted-block/trust evidence, or explicit freshness failure. Owner/stream never derived from storage outside authenticated manifest. |
| `OwnerRegistryWriter.create(...)` / `commit(...)` | A-only injected owner signer, exact immutable binding, CAS arguments and verified receipt result. |
| `prepareRecovery(...)` | Trusted handoff, new B credential, immutable manifest and initial checkpoint; returns prepared state only after storage/registry verification. |
| `saveCheckpoint(...)` | A-only validated content, current CAS expectation, exact capsule upload then commit. |
| `discoverRecovery(policy, adapters)` | Authenticated immutable manifest and exact selected credential context; no content success yet. |
| `recoverCurrent(discovered, adapters)` | Full current-head/digest/context/AEAD/schema checks and final head recheck. |
| `createLocalCopy(recovered)` / `exportLocalCopy(copy)` | Local data with explicit source evidence; no registry authority or synthetic "committed" version. |

Minimum error codes: `AUTH_CANCELLED`, `PRF_UNAVAILABLE`, `NO_RECOVERY_MATERIAL`, `MANIFEST_INVALID`, `ENROLLMENT_CONFLICT`, `CONTEXT_MISMATCH`, `CREDENTIAL_MISMATCH`, `UNREGISTERED_ENROLLMENT`, `MANIFEST_BINDING_MISMATCH`, `FRESHNESS_UNAVAILABLE`, `DIGEST_MISMATCH`, `CURRENT_DATA_UNAVAILABLE`, `DECRYPT_FAILED`, `SCHEMA_INVALID`, `WRITE_CONFLICT`, `HEAD_MOVED`, `SESSION_EXPIRED`. A bad mirror is a per-source diagnostic if another valid mirror completes recovery; it must not force premature global failure.

### Mera dependency boundary

The official repository and published npm package were verified as `@category-labs/mera` version `0.2.0` on 26 September 2026. Pin that exact version and resolved integrity in the lockfile, and record any repository commit used. No floating `main`, caret dependency or claim that a docs page is a package pin.

The observed interfaces are:

```ts
getPasskeyPrfOutput({ rpId, credential?, prfSalt?, timeout?, webAuthnClient? })
  // -> Promise<{ credentialId: string, prfOutput: Uint8Array }>
createSecretVaultWithNewPasskey({ rp: { id, name }, user: { name, displayName }, secret })
  // -> Promise<PasskeySecretVault>
parseSecretVault(raw)
  // -> validated PasskeySecretVault
decryptSecretVaultWithPasskey({ rpId, vault })
  // -> Promise<Uint8Array>
```

The lookup API permits credential omission and an explicit 32-byte salt. Both `createPasskeyWithPrfOutput` and creating a new vault may require a fallback assertion; do not promise one prompt for account creation or backup enrollment. Unlock uses a further assertion. Baseline fresh B recovery therefore expects two assertions: lookup, then vault unlock. Measure actual ceremonies, cancellation behavior and fresh-device support. New Mera credential creation uses a fresh user handle; still verify discoverability in the actual supported browser/authenticator combination.

Official API references: [PRF lookup](https://github.com/category-labs/mera/blob/main/docs/src/content/docs/reference/get-passkey-prf-output.md), [new-passkey vault](https://github.com/category-labs/mera/blob/main/docs/src/content/docs/reference/create-secret-vault-with-new-passkey.md), [vault format](https://github.com/category-labs/mera/blob/main/docs/src/content/docs/reference/secret-vault-format.md), [unlock](https://github.com/category-labs/mera/blob/main/docs/src/content/docs/reference/decrypt-secret-vault-with-passkey.md), [existing-secret recipe](https://github.com/category-labs/mera/blob/main/docs/src/content/docs/recipes/use-an-existing-secret.md). These were checked against the upstream documentation; implemented package behavior still needs tests.

## 9. Mandatory A stateless/account and data path

A's account uses its RP and Mera's documented default PRF salt, SHA256(UTF8("mera.prf.salt.v1")). `createPasskeyWithPrfOutput` supplies the primary PRF output; the account is derived using the verified Mera BIP39/BIP32 Ethereum mapping at `m/44'/60'/0'/0/0`. The exact recipe is: interpret all 32 PRF bytes as BIP39 entropy; use the English BIP39 wordlist; use the empty mnemonic passphrase; derive the BIP39 seed, then BIP32 from that seed, then the stated Ethereum path. Preserve these exact choices on fresh login. Separately derive an A lookup key and AES envelope key from that PRF output using HKDF-SHA-256 with the protocol HKDF salt above and distinct info labels `primary-locator` and `primary-record-aes-gcm`. The A locator is base64url(SHA256(UTF8("continuity-kit/v1/primary-locator") || 0x00 || Klookup)); the zero separator is mandatory. It is not B's locator or a wallet secret.

After receiving the final B manifest, A creates exactly one canonical `PrimaryRecord = {format:"continuity-primary/v1", context, manifestDigest, dataKey}`. Encrypt it under the primary envelope key with fresh random 96-bit nonce and canonical AAD `{format:"continuity-primary-index/v1", aRpId, applicationId, locator}`. Store the encrypted exact bytes on both approved mirrors before first registry creation. Only one such immutable record is permitted for the new A credential; retries reuse bytes. The ordinary flow cannot resume a lost unfinished enrollment. New credentials require their own authorization; the narrowly reviewed operator exception in section 5.2 applies only to already persisted exact material after a known pre-signing failure. A localStorage-only data key is not sufficient.

Fresh A uses `getPasskeyPrfOutput` without credential metadata at the same default Mera salt, derives the same address plus its primary lookup/envelope keys, obtains/decrypts the primary record, and checks all context against policy **and the just-derived address against `context.owner`**. The record's manifest digest must match the exact owner/stream registry record. A then performs the same current digest, context, AEAD, schema and final head checks as B using the recovered random data key. No old local state or B authentication is needed for this A path. B recovery never needs the A primary record.

The primary record is encrypted directly with standard HKDF/AES-GCM using the already-returned A PRF material; no additional passkey ceremony is needed just to wrap it. B still uses the required Mera secret vault. A's first durable protected checkpoint follows explicit B setup; do not claim full backup preparation in one onboarding ceremony. Mera's creation fallback can also add an assertion to A account creation, so record physical prompt counts instead of assuming a bounty criterion passed.

Test A while it remains available: clear application storage, reconstruct the **same** address and full private workspace with A's original passkey, establish a visibly scoped expiring signing session and execute a new approved testnet transaction. Record prompt counts and real receipt. A typed signature alone or a local model write does not establish an executed Monad transaction. Sponsor interpretation remains a distinct gate.

For the local browser harness, the topology is A `http://primary.localhost:4173` with RP `primary.localhost`, B `http://recovery.localhost:4174` with RP `recovery.localhost`, and a local service at `http://localhost:4175` for encrypted mirrors and the explicitly simulated registry. Physical A/B enrollment, fresh B recovery of v2 with A unavailable/stale-v1 rejection, and fresh A restoration followed by signed local v3 were observed. The user reports iPhone, Chrome and in-app browser use and mixed single/double confirmations, without a controlled per-flow matrix or counts. Both RPs must have disjoint scope; policy validation rejects identical and parent/child RP pairs. Both mirror slots on one local service model independent corrupt/missing responses, not independent infrastructure availability. Actual T1 chain evidence requires its separately approved setup; the local policy must not silently become a public deployment policy.

## 10. Required tests and falsification cases

Local tests must use fixed synthetic PRF fixtures explicitly labeled as such. Integration tests test observed behavior, not only helper functions. Contract tests use actual deployed local bytecode as well as the in-memory model where appropriate.

| Test | Required outcome |
| --- | --- |
| Fresh B: no prior local state and A unavailable | Automatic lookup/unlock/current content succeeds using only B credential, approved stores and registry. Network trace contains no A request. |
| Fresh A: no prior local state, A available | Original passkey reconstructs identical owner address, authenticates primary record and opens current workspace. Swapped records, wrong owner and wrong context fail. A/B lookup keys and encryption purposes remain distinct. |
| Correct v1 then v2; store returns valid v1 for requested v2 | Never return v1 as current. Other mirror's v2 succeeds; if none survives, `CURRENT_DATA_UNAVAILABLE`. |
| Wrong PRF key/credential, missing index | No plaintext return; distinguish unsupported/cancelled authenticator from absence without inventing a cause. |
| Tamper index nonce/ciphertext or swap another credential's manifest | Authentication fails; good mirror can still complete. |
| Validly shaped alternative owner, stream, chain, address, code hash, app, schema or RP | Reject against authenticated context and trusted policy; never redirect registry/RPC lookup. |
| Forge outer vault credential/salt/nonce/ciphertext | Outer authentication or selected-credential/context checks fail; no foreign credential prompt is initiated. |
| Whole valid foreign vault/manifest/capsule substitution | Fails selected-credential/manifest/registry/context binding, even when objects individually decrypt in their original contexts. |
| Same B credential rebound to another stream; both decryptable manifests | SDK refuses re-enrollment; recovery of differing manifests returns `ENROLLMENT_CONFLICT`. No newest-by-storage-order behavior. |
| Storage hides one of two historical alternate manifests | Demonstrate why this cannot be detected statelessly; enforce the new-credential/one-manifest invariant at enrollment. Do not claim lookup CAS solves it. |
| Attacker copies a valid manifest but changes lookup key | Manifest AAD/derived key check fails. Exact replay at original locator is safe because manifest is immutable. |
| Missing registry, wrong manifest digest, wrong network/code, stale/disagreeing RPCs | Fail without content success or fallback authority. Local tests cannot prove real RPC honesty. |
| Mutate capsule header, nonce, ciphertext or payload type | Digest, context, AEAD or schema validation fails before content return. |
| B forges a new encrypted capsule with recovered data key | Not accepted as current without matching owner-authorized chain digest. |
| Wrong owner writes, duplicate create, zero digest, absent stream, overflow/no-change | Registry reverts; original stream/head is unchanged. A different owner's own stream is not an unauthorized mutation. |
| Two writers share CAS expectation | Exactly one commit succeeds; other retains work and receives conflict. |
| Storage failure before commit, transaction failure after upload | No misleading prepared/saved result; uncommitted blobs remain non-authoritative. |
| Head advances during recovery | Retry within limit or return `HEAD_MOVED`; never silently describe superseded version as current at the final read. |
| Handoff wrong origin/source, reused/expired nonce, reordered messages, popup navigation | Reject/expire; no key delivery to unexpected origin; abort cannot leave "reserve prepared" status. |
| PRF unavailable, cancelled prompt, interrupted creation, expired A session | Controlled UX; no generated secret or newly orphaned credential is claimed recovered/registered. |
| Huge/noncanonical/duplicate-key objects, unexpected fields and encodings | Reject within limits; no implicit coercion or dynamic execution. |
| B local edit/export | Original verified checkpoint evidence remains unchanged; working copy is explicitly local and no A registry transaction occurs. |

Physical H1 proof needs genuinely different RP domains, approved actual passkeys, a fresh supported environment and documented provider/browser/device details. Test on a second supported environment where the B credential actually survives; synchronization of the credential and PRF behavior is an observation, not an assumption. T1 separately repeats the stale/missing-current cases with a real approved Monad deployment and recorded block/receipt evidence. Related Origin Requests alone are not the fallback design because they can depend on the original RP's availability.

The remaining critical gates include controlled cross-environment physical replication and prompt measurements, an approved durable storage/deployment plan, real-chain execution and receipts, and independent developer evaluation. Package/protocol/local tests and the observed physical core are recorded separately in EVIDENCE.md. Passing one gate does not establish another.

## 11. Implementation review resolutions

P2_REVIEW.md and V1_REVIEW.md record the independent AI-assisted findings and fixes. Local registry signatures use canonical bytes of `{domain: FixedContext, ...RegistryCommand}`. The writer privately freezes the entire deployment domain plus owner/stream; no caller-supplied domain or unrestricted signing method is accepted. Every operation checks session expiry, including after asynchronous signing. This is an application-enforced local-model scope, not a Monad transaction or on-chain delegation.

Enrollment installs a per-account intent lock synchronously before asynchronous encryption. Identical concurrent calls share one completion and one exact encrypted primary record; conflicting intentions fail. Checkpoint content is validated and cloned before any await, so the content returned with a digest equals the content encrypted under that digest. The UI serializes required handoff deliveries and disables workspace edits while saving.

Frozen synthetic conformance vector: 32 bytes of `0x2a` produce owner `0xb63b33315674e004adb9c64a7477207841894c97`, primary locator `dZvr_qjgSe4ZwoOQGWjHsPiTEWU65utkp3kOrw05E3E`, and primary envelope key `96533ed89596f01775f54ce05ec667f19df5ea315440acd552d3404a3a37ca42`. These are public test values; the tests independently express the BIP39/BIP32 and HKDF/hash recipe using viem and Node crypto.

## 12. T1 policy and signer integration

`T1_INTEGRATION_DESIGN.md` specifies the detailed implementation contract. Wire `Context` and encrypted v1 objects are unchanged. Runtime policies/evidence discriminate `local-model` from `trusted-rpc-quorum`; the latter supports Monad testnet 10143 only. A chain policy requires its actual registry address, runtime-code hash, two approved HTTPS providers and bounded freshness/transport limits. A reader is bound to its copied policy at construction. Neither stored metadata nor a caller's per-read arguments can substitute a deployment.

The primary account exposes a constrained owner writer backed privately by Mera's signing session and viem adapter. It accepts only exact registry create/commit commands for the bound owner/stream/manifest and full deployment context. Its chain branch signs standard EIP-1559 transactions with zero value and no alternate transaction features. The session is bounded by expiry (at most ten minutes), count (at most three) and a declared full-gas fee budget; the local canonical-message branch remains distinct. Contract deployment is a separate one-transaction capability, not another permitted registry method.

Before signing, both providers must agree on the pending nonce; native gas/fee preparations must fit the fixed limits. Scope and expiry are rechecked across asynchronous steps. The full `gasLimit × maxFeePerGas` budget is reserved before signing, without refunds for uncertain or reverted submissions. Validate signed bytes, sender and hash before a single broadcast. A public ticket stores identity/envelope/hash metadata but no secret or serialized signed transaction. Reconciliation never signs, resends or supplies authorization merely because a ticket was loaded.

Receipt confirmation binds the exact transaction and registry event to a historical block on both providers, checks runtime code, and establishes a fresh common accepted finalized tip. Equal-height receipt and tip evidence must share the same hash. Historical receipts do not expire merely because their blocks are old, but current-head evidence must be fresh. Local time, configured providers and trusted client code remain assumptions; these checks are not a light client or a sandbox against compromised JavaScript.

The shipped browser harness remains explicitly local. Offline fixture tests can exercise real Mera transaction serialization, accepted mocked receipts and the entire A/B protocol, but cannot establish actual Monad finality, public infrastructure durability, native fees or hardware support. No live configuration, account, funding or transaction is authorized by this specification.


## 29 September: separate bounded public-demo candidate

The wire protocol, key derivation and contract remain unchanged. `src/release/profile.ts` defines a separate build-time HTTPS policy with exact disjoint A/B RPs, pinned testnet registry/RPCs and capped sessions. A presenter capability authorizes encrypted storage writes; it never authorizes registry operations and is not sent to B. The shared HTTP adapter accepts an optional per-write header provider; ordinary local callers keep their previous behavior. `src/release/store.ts` exposes immutable encrypted-object routes and a read-only presenter check, using the quota migration in `migrations/0001_demo_objects.sql`. Both slots share one database/operator. Expiry stops access without promising deletion. `release/README.md` describes the remaining hosting/native limits. This local implementation does not authorize publication, new credentials or further transactions.
