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

// Populate the selector only from this captured, approved list.
for (const payment of payments.approvedPayments) {
  paymentSelect.add(new Option(`Payment ${payment.rightId}`, String(payment.rightId)));
}
paymentSelect.value = String(payments.selectedRightId);

// Render CURRENT state after every action. Do not display a late promise's result
// after a selection change; cancelled/stale operations reject SESSION_CLOSED.
function render() {
  const state = payments.state;
  openButton.disabled = !state.canOpen;
  collectButton.disabled = !state.isOpen || state.isBusy || state.accountBlocked;
  // A disabled selector is just UI; the helper also rejects changes during collect.
  paymentSelect.disabled = state.isBusy;
  refreshButton.disabled = state.isBusy;
  checkButton.disabled = state.isBusy;
  showPaymentState(state); // Show selected amount, contract and fee bound here.
}
async function perform(action) {
  try {
    const pending = action(); // open() invokes native auth before the first await.
    render();
    await pending;
  } catch (error) {
    if (error.code !== 'PAYMENT_SESSION_CLOSED') showPaymentError(error.code);
  } finally { render(); }
}
paymentSelect.onchange = () => {
  try { payments.select(BigInt(paymentSelect.value)); }
  catch (error) { showPaymentError(error.code); }
  paymentSelect.value = String(payments.selectedRightId);
  render(); // Selection does no I/O. Check the selected payment deliberately.
};
refreshButton.onclick = () => perform(() => payments.refreshAvailability());
openButton.onclick = () => perform(() => payments.open());
collectButton.onclick = () => perform(() => payments.collect());
checkButton.onclick = () => perform(() => payments.check());
closeButton.onclick = () => { payments.close(); render(); };
render();

// Re-render when the tab regains focus; canOpen always checks actual freshness.
// open() rechecks even if the UI did not re-render when the 30-second window ended.
window.addEventListener('focus', render);
// On component teardown:
// window.removeEventListener('focus', render);
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

## Select, check, then open

Both primary and recovery apps use the same approved list. The first approved
payment is selected initially; `select(rightId)` switches it without any network or
credential request. Refresh availability explicitly before offering **Open**.
The helper reads the selected payment through the installed public SDK. A funded
observation remains usable for at most 30 seconds measured with a monotonic clock,
and never beyond the profile expiry. Already-collected, unavailable and failed
checks cannot open a signing session. Availability is not proof of payment.

| Method or state | Meaning |
| --- | --- |
| `approvedPayments` | Frozen captured list; do not accept an arbitrary payment ID from a URL or form. |
| `select(rightId)` | Validate a listed bigint ID, close signing, discard readiness and cancel stale reads. No I/O. |
| `refreshAvailability()` | Explicit credential-free check. No localStorage or Web Lock is needed for this read. |
| `open()` | Consume fresh funded readiness and call the host's existing-key action directly. No automatic refresh, wait or collection. |
| `collect()` | Collect only the selected/opened payment, then close its signer. A supplied `collect(rightId)` must match exactly. |
| `check(rightId = selectedRightId)` | Reconcile that approved payment's existing local journal, even if a different payment is selected. |
| `state` | Frozen current selection, advisory observation, open/busy/blocking flags and selected payment outcome. No signer or key. |

`canOpen` is computed each time, so it becomes false when readiness expires even if
the browser delayed a UI timer. `open()` checks it again before any native action.
Do not await your own network request inside the Open button handler before calling
`open()`: that can lose the browser's native-authentication user gesture. The host's
`openExistingAccount` callback must also start native authentication directly.

Changing selection or calling `close()` invalidates pending reads and aborts the
host's native signal. An unfinished native prompt still counts as busy until its
promise settles; a second prompt cannot overlap it. A returned late signer is
closed. Cancelled read/authentication promises reject `PAYMENT_SESSION_CLOSED`;
a claim already in flight may preserve its original error and uncertainty. Read-only requests
already sent may still finish; cancellation suppresses their display results. A late
journal result can retain a safety block for its original payment, but cannot clear
an existing block; run a fresh explicit check to reconcile it. Selection is
rejected while collection is in flight, even after Close, because closing a session
cannot recall a transaction already sent.

## Session and failure handling

The helper closes the **parent client and recovered signer** after every collection
attempt, including errors, and on cancellation, page exit or at most five minutes.
The lifetime starts when opening begins, includes time spent in native UI, and is
checked again after authentication and before collection so a delayed browser timer
cannot extend it. Receipt checking needs no credential or signer; it may mark a
public journal entry confirmed in browser storage. Construction and availability
checks do not access the journal; journal access is deferred until needed.

Known pending hashes and uncertain reservations remain blocked across selections.
An exact successful `check` clears only its own payment's known pending state.
Checking another settled payment, refreshing availability or checking a stateless
reference cannot clear it. `state.unresolvedPayments` lists the known payment IDs;
`state.payment` reports only the selected payment, if previously attempted/checked.

An unscoped `PAYMENT_ACCOUNT_BLOCKED`, invalid/conflicting journal or intent mismatch
sets `state.unscopedAccountBlock`. This helper does not guess which other transaction
caused it and will not clear it with an unrelated receipt. Reconcile the original
attempt in its proper context and inspect the journal; recreate the helper only
after resolution. Do not use reload, journal deletion or another credential as a
retry mechanism. Final SDK guards remain authoritative on every collection attempt.

Never retry an unknown send automatically, clear its journal or create another key.
Use `check` for its existing journal entry. A reservation with no hash needs operator
reconciliation. The durable journal and Web Locks coordinate cooperating tabs on one
origin, not other devices/origins or hostile code. This helper additionally retains
known uncertainty for its own lifetime; it does not scan all history before native
authentication. The existing passkey, recovery origin and ciphertext still have to
be available. Account recovery returns full signing authority; this adapter does
not turn it into a restricted payment key.

The installed-package tests use fictional accounts, actual disposable Mera signers
and mocked RPC responses. The focused lifecycle tests use controlled SDK doubles
and also check inert construction through the real public import. They prove package
consumption and boundary behavior, not native authentication, provider independence,
external adoption or customer demand. Earlier public two-payment testnet evidence
remains a separate result.

## A receipt from another browser

Use the separate typed `createTestnetPaymentVerifier({ profile }).check({ rightId, hash })`
API for an explicit reference that is not in this browser's journal. It does not
need this example's signing helper or an opened account. Only `paymentVerified: true`
establishes the exact payment. See the [reference example](../../payments/README.md#check-a-reference-from-a-fresh-browser)
and [validation](../../evidence/payment-reference-validation-2026-10-10.json).
This read must never be used to clear or bypass an unresolved local attempt.
