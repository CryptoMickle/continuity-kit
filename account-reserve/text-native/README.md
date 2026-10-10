# Native text reserve integration

A separately built browser integration that uses the public SDK's **native WebAuthn default**. It prepares one immutable text snapshot in two or three explicitly configured stores, verifies every copy before reporting readiness, and recovers from a valid survivor. It has no simulated credential endpoint, failure controls, wallet or signing account.

This is an experimental integration reference. Build and automated tests do not establish physical passkey compatibility, independent providers, origin ownership or production security. The existing public demo and earlier reserves are unchanged. A recovery passkey remains bound to B's hostname and the app's original configuration.

## Generate and build

From the SDK repository:

```sh
npm run create:native-text -- /absolute/empty/native-text
cd /absolute/empty/native-text
npm ci --ignore-scripts
```

Copy `profile.example.json` to `profile.json`. Set your existing owned A and B origins, B's exact hostname as `recoveryRpId`, a stable `appId`, a deliberate expiry and two or three ordered replica IDs. Keep their same-origin paths in the exact form `/api/replicas/<id>/reserve`. The example `.test` names do not create or configure domains. HTTPS is required outside recognized loopback hosts; HTTP localhost is only for a deliberate local native check.

```sh
npm run build -- --profile profile.json
npm run doctor -- --profile profile.json
```

The build writes `dist/primary` and `dist/recovery`, each with its role-bound public configuration and the same native frontend assets. It also writes `dist/operator-profile.json` for the existing SQLite operator. Only the two role directories are frontend assets. **Never serve the source folder, SDK tarball, node_modules, private directory or entire dist parent.** A new build refuses to overwrite an existing output directory; use `--out /absolute/new-output` when rebuilding, and pass that output to the doctor too.

The generator only creates files. It does not install, issue grants, create passkeys, configure TLS or deploy. The doctor checks configuration, role bindings, every asset hash and HTML asset references; it rejects missing, changed or symlinked assets. These are consistency checks, not a signed supply-chain attestation. It does not invoke an authenticator or contact storage. Native PRF support and device prompts remain unverified until an explicit physical test succeeds.

## Start the operator stack

Copy `ports.example.json` to `ports.json` and choose five distinct free loopback ports (six for three stores). Replica IDs and order must match `profile.json`. With HTTP localhost, the A and B URL ports must match the frontend ports. With HTTPS, your existing TLS proxy forwards to the chosen loopback frontend ports while preserving Host and Origin.

After building and checking the assets, initialize a **new** private state directory once:

```sh
npm run operator:init -- --profile profile.json --ports ports.json --state private/operator
```

This creates separate SQLite databases, distinct local administrator invitation files and the bound operator configuration. Files are private (`0600`), directories are private (`0700`), and the manifest is committed last. The command refuses any existing target; it does not reset, repair or adopt another database. It creates no passkey, upload grant, service or account. Keep this original state directory and profile for subsequent starts.

Start the frontend, gateway and each store with one command:

```sh
npm run operator:start -- --profile profile.json --state private/operator --out dist
```

The startup command first reports correctable configuration problems with a
specific explanation and action. To inspect a stopped setup without starting it:

```sh
npm run operator:diagnose -- --profile profile.json --state private/operator --out dist
```

Add `--check-ports true` to briefly bind and release each configured loopback port.
The probe sends no request to an existing listener and never stops it. Port
availability is an observation, not a reservation or proof of service identity.
Startup independently checks everything again and acquires its own exclusive lock.

| Command | When to use it | What it establishes |
| --- | --- | --- |
| `doctor` | After build | Installed SDK and role assets match the profile. |
| `operator:diagnose` | Before startup, or after a startup refusal | Private state, original bindings, build and optionally local port availability. |
| `operator:check` | While the managed operator is running | Configured frontend, gateway and stored-response consistency. |

Diagnostics make no file changes, issue no grants and request no credentials.
They return fixed messages without private paths, invitations, locators, database
contents or raw system errors. Their result is not authenticated plaintext
recovery or native-device acceptance.

