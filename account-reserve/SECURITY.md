# Experimental authority and trust model

This is not an audited custody, wallet recovery or production payment service. It wraps one already-derived EOA key in a separately versioned reserve protocol. It does not rotate or revoke the original signer. A malicious or compromised reserve client can use the full underlying EOA authority, even though the reference UI exposes only one bounded test action.

## Trusted inputs and stored material

- The integrating developer supplies fixed app ID, original RP, reserve RP and derivation identifier in trusted client configuration.
- At preparation the existing key is checked against the expected original account. The original app transfers one binary leaf key once through an origin/window/nonce-bound MessageChannel. It is never placed in a URL, DOM, browser storage or server request.
- B uses a discoverable passkey PRF operation for an app-specific bootstrap. HKDF separates opaque lookup material from manifest encryption. An authenticated encrypted manifest binds the selected credential, complete fixed configuration, owner and actual Mera vault. The vault contains a separately bound binary key envelope.
- Store responses cannot choose RP, RPC URL, executable code or contract. Decryption, binding checks and key-derived owner verification precede any usable signer.
- Readiness requires exact ciphertext readback, a fresh public recovery call, verification of a fresh challenge signature and signer closure.
- Mutable plaintext buffers are wiped best effort. JavaScript strings, library internals, garbage collection, copied bytes and compromised execution environments prevent a guaranteed-erasure claim.

## Original-app disappearance

B's recovery path must never call A. Chain state and B's credential, code and encrypted store still have to survive. Local A and B share an operator, process and machine; disabling A's routes proves only an application/API outage. It is not independent infrastructure survival. A production architecture needs a separately available client and durable replicated storage with a tested deletion/lifetime policy.

## Enrollment limitations

One newly dedicated B credential and app namespace bind once. Conditional storage creation and a local attempt latch prevent ordinary overwrites and blind retries. A store that hides previous records can defeat a global "never enrolled before" assertion; the protocol makes no such global claim. Never reuse a failed/missing credential to bind another account. A different credential may discover a different valid reserve. The UI must make the recovered original account and its actual rights visible before any action.

Native requests receive a cancellation signal and bounded deadline. Cancellation clears SDK-owned byte buffers and rejects late results; JavaScript and platform internals may retain other copies, so this is not guaranteed physical memory erasure. Cancellation/expiry cannot undo an already-completed credential creation or store write. Ambiguous preparation ends with an existing-reserve check, not another hidden creation. A fresh recovery may succeed after an interrupted setup, but no ready status is claimed until independently verified.

## Transaction boundary

The local demo accepts only chain 31337, one deployed test contract, `claim(uint256)`, zero transaction value and bounded gas/fees. A pending attempt is reserved under a Web Lock; public metadata (chain, contract, account, right and transaction hash) is retained in localStorage before broadcast. There are no keys or signed transaction bytes in that ticket. Fresh same-origin tabs and reloads reconcile the ticket rather than signing a second transaction. Missing reliable browser locking or storage failure stops signing/broadcast. A pre-hash interrupted reservation stays blocked for manual reconciliation. This safeguard requires retained storage in the same browser origin; it is not shared across other devices and does not survive deletion of that storage. The contract fixes the beneficiary and rejects unrelated owners and duplicate claims. UI restrictions do not cryptographically reduce the recovered EOA's authority.

The synthetic issuer, local gas funding and synthetic authenticator endpoints exist solely in a loopback fixture. **Do not deploy server.mjs to the public Internet.** It is not a public relayer or credential service. Native WebAuthn mode disables the synthetic credential endpoints. No real keys or funds belong in either mode.

## Unproved or unsupported

The reusable `/browser` controllers preserve the same origin/source/nonce-bound
handoff. They validate the original key/owner pair before opening setup, transfer
only an owned temporary copy, and resolve ready only after the core independently
reopens and signs. Cancellation wipes owned buffers best effort; it cannot undo
a completed credential creation or immutable write. The caller must still close
its original signing session and clear its own key copy.

The `/http-store` adapter restricts paths to the same origin and bounded records;
one capability permits at most one attempted PUT per adapter instance. Real
write-once enforcement belongs to the server. The starter's single-process RAM
server is a teaching fixture, including its intentionally synthetic PRF oracle.
Never deploy that server or use it with valuable accounts. `/preflight` checks
are static presence/configuration checks, never physical PRF or durability proof.

- Broader physical passkey/PRF support, direct iPhone webpage recovery and separate browser profiles. One native fresh-tab local run succeeded on 8 October; the user reported five setup confirmations. This is not universal compatibility or a one-prompt claim.
- The optimized enrollment path has not been physically tested. A bounded public native recovery and one claim completed on Monad testnet on 8 October with Primary version 3 / Reserve version 2; the later enrollment optimization is published as Primary version 4 / Reserve version 3. The historical proof does not establish a lower system-prompt count for that update. See [the portable public proof](evidence/public-proof.json).
- Compromised-signer recovery, EOA revocation, P256 smart accounts, provider portability after losing the B credential/RP, or storage-independent recovery.
- Independent audit, formal verification, customer adoption, willingness to pay or promised prize eligibility.

The previous data-only ContinuityKit public proof does not establish these new properties. No legal immunity follows from a technical test or an experimental disclaimer.
