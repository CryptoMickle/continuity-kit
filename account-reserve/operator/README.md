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