| Diagnostic | Corrective action |
| --- | --- |
| `PROFILE_STATE_MISMATCH` | Locate the original profile for this state. Do not rewrite app IDs, RP, origins, expiry or the saved manifest to force a match. |
| `PRIVATE_PERMISSIONS_INVALID` | Inspect ownership and access to the intended private paths. Directories require `0700`, files `0600`, owned by the operating user. The command never changes permissions. |
| `RUNTIME_LOCK_PRESENT` | Investigate the known launcher and any interrupted shutdown. The report cannot identify a live or stale owner; free ports or lock age do not justify deleting it. |
| `PORT_OCCUPIED` | Identify the existing port owner. Stop it only if it is yours and you intend to stop it. No automatic termination, rebinding or port change occurs. |
| `STATE_INVALID` | Preserve the state for inspection or restore a verified backup into a new directory. Do not reinitialize the existing directory. |
| `BUILD_INVALID` | Run the doctor with the same profile. Install dependencies or rebuild into a new output directory as appropriate. |

A runtime lock stops the preflight before state-content and port checks; use
`operator:check` for an already running stack. Diagnostic success is advisory:
files and ports may change afterward, so the launcher does not trust it as a
replacement for startup validation.

The launcher checks the installed SDK, built asset hashes and original state, reserves every port, starts each store in a separate child process, then verifies the configured read paths. An occupied port or incomplete startup closes only resources owned by this launch. It never stops a process found through a PID file. No grant is issued or native credential requested during startup.

Once ready, an individual store failure reports `degraded` while the gateway, B and surviving stores stay running. If every store stops, status becomes `unavailable`. The launcher never remaps a failed route or automatically restarts a store. Initial setup still needs all intended copies; recovery can use an authenticated survivor. This is one managed local stack, not a deployment to independent providers.

In a second terminal, run the read-only check:

```sh
npm run operator:check -- --profile profile.json --state private/operator --out dist
```

The check verifies the frontend role/profile and served asset bytes, each store's profile, and reads through the direct store, gateway and B. Where a stored record exists, responses must match the private local database bytes. An empty store is reported only as `emptyRouteReachable`. Identical or empty responses do not establish store identity; process ownership and bound launch configuration supply the local wiring. This is not authenticated plaintext recovery, native passkey proof, public TLS validation or a security audit. The check sends only GET requests and never issues a grant, repairs a copy or prints locators, ciphertext or invitations.

Press Ctrl+C in the launch terminal to stop its owned services cleanly. A normal restart uses the same databases and invitations, preserving immutable records and quota. The private `runtime.lock` prevents two launchers using the same state. A lock left after a forced process termination is deliberately not removed automatically: inspect the owned services before deciding whether to remove a stale lock. The tool will not guess or kill an unrelated process.

Only the A and B frontend listeners belong behind your public TLS proxy. **Do not expose the gateway or internal store ports**, including their invitation endpoints. The native recovery host exposes only fixed reserve GET/PUT paths and built assets. The lower-level `operator-runtime` commands remain available for deliberate manual operation; do not run them concurrently against the managed stack.

Two stores on one computer still share the machine, gateway and B frontend. Loss of B's origin or the usable passkey can prevent recovery. Configure retention and ownership deliberately before inviting other users; automatic snapshot updates, key migration and automatic repair remain outside this protocol.

## Back up and restore the complete operator

The managed backup combines every configured replica, the original app/origin/RP
policy, encrypted records and consumed issuance quota into one private file.
It works with both profile versions. It contains no passkey material, plaintext,
administrator invitations or outstanding upload grants. App labels, origins,
opaque locators, record counts and ciphertext remain visible to anyone who can
read it; this is not an encrypted wrapper around that metadata.

Back up before the fixed profile expires. Stop `operator:start` cleanly before
backup, and stop any manually launched store writers too. The command takes the same exclusive `runtime.lock` as the managed
launcher. A live or stale lock is refused; no process is killed and no old lock
is removed automatically. The lock does not coordinate manual lower-level tools.

Create a private destination outside the served role directories. It must have
an existing `0700` parent; the new file is `0600` and is never overwritten:

```sh
mkdir -m 700 private/backups
npm run operator:backup -- --profile profile.json --state private/operator \
  --out private/backups/operator-2026-10-10.json
```

