import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runRecoveryDrill, loadFreshWorkSdk, formatDrillSummary } from '../drill/run.mjs';
import { createDrillFixture } from '../drill/fixtures.mjs';
import { startDrillHosts } from '../drill/loopback-hosts.mjs';
import { createEncryptedExport, importEncryptedExport, tamperEncryptedExport } from '../drill/encrypted-export.mjs';

test('complete real-SDK drill records the tradeoffs and writes matching finished exports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'work-recovery-drill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runRecoveryDrill({ outputDirectory: directory });
  assert.equal(report.status, 'passed', JSON.stringify(report));
  assert.equal(report.synthetic, true);
  assert.equal(report.checks.length, 10);
  assert.ok(report.checks.every(check => check.status === 'passed'));
  const outage = report.checks.find(check => check.id === 'fresh-work-recovery-during-primary-outage').observed;
  assert.deepEqual([outage.primaryBefore, outage.primaryAfter, outage.allFiveFieldsMatch, outage.expectedOwnerMatches, outage.signerExposed], [503, 503, true, true, false]);
  assert.equal(report.operations.workRecoveryStorage.primary, 0);
  assert.equal(report.operations.workRecoveryStorage.storeReads, 1);
  assert.equal(report.operations.credentialApiCalls.workRecovery.assertions, 1);
  assert.equal(report.operations.credentialApiCalls.exportRecovery.assertions, 1);
  assert.equal(report.operations.totalHttp.storeWrites, 1);
  assert.equal(report.operations.nativePromptsMeasured, false);
  assert.ok(report.comparison.some(row => row.workReserve === 'STORE_UNAVAILABLE' && row.encryptedExport === 'recovered'));
  assert.ok(report.comparison.some(row => row.workReserve === 'RESERVE_MISSING' && row.encryptedExport === 'recovered'));
  assert.ok(report.comparison.some(row => row.workReserve === 'recovered' && row.encryptedExport === 'BASELINE_FILE_MISSING'));
  assert.equal(report.exports.writtenAndReadBack, true);
  const finished = JSON.parse(await readFile(join(directory, 'finished-work.json'), 'utf8'));
  const text = await readFile(join(directory, 'finished-work.txt'), 'utf8');
  assert.match(finished.deliverable, /Address error:/);
  for (const field of ['title', 'client', 'brief', 'deliverable', 'nextStep']) assert.ok(text.includes(finished[field]));
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')), report);
  assert.equal(await readFile(join(directory, 'summary.txt'), 'utf8'), formatDrillSummary(report));
  const encrypted = await readFile(join(directory, 'encrypted-export.json'), 'utf8');
  assert.equal(encrypted.includes(finished.brief), false);
});

test('deterministic fixtures repeat outcomes while creation fallback changes observed operations', async () => {
  const first = await runRecoveryDrill({ fixture: { seed: 'repeatable-public-fixture' } });
  const second = await runRecoveryDrill({ fixture: { seed: 'repeatable-public-fixture', creationFallback: true } });
  assert.equal(first.status, 'passed'); assert.equal(second.status, 'passed');
  assert.equal(first.fixtureId, second.fixtureId);
  assert.deepEqual(first.comparison, second.comparison);
  assert.equal(first.exports.editedJsonSha256, second.exports.editedJsonSha256);
  assert.equal(first.operations.credentialApiCalls.sharedCredentialCreation.assertions, 0);
  assert.equal(second.operations.credentialApiCalls.sharedCredentialCreation.assertions, 1);
  assert.equal(second.operations.credentialApiCalls.workRecovery.assertions, 1);
});

test('encrypted-export baseline imports real encrypted bytes and rejects tampering, policy change and missing credential', async t => {
  const fixture = createDrillFixture();
  const sdk = await loadFreshWorkSdk();
  let credential;
  t.after(() => { credential?.close(); fixture.close(); });
  credential = await sdk.createWorkReserveCredential({ config: fixture.config, user: { name: 'Synthetic', displayName: 'Synthetic' }, webAuthnClient: fixture.client('create') });
  const bytes = await createEncryptedExport({ work: fixture.work, owner: fixture.owner, config: fixture.config, credential, webAuthnClient: fixture.client('protect') });
  const options = { config: fixture.config, webAuthnClient: fixture.client('import') };
  const opened = await importEncryptedExport({ ...options, bytes });
  assert.deepEqual(opened.work, fixture.work); assert.equal(opened.owner, fixture.owner);
  assert.equal('account' in opened || 'privateKey' in opened, false);
  await assert.rejects(importEncryptedExport({ ...options, bytes: tamperEncryptedExport(bytes) }), { code: 'BASELINE_AUTH_FAILED' });
  await assert.rejects(importEncryptedExport({ ...options, bytes, config: { ...fixture.config, appId: 'another-app' } }), { code: 'BASELINE_POLICY_MISMATCH' });
  await assert.rejects(importEncryptedExport({ ...options, bytes, webAuthnClient: fixture.client('lost', { credentialLost: true }) }), { code: 'BASELINE_AUTH_FAILED' });
  await assert.rejects(importEncryptedExport({ ...options, bytes: undefined }), { code: 'BASELINE_FILE_MISSING' });
  await assert.rejects(importEncryptedExport({ ...options, bytes: new TextEncoder().encode('{}') }), { code: 'BASELINE_FILE_INVALID' });
});

test('drill does not report readiness if the stored bytes cannot be read back', async () => {
  const report = await runRecoveryDrill({ hostFactory: async options => { const hosts = await startDrillHosts(options); hosts.setStoreMode('missing'); return hosts; } });
  assert.equal(report.status, 'failed');
  assert.equal(report.failure, 'READBACK_FAILED');
  assert.deepEqual(report.checks.map(check => [check.id, check.status]), [['prepare-real-work-sdk', 'failed']]);
  assert.equal(report.exports, undefined);
});

for (const mutation of ['wrong work', 'wrong owner', 'exposed signer']) test(`drill rejects a fresh recovery result with ${mutation}`, async () => {
  const report = await runRecoveryDrill({ loadSdk: async () => {
    const sdk = await loadFreshWorkSdk();
    return { ...sdk, async recoverWorkReserve(options) {
      const context = await sdk.recoverWorkReserve(options);
      if (mutation === 'wrong work') return { ...context, work: { ...context.work, brief: 'This is the wrong brief.' } };
      if (mutation === 'wrong owner') return { ...context, owner: '0x' + '1'.repeat(40) };
      return { ...context, account: { signMessage: () => {} } };
    } };
  } });
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.at(-1).id, 'fresh-work-recovery-during-primary-outage');
  assert.equal(report.checks.at(-1).status, 'failed');
  assert.equal(report.exports, undefined);
});

test('a broken tamper injection cannot produce a passing rejection report', async () => {
  const report = await runRecoveryDrill({ hostFactory: async options => {
    const hosts = await startDrillHosts(options);
    return { ...hosts, setStoreMode(mode) { hosts.setStoreMode(mode === 'tampered' ? 'healthy' : mode); } };
  } });
  assert.equal(report.status, 'failed');
  assert.equal(report.failure, 'EXPECTED_REJECTION_NOT_OBSERVED');
  assert.equal(report.checks.at(-1).id, 'tampered-ciphertext-rejected-by-both');
});

test('primary remaining available cannot be mislabeled as a successful outage test', async () => {
  const report = await runRecoveryDrill({ hostFactory: async options => ({ ...await startDrillHosts(options), setPrimaryOnline() {} }) });
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.at(-1).id, 'fresh-work-recovery-during-primary-outage');
  assert.equal(report.checks.at(-1).status, 'failed');
});
