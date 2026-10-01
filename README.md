# ContinuityKit

Recover private app work through a separately prepared client, and check that a surviving copy matches the owner's approved checkpoint.

ContinuityKit is an experimental TypeScript SDK with a reference workspace app. Mera supplies passkey PRF and encrypted-vault operations. A Monad-testnet registry records owner-authorized versions and digests; recovery reads the registry and does not make a transaction.

## Try it locally

Requirements: Node 24+ and npm. These commands use public synthetic fixtures, without accounts, physical passkeys, funds or blockchain transactions:

```sh
cd continuity-kit
npm ci --ignore-scripts --no-audit --no-fund
node delivery/source-candidate/verify.mjs
npm run demo:passport
node delivery/sdk-example.ts
npm run check
```

The example corrects a note in v2, loses the primary session, recovers from a fresh B client and rejects an authentic old copy. Missing current bytes and an unavailable registry fail explicitly. [Browser trial and build instructions](continuity-kit/README.md) · [Integration boundaries](continuity-kit/INTEGRATION.md) · [Encrypted-export comparison](continuity-kit/BACKUP_COMPARISON.md).

## What is demonstrated

The 1 October source snapshot passed 264 JavaScript/TypeScript tests, typechecking, a clean-directory build and both synthetic examples. It reproduces the 28-file local hosting candidate. A separate 28 September physical run recorded v1/v2/v3 writes on Monad testnet, fresh B-v2 recovery with A offline and stale-v1 rejection, then fresh A-v3 continuation. Enrollment required operator repair and both copies shared one local service.

Public hosting and a controlled same-B-passkey second-client demonstration remain unproved. No independent integration, customer adoption, revenue or recurring transaction volume is claimed. This is not production backup infrastructure or an independently audited product.

## Implementation

- [Recovery SDK](continuity-kit/src/sdk/index.ts) and [protocol](continuity-kit/src/sdk/protocol.ts)
- [Passport payload example](continuity-kit/examples/passport-recovery/adapter.ts)
- [Registry contract](continuity-kit/contracts/src/ContinuityRegistry.sol)
- [Bounded encrypted store](continuity-kit/src/release/store.ts) and [generated migrations](continuity-kit/release/database)

Recovery requires prior preparation, a surviving recovery credential, authentic encrypted metadata/current bytes and the configured registry/RPC trust assumptions. A signed old backup can be authentic without being current. The registry cannot recreate lost bytes, restore A's wallet authority or establish the truth of the content. Two storage slots in one database do not provide independent infrastructure.

## Attribution

Mikkel / CryptoMickle is the sole human developer. OpenAI Codex and GPT agents assisted design, code, tests, documentation and review. Mera and other dependencies retain their own licenses; original project code is under [MIT](LICENSE). See [provenance](PROVENANCE.md), [dependency notices](continuity-kit/public/third-party-notices.txt) and the exact [publication file list](PUBLICATION_FILES.json). The passport example references Turnstile's public data model; it does not integrate that project's identity layer or imply endorsement.
