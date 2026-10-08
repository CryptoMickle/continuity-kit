import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMessage } from 'viem';
import { makeDerivedSdkFixture } from './sdk-derived-fixture.mjs';

export async function runInstalledConsumer(kind) {
  const f = await makeDerivedSdkFixture(kind);
  const temp = await mkdtemp(join(tmpdir(), 'installed-reserve-records-'));
  try {
    const start = f.stats().recoveryRequests;
    const ready = await f.prepare();
    assert.equal(ready.status, 'ready');
    const prepareAssertions = f.stats().recoveryRequests - start;
    const baselineStart = f.stats().recoveryRequests;
    const baselineBytes = await f.exportEncryptedBaseline();
    const baselinePrepareAssertions = f.stats().recoveryRequests - baselineStart;
    const baselinePath = join(temp, 'competent-encrypted-export.json');
    await writeFile(baselinePath, baselineBytes, { mode: 0o600 });
    const index = new Map(f.store.records().map(([locator, bytes]) => [locator, new Uint8Array(bytes)]));
    f.closeOriginal();
    await assert.rejects(() => f.baselineRestoreOriginal(), (error) => error.code === 'PASSKEY_OPERATION_FAILED');
    const originalRequests = f.stats().originalRequests;
    const ownerForTestAssertionOnly = f.policy.expectedOwner;
    const resolved = import.meta.resolve('@continuitykit/account-reserve');
    const fresh = await import(`${resolved}?fresh-consumer=${randomBytes(8).toString('hex')}`);
    const recoveryStart = f.stats().recoveryRequests;
    const recovered = await fresh.recoverReserve({
      config: { ...f.config }, webAuthnClient: f.newRecoveryClient(),
      store: { async get(locator) { const bytes = index.get(locator); return bytes && new Uint8Array(bytes); } },
    });
    const recoveryAssertions = f.stats().recoveryRequests - recoveryStart;
    const message = `SYNTHETIC INSTALLED CONSUMER ${kind} ${randomBytes(32).toString('hex')}`;
    try {
      assert.equal(recovered.owner, ownerForTestAssertionOnly);
      assert.equal(await verifyMessage({ address: ownerForTestAssertionOnly, message, signature: await recovered.account.signMessage({ message }) }), true);
    } finally { recovered.close(); }
    const baselineRecoveryStart = f.stats().recoveryRequests;
    const baseline = await f.importEncryptedBaseline(new Uint8Array(await readFile(baselinePath)));
    const baselineRecoveryAssertions = f.stats().recoveryRequests - baselineRecoveryStart;
    try {
      assert.equal(baseline.owner, ownerForTestAssertionOnly);
      assert.equal(await verifyMessage({ address: ownerForTestAssertionOnly, message, signature: await baseline.account.signMessage({ message }) }), true);
    } finally { baseline.close(); }
    assert.equal(f.stats().originalRequests, originalRequests);
    assert.equal(prepareAssertions, 4); assert.equal(recoveryAssertions, 2);
    assert.equal(baselinePrepareAssertions, 1); assert.equal(baselineRecoveryAssertions, 1);
    return {
      kind, success: true, sourceDerivedFixtureNotIntegration: true,
      sameExistingOwner: true, freshSignatureVerified: true, originalClientInvocationsDuringRecovery: 0,
      competentAvailableExportAlsoWorks: true,
      apiMeasurementsNotHumanUx: {
        candidate: { preparationAssertionsIncludingIndependentCheck: prepareAssertions, recoveryAssertions, recoveryRequiresExternalFileOrOwnerInput: false },
        encryptedExport: { preparationAssertions: baselinePrepareAssertions, recoveryAssertions: baselineRecoveryAssertions, recoveryRequiresAvailableEncryptedFile: true },
        noPhysicalPromptClaim: true,
      },
      conclusion: 'Both recover. Discovery removes the file input; it adds authenticator calls. This proves neither simpler human UX nor adoption.',
    };
  } finally { f.cleanup(); await rm(temp, { recursive: true, force: true }); }
}

if (process.argv.includes('--consumer')) {
  const kind = process.argv[process.argv.indexOf('--consumer') + 1];
  console.log(JSON.stringify(await runInstalledConsumer(kind)));
}