Retain the returned `sha256` separately through a trusted channel. Copy the
backup and the original public profile to independently retained storage; keeping
them only beside the original databases does not protect against machine loss.
Copying to external storage is a deliberate operator task, not an automatic
upload performed by this command. Preserve private file modes on the destination.
The old managed stack may be restarted after the backup command returns.

On the replacement installation, use the same package and original `profile.json`.
Build and run the doctor as above, supply explicit local `ports.json`, and restore
into a **new, nonexistent** directory. Do not run `operator:init` there first:

```sh
npm run operator:restore -- --profile profile.json --ports ports.json \
  --in private/backups/operator-2026-10-10.json \
  --sha256 <the-separately-retained-64-character-digest> \
  --state private/restored
npm run operator:start -- --profile profile.json --state private/restored --out dist
npm run operator:check -- --profile profile.json --state private/restored --out dist
```

Replace the digest placeholder; do not compute a new digest from an untrusted
received file and treat that as verification. Restore validates the complete
bounded bundle and each ordered replica before writing state, uses no-overwrite
database imports and commits the state manifest last. It preserves ciphertext,
app bindings, expiry and used quota. It generates fresh administrator invitations;
old pending grants cannot upload after restore. Issue any future grants using
`private/restored/invitations.json`. Recovery itself requires no upload grant.

Keep the original B hostname/RP, origin and app IDs reachable through your owned
TLS routing. Internal HTTPS proxy ports may change explicitly; localhost A/B
ports must still match their profile origins. This command does not move a
domain, rebind a passkey, extend expiry or merge different profiles. Before
retiring the old deployment, check each app through fresh B and export the
expected text using the existing passkey. A successful structural import is not
proof that a passkey is available or every ciphertext decrypts.

The retained digest detects a byte change relative to that retained value. It
does not establish an author's identity, the latest snapshot, anti-rollback or
a global quota across restored forks. Do not run an old and restored fork as if
their quotas were coordinated. A copy stored on another disk is also not proof
of an independently operated provider. The installed test replays recovery from
new temporary state after removing the original path, with synthetic credentials
on one machine; no physical-device or external-host recovery is implied.

Native SDK packaging explicitly allows only source files, and the generated
project excludes private state, backup/grant files and build output from npm and
Git. These exclusions do not protect a manual upload of the entire directory.
Run the repository's `npm run test:native-backup` for file-boundary, rollback,
package-exclusion and installed-SDK restoration checks.

## Issue one setup permission

The operator, not a public browser endpoint, issues short-lived upload grants. The initialization step creates the private `invitations.json` with the exact replica ports and distinct invitations, so no bearer values need to be copied into configuration by hand.

```sh
npm run issue:grants -- --profile profile.json --invitations private/operator/invitations.json --out private/operator/setup-grants.json
```

The issuer contacts the fixed local store ports once each. It writes a new mode-0600 bundle in an existing mode-0700 directory, and never prints tokens. Each grant permits one upload attempt at its store and expires within five minutes (or earlier at profile expiry). Do this only when the recipient is ready. The bundle is a private bearer permission, **not** public configuration or a decryption key. Deliver it privately to the intended setup session. It is not a signed attestation of user identity or server ownership.

In A, write fictional text and choose preparation. In the opened B window, supply the private bundle, check it, then deliberately choose creation or the existing reserve passkey. Permission validation does not invoke the authenticator. The subsequent passkey button does; your browser/device may request more than one confirmation. Keep both windows open until every copy is independently verified. B clears the input and in-memory upload capability after the attempt.

A partial or unknown issuance can consume quota even if no bundle is returned. A partial or unknown write can leave a surviving encrypted copy. Neither path retries automatically. Keep existing passkeys, check the reserve and inspect the operator's bounded status before deliberately arranging another setup. Never infer failure means nothing was saved.

## Recover and continue

Fresh B needs only its existing passkey and one intact encrypted copy. No grant bundle, operator invitation, account address or export file is required. Opening does not write, repair or create a passkey. Conflicting authenticated copies stop; the protocol never guesses which is newest. Local edits do not modify the immutable snapshot: export TXT or JSON to keep them.

