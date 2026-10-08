# Local payment-right fixture

This owned fixture runs only on disposable loopback Anvil, chain `31337`. Its native
test units have no economic value. It neither deploys to Monad nor connects to any
public RPC. It is not a production escrow, recovery contract, or security audit.

An ephemeral local issuer locks synthetic native units for a fixed beneficiary.
Only that beneficiary can claim, exactly once. The original beneficiary address
discovers the right through the contract's `rightForOwner` mapping; recovery does
not need the primary browser's stored right identifier. New unrelated accounts
cannot claim existing rights.

`startLocalChain()` from `harness.mjs` returns:

- `chainId`, `rpcUrl`, `contractAddress`, `abi`, `employerAddress`, `deploymentHash`.
- `prepareRight(owner, { amount? })`: create one funded right, or return the
  existing one for that owner. Default `amount` is `1000000000000000n` synthetic
  native base units. A repeated request with another amount is rejected.
- `readRight(id)`: `{ id, beneficiary, amount, claimed }`, with bigint values.
- `rightForOwner(owner)`: the same record, or `null` if no right exists.
- `claimReceipt(hash)`: mined receipt status and decoded claim events.
- `rpc(method, params)`: internal local RPC only. Do not expose this unfiltered to
  a browser; the caller must enforce a method/contract allowlist.
- `close()`: terminate the disposable child process; safe to call twice.

Preparing a fixture explicitly funds the beneficiary with one synthetic local
native unit for gas. This is test scaffolding, not a wallet funding feature. The
issuer key is generated in memory, never returned, logged, or written to disk.
Anvil starts with `--accounts 0`; there is no unlocked default-account list.

The contract test proves escrow conservation, discovery, named rejection of an
unrelated claimant, issuer-only preparation, one exact native transfer, and
duplicate-claim rejection.

The account-reserve test separately exercises Iris-style and Accrue worker-style
derivations through the actual Mera and scure APIs. It issues the funded right
before reserve preparation, ends the original signing session, wipes the retained
source leaf, and verifies that restoring through the disabled original credential
fails. A fresh SDK client then discovers the encrypted reserve without an owner or
locator hint, restores the same EOA, discovers the existing right on the local
chain, and claims exactly the owed native amount less gas. An unrelated signer
and a second claim are rejected. Its machine-readable result is
`reserve-claim-evidence.json`.

These are independently composed source-inspected derivation fixtures and a
synthetic RAM authenticator. They are not integration into Iris or Accrue, physical
passkey validation, independent operators, a public chain test, or a security
audit. The source outage is simulated by disabling the original credential client;
the original sites are not contacted.

Run from the package directory:

```sh
node --test tests/chain-local.mjs tests/chain-reserve.mjs
```

The checked-in artifact is produced from this directory's own Solidity source.
Rebuild with installed Foundry (`forge`, Solidity `0.8.30`):

```sh
node chain/build.mjs
```

`CONTINUITY_ANVIL` and `CONTINUITY_FORGE` may select installed binaries. Neither
setting is an RPC URL. Runtime verifies the artifact's source digest before use.
