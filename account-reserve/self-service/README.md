# ContinuityKit self-service judge demo

An isolated native-passkey demonstration for a judge's own fictional work. Both Sites are publicly live following explicit user approval on 9 October 2026. All 19 anonymous read-only HTTP checks passed. Browser checks verified desktop and mobile layouts, edited fictional content, A-to-B setup, automatic capacity admission before native creation, cancellation, fresh B recovery entry and TXT/JSON export readback. No native credential was created or authenticated during these checks. After the Safari correction, the user reported that the fresh iPhone setup worked. Worker logs corroborate successful iPhone admission, upload and subsequent read on 9 October at 19:02–19:03 UTC. The user then confirmed fresh-page recovery with the existing passkey, continued editing and TXT export in Safari on iPhone. A later iPhone reserve read returned HTTP 200 at 19:06:21 UTC. Device-screen and exported-file contents were not independently inspected. This is the builder’s acceptance test, not an independent participant trial.

Public addresses from `profile.json`:

- **A — original workspace:** [continuitykit-try-primary](https://continuitykit-try-primary.cryptomickle.chatgpt.site/)
- **B — independent reserve:** [continuitykit-try-reserve](https://continuitykit-try-reserve.cryptomickle.chatgpt.site/)

These are new Sites with a separate recovery relying-party domain and a dedicated D1 database. Passkeys and snapshots from earlier demos remain associated with their original B site; they do not migrate to this one. Prepare a new fictional snapshot and reserve passkey for this B site.

## Safari setup correction, 9 October 2026

An iPhone attempt stopped before any passkey request or snapshot upload. Its exact transport failure could not be confirmed from Worker logs. The correction sends an origin-only referrer for same-origin POST/PUT while keeping exact-origin validation, and uses D1 time plus conservative monotonic timing for the five-minute admission budget. Error messages distinguish network, timeout, HTTP and response-validation failures. Uncertain admission and upload results are never retried automatically.

Use fresh A and B pages after this update; older loaded clients do not understand the added server timing field. 149 automated UI, database, timing and SDK regression checks passed. After publication the user reported that the fresh iPhone setup worked. A subsequent user report confirmed fresh-page recovery and edited TXT export under the test instructions. See `../evidence/self-service-iphone-setup-report-2026-10-09.json` for the evidence boundary.

## Try the public flow

1. Open A and edit the fictional project, client, brief, draft and next step. Use no personal, confidential or valuable content.
2. Select **Start my example account**, then **Prepare in B**. A creates a new, unfunded account key locally and opens B. Keep both windows open.
3. B automatically checks capacity and obtains a short-lived upload permission. No operator code is needed. Select **Create reserve passkey** yourself and complete the device prompts. Setup creates one passkey; protecting and independently checking the snapshot can require several further confirmations.
4. Wait for the snapshot-ready confirmation in both windows. Keep the passkey and the public B link. If setup stops, keep any passkey already created and use **Check existing reserve** before considering another setup; an upload may have succeeded without confirmation.
5. Discard A's window state or close A. Open the public B link in a fresh page and select **Open my existing reserve**. Recovery needs the existing B passkey, with no account address, upload permission or export file.
6. Continue the recovered draft and export TXT or JSON. These exports contain work only. Edits do not overwrite the immutable snapshot. Recovery closes its context immediately; this interface has no account-unlock control.

Native credential creation and authentication require the user. The browser and authenticator must support passkey PRF. Another device can recover only if the same passkey is available through a compatible provider; cross-device success is not guaranteed. Closing A proves recovery without that window's state, **not an HTTP 503 or service outage**. No global outage control is exposed.

## Limits and retention

- At most **64 snapshots**, each at most **64 KiB of encrypted record data**; editable work is limited to **16 KiB**.
- At most **256 upload permissions issued over this release's lifetime**. Each lasts at most five minutes, reserves a slot while active and permits one successful upload. Expired unused permissions release their slot but still count toward 256.
- Storage and admission counts are bounded. Traffic, database request counts and billing are not guaranteed to be capped. Public capacity can fill up.
- Access ends **10 November 2026 at 00:00 UTC**. Access expiry does not delete records. A separate authenticated cleanup can remove expired state; no cleanup execution or deletion is claimed here. Provider recovery history may retain deleted records for up to 30 further days.

There are no funds, wallet connection or blockchain transactions. Preparation includes a local signature check of the new example account. The underlying reserve can restore account authority, and does not revoke the original key; this is an experimental fictional-work demo, not a permanent backup or custody service.

## Local checks

From the repository root, with Node.js 24 or later and dependencies installed:

```sh
npm ci
node --test tests/self-service-ui.mjs tests/self-service-backend.mjs tests/self-service-capability-clock.mjs
node --test tests/work-reserve.mjs tests/work-browser.mjs tests/native-cancellation.mjs
```

The backend suite uses local Miniflare/D1 and needs loopback access. These checks use test doubles for credentials and do not establish physical-passkey success. The builder has reported completing the physical iPhone setup, fresh-page recovery and edited-export sequence. This report is separate from the automated checks; the exported bytes and device screen were not independently inspected. Cross-device recovery and an actual A service outage require their own observed evidence.
