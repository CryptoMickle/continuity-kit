import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { recoverReserve } from '@continuitykit/account-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { createTestnetPaymentAvailability, createTestnetPaymentVerifier } from '@continuitykit/account-reserve/payments';
import { createPaymentActions } from './actions.mjs';
import { argumentsFrom, readPaymentStarterProfile } from './build.mjs';
import { runPaymentStarterDoctor } from './doctor.mjs';
import { startPaymentPreview } from './serve.mjs';

/** Installed, credential-free structural smoke; not a native recovery or payment proof. */
export async function runPaymentStarterSmoke({ profile, out } = {}) {
  const report = await runPaymentStarterDoctor({ profile, origin: profile.recoveryOrigin, out });
  assert.equal(report.ok, true, 'PROFILE_OR_BUILD_CHECK_FAILED');
  assert.equal(typeof recoverReserve, 'function'); assert.equal(typeof createReserveHttpStore, 'function');
  assert.equal(typeof createTestnetPaymentAvailability({ profile: profile.payment }).check, 'function');
  assert.equal(typeof createTestnetPaymentVerifier({ profile: profile.payment }).check, 'function');
  let nativeCalls = 0;
  const actions = createPaymentActions({ profile: profile.payment, openExistingAccount: () => { nativeCalls++; throw new Error('UNEXPECTED_AUTHENTICATION'); }, lifetimeTarget: new EventTarget() });
  try {
    assert.equal(actions.selectedRightId, profile.payment.claims[0].rightId);
    assert.equal(actions.canOpen, false); assert.equal(actions.isOpen, false);
    await assert.rejects(actions.open(), error => error.code === 'PAYMENT_AVAILABILITY_REQUIRED');
    for (const claim of profile.payment.claims) { actions.select(claim.rightId); assert.equal(actions.selectedRightId, claim.rightId); assert.equal(actions.canOpen, false); }
    assert.equal(nativeCalls, 0);
  } finally { actions.dispose(); }
  const preview = await startPaymentPreview({ out, port: 0 });
  try {
    const response = await fetch(preview.url); assert.equal(response.status, 200); assert.match(await response.text(), /type="module"/);
    assert.match(response.headers.get('permissions-policy'), /publickey-credentials-get=\(\)/);
    assert.equal((await fetch(new URL('payment-config.json', preview.url))).status, 200);
    assert.equal((await fetch(new URL('api/reserve/' + 'a'.repeat(64), preview.url))).status, 404);
    assert.equal((await fetch(preview.url, { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(new URL('build-report.json', preview.url))).status, 404);
  } finally { await preview.close(); }
  return Object.freeze({ ok: true, installedPublicSdk: true, helperConstructionAndSelectionInert: true, localStaticPreview: true, reserveProxy: false, physicalPasskeyVerified: false, paymentsSent: 0, networkScope: 'owned-loopback-preview-only' });
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = argumentsFrom(process.argv.slice(2)); console.log(JSON.stringify(await runPaymentStarterSmoke({ profile: await readPaymentStarterProfile(args.profile), out: args.out }))); }
  catch { console.error('PAYMENT_STARTER_SMOKE_FAILED'); process.exitCode = 1; }
}
