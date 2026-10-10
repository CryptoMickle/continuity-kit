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

## Operate storage behind B

Use the generated `operator-runtime` modules unchanged. Keep each store in its own process and database, bound to the same generated operator profile. This example uses local ports; place the public frontend behind your configured TLS reverse proxy, preserving its original Host and Origin. Loopback listeners are not a public TLS service.

```sh
mkdir -m 700 private
node operator-runtime/cli.mjs init --profile dist/operator-profile.json --database private/alpha.db
node operator-runtime/cli.mjs init --profile dist/operator-profile.json --database private/beta.db
node operator-runtime/cli.mjs invite --file private/alpha-invitation.txt
node operator-runtime/cli.mjs invite --file private/beta-invitation.txt
node operator-runtime/host.mjs --profile dist/operator-profile.json --database private/alpha.db --invitation-file private/alpha-invitation.txt --role recovery --port 8787
# In separate processes:
node operator-runtime/host.mjs --profile dist/operator-profile.json --database private/beta.db --invitation-file private/beta-invitation.txt --role recovery --port 8789
node operator-runtime/replica-gateway.mjs --configuration private/gateway.json --port 8790
```

`private/gateway.json` contains B's exact `recoveryOrigin` and `replicas: [{"id":"alpha","port":8787},{"id":"beta","port":8789}]`. Its IDs/order must match the native profile. The gateway has fixed targets and does not select or authenticate ciphertext. The browser SDK does that.

```sh
npm run serve -- --profile profile.json --role primary --assets dist/primary --port 8786
npm run serve -- --profile profile.json --role recovery --assets dist/recovery --gateway-port 8790 --port 8788
```

The native recovery host forwards only GET/PUT for configured reserve routes. It does not expose enrollment issuance, simulated credentials, store controls or arbitrary upstream requests. Route only the appropriate frontend listener through each origin's TLS proxy. Do not proxy the operator stores' invitation endpoints to the public internet.

Two stores on one computer share the machine, gateway and B frontend. This reference does not establish separate providers. Loss of B's origin or the usable passkey can still prevent recovery. Configure retention and ownership deliberately before inviting other users; automatic snapshot updates, key migration and automatic repair are outside this protocol.

## Issue one setup permission

The operator, not a public browser endpoint, issues short-lived upload grants. Create a private file with mode `0600` containing `{"replicas":[{"id":"alpha","port":8787,"invitation":"<alpha invitation>"},{"id":"beta","port":8789,"invitation":"<beta invitation>"}]}`. Read invitation values from your private files without putting them in shell arguments, logs, tracked files or public assets. Every invitation is distinct.

```sh
npm run issue:grants -- --profile profile.json --invitations private/invitations.json --out private/setup-grants.json
```

The issuer contacts the fixed local store ports once each. It writes a new mode-0600 bundle in an existing mode-0700 directory, and never prints tokens. Each grant permits one upload attempt at its store and expires within five minutes (or earlier at profile expiry). Do this only when the recipient is ready. The bundle is a private bearer permission, **not** public configuration or a decryption key. Deliver it privately to the intended setup session. It is not a signed attestation of user identity or server ownership.

In A, write fictional text and choose preparation. In the opened B window, supply the private bundle, check it, then deliberately choose creation or the existing reserve passkey. Permission validation does not invoke the authenticator. The subsequent passkey button does; your browser/device may request more than one confirmation. Keep both windows open until every copy is independently verified. B clears the input and in-memory upload capability after the attempt.

A partial or unknown issuance can consume quota even if no bundle is returned. A partial or unknown write can leave a surviving encrypted copy. Neither path retries automatically. Keep existing passkeys, check the reserve and inspect the operator's bounded status before deliberately arranging another setup. Never infer failure means nothing was saved.

## Recover and continue

Fresh B needs only its existing passkey and one intact encrypted copy. No grant bundle, operator invitation, account address or export file is required. Opening does not write, repair or create a passkey. Conflicting authenticated copies stop; the protocol never guesses which is newest. Local edits do not modify the immutable snapshot: export TXT or JSON to keep them.

`adapter.mjs` remains the two-function editor boundary, `getText()` and `applyText(text)`. `main.mjs` calls only the installed public `/text-browser`, `/text-reserve` and `/http-store` entrypoints. It supplies no synthetic WebAuthn override. Native authentication is initiated only by explicit buttons, and page exit aborts pending operations and clears the opened local copy.

The parent repository's `npm run test:native-text` checks configuration, grant expiry and binding, frontend lifecycle/gesture boundaries, actual temporary operator databases, routing denials and a clean installed-generator build. Browser rendering checks do not authenticate. These checks are distinct from a user-run native passkey acceptance test.
