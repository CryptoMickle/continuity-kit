# Text Reserve versus a retained encrypted file

**Hosted discovery avoids having to find a saved file. A retained encrypted file
avoids relying on the reserve store.** Both need a surviving credential, authentic
bytes and compatible trusted recovery code. This is a dependency tradeoff, not proof
of general superiority or customer preference.

The [text-v1 report](../evidence/text-drill-2026-10-09.json) records six conditions
across both recovery paths, each in a fresh Node process: **12 matrix recovery
processes**, with actual loopback A=503 checks before and after every attempt. It uses
the current text SDK and a synthetic HMAC WebAuthn adapter. Four regression tests
passed. This is separate from the published `/text/` page/UI checks and the
[10 October builder-reported iPhone recovery/export](../evidence/text-native-acceptance-2026-10-10.json).
That report followed the instructed Mac Safari → iPhone Safari same-passkey sequence;
Worker logs corroborate a Mac Safari upload and an iPhone Safari reserve read. Redacted
locators prevent linking them independently to the same record. Device screens,
credential identity, the requested marker and exported bytes were not independently
inspected. The report is not a native trial of this two-method comparison or evidence
of lower human effort.

## Same document, credential and readiness requirement

The two paths protect the same 95-byte UTF-8 fixture with the same available
credential. Neither contains an account key or signing surface. The
[encrypted-file implementation](../drill/text-drill.mjs) uses Mera PRF, a separate
random PRF salt, HKDF and AES-256-GCM with authenticated configuration. It does not
reuse the reserve encryption key. This functional comparison format is not a
supported production backup format.

The backup is written to a real file before A is made unavailable. File recovery
children read that file themselves; the missing-file case uses an absent path.
An independent fresh-process import checks the file before the outage. Text Reserve
performs its own byte readback and new discoverable assertion/decryption before
readiness. No recovered text or derived key is passed into a matrix recovery child.
Synthetic authenticator material is supplied so the same credential is available;
this is not evidence of physical passkey synchronization.

| Executed condition | Text Reserve | Retained encrypted file |
| --- | --- | --- |
| A=503; both encrypted copies retained | Exact text recovered; no A request | Exact text recovered; no HTTP request |
| File missing; reserve retained | Recovers through discovery | `BASELINE_FILE_MISSING` |
| Reserve record missing; file retained | `RESERVE_MISSING` | Recovers |
| Reserve service unavailable; file retained | `STORE_UNAVAILABLE` | Recovers without reserve HTTP |
| Both encrypted copies altered | `MANIFEST_AUTH_FAILED` | `BASELINE_AUTH_FAILED` |
| Credential unavailable | `PASSKEY_OPERATION_FAILED` | `BASELINE_KEY_UNAVAILABLE` |

Successful outputs match both text and digest. Both recovered paths are edited into
the same finished document; matching TXT/JSON files are written and read back. There
is one immutable reserve write. These results establish neither public-service
outage recovery nor human usability.

## Actual API counts

The shared synthetic credential creation is counted separately: **one create call,
zero assertions** in this run, with PRF output available during creation.

| Operation after that shared creation | Text Reserve | Encrypted file |
| --- | --- | --- |
| Prepare and independently verify | 1 assertion | 2 assertions |
| Healthy fresh-process recovery | 1 assertion; 1 HTTP read | 1 assertion; 0 HTTP requests |

Reserve preparation reuses its creation-time PRF result. The file uses another PRF
salt, requiring an assertion for encryption and another for the independent import.
This explains the setup-count difference; it is not a measured native-prompt,
elapsed-time, effort or cost advantage. A creation-time PRF fallback would change the
counts. The report records zero signups and signing actions, not external-user effort.

Fresh processes are not fresh browser profiles. The local HTTP services share an
operator. No device synchronization, native prompt count, human onboarding time,
D1 billable-row count or production expense was measured. The file still needs its
credential/RP and trusted import code; it does not solve arbitrary domain loss.
Neither method automatically saves later edits or recovers a lost credential.

Reproduce from this source revision with locked dependencies and loopback permission:

```sh
npm ci --ignore-scripts
node scripts/text-recovery-drill.mjs
node --test tests/text-recovery-drill.mjs
```

A run writes its report and actual files to a new `drill/text-evidence/run-…/`
directory. The retained evidence report above is the reviewed run; these commands
are for a deliberate new run, not a claim one was rerun to edit this document.

## Supplemental older Work v1 evidence

The [older Work report](../evidence/work-drill-2026-10-09.json) and
[readable output](../evidence/work-drill-2026-10-09.txt) retain ten passing checks for
the five-field Work protocol. Its file contains the same work and owner annotation,
but no account leaf; Work preparation additionally checks an account vault. Its
three preparation assertions versus the file's two are therefore not an equal-feature
account benchmark. Its 1,163-byte export is fixture-specific and is not the size of
the new text backup. Run `npm run drill:work` to reproduce that separate older path.

Choose between the storage dependencies for a real application's needs; see the
[adoption and operating plan](ADOPTION_PLAN.md). Neither comparison demonstrates
outside adoption or willingness to pay.
