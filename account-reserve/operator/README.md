# Operator-controlled text reserve

This package serves the two native-passkey text apps and a ciphertext store on an
operator-controlled recovery origin. Node 24 and durable local disk are required.
The database is SQLite; there is no Sites, Vercel, D1, Redis or hosted database
dependency. This is a bounded experimental deployment, not an audited backup service.
The browser uses the same text-v1 wire format and installed public SDK as the demo.

Keep the same **HTTPS recovery origin, hostname/RP ID, app IDs and expiry** when
moving the store. A new domain cannot open old reserves simply by copying the
encrypted database. The operator must own and retain the recovery domain, TLS,
DNS, trusted client code, hosting and storage. Separate origins under one operator
are not independent providers. Moving this package does not make the existing
`chatgpt.site` demo hostname portable.

## Create a standalone package from public source

From the public source checkout, install dependencies, build the two-app client and
create a package in a new directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix integrations/multi-app ci --ignore-scripts --no-audit --no-fund
node scripts/build-app-reserves.mjs
node operator/create.mjs /absolute/empty/operator-package
cd /absolute/empty/operator-package
npm ci --ignore-scripts --no-audit --no-fund --omit=dev
```

The generator copies the reviewed `dist-self-service-apps` browser build, packages
the public SDK and creates a lockfile. It refuses an occupied destination or a
destination inside the source tree. No cloud account, credentials or live database
is copied. `drill-worker.mjs` is a synthetic IPC-only test tool; the host and browser
never import it. Only the `public` folder is served.

Copy `profile.example.json` to `profile.json` and set the two HTTPS origins and an
explicit access deadline. Retain the provided app IDs when restoring those apps.
The profile is pinned when the database is created; opening a database under a
different profile stops rather than silently changing cryptographic policy.
The supplied browser starter supports exactly the `textarea` and `markdown` app
entries shown in the example. The storage profile allows up to eight distinct
app IDs for custom consumers; adding apps requires a reviewed frontend/configuration
change, not just adding arbitrary JSON to this starter's profile.

```sh
node cli.mjs init --profile profile.json --database private/reserve.db
node cli.mjs invite --file private/invitation.txt
node host.mjs --profile profile.json --database private/reserve.db --invitation-file private/invitation.txt --assets public --role recovery --port 8787
```

Run Primary separately if this package also supplies A:

```sh
node host.mjs --profile profile.json --assets public --role primary --port 8788
```

Place the Node processes behind a TLS reverse proxy on the configured origins.
Forward the original `Host` header and request `Origin`; do not log authorization
headers, request bodies or reserve URLs. The listener binds **127.0.0.1 only** and
ignores forwarded host/protocol headers. The proxy should set connection/request
limits and a body limit of 90 KiB. Keep the private directory outside the web root.
That directory must be owned by the operator and inaccessible to untrusted local
writers. File-type checks and atomic no-clobber import are not a sandbox against
someone who can replace parent directories or manipulate local filesystem races.
Do not use a stateless host with an ephemeral filesystem for the SQLite database.
The host accepts HTTP only for localhost/127.0.0.1 testing. The bundled browser
starter currently requires the configured HTTPS origins; the automated loopback
drill exercises the installed SDK and HTTP API rather than claiming native UI proof.

The operator privately supplies the invitation code to an intended tester, who
pastes it into B before admission. It is never a URL parameter or configuration
response. The file contains a random 256-bit code, has mode 0600, and is not printed
by the CLI. Native passkey confirmations still belong to the human. The invitation
grants permission to request a bounded upload; it cannot decrypt a reserve.
Rotate it by creating a new invitation file and restarting B with that path.
Existing recovery does not require the invitation.

## What is bounded

- At most 64 immutable encrypted records, each at most 65,536 bytes; text-v1 itself
  permits at most 16,384 UTF-8 bytes of text.
- At most 256 issued upload capabilities over this database's lifetime. Expired
  unused admissions still count. Live unused grants reserve capacity.
- Each random capability expires after five minutes or at the access deadline,
  whichever comes first. Its hash is stored; each authorized write attempt consumes
  it. SQLite transactions prevent a second write or parallel quota overrun.
- There is no public arbitrary-write endpoint: obtaining a capability requires the
  invitation, an exact B Origin and an accepted JSON request. Reusing a capability
  is rejected. An uncertain write is reconciled by recovery, never automatic retry.
- Reads use an opaque passkey-derived locator. The server validates the envelope's
  bounded canonical shape, but only the client can authenticate its ciphertext.

The process also limits admitted requests per minute, connections and body sizes.
These measures are not an identity service, DDoS defense or bill ceiling. Disk,
hosting, DNS, TLS, operating-system updates, monitoring and support remain the
operator's responsibility. No free-hosting or permanent-retention claim is made.
Passkey loss, origin loss, malicious recovery code and missing/corrupted ciphertext
remain failure cases. One B client is trusted for both apps: app-specific HKDF
separation does not protect either app from a malicious script on B.

## Move the ciphertext store without changing B

The single-store migration below retires one database before its replacement
serves B. Deliberate replication is a separate, opt-in SDK flow described next;
do not turn old database exports into parallel active writers and assume that
they will reconcile automatically.

First pause new enrollments by restarting B **without** `--invitation-file`.
Existing reads continue; wait at least five minutes for outstanding grants to
expire, then stop B before the final export. The tool can take a consistent live
snapshot, but a live snapshot cannot include later writes. Do not leave two
independent active databases serving the same origin.

```sh
node cli.mjs export --profile profile.json --database private/reserve.db --file encrypted-transfer.json
node cli.mjs import --profile profile.json --database replacement/reserve.db --file encrypted-transfer.json
node cli.mjs status --profile profile.json --database replacement/reserve.db
node host.mjs --profile profile.json --database replacement/reserve.db --invitation-file private/invitation.txt --assets public --role recovery --port 8787
```

Copy the package/profile/transfer privately to the replacement operator host as
needed, configure the same recovery HTTPS origin there, and switch the proxy/DNS
without changing the origin. Keep the old encrypted snapshot until the replacement
is verified. The import refuses any existing destination, including symlinks; it
validates the entire transfer and publishes the new database atomically. It cannot
overwrite the active runtime database. Do not edit the expiry during migration.

The transfer contains the public configuration, opaque record locators, encrypted
record bytes and total issued-capability count. It contains **no plaintext, PRF
output, passkey secret, invitation, live capability or credential-ID list**. The
issued count survives migration, so moving does not reset admission quotas. Pending
capabilities intentionally do not transfer. The checksum detects accidental change;
it is not a signature or proof of authenticity. Only client decryption authenticates
the records. Treat the archive as private metadata even though it is encrypted.
Counts apply to one database history. An older archive can omit subsequent writes
and admissions; running forked copies can spend capacity independently. The package
does not provide anti-rollback state or a global quota across operators. Use the
final stopped-writer snapshot, retain its provenance, and retire the former instance.

## Optional replicas for a custom text integration

The SDK can prepare the **same immutable ciphertext** in two or three explicitly
configured stores, then authenticate every available candidate during recovery.
This is optional developer functionality. The bundled two-app UI and the public
Sites demo still use their existing single-store flow. Deploying the gateway alone
does not replicate old records or enable replicas in that UI.

Use separate database files and processes with the exact same `profile.json`.
Give each store its own invitation file and single-use upload capability. A token
issued by alpha cannot write to beta. Keep private files outside the served assets.

```sh
node cli.mjs init --profile profile.json --database private/alpha.db
node cli.mjs init --profile profile.json --database private/beta.db
node cli.mjs invite --file private/alpha-invitation.txt
node cli.mjs invite --file private/beta-invitation.txt
node host.mjs --profile profile.json --database private/alpha.db --invitation-file private/alpha-invitation.txt --role recovery --port 8787
# Run the following in separate processes:
node host.mjs --profile profile.json --database private/beta.db --invitation-file private/beta-invitation.txt --role recovery --port 8789
node replica-gateway.mjs --configuration replicas.json --port 8790
```

Copy `replicas.example.json` to `replicas.json`, set the same B recovery origin and
pin the two loopback ports. The gateway serves only fixed routes under
`/api/replicas/alpha/` and `/api/replicas/beta/`: `enrollment/start` and
`reserve/<locator>`. Route these paths from your TLS reverse proxy to port 8790,
preserving the original Host/Origin. Serve your trusted B frontend independently
of either storage process. The gateway cannot choose an arbitrary upstream URL,
does not follow redirects, does not retry writes and does not select ciphertext
on the client's behalf. Only SDK decryption decides whether a candidate is valid.

For recovery, call directly from a user action on B:

```js
import { recoverTextReserveFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';

const replicas = [
  { id: 'alpha', store: createReserveHttpStore({ basePath: '/api/replicas/alpha/reserve' }) },
  { id: 'beta', store: createReserveHttpStore({ basePath: '/api/replicas/beta/reserve' }) },
];
const result = await recoverTextReserveFromReplicas({ config, replicas, signal });
showRecoveredText(result.reserve.text);
showReplicaResults(result.replicas);
```

For new preparation, your integration must deliberately obtain a separate upload
capability from each `enrollment/start` endpoint, then pass each capability to its
own `createReserveHttpStore`. Use a one-use handle from
`createTextReserveCredential` or `selectTextReserveCredential` and call
`prepareTextReserveReplicas({ config, recoveryCredential, text, replicas, signal })`.
Only full byte-exact readback plus independent passkey verification of **every**
intended store returns ready. A partial or uncertain write is not full replica
readiness. Keep the existing key, inspect the safe per-store diagnostics and
recover/check the surviving records. Never automatically retry or make a new key.

Recovery checks all configured candidates before returning. Missing, unavailable
or unauthentic copies can coexist with a valid survivor. Different authenticated
ciphertext records produce `REPLICA_CONFLICT`, even if their plaintext matches:
text-v1 is immutable and provides no timestamp, majority rule or latest-version
election. The gateway never repairs or copies records automatically.

Each database retains its own 64-record/256-admission bounds. This is not a global
quota or a bill ceiling across stores. A loopback deployment still shares one
machine, operator, gateway, B domain and trusted frontend. Separate processes and
files demonstrate storage-process failure tolerance, not independent hosting
providers. A stopped gateway, lost B origin/passkey, malicious B code or loss of
every valid copy still prevents safe recovery.

Run the reproducible process-failure drill from the source checkout:

```sh
npm run build:apps
npm run test:replicas
node scripts/text-replica-drill.mjs /absolute/path/replica-proof.json
```

The drill installs the packaged SDK in a fresh directory, uses actual operator
processes and durable SQLite files, stops a store process, changes stored
ciphertext and checks exact export in fresh clients. Credentials are synthetic;
this does not measure physical passkey prompts or establish native-device support.

## Verify the replacement

From a source checkout:

```sh
node --test tests/operator-portability.mjs
node scripts/operator-portability-drill.mjs /absolute/path/operator-proof.json
```

The drill installs the SDK into a new package, prepares two app documents with one
synthetic credential, exports encrypted records, stops the original OS process,
removes its temporary database, imports to a new database and starts a new host
process at the same loopback origin. A fresh client process, given no old locators
or decrypted state, recovers both exact documents. Wrong-origin recovery and altered
ciphertext are rejected; the other app remains readable. No synthetic key appears
in the transfer. This is a local storage/host replacement, not a native passkey
trial, provider-independence proof or completed public infrastructure migration.

After the configured access deadline, the host denies reads/writes. Expiry does
not erase the database, old snapshots or exports. Retention cleanup is an explicit
operator duty: stop the host, verify the agreed retention period, and remove the
intended encrypted DB and backup files using the operator's normal filesystem
procedures. There is deliberately no public deletion or retention endpoint.
