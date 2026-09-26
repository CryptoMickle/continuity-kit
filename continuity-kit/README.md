# ContinuityKit

Private application work should have a way back when its original app disappears.

ContinuityKit prepares a separate recovery passkey on a second origin, stores encrypted checkpoints, and checks an owner-authorized version registry before opening a copy. A valid old copy is not accepted as the current one. If the latest bytes are gone, the app says so.

**Current status:** working local prototype and reviewed SDK. Physical A/B enrollment, fresh B exact-v2 recovery with A offline/stale-copy rejection, and fresh A restoration followed by signed local v3 all passed. The user reports iPhone, Chrome and in-app browser use; a controlled compatibility matrix and exact prompt counts remain unmeasured. No Monad deployment, transaction, external integration or prize eligibility is claimed. The browser demo uses a signed local registry model. See [EVIDENCE.md](EVIDENCE.md) and [PROJECT_STATE.md](PROJECT_STATE.md).

## Run the local demo

Requirements: Node 24 or later and npm. Solidity tests additionally use Foundry; the local run used 1.7.1 and solc 0.8.28. No account, wallet extension, API key, funds or remote service is needed for the synthetic demo.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

Open **http://primary.localhost:4173**. The independent recovery client is **http://recovery.localhost:4174**. The encrypted stores and signed registry model use **http://localhost:4175**. All services bind to `127.0.0.1`. Different ports alone are not separate passkey RP IDs; these clients use sibling hostnames and disjoint RP scopes.

Use **Create demo account**, then **Open recovery setup**, then **Prepare simulated reserve** in the recovery window. That flow uses the real Mera vault library with explicitly synthetic, public PRF fixtures. It does not create physical passkeys. The popup must remain open for the origin-checked handoff.

For a reproducible recovery-only demo when popup automation is unavailable, run this once while the local service is running:

```sh
npm run demo:seed
```

This creates the same public synthetic fixture, including v1, directly through the SDK and HTTP adapters. It deliberately bypasses the browser enrollment handoff and is **not evidence that that handoff or physical WebAuthn works**. If the fixture is already enrolled, use **Restore primary** instead of creating another enrollment. The immutable record must not be rebound. The public fixture seed makes its content public in practice; use sample text only.

## Reproduce the useful failure

1. In A, choose **Restore primary from a fresh session** if using the seed helper. The original account and private workspace reconstruct from the fixture credential and encrypted stores.
2. Change the draft and **Save checkpoint**. Confirm v2.
3. Choose **Take primary offline**. A now returns HTTP 503, including its pages and application source requests.
4. Open a fresh B client, or use **Discard this session & reload** there. No key, credential ID, owner address or recovery file is entered.
5. Select **Mirror 1 serves an old valid copy** and recover. B rejects v1 and opens v2 from the other mirror. Inspect its receipt.
6. Select **Both mirrors serve an old valid copy**, then recover again. B refuses to display it as current. **Latest bytes unavailable** exercises explicit absence.
7. Select **Registry unavailable**. B refuses to label a copy current even if encrypted bytes survive.
8. Return the condition to **Both copies healthy** and **Bring primary back**.

Edits in B create a local working copy. **Export local copy** deliberately downloads plaintext content with its source receipt. It does not change the registry or recover the A wallet's authority.

The service's two mirrors occupy one local process and disk. They simulate independently faulty responses; they are not independent hosting providers or a durability guarantee. Controls affect this local demonstration only. The loaded A page can still display its in-memory contents after shutdown, so use a new B session and check A's HTTP 503 rather than treating a still-open tab as a server response.

## Physical test — one local recovery verified

On 26 September 2026, the completed physical enrollment produced v1 and a subsequent save produced v2. With A returning HTTP 503 and its old tab closed, fresh B used the prepared recovery passkey to discover its metadata, reject the same stream's stale v1 and open the exact v2 content. The [saved receipt](evidence/physical-recovery-receipt.json) identifies the physical owner/stream and local-model evidence. After A was enabled again, a fresh A tab restored the exact same content and signed v3 on the same owner/stream/manifest; see the [v3 local head](evidence/physical-primary-v3-head.json). These are physical local-model results, not a controlled device matrix or real-chain proof.

The user approved creating test passkeys for these two local RPs on the Mac/iPhone setup. Authentication and biometric prompts are completed by the user. Start physical mode explicitly:

```sh
npm run dev -- --physical
```

Physical mode disables automatic hot reload; restart the local service after code changes.

Open **http://primary.localhost:4173/?mode=physical** and choose **Create primary passkey**. Keep A active and complete its device prompt, including any additional verification prompt after saving the credential. When A confirms the account is ready, choose **Open recovery setup**. In that new window, choose **Create recovery passkey** and complete B's prompts. Do not independently recreate the enrollment window: its `opener`, origin and session nonces bind the handoff.

Both clients must confirm preparation before relying on the reserve. Account creation may require a fallback assertion; B setup includes a separate PRF lookup. Fresh B recovery normally requests lookup and vault unlock. Record actual device prompts; a successful API call does not establish a one-prompt UX or cross-device PRF synchronization.

If enrollment is interrupted before confirmation, the newly created passkey may remain on the authenticator without a completed recovery profile. An interrupted attempt was observed during development; the user reported saving its A passkey on iPhone. It is not evidence of a working backup. Do not delete user credentials automatically or silently rebind an old credential. A new attempt uses new, timestamp-labeled credentials.

Physical protocol checklist:

- Record browser/version, macOS/iOS versions, credential provider and actual create/assertion prompts; never record biometric data or secrets.
- Finish A/B enrollment; save v2; close old sessions; turn A off; freshly open B using its surviving credential.
- Repeat stale-one, stale-both, missing-current and unavailable-registry cases.
- While A is available, freshly restore its same address **and full content** with A's passkey. A real Monad transaction is a separate future gate.
- Repeat on a second supported environment that actually has the B credential. Do not infer sync/PRF support from the first device.

