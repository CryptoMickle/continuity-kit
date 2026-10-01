# Try ContinuityKit in your browser

A private, local trial of the current app, including the approved visual design. It uses **public synthetic credentials, sample text, a local version registry and two encrypted copies in one RAM service**. It is not a Turnstile integration, independent hosting or the physical Monad demonstration.

## Start in a clean folder

Requirements: Node.js 24+ and npm. Extract this archive into a new folder and run these commands inside `continuity-kit-browser-trial`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm start
```

Open **http://trial-recovery.localhost:4374/try.html**. The guide stays available during the primary-app outage. Use the same desktop browser for both clients.

Installation fetches the exact public dependencies in `package-lock.json`. Running the trial uses loopback services only. It needs no wallet, authenticator, account, .env file or prior browser state. The launcher ignores environment files, fixes synthetic mode, rejects command-line options and creates no persistent store. Ports 4373–4375 must be free. It fails rather than changing ports or stopping another service. Closing the terminal loses the sample work; restart `npm start` for a fresh v1. Never enter private content: the synthetic credentials are public.

## The useful question

Can an independent recovery entrance open the latest saved correction when the original app is unavailable, and distinguish it from an old but valid copy?

1. In A, choose **Open existing workspace**. The launcher prepared a public v1; this bypasses browser enrollment and is not an onboarding test.
2. Replace **Working draft** with an invented correction, such as `Corrected meeting point: south entrance, not north.` Choose **Save checkpoint**. Check that v2 is verified.
3. Expand **Demonstration tools · outages and verification tests**. Select **Mirror 1 serves an old valid copy**, then choose **Take primary offline**.
4. Close A's tab. Open B fresh from the guide and choose **Recover demo workspace**. It should return the exact correction and verified v2, with one invalid mirror response rejected. Open the result details/receipt if needed.
5. Optionally edit and export the recovered local copy. This does not save a checkpoint or grant primary signing authority.
6. To test failure, in B choose **Both mirrors serve an old valid copy** and then **Discard this session & reload**. Recover again: it must not label v1 as current. Repeat with **Registry unavailable** to check that freshness failure is explicit.
7. In B restore **Both copies healthy** and **Bring primary back**, or stop and restart the launcher to reset everything.

If a step fails, record the step and visible error. Do not repeat native authentication or create physical keys; this trial should not ask for them. The purpose is to learn where the product is useful and confusing, not to obtain a passing answer.

## Check the package

```sh
npm test
npm run typecheck
npm run build
```

Tests cover the SDK, local HTTP model, handoff and actual UI handlers with synthetic/controlled adapters. The build fixes synthetic mode. `dist/` is only a static client; use `npm start` for the local stores and two-origin trial. Do not expose this development server as public infrastructure.

`PACKAGE_MANIFEST.json` lists hashes of the included files and their source hashes. This is a **working-tree snapshot**, not a claim that uncommitted files are part of the recorded Git commit. The only transformation of copied app/SDK/test sources replaces the original local hostnames and ports with the isolated trial names/ports. The launcher, guide and package configuration are separate trial files. No .local-state, .env, chain runtime config, native credentials, outreach records or parent-project research is included.

## What this does and does not establish

This trial checks recovery and version verification against a signed local model. Separate physical testing on Monad testnet recorded real v1/v2/v3 application writes and fresh B-v2 recovery on 28 September; those records are not produced by this trial. Initial physical setup needed repair, both copies still shared one local service, and a controlled device/prompt matrix remains absent.

A simple encrypted export can also preserve content. An independent trusted version service can also help detect stale copies. ContinuityKit's additional current-version check costs setup and an available registry; it cannot recover missing bytes or establish that the app content itself is true.

No outside adoption, paid use, independent evaluation or recurring demand has been established. This package is prepared privately and has not been sent or published.

## Record an evaluation

Use `EVALUATION_NOTES.md`. Useful feedback explains a recurring real workflow, whether a simpler backup is sufficient, and which step was difficult. Do not include personal notes, passkeys, secrets or other people's content.
