# Adoption hypothesis and operating plan

Research checkpoint: **9 October 2026**. This is a proposed pilot, not evidence of
customer demand. No external maintainer has adopted ContinuityKit, and no outreach,
recruitment, customer test or willingness-to-pay interview was performed for this plan.
The machine-readable sources and assumptions are in
[the research record](../evidence/adoption-research-2026-10-09.json). That earlier
checkpoint predates the completed local text-only integration described below;
its outside-adoption and pricing unknowns remain unresolved.

## One initial customer hypothesis

Target a small independent browser-app team that stores **private, unfinished text**:
drafts, project briefs or notes that a user may want to finish after the app closes.
The useful job is: prepare a snapshot while A works; later open B, discover that
snapshot with the surviving passkey, continue editing and export without A or a
manually retained backup file. The team must be willing to own or contract for B's
domain, storage and maintenance. This describes fit; it does not establish market size.

Start with one document and explicit snapshots within text-v1's 16 KiB raw UTF-8
limit. Exclude attachments, automatic synchronization, collaborative history,
regulated or safety-critical records, credential-loss recovery and guarantees of
permanent storage. The account-free text protocol and integration are implemented
and locally tested. The preferred published URLs are [A/text/](https://continuitykit-try-primary.cryptomickle.chatgpt.site/text/)
and [B/text/](https://continuitykit-try-reserve.cryptomickle.chatgpt.site/text/);
both Sites version 3 pages have been observed live. A editing/TXT/JSON download,
mobile rendering, admission and cancellation before passkey creation were checked.
Native text-v1 setup and Mac-to-iPhone recovery/export remain pending.
The retained Work v1 path still requires an account leaf during preparation.

## Evidence we have, and what it does not prove

- [Textarea text mode](../integrations/textarea-text/README.md) is a real **agent-built integration**
  of an independently authored editor: the original editor and highlighter execute,
  and a clean consumer installs an SDK tarball through public entry points. It is
  not upstream adoption or an external developer experience measurement. This current
  integration requires only the document, with no invented fields or account key.
  Clean-package, synthetic recovery and JSDOM TXT/JSON readback checks passed;
  physical text-v1 browser acceptance remains pending. The older Work adapter with
  its disposable account remains a separate reference in `integrations/textarea/`.
- [The text-v1 recovery drill](EXPORT_COMPARISON.md) executes a competent encrypted-file
  baseline. Both approaches recover when their required bytes and credential survive.
  Reserve discovery avoids retaining a file; a retained file avoids a hosted-store
  dependency. Six conditions across 12 fresh recovery processes use the same text
  and credential, with actual A=503 and file/TXT/JSON readback. Four regression tests
  passed. These are synthetic local observations, not native prompt or human-effort
  measurements. The older Work v1 report remains supplemental evidence.
- Two pinned source references from the competition review motivate the engineering
  questions, not customer demand. [Iris's account module](https://github.com/vmlechko/Iris/blob/3a1244c418c0f8308ec95a56383c2509965ebb70/lib/account.ts#L44)
  selects `location.hostname` as its RP ID and restores its account through that RP.
  [FIRSTHAND's bundle implementation](https://github.com/kaustubh76/Firsthand/blob/a3a078ca97d7234eefc01228c0f92b343a4c3f1f/packages/sdk/src/portability/bundle.ts#L104)
  already exports ciphertext, sidecars and wrapped keys, then supports import into
  another gateway. These files were read at their pinned revisions; neither project
  requested ContinuityKit. They establish neither novelty across the market nor
  current competition ranking.

## Who keeps B alive?

The current demonstration has two origins under the builder's Sites account. A
separate database and hostname do not establish an independent operator or provider.
A real pilot needs a named B operator and explicit responsibility for domain renewal,
hosting charges, recovery-client updates, storage, monitoring, support and eventual
cleanup. Prefer a recovery domain controlled for the intended retention period and
an administrative failure domain separate from A; this is a deployment requirement,
not a demonstrated property of the present Sites setup.

WebAuthn credentials are scoped to their RP ID. The current implementation uses B's
hostname and fixes the allowed origins in its configuration. Copying encrypted bytes
to an unrelated hostname is therefore insufficient for recovery. Preserving the same
B origin/RP while moving infrastructure is a possible migration path that still needs
a demonstrated procedure. No portability of the present `chatgpt.site` hostname is
established, and related-origin WebAuthn support is not implemented here.
See the [WebAuthn RP rules](https://www.w3.org/TR/webauthn-3/#relying-party-identifier).

The recovery client remains trusted code: encryption at rest does not make a malicious
replacement client safe. Losing B's domain or the passkey can defeat this path even
when the encrypted database survives. The current demo ends access on **10 November
2026 at 00:00 UTC**. Expiry is not deletion; an authenticated cleanup operation and
verified result are separate, and no cleanup execution is claimed by this document.

## Bounds and costs

The [current backend](../self-service/backend/profile.mjs) permits **64 records of at
most 65,536 bytes** and **256 lifetime admissions**, shared by text-v1 and the older
self-service Work flow. These are not separate quotas per mode. Live unused admissions reserve
capacity atomically. Expired unused admissions still consume the lifetime allowance;
each admission can authorize at most one immutable record.

That is at most **4,194,304 bytes (4 MiB) of encrypted record payload**. D1 stores
base64url text: up to 87,382 characters per record, or **5,592,448 bytes** across 64
maximum-size records, before capability rows, indexes and SQLite overhead. The actual
database size is not measured here. These are per-release demo bounds, not a production
tenant or billing model.

Direct Cloudflare list prices checked on 9 October 2026, in USD:

| Resource | Free allowance | Paid allowance and excess rate |
| --- | --- | --- |
| Workers | 100,000 requests/day; 10 ms CPU/invocation | Minimum $5/account/month; 10M requests and 30M CPU-ms/month included; excess $0.30/M requests and $0.02/M CPU-ms |
| D1 | 5M rows read/day; 100,000 written/day; 5 GB total storage | 25B reads/month, 50M writes/month and 5 GB included; excess $0.001/M reads, $1/M writes, $0.75/GB-month |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Allowances
are shared with other usage in the account. D1's per-database cap is 500 MB on Free
and 10 GB on Paid; the maximum row/string/BLOB is 2,000,000 bytes. Small stored data
does not prevent quota exhaustion from repeated queries.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

**The actual Sites account plan, charges and available allowance are unknown.** These
list prices are a direct-Cloudflare planning reference, not a quotation for Sites and
not proof the demo is free. Its HTML/assets are served by Worker code; do not assume
Cloudflare's separate free static-asset treatment applies.

The 64/256 limits do **not** cap HTTP requests, repeated reads, attempted writes, CPU,
logs or bills. Admission throttling is best-effort and local to a Worker isolate.
Rejected requests still use hosting resources; valid-looking misses can query D1.
Before an ongoing pilot, establish actual account billing, request/CPU and D1 row
metrics, appropriate traffic controls, and an owner able to stop admissions or service.
An alert or per-request CPU limit is not a total spending ceiling.

## Integration economics and a bounded pilot

Known: the account-free Textarea adapter and installed consumer run locally. The
text-v1 drill measures one assertion for each healthy recovery: reserve uses one HTTP
read, while the retained file uses none. After shared credential creation, reserve
preparation/verification uses one assertion and file preparation/verification two;
their distinct PRF-salt/reuse choices explain that difference. These are API counts,
**not native prompts, human steps or D1 billed rows**. No external integration time,
ongoing support load, production CPU usage, customer acquisition cost or willingness
to pay has been measured. Do not infer a subscription price or gross margin from the
small payload. Domain/control, maintenance and support may matter more than storage.

Only start a future pilot after a suitable maintainer voluntarily agrees and the
operator/cost/domain questions above have answers. Suggested success gates below are
targets, not completed experiments; no recruitment is initiated by this plan.

| Gate | Evidence required before proceeding |
| --- | --- |
| App fit | One independently maintained app has a real unfinished-text recovery job; its maintainer can explain why retained encrypted export alone is insufficient for that job. |
| Integration | Maintainer integrates public SDK entry points into their own capture/restore/export flow; record their time and required author help. Proposed budget: four engineering hours before reassessing scope. |
| Correct recovery | Exact prepared text returns in a fresh B context with A unavailable; edit/export works; no hidden A state or account signer is required for the text-only path. Native acceptance belongs to the exact released protocol/browser combination. |
| Operating ownership | Named B operator accepts a retention period, domain control, measured plan costs, support and exit/cleanup duties. No indefinite free-hosting promise. |
| Preference | After seeing both competent recovery paths, the maintainer explicitly chooses to retain or ship the integration and records the reason. An agent-written adapter is not this evidence. |

Stop or narrow the pilot if the app needs unsupported synchronization/attachments,
PRF support fails on its required devices, B cannot retain its RP/domain, integration
exceeds the budget without a concrete fix, or the maintainer prefers ordinary export
after the fair comparison. One favorable pilot would be an early signal, not product
market fit. Real interest and independent use cannot be manufactured by more agent
code, more tests or competition-source research.
