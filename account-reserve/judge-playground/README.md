# Interactive judge playground

A fictional browser-local walkthrough using unchanged ContinuityKit Work SDK encryption.
It requires no native passkey, wallet, testnet balance or setup code. All example keys and
ciphertext stay in memory; reloading or starting again discards the session.

```sh
npm ci --ignore-scripts
npm run dev
```

Build with `npm run build`. Use Node 24+. This directory is a standalone static application.
The root tests compare both vendored SDK files byte-for-byte with their canonical sources.
Mera 0.2.0 and viem 2.56.9 are pinned in the lockfile. ContinuityKit is MIT-licensed;
third-party packages retain their own licenses.

Change a line, prepare, discard the original in-memory draft, open a fresh SDK context,
continue editing and export TXT or JSON. The damaged-copy control alters ciphertext in a
separate reader and runs actual verification against it; the stored original stays intact.

This proves the browser can run the crypto and work flow. It does not prove physical
passkeys, multiple devices, an HTTP outage, independent hosting, or production security.
The example account has no funds or chain connection. Preparation verifies that account;
subsequent work recovery never opens its signer. The physical Work and separate Monad
account results are linked with their evidence boundaries.
