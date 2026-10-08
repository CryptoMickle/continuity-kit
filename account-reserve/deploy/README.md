# Unpublished testnet candidate

This directory is separate from the existing local 31337 chain artifact and
executor. It contains an owned test-only `PaymentRight` source, pinned Solidity
0.8.30/Paris compiler profile, creation bytecode, immutable issuer locations, and a
local proposal builder and bounded operator. Proposal construction stays offline;
only the explicitly invoked operator can reconcile with or execute against the
two fixed public testnet RPCs. No faucet, hosting or credential creation is included.

Rebuild using the already installed/cached Foundry compiler:

```sh
node deploy/build.mjs
```

The build uses `forge --offline`. Its artifact includes source/settings hashes,
creation-code hash and runtime template. `proposal.mjs` patches the immutable
issuer to derive the exact candidate runtime hash and predicts CREATE address
from the supplied public issuer/nonce. These remain predictions until checked
against an actual approved deployment. Build output has no timestamps and is
reproducible with the pinned compiler/settings/source.

Copy `proposal-input.template.json` to a new local file and fill only the four
public fields after identifying the actual actors. Null template values are
deliberately invalid; no example address is passed off as an existing account.

```sh
node deploy/proposal.mjs --input /path/to/public-input.json --out /path/to/new-proposal.json
```

The output file must not exist. No nonce, balance, provider, fee, permission,
credential or public origin is verified by this command. Public origins,
namespace and expiry remain explicitly unfilled in its release profile.
Its `enabled:false` flag fails closed. Filling or toggling configuration is not
user authorization; deployment and execution require the separately approved scope.

Four proposed transactions are fixed: deploy; fund the beneficiary with 0.06
test-MON for gas; lock 0.10 test-MON for that beneficiary; claim the same right once
through the recovered signer. Gas ceilings are 1,000,000/30,000/300,000/300,000;
max fee 200 gwei; priority cap 2 gwei. Maximum total fees are 0.326 test-MON. Issuer
starting coverage is 0.426 test-MON. Sum of every transaction's fee and value is
0.486, which also counts the transferred gas budget again as the beneficiary fee.
All are proposed ceilings, not observed costs or authorized spending.

The proposal includes exact call bytes and read-only estimate templates. Later
templates depend on preceding confirmed state. Actual gas must be freshly
estimated with an explicit ceiling and a 20% margin, inside all caps. Current
funds/fees and contract compatibility on public Monad remain unverified. Old
deployment/testnet authorizations do not transfer to this candidate.

Local proof:

```sh
node --test tests/release-chain.mjs
```

It starts an owned loopback Anvil process with no default unlocked accounts and
Paris hardfork, using numeric chain ID 10143 only to exercise the candidate
envelopes. It explicitly funds an initially empty beneficiary through the proposed
gas transfer, deploys and checks issuer-patched runtime, prepares a synthetic
Mera reserve, disables the original credential, recovers the same signer and
claims once. It stops that child afterward. `local-validation.json` records local
results; numeric chain ID 10143 is **not** evidence of any public Monad activity.


## Bounded setup operator

`operator.mjs` executes only the first three proposal transactions, one explicitly
selected role at a time. It requires an exact proposal rebuilt from the current
candidate artifact, two injected clients, an issuer signer, a durable journal,
and explicit approval bound to the SHA-256 of the complete proposal. The claim
remains in the recovered-beneficiary executor. Actual Primary/Recovery origins,
namespace and the resulting beneficiary must first be established in a separately
approved credential ceremony before constructing the final transaction proposal.
A locally generated example beneficiary cannot stand in for that account.

`operator-runner.mjs` is the concrete public binding. Its default is local
inspection; the following commands require no signer and cannot broadcast:

```sh
node deploy/operator-runner.mjs --proposal /path/to/proposal.json --journal-dir /path/to/protected-tickets
node deploy/operator-runner.mjs reconcile --proposal /path/to/proposal.json --journal-dir /path/to/protected-tickets --role deploy
```

Inspection performs no RPC requests and creates no journal directory. Reconciliation
uses the two fixed RPCs but only reads state. It accepts `deploy`,
`fund-beneficiary-gas` or `issue-fixed-right`; it never signs, rebroadcasts, replaces,
auto-retries or clears an attempt. The fixed transports disable HTTP retries,
redirect following and CCIP Read. No command accepts an alternative URL or chain.

Public execution is still unapproved and has not been run. A future explicit
approval file must contain exactly these fields, using the `proposalHash` returned
by inspection and a canonical ISO expiry within 24 hours. This example is
intentionally invalid until the concrete user approval exists:

```json
{
  "format": "account-reserve-operator-approval/v1",
  "proposalHash": null,
  "network": "public-testnet",
  "rpcUrls": ["https://testnet-rpc.monad.xyz", "https://rpc-testnet.monadinfra.com"],
  "roles": ["deploy", "fund-beneficiary-gas", "issue-fixed-right"],
  "expiresAt": null,
  "approvedByUser": false
}
```

Setting `approvedByUser` is a caller assertion, not an approval workflow or proof
of human consent. Do not manufacture this file from local implementation approval.
After concrete approval, an operator must explicitly invoke one step:

```sh
node deploy/operator-runner.mjs execute --proposal /path/to/proposal.json --journal-dir /path/to/protected-tickets --role deploy --approve-exact-proposal --approval /path/to/approval.json --signer /path/to/issuer.secrets.json
```

The explicit issuer file must be an owned, single-link regular file with mode
0600, not a symlink, containing only `{"privateKey":"0x..."}`. Never place it in
the repository, command line, environment or publication package. The runner
validates exact approval before opening that file. It does not generate keys,
search default locations or read environment credentials. A persisted attempt
avoids opening the signer at all. JavaScript does not provide guaranteed erasure
of key material from process memory; this is a testnet operator binding.

Each step checks fresh matching numbered blocks from both fixed providers while
allowing ordinary head advancement and provider lag. It checks chain, account
code, nonces, runtime, issuer, empty right state, conservative remaining fee/value
coverage, native estimates with 20% margin, and fee caps. A beneficiary must have
zero balance/nonce initially and exactly the proposed gas funding before issue.
Unexpected extra transfers therefore fail closed. Provider agreement is
corroboration, not a cryptographic light-client proof.

The file journal exclusively creates and fsyncs the reserved ticket before any
signature, then the exact signed hash before the one send invocation. Tickets
contain only public proposal hash, role, phase, selected gas and transaction hash;
no signed raw bytes or credentials. Keep one durable protected directory for this
proposal, and never delete/copy tickets to obtain another attempt. A crashed
writer can leave its lock file; read-only reconciliation still works. A reserved
attempt with no signed hash, unknown delivery or reverted receipt requires manual
investigation. The tool deliberately provides no reset/unlock/replacement command.

Reconciliation verifies both receipts, the exact signed transaction envelope and
recovered issuer, canonical receipt block finalized by both providers, runtime,
issuer, balances/nonces and exact `RightIssued` data/state. Every later setup step
requires all preceding steps to reconcile as finalized. One invocation never
advances automatically to the next transaction.

Local verification:

```sh
node --test tests/operator-flow.mjs tests/operator-runner.mjs
```

The flow suite starts and stops its own loopback Anvil and uses disposable test
actors. `operator-validation.json` records the three local setup transactions and
read-only restart checks. Its two clients share one local backend; it is not proof
of public provider independence, live Monad behavior, physical credentials,
publication, or approval. The separate runner tests inspect fixed transport
settings and verify that missing approval cannot open a signer; they never invoke
the public command.
