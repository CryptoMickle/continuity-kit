# Private work continuation

Prepare a reserve for a specific unfinished piece of work and its existing account.
If the original app is unavailable, open the prepared brief, finish the deliverable
and export a local copy without unlocking account signing.

The separate public Work Sites use native passkeys and bounded D1 storage. On 9 October,
a fresh application page on Mac recovered the exact prepared work while A returned 503;
A was restored afterward. Completed copy was exported through the UI and the saved TXT
and JSON files were compared. Safari/iPhone recovery with the existing passkey is
explicitly user-confirmed, but no direct iPhone screen/full-content proof has been
collected. See [portable evidence](../evidence/work-public-proof.json) and the
[finished example](../delivery/examples/finished-checkout.txt).

The Work implementation and its physical evidence are [published at commit
`3e309345`](https://github.com/CryptoMickle/continuity-kit/tree/3e3093456ebbf7765e40967b83b120a1cbc54b97/account-reserve).
The playground, Textarea integration, recovery drill and optional-payment example below
are included in this updated source tree; use this revision for their commands. The local server below
stays synthetic-only and is never the public host.
The earlier Redis proposal in the native-candidate document is historical; the approved
Work deployment uses D1. This demonstration does not establish demand or sponsor acceptance.

## Try the flow

The [judge playground](https://continuitykit-playground.cryptomickle.chatgpt.site/)
is published as the first stop. It uses the real
Work encryption flow with fictional, browser-local credentials. No passkey, wallet or
setup code is required. It can demonstrate edit, prepare, recover, continue and export;
it does not demonstrate a website outage, physical authentication or independent storage.
For the verified native result and separate Monad account proof, see the
[judge guide](../delivery/JUDGE_GUIDE.md).

Run the same playground locally with `npm run dev:playground` from the project root.

## Run

From the account-reserve project, with Node 24 and the locked dependencies installed:

```sh
npm run build:work
npm run typecheck:work
npm run test:work
npm run dev:work
```

Open <http://work-primary.localhost:5073/>. Use the fictional brief, create the disposable example account, then prepare the reserve in the second origin. After the independent check, take A offline and open a fresh reserve page. Open the prepared work, finish the deliverable and export it. An optional, separate account check signs only a local challenge and closes its signer; it sends no transaction.

The loopback server only permits synthetic credentials. No native keys, testnet accounts, chain, wallet, public RPC or real money are used. It keeps ciphertext and synthetic authentication material in RAM. Restarting the server erases this example. Both origins run in one process; this demonstrates failure of A's frontend/API, not independent hosting or survival of operator loss.

## Integration

Use `/work-reserve` for the protocol and `/work-browser` for the two-window handoff. The existing `/http-store` transport also works. The old `/browser` and core reserve-v1 APIs remain unchanged.

```js
import { recoverWorkReserve } from '@continuitykit/account-reserve/work-reserve';

// B needs the app configuration and a reader, not the account address,
// locator, saved file or original browser session.
const reserve = await recoverWorkReserve({ config, store });
try {
  showEditor({ ...reserve.work }); // reading does not open a signer
  // Only after a separate deliberate account action:
  // const signer = await reserve.openAccount();
  // try { ...an explicitly scoped application action... }
  // finally { signer.close(); }
} finally {
  reserve.close();
}
```

In an actual integration, A supplies its existing derived EOA leaf and a plain-text work snapshot to `startWorkReserveSetup`. It must not create a replacement identity. This demo uses a disposable random example leaf because it is an isolated protocol/UI test.

The work schema is `{schema:'continuity-work/brief-v1',title,client,brief,deliverable,nextStep}`. Only plain string fields are accepted; canonical JSON is limited to 16 KiB. Title and client are limited to 256 JavaScript string code units each. There is no HTML execution, rich text, attachment upload or automatic publishing.

### An existing editor as a packaged consumer

The [Textarea integration](../integrations/textarea/README.md) runs Anton Medvedev's
actual MIT-licensed Textarea editor at pinned commit
`8aa2247e4d92d963059e8788624e0c0d1be8d6a3`. Its document maps to `deliverable`;
the adapter supplies the other four Work fields. The unchanged upstream source and
license are retained and checked against their recorded hashes. The generated consumer
installs a local SDK tarball and imports only public SDK entry points.

From this source checkout, choose an empty destination:

```sh
node integrations/textarea/create.mjs /absolute/path/to/textarea-work-demo
cd /absolute/path/to/textarea-work-demo
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

Open <http://textarea-primary.localhost:5373/>. The reserve origin is
<http://textarea-reserve.localhost:5374/>. `npm test` in the generated consumer
executes the pinned editor in JSDOM, prepares through the installed SDK, makes A return
503 and recovers through a new Node process. It checks every Work field, owner binding,
continued editing/JSON export and immutable storage. URL-fragment persistence and the
upstream service worker are disabled so recovered text does not enter the URL or cache.
The upstream first-line tab title remains and may appear in browser history.

This is an agent-built integration with independently authored application code, not
upstream adoption or an independent developer's evaluation. It is local and synthetic;
the server is never a deployable service. JSDOM is not browser, download or native-passkey
evidence. From the source checkout, `npm run test:oss-work` also verifies the clean,
locked installation and build after dependencies have been cached.

### Test the backup tradeoff

```sh
npm run drill:work
npm run test:drill
```

The [recovery drill](../drill/README.md) runs the real SDK against two disposable
HTTP hosts and compares it with a functioning encrypted-file export of the same work,
protected by the same synthetic credential. Both recover while A is unavailable.
Work Reserve succeeds when the file is missing but hosted ciphertext survives; the
encrypted export succeeds when its file survives but the reserve host or record does not.
Both reject tampered ciphertext and fail without their recovery credential.

The reviewed run's ten checks and measured operation counts are in
[`evidence/work-drill-2026-10-09.json`](../evidence/work-drill-2026-10-09.json) and
its [readable report](../evidence/work-drill-2026-10-09.txt). Counts describe SDK and
storage operations, not human time or device prompts. The file baseline contains private
work, not an account key; preparation counts are not an equal-feature account benchmark.
The result establishes a dependency tradeoff, not general superiority to backup.

### Optional collection through the same account

The [local entitlement example](../examples/work-entitlement/README.md) binds a
fictional job's work to an already-issued payment right. Work opens, is edited and
exported with signing locked. A separate opt-in action opens the same account, collects
that existing right once and closes the signer. It does not issue or earn payment by
editing the draft, and the contract does not attest completion of the work.

With Node 24+, locked dependencies and local Foundry Anvil available:

```sh
npm run demo:work-entitlement
npm run demo:work-entitlement -- --claim-existing-payment
npm run test:work-entitlement
```

Each command creates a disposable local example on chain 31337. There is no public RPC
or real money. See [`evidence/work-entitlement-local-2026-10-09.json`](../evidence/work-entitlement-local-2026-10-09.json)
for the six passing checks and exact scope. This combined local flow is separate from
the historical Account Reserve payment on Monad testnet.

## Important limits

- The reserve contains **one immutable prepared snapshot**. It does not sync, checkpoint later edits, select the latest chain version, rotate keys or overwrite an old record. Editing the recovered copy only changes that page; export keeps those changes.
- Work encryption and account-vault protection use separate cryptographic purposes under a dedicated recovery passkey. They are not separate principals. Whoever can use that passkey can also request account unlock.
- Preparation verifies both work and the same account through a fresh recovery read and local signature challenge. A later work read exposes no signer. `openAccount()` is an explicit second step and returns full EOA signing authority; an integrating app must restrict the actions it exposes.
- A work-opening request uses one discovery assertion; explicit account unlock adds one. Complete preparation still uses one credential creation plus three assertions when creation returns PRF output, or four when it needs a fallback. These are API calls, **not a promise about Face ID or platform prompts**.
- The protocol has a separate discovery namespace. Existing reserve-v1 credentials/records are not silently migrated or reused. Public version 1 proof remains evidence for that older protocol only.
- SDK-owned mutable key buffers are cleared and operations are bounded/cancellable. JavaScript strings and caller copies of decrypted content cannot be reliably erased; callers must release their own state. Page close aborts pending work and closes the local signer.

See [protocol details](../sdk/WORK_PROTOCOL.txt) and [prize evidence gates](../delivery/WORK_RESERVE_CANDIDATE.md).
