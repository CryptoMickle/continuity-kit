# Isolated reserve-store release candidate

Local preparation only. Nothing in this directory deploys, enables a public
route, creates a database/account, changes an existing ContinuityKit service, or
calls a public chain. The existing application is not automatically rewired.

The Fetch-compatible `createReserveHandler` serves only the new B origin's
`GET /api/reserve/:locator` and `PUT /api/reserve/:locator`. It has no original-A
dependency, signer, private key, wallet route, public admin endpoint, or ticket
issuer. Missing/disabled configuration returns 503 before contacting storage.

## Operator configuration

`profile` has exactly `version: 1`, `enabled`, a random 32-hex `releaseId`,
`recoveryOrigin` (one exact HTTPS origin with no port/path), and canonical ISO UTC
`expiresAt` (at most 45 days ahead). The independently configured `allowedOrigins` must contain exactly
that approved B origin. The placeholder is `https://account-reserve.example.invalid`;
it is an example, not a deployed or approved site. Do not reuse an old release
ID, namespace, credential, or old ContinuityKit routes/profile.

`command` is a server-only Redis command function. `createRedisRestCommand` can
provide it using an explicit HTTPS endpoint and its own exact endpoint allowlist.
Keep the database token only in server configuration. The transport never follows
redirects, retries writes, or forwards provider errors. Response size and time are
bounded. Configure a durable/no-eviction database; do not clear its release hash.

Storage uses **one** `accountreserve:v1:<releaseId>` hash. Lua atomically creates
the ciphertext and consumes its ticket. Existing objects cannot be overwritten,
including by the same token with different bytes. At most 16 records of 64 KiB
can be created in an intact release namespace. Redis server time enforces expiry;
the hash is set to expire at that deadline, so this candidate deletes its stored
data after expiry. It must not be described as lasting backup storage.

## Enrollment capability

Anonymous public writes are disabled. The operator prepares 32-byte random
capabilities offline and installs only their SHA-256 hashes in server-only
`enrollmentTickets` (at most 16). Each grant is `{hash, locator}`. A concrete
locator prebinds the capability. `locator: "*"` is allowed when the new B passkey
does not yet exist: its first successful write atomically binds and consumes the
capability. It never permits a second object. A rejected overwrite does not
consume a previously unused capability.

`prepare-release.mjs` can generate a new protected output directory containing a
disabled server profile and a separate secret enrollment file. It prints paths
only. Its arguments are output directory, B origin, canonical expiry (within 45
days), and optional count. Do not run it as part of deployment startup; do not
commit or publish the secret file. Enabling its output still requires selecting
the approved origin, backend and expiry. No production enrollment capability has
been generated as part of building this candidate.

The operator delivers one capability only to the approved enrollment ceremony.
The frontend passes it to `createReserveHttpStore({enrollmentToken})` in memory.
It is sent once in the PUT Authorization header and is not stored in a URL,
manifest, ciphertext record, browser storage or log. Clear it after canceled
setup. The adapter refuses another PUT after an attempted write, even when the
response is lost. Fresh recovery uses `createReserveHttpStore()` and requires
only the existing B passkey and encrypted record; no capability is needed for GET.
The origin is enforced by the actual browser request and server configuration.

After enrollment closes, `enrollmentTickets: []` permits existing recovery reads
while denying every new PUT. Neither B recovery nor its server needs to retain
an enrollment capability or write grant to read already stored ciphertext.

A capability is a one-write bearer permission, not a passkey/owner identity
attestation. Anyone holding it can spend it on garbage and deny that enrollment.
Protect its delivery, use a locator-bound grant when practical, and never expose
capabilities as public demo source/configuration. SHA-256 hashes alone disclose
no practical capability for these high-entropy tokens.

## Readiness and limits

A 201 response proves only a storage write. The unchanged SDK still requires
exact readback, fresh public discovery, owner consistency and a challenge
signature before it reports a prepared reserve. After an ambiguous PUT, do not
repeat enrollment; use fresh recovery with the existing credential. GET 404 is
missing data; storage failures return 503 and are not misreported as missing.

This is not a hard billing cap: unauthenticated ciphertext reads and rejected
requests can still incur hosting/provider charges. Production approval must
include edge rate limits/budget controls and backend durability. The 16-write
guarantee assumes the authoritative Redis namespace is retained and not reset,
evicted, rolled back or maliciously changed. A server/operator that can erase all
state can reset a quota; the protocol does not pretend otherwise. Expired data
cannot be recreated under the same profile because both handler and Redis reject
the old absolute deadline.

Ciphertext is public to anyone who knows its opaque locator. Confidentiality and
manifest authenticity remain the SDK's responsibility. This store cannot prove
independent operators, prevent compromised B from misusing a recovered signer,
revoke copied EOA keys, or establish product demand.