The localhost test does not demonstrate separately hosted HTTPS domains. That deployment needs its own concrete approval and policy.

## SDK and trust boundaries

The SDK lives under `src/sdk/`; it has no UI dependency. `src/main.ts` is a small demonstration shell hosted on both origins. The B recovery path uses only the recovery credential, policy, mirrors and registry; it does not request A or receive its signer. A developer can import the recovery functions without importing this demo shell.

```ts
import {
  MeraPasskeyAdapter, HttpMirrorStore, HttpRegistry,
  LOCAL_POLICY, discoverRecovery, recoverCurrent,
} from './src/sdk/index.ts';

// This policy and registry are explicitly local-model only.
const adapters = {
  mirrors: LOCAL_POLICY.mirrorUrls.map(url => new HttpMirrorStore(url)),
  registry: new HttpRegistry(LOCAL_POLICY),
};
const passkeys = new MeraPasskeyAdapter(); // No credential is created on construction.
// Call after an explicit user gesture on the configured B origin.
const discovered = await discoverRecovery(LOCAL_POLICY, passkeys, adapters);
const result = await recoverCurrent(discovered, passkeys, adapters);
// result includes validated content and the exact accepted version/digest evidence.
```

`createPrimary(policy, passkeys, primaryAdapters)`, `prepareBackup`, `finalizeEnrollment`, `saveCheckpoint` and `restorePrimary` implement the A/enrollment path. A needs explicitly typed primary adapters; B needs only mirrors and a policy-bound reader. `finalizeEnrollment` returns `prepared` or `pending`. `saveCheckpoint` returns `saved`, `superseded` or `pending`; callers must inspect the status before updating the editor or claiming a successful checkpoint. `createLocalCopy` and `exportLocalCopy` preserve source evidence. The high-level protocol and format are in [SPEC.md](SPEC.md). A sample alone does not supply the required cross-origin enrollment state machine.

The default Mera adapter uses browser WebAuthn. `SyntheticWebAuthnClient` is a separate, explicitly named fixture. No automatic unsupported-PRF fallback turns physical authentication into a simulation.

The SDK has distinct local-model and Monad-testnet policy/evidence types. `MonadRegistryReader` and `HttpTransactionTransport` require an explicit, complete deployment policy; no testnet address or live write configuration is enabled in the demo. Primary account objects expose a constrained writer, never Mera's unrestricted signer. The writer pins owner, deployment, stream, methods, zero value, expiry, transaction count and full-gas fee budget. It reconciles uncertain submissions by hash and validates finalized transaction/receipt/state evidence. These paths passed local synthetic tests and a separate bounded review; actual Monad deployment and physical chain evidence remain separate gates. See [testnet runbook](testnet/RUNBOOK.md) and [deployment proposal](testnet/DEPLOYMENT_PROPOSAL_NO.md). Signed local-model commands are not Ethereum transactions.

## Verification

```sh
npm run check
cd contracts
forge test -vv
forge fmt --check
forge build --sizes
```

The JavaScript suite includes cryptographic round trips and adversarial integration cases, origin/nonce handoff tests, and a real loopback HTTP service test. The latter needs permission to bind a local port in sandboxed environments. Solidity tests include owner/stream isolation, exact CAS, fuzz cases and a stateful invariant campaign.

Mera 0.2.0, viem 2.56.9, TypeScript 5.9.3 and Vite 8.3.1 are pinned; `package-lock.json` locks the dependency tree. Native Web Crypto supplies AES-GCM, HKDF and SHA-256. The account mapping follows the documented BIP39/BIP32 recipe and independent conformance tests. Passing these checks is not a security audit.

The local service persists only encrypted objects and public registry metadata under ignored `.local-state/`. Signing keys and plaintext drafts remain in memory. Explicit plaintext export is the exception. No analytics, plaintext key logging, wallet transfer controls or production credentials are used.

## Deliberate limitations

Recovery requires prior enrollment, a surviving B credential and authentic index/current blob copies. It cannot recreate missing bytes, revoke a copied data key, recover A's wallet authority, or discover a user's globally newest enrollment from untrusted storage. One fresh credential pair maps to one immutable stream. Trusted delivered client code and authenticator behavior are assumptions. Browser memory cannot promise complete secret erasure. A registry/RPC view supplies a stated trust assumption, not a light-client proof.

The staged competition package is in `delivery/`. No public repository, deployment, video, external message or submission has been made. Personal liability under competition terms remains a separate unresolved question; neither a nonfinancial prototype nor an MIT license removes those obligations.

## AI assistance and provenance

Mikkel is the sole planned human developer. OpenAI Codex and GPT agents assisted protocol design, implementation, tests, documentation and review. The separate reviews are AI-assisted and are not independent security audits. This isolated product source was created locally on 26 September 2026; no Delveworn or Market Dungeon source/assets were copied into this implementation. Earlier research informed its design. The published build-window and substantial-majority requirement must still be checked against the final submitted commit history.

Dependencies retain their own licenses and notices. ContinuityKit's local MIT license applies to its original source; it does not relicense Mera, viem, scure or development tools. Exact dependency versions and integrity values are in package-lock.json.

[Third-party notices](public/third-party-notices.txt) preserve original license texts for 22 installed dependency package/version entries. The [source inventory](delivery/DEPENDENCY_LICENSES.md) records paths and hashes and distinguishes development tooling. It is conservative dependency coverage, not a claim about exact bundled code or a completed project-rights/legal review.
