# ContinuityKit

## Current submission direction: Work Reserve

Recover prepared private work when its original app is unavailable. Open the brief, finish the draft and export a usable copy with an existing recovery passkey. Account signing stays locked throughout the Work task.

Try the [interactive playground](https://continuitykit-playground.cryptomickle.chatgpt.site/) first: edit a fictional draft, prepare it, recover it, finish it and export it. No setup code, wallet or native passkey is needed. This runs the actual Work SDK encryption with browser-local synthetic credentials; it is not physical-passkey, cross-device or HTTP-outage proof.

Read the [current Work Reserve source and commands](account-reserve/README.md) and [judge guide](account-reserve/delivery/JUDGE_GUIDE.md). The guide separates the playground, the [recorded physical Work result](account-reserve/evidence/work-public-proof.json), and the [finished fictional handoff](account-reserve/delivery/examples/finished-checkout.txt). The hosted physical demonstration uses bounded encrypted D1 storage and an existing prepared passkey.

Reproducible source examples include a [Textarea editor adapter](account-reserve/integrations/textarea/README.md), a [controlled comparison with encrypted export](account-reserve/drill/README.md), and an [optional pre-existing payment through the same recovered account](account-reserve/examples/work-entitlement/README.md). The Textarea adapter is written by this project against independently authored MIT source, not external adoption or endorsement. The payment example runs only on disposable local Anvil: work opens without account signing, and a separate deliberate action may claim a previously issued right. Editing or exporting work does not earn that right. These additions do not replace the separately attributed historical physical proofs.

The [9 October core Work snapshot](https://github.com/CryptoMickle/continuity-kit/tree/3e3093456ebbf7765e40967b83b120a1cbc54b97/account-reserve) and [8 October Account Reserve snapshot](https://github.com/CryptoMickle/continuity-kit/tree/fdfd817176c87a760cd026f95bb449aad4d57195/account-reserve) remain preserved historical references. Use the current relative source links above for the newer examples.

This is one immutable prepared snapshot, not automatic backup or synchronization. Later edits need their own export. The services share one operator; shared-provider failure, loss of the recovery passkey, independent security and customer demand remain unproven. Mikkel / CryptoMickle is the sole human builder, assisted by OpenAI Codex and GPT agents.

The earlier Account Reserve implementation and its [Monad testnet proof](account-reserve/evidence/public-proof.json) remain separately attributed supporting work: a recovered account claimed an existing payment once. The Work demonstration uses fictional data and an unfunded example account, and sends no blockchain transactions. Original source is MIT-licensed; the SDK is not published on npm. Video and final competition submission remain deferred.

## Earlier content-recovery prototype
Recover private application work through a separately prepared client, and detect when a surviving copy does not match the owner's approved checkpoint.

ContinuityKit is an experimental TypeScript SDK with a reference workspace app. Mera supplies passkey PRF and encrypted-vault operations. A Monad-testnet registry records owner-authorized versions and digests. Saving an approved checkpoint writes to the registry; recovery reads it without making a transaction.

## Try the SDK in a separate application

Use Node 24+ and npm. These commands install locked dependencies, build a private local package, and test an application that imports that package through its public exports:

```sh
cd continuity-kit
npm ci --ignore-scripts --no-audit --no-fund
node delivery/source-candidate/verify.mjs
npm run build:sdk
npm run verify:sdk
```

Verification defaults to npm's offline cache. If a dependency is absent, use `npm run verify:sdk -- --allow-downloads` to permit public dependency downloads during installation. Runtime fetch remains disabled in this synthetic consumer. The package is not published to npm.

The standalone project-journal example saves a corrected decision, skips an unchanged snapshot, closes the primary session, then recovers exact v2 through the recovery reader. It rejects an authentic stale copy and fails explicitly when all current copies or current-version evidence are unavailable. It uses public synthetic credentials and a local in-memory registry: no accounts, physical passkeys, private contents or blockchain transactions.

[SDK installation and API guide](continuity-kit/delivery/SDK_PACKAGE.md) · [Standalone consumer](continuity-kit/examples/standalone-consumer/README.md) · [Integration boundaries](continuity-kit/INTEGRATION.md) · [Encrypted-export comparison](continuity-kit/BACKUP_COMPARISON.md)

The other examples and full JavaScript/TypeScript checks are available with:

```sh
npm run demo:passport
node delivery/sdk-example.ts
npm run check
```

The complete suite includes optional real-Redis integration groups. To run those, set `REDIS_SERVER_BIN` to a locally installed Redis binary; otherwise those groups are explicitly skipped. Tests use disposable local data and sockets. Solidity tests require Foundry separately. [Browser trial and release build instructions](continuity-kit/README.md).

## Demonstrated behavior and boundaries

- The 5 October internal clean-directory trial installed dependencies from the lockfile, built and installed the SDK tarball in a separate consumer, checked its public types in NodeNext and Bundler modes, and ran both source examples. Its full application check passed 300 tests with zero skipped, typechecking and the UI build. The final selected source preserves those code, test and dependency bytes; its later changes are documentation and export selection. This is an internal engineering evaluation, not independent adoption or a security audit.
- The same application source reproduced all 17 artifacts of the frozen 3 October release candidate byte for byte using its original profile and existing locked dependencies. Source manifest identity and runtime artifact comparison are separate checks. A local rebuild does not deploy anything or repeat a physical test.
- The separate public demonstration completed v1 and corrected-v2 Monad-testnet writes, existing-primary restoration and fresh recovery on 3 October. An iPhone observation showed the same corrected content using the instructed existing-key flow. It required two confirmations in that reported run.
- On 5 October, successful controls showed Primary's root and application asset returning HTTP 503 while Recovery remained available. The user's iPhone success screenshot arrived between those controls. A later screenshot of the same already-open copy, supplied after Primary was restored, showed the exact v2 marker. This is bounded screenshot-supported outage recovery, not a continuous ceremony or network trace, certified fresh profile, universal-device proof or sponsor acceptance.

The separate demonstration is hosted at [Primary](https://continuitykit-primary.cryptomickle.chatgpt.site) and [Recovery](https://continuitykit-recovery.cryptomickle.chatgpt.site/?mode=physical). It uses example content and bounded presenter access; new public enrollments are not open to arbitrary visitors. Configured access ends on 10 November 2026 at 00:00 UTC. This cutoff does not delete stored copies, stop billing or guarantee availability until then.

Recovery needs prior preparation, a surviving recovery credential, authentic encrypted metadata/current bytes and the configured registry/RPC trust assumptions. It cannot recreate missing bytes, restore the primary wallet's authority or establish the truth of content. The two public storage slots share one database/operator. The outage test demonstrates recovery during Primary-host loss; it does not establish survival after loss of all operated services.

No external integrator, customer adoption, revenue or recurring transaction demand is documented. Production operations, independent storage durability, key-loss/rotation and host identity integration remain work for a real deployment.

## Implementation

- [Recovery SDK](continuity-kit/src/sdk/index.ts) and [protocol](continuity-kit/src/sdk/protocol.ts)
- [Host integration contract](continuity-kit/delivery/SDK_INTEGRATION_CONTRACT.md)
- [Passport payload example](continuity-kit/examples/passport-recovery/adapter.ts)
- [Registry contract](continuity-kit/contracts/src/ContinuityRegistry.sol)
- [Encrypted store adapter](continuity-kit/src/release/redis-store.ts)

## Attribution and source

Mikkel / CryptoMickle is the sole human developer. OpenAI Codex and GPT agents assisted design, code, tests, documentation and review. Original project source is under the supplied [MIT license](LICENSE); dependencies retain their own licenses. The passport example references Turnstile's public data model but does not integrate its identity layer or imply endorsement.

[Provenance and preserved history](PROVENANCE.md) · [Dependency notices](continuity-kit/public/third-party-notices.txt) · [Exact selected source manifest](continuity-kit/SOURCE_MANIFEST.json) · [Publication file list](PUBLICATION_FILES.json)