`adapter.mjs` remains the two-function editor boundary, `getText()` and `applyText(text)`. `main.mjs` calls only the installed public `/text-browser`, `/text-reserve` and `/http-store` entrypoints. It supplies no synthetic WebAuthn override. Native authentication is initiated only by explicit buttons, and page exit aborts pending operations and clears the opened local copy.

The parent repository's `npm run test:native-text` checks configuration, grant expiry and binding, frontend lifecycle/gesture boundaries, actual temporary operator databases, routing denials, safe initialization, managed process failures, read-only readiness and clean installed-generator behavior. Browser rendering checks do not authenticate. These checks are distinct from a user-run native passkey acceptance test.


## Several app reserves with the same native passkey

The same generated package also supports a **version 2 collection profile**.
Copy `profile.collection.example.json` to a new `profile.json` before the first
build and initialization. Define 2–8 apps using stable `id`, `label` and `appId`
values. Keep each existing application's original `appId`; it is part of the
key derivation and cannot be renamed to move a reserve. All apps use the same
exact B origin/RP and the profile's ordered 2–3 storage routes. This reference
hosts the example editors together on A; it is not a cross-origin app-directory
or automatic discovery service.

`id` selects an editor and permission handoff; `appId` binds the encrypted
reserve. The browser never obtains either value from a pasted grant or arbitrary
URL. B's `/?app=<id>` can select only an app already in the fixed profile.

Use the same build, doctor, ports and operator commands documented above.
The build chooses the collection interface for v2 and retains the single-app
interface for v1. Initialize a **new private state directory for a new profile**.
The existing state reader refuses a changed app list, ordering, label or binding;
it does not rewrite databases. Do not modify an established v1 profile or copy
its state into a v2 directory and assume migration occurred. Migration and
additional apps in an existing deployed profile are not automated here.

Prepare the apps one at a time. When the selected B setup tab is ready, issue
its private permission bundle using the matching profile `id`:

```sh
npm run issue:grants -- --profile profile.json --app textarea \
  --invitations private/operator/invitations.json \
  --out private/operator/textarea-grants.json
```

In that B tab, paste the file contents into **One-time upload permission**, then
choose **Check upload permission**. This clears the input and checks the app,
origin, store order and short expiry without requesting a passkey. Choose
**Create my first reserve passkey** only if this is the first reserve at B.
For every subsequent app, choose **Use my existing reserve passkey** and select
that same key. Selection failure never falls back to creating another key.
Wait for all configured copies to be independently checked before closing A.

Use the second profile ID and a fresh private output file for the next app:

```sh
npm run issue:grants -- --profile profile.json --app markdown \
  --invitations private/operator/invitations.json \
  --out private/operator/markdown-grants.json
```

These JSON bundles bind the frontend handoff to the selected app. The underlying
operator token still permits one opaque ciphertext write; it cannot inspect the
encrypted record's app namespace. This is not server-enforced per-app admission.
Never publish an invitation or grant file, and do not issue grants in advance of
an available setup window. An uncertain issuance/write can consume quota and
must not be repeated automatically.

Open B's root address in a fresh tab and choose **Open my app reserves**. The
installed SDK makes one discoverable assertion for the collection and checks
each app's authenticated copies. That is one API assertion, not a promise of
one device confirmation. Missing, unavailable, altered and conflicting copies
are reported per app; a valid sibling remains editable and exportable. Markdown
is displayed as plain text, never executed HTML.

Each app offers exact TXT and structured JSON export. Unedited BOM/CRLF bytes
are retained; actual typing follows the browser editor's text behavior. Closing
the copies or leaving the page clears the retained editor state and export
links. Cancelling rejects late results. When profile access expires, already-open
work remains editable/exportable; new recovery and preparation stop. Edits do not
update stored snapshots. No issuer, synthetic credential or storage-failure
control is bundled into either deployed role directory.

Automated installed-package checks cover actual SQLite restart and recovery
through B after A and one store stop, with test-only synthetic credentials
outside the deployed assets. This package is not yet physically accepted with
native multi-app passkeys, deployed to the public Sites, or independently audited.
See [collection package validation](https://github.com/CryptoMickle/continuity-kit/blob/main/account-reserve/evidence/native-collection-package-2026-10-10.json).
