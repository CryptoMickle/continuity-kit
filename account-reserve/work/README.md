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

This source candidate has not yet been published as an update to the earlier GitHub
snapshot. The local server below stays synthetic-only and is never the public host.
The earlier Redis proposal in the native-candidate document is historical; the approved
Work deployment uses D1. This demonstration does not establish demand or sponsor acceptance.

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

## Important limits

- The reserve contains **one immutable prepared snapshot**. It does not sync, checkpoint later edits, select the latest chain version, rotate keys or overwrite an old record. Editing the recovered copy only changes that page; export keeps those changes.
- Work encryption and account-vault protection use separate cryptographic purposes under a dedicated recovery passkey. They are not separate principals. Whoever can use that passkey can also request account unlock.
- Preparation verifies both work and the same account through a fresh recovery read and local signature challenge. A later work read exposes no signer. `openAccount()` is an explicit second step and returns full EOA signing authority; an integrating app must restrict the actions it exposes.
- A work-opening request uses one discovery assertion; explicit account unlock adds one. Complete preparation still uses one credential creation plus three assertions when creation returns PRF output, or four when it needs a fallback. These are API calls, **not a promise about Face ID or platform prompts**.
- The protocol has a separate discovery namespace. Existing reserve-v1 credentials/records are not silently migrated or reused. Public version 1 proof remains evidence for that older protocol only.
- SDK-owned mutable key buffers are cleared and operations are bounded/cancellable. JavaScript strings and caller copies of decrypted content cannot be reliably erased; callers must release their own state. Page close aborts pending work and closes the local signer.

See [protocol details](../sdk/WORK_PROTOCOL.txt) and [prize evidence gates](../delivery/WORK_RESERVE_CANDIDATE.md).
