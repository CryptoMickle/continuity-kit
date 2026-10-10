# An installed payment adapter

This example connects an application's existing account recovery to the experimental
`@continuitykit/account-reserve/payments` export. It does not create a wallet,
credential, reserve, contract or payment. The application must already have a prepared
account reserve and an explicit, reviewed payment profile.

The package is distributed as source/a local tarball; it is not published to npm.
From the repository's `account-reserve/` directory, with Node 24+:

```sh
npm ci --ignore-scripts
npm pack --ignore-scripts --pack-destination /absolute/empty/package-output
```

In a separate application, install the resulting `.tgz` as a dependency with
`npm install --ignore-scripts /absolute/package-output/continuitykit-account-reserve-0.0.1-experimental.tgz`.
Copy `actions.mjs` beside your application code. It imports only the installed public
API, never a repository-relative module. The package entry includes TypeScript declarations.

## Connect the existing recovery action

Supply the existing SDK `recoverReserve` result, or your existing primary-account
session with the same `owner`, viem local `account`, and `close()` interface. A text
reserve is not an account and cannot be used as this signing session.

```js
import { recoverReserve } from '@continuitykit/account-reserve';
import { createPaymentActions } from './actions.mjs';

const payments = createPaymentActions({
  profile: reviewedPaymentProfile,
  openExistingAccount: ({ signal }) => recoverReserve({
    config: existingReserveConfig, store: existingReserveReader, signal,
  }),
});

// Separate buttons: opening an existing key never collects a payment.
openButton.onclick = async () => {
  try { await payments.open(); showReady(); }
  catch { showOpenFailure(); }
};
collectButton.onclick = async () => {
  try {
    const result = await payments.collect(reviewedRightId);
    if (result.receipt) showReceived(result.hash);
    else showPending();
  } catch { showCheckRequired(); }
};
checkButton.onclick = async () => {
  try {
    const result = await payments.check(reviewedRightId);
    if (result.receipt) showReceived(result.hash);
    else showPending();
  } catch { showCheckFailure(); }
};
closeButton.onclick = () => payments.close();
// On component teardown, also remove the page-lifetime listener:
// payments.dispose();
```

`reviewedPaymentProfile` is trusted application configuration, with the exact
`chainId: 10143`, contract `address`, `owner`, `issuer`, `expectedRuntimeCodeHash`,
ISO `expiresAt` and `claims: [{ rightId: 1n, amount: 10000000000000000n, nonce: 0 }]`.
Use your actual approved values; do not copy fictional addresses or nonces. The
profile's right IDs and amounts are bigint values, not JSON decimal strings.
The guard rechecks chain, runtime, issuer, beneficiary, nonce, amount and fixed fees.
This remains a bounded Monad testnet adapter, not a general payment service.

The SDK factories do not request credentials, read RPCs or submit anything during
construction. The public entry has no endpoint/transport override. A deliberate
`collect` action is the only signing path. Profile configuration is not user consent;
show the amount, contract and fee bound before enabling the collection action.

## Session and failure handling

The helper closes the **parent client and recovered signer** after every collection
attempt, including errors, and on cancellation, page exit or at most five minutes.
Late authentication results after cancellation are closed immediately. Closing a
signer cannot recall a transaction already sent. Receipt checking needs no credential
or signer; it may mark a public journal entry confirmed in browser storage.

Never retry an unknown send automatically, clear its journal or create another key.
Use `check` for its existing hash. A reservation with no hash needs operator
reconciliation. The durable journal and Web Locks coordinate cooperating tabs on one
origin, not other devices/origins or hostile code. The existing passkey, recovery
origin and ciphertext still have to be available. Account recovery returns full
signing authority; this adapter does not turn it into a restricted payment key.

The installed-package tests use fictional accounts and mocked RPC responses.
They prove package consumption and boundary behavior, not native authentication,
live provider independence, external adoption or customer demand. The earlier public
two-payment testnet evidence remains a separate result.
