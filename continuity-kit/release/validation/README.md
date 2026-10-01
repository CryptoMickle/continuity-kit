# Local Workers/D1 compatibility

This isolated tooling package runs a compiled ContinuityKit candidate in Cloudflare's local `workerd` runtime using Miniflare **4.20260730.0** (workerd **1.20260730.1**). Version 4 was the stable major selected from npm on 1 October; the then-current default tag was a version 5 alpha. The app's dependency files and candidate bytes are unchanged.

First build a candidate from the project root using the release builder. The example below assumes it was written to `delivery/local-export/my-release`. Run these commands from `release/validation`; substitute the path if you chose another output directory.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check -- --candidate ../../delivery/local-export/my-release --output /private/tmp/continuity-runtime-result-new.json
```

Use a new output filename; the check refuses to overwrite a result. It requires Node 24+ and permission to run a local binary and bind loopback ports. It verifies all candidate hashes before starting. An expired candidate fails explicitly.

The test creates disposable local D1 storage and uses a public synthetic upload token. It applies the candidate's generated migrations through the D1 API, serves all 12 compiled client assets, checks security headers and closed routes, stops A independently, exercises the real store's authorization/CORS/immutable writes and quotas, then restarts the runtime against the same temporary storage. Instances are disposed and temporary data removed on completion or error.

Outbound requests from the tested Workers are rejected and counted. No remote binding, account credential, deploy command, passkey operation or chain call is configured. This is a runtime compatibility check, not a browser/native-authentication test or a hosted Sites/D1 result. The exact Sites compatibility date and cloud migration runner remain separate release checks.

Test-harness fixes during development: set `modulesRoot` to the candidate so workerd does not receive a module path escaping its root; use `dispatchFetch` for ordinary store HTTP requests rather than `getWorker().fetch`, whose development-control proxy rejects foreign Origin headers. Neither fix changed installed dependencies or application code.

References: [Cloudflare D1 testing](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/), [Miniflare setup](https://developers.cloudflare.com/workers/testing/miniflare/get-started/), consulted 1 October 2026.
