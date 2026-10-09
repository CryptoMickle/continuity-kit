# Authenticated work-reserve expiry cleanup

This procedure concerns only the new work reserve, release `70b323ddd108a14ca1c8c9288ccabac8`, on `https://continuitykit-work-reserve.cryptomickle.chatgpt.site`. Its fixed access deadline is 2026-11-10T00:00:00.000Z. Do not use Account Reserve v1, Delveworn or Redis credentials.

The user approved fictional example data, active deletion after that deadline and possible provider recovery history for up to 30 further days. A successful schedule creation does not prove future execution or erasure of provider backups.

## Scoped maintenance authentication

Use the native Sites `get_site` action for project `appgprj_6ac80f08ed008191b0fcc97cbf0214ed`. The caller must have access to the returned Site service credential. Do not print, save or put this credential in a URL, schedule, source, shell argument or browser. Do not send the original credential to the application Worker.

Derive a separate capability using standard HMAC-SHA-256. The HMAC key is the exact service credential as UTF-8. Its message is UTF-8 `continuitykit:work-retention:v1\n70b323ddd108a14ca1c8c9288ccabac8`, where `\n` is one newline. Encode the result as 64 lowercase hexadecimal characters. The server stores only SHA-256 of that 64-character UTF-8 capability, in `WORK_RETENTION_AUTH_HASH`.

The derived capability authenticates the maintenance caller. It does not permit reading snapshots, consuming enrollment codes, changing deadlines, choosing another namespace or deleting before expiry. The original service credential never needs to enter this Worker's configuration. Anyone able to obtain that Site service credential can derive the cleanup capability; it is not a unique identity for one scheduled task.

Credential rotation can invalidate this derivation. A rejected capability is a failure to report, not permission to alter the server hash, access rules, deadline or source. Two consistent credential reads during setup establish only current consistency.

## Invocation and readback

Send HTTPS POST to the exact origin and path `/api/retention/cleanup`, with `Content-Type: application/json`, `Authorization: Bearer <derived capability>`, body `{}`, no cookies, no query parameters and no redirects. Bound the request to 20 seconds. Keep response/error logging sanitized; never log request headers or the credential/capability.

- Before the deadline: authenticated requests return HTTP 409 and `RETENTION_NOT_DUE`. This performs the actual guarded D1 batch with no deletion. Missing/wrong credentials return 403 before accessing D1.
- After expiry: accept only HTTP 200 with `activeRecordsDeleted: true` and `remaining: 0`. Call the same idempotent endpoint once more for readback and require the same conditions. `purgedMs` may be null if nothing was ever stored; otherwise it must be at or after the fixed deadline.
- Retry only a network error, 429 or 5xx, at most three attempts with bounded backoff. An unknown deletion result is safe to check again because scope and deadline cannot change. Report non-success; never fall back to an unauthenticated writer or change the data/schema to make the job succeed.

The post-expiry route stays available even though ordinary demo routes return 410. Active deletion removes ciphertext, locator and consumed-code rows. It retains only the empty release header to prevent expiry extension/reuse. D1 recovery history is outside this endpoint's authority.
