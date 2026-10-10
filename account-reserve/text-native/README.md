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
