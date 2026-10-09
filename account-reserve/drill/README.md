# Run a recovery drill

From the project root, with Node 24+ and locked dependencies installed:

```sh
node scripts/work-recovery-drill.mjs
```

The command runs the current Work SDK and Mera encryption against two disposable
HTTP servers bound to `127.0.0.1`. It prints its observed checks and writes
`report.json`, `summary.txt`, matching finished TXT/JSON work, and an actual
encrypted-export baseline under a new `drill/evidence/run-…/` directory. Exit code
zero means every check passed. A failed check stops the drill and produces a failed
report; it never silently replaces missing proof with a prewritten success.

This is a **synthetic developer test**, not a physical-passkey test. It uses public
deterministic fixture material and fictional work. Never fund its example account,
use its credential with real data, or deploy the local fault-injection servers.
It makes no RPC calls and sends no transactions. Loopback networking must be
permitted by the environment; `EPERM` is an environment failure, not a passed test.

## What executes

1. Create one simulated recovery credential; prepare an encrypted work snapshot
   using the real Work SDK, including its independent readiness check.
2. Protect the **same work and owner binding** in a real Mera encrypted export
   using that same available credential, then independently import the file.
3. Wipe the original synthetic account leaf, close the enrollment handle and make
   the original HTTP endpoint return 503. Load a fresh SDK module and create a new
   reader/client with no supplied locator, address, leaf key or old context.
4. Recover all five fields and the matching owner. Deny account-vault PRF access
   during Work recovery and reject any result exposing a signer. Bracket the
   recovery with HTTP 503 checks and measure original-app requests.
5. Finish the draft, close the recovery context, export matching text/JSON and
   read the written files back. Recover again to verify the stored snapshot stayed
   unchanged with exactly one original write.
6. Actually run the comparison and failure cases below.

The primary endpoint is a local availability fixture, not a public website outage.
Fresh SDK state is not a fresh browser profile. The retained synthetic credential
stands in for a surviving authenticator; device synchronization is not tested.

## A fair encrypted-file comparison

The baseline is functional code in `encrypted-export.mjs`, using
`createSecretVaultWithExistingPasskey` and `decryptSecretVaultWithPasskey` from
Mera. It imports retained encrypted bytes and authenticates their app policy,
owner annotation and exact work fields. It is not a deliberately broken backup.

| Controlled condition | Work Reserve | Retained encrypted export |
| --- | --- | --- |
| Original app unavailable; both copies retained | Must recover | Must recover |
| Export file missing; reserve storage available | Must recover without a file | Must report missing file |
| Reserve record missing; export retained | Must report missing reserve | Must recover |
| Reserve service unavailable; export retained | Must report unavailable store | Must recover without HTTP requests |
| Ciphertext modified | Must reject | Must reject |
| Recovery credential unavailable | Must reject | Must reject |

The report derives its outcomes by executing those operations. It separately counts
credential creation, PRF/assertion API calls and HTTP storage reads/writes. These
are **not human steps, Face ID prompts, elapsed onboarding time or cost estimates**.
The baseline has no host-storage requirement, but the user must retain its file and
compatible trusted import code. Work Reserve uses credential-driven discovery but
depends on available hosted bytes and trusted recovery code.

The comparison covers private work. The file does **not** include an account leaf
or signing authority. Work preparation additionally encrypts and verifies the
optional account vault, so setup-operation counts are not an equal-feature account
recovery benchmark. Neither result establishes customer preference, market demand,
production security, complete infrastructure independence or universal superiority.

## Reproduce and test a specific fixture

```sh
node scripts/work-recovery-drill.mjs --seed=public-fixture-one --out=example-one
node scripts/work-recovery-drill.mjs --seed=public-fixture-one --creation-fallback --out=example-fallback
node --test tests/work-recovery-drill.mjs
```

Only public synthetic fixture labels belong in `--seed`. The same label gives the
same work/credential fixture and outcome counts; AES-GCM/Mera nonces remain random,
so encrypted bytes intentionally differ between runs. `--creation-fallback`
exercises a credential-create response without PRF output and measures the extra
assertion. `--json` prints the machine-readable report instead of the summary.
`--out` accepts a simple run name inside `drill/evidence/`; existing evidence files
are never overwritten.

The exported `runRecoveryDrill` function accepts a fixture factory, host factory,
SDK loader and baseline implementation for focused tests. The test suite deliberately
breaks owner/content matching, signer separation, readback, outage control and
tamper injection to prove those failures cannot become green reports. This injection
surface is local test scaffolding, not a plugin API for untrusted live services.
