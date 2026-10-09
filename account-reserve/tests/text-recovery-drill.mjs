import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runTextRecoveryDrill, startTextDrillHosts, textDrillAuthenticator, createTextEncryptedFile, importTextEncryptedFile, tamperTextCiphertext } from '../drill/text-drill.mjs';

test('account-free comparison uses real outage, fresh processes and exactly matching finished exports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'text-recovery-drill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runTextRecoveryDrill({ outputDirectory: directory });
  assert.equal(report.status, 'passed'); assert.equal(report.synthetic, true); assert.equal(report.comparison.length, 6);
  assert.equal(report.operations.totalHttp.storeWrites, 1);
  assert.deepEqual(report.operations.sharedCredentialCreation, { creates: 1, assertions: 0 });
  assert.deepEqual(report.operations.reservePreparation, { creates: 0, assertions: 1 });
  assert.deepEqual(report.operations.encryptedFilePreparation, { creates: 0, assertions: 2 });
  assert.match(report.encryptedFileStorage, /independently imported in a fresh process before the outage/);
  assert.equal(report.operations.nativePromptsMeasured, false); assert.equal(report.operations.humanStepsMeasured, false);
  assert.equal(report.operations.signups, 0); assert.equal(report.operations.signingActions, 0);
  for (const row of report.comparison) for (const result of [row.textReserve, row.encryptedFile]) {
    assert.equal(result.primaryBefore, 503); assert.equal(result.primaryAfter, 503); assert.equal(result.httpDelta.primary, 0);
    assert.equal(result.httpDelta.storeWrites, 0); assert.equal(result.credentialApiCalls.creates, 0);
    if (result.status === 'recovered') assert.equal(result.exactTextAndDigestMatch, true);
    assert.equal('text' in result, false);
  }
  const healthy = report.comparison[0];
  assert.deepEqual(healthy.textReserve.credentialApiCalls, { creates: 0, assertions: 1 });
  assert.deepEqual(healthy.encryptedFile.credentialApiCalls, { creates: 0, assertions: 1 });
  assert.equal(healthy.textReserve.httpRequests, 1); assert.equal(healthy.encryptedFile.httpRequests, 0);
  assert.deepEqual(report.comparison.map(row => [row.textReserve.status, row.encryptedFile.status]), [
    ['recovered', 'recovered'], ['recovered', 'BASELINE_FILE_MISSING'], ['RESERVE_MISSING', 'recovered'],
    ['STORE_UNAVAILABLE', 'recovered'], ['MANIFEST_AUTH_FAILED', 'BASELINE_AUTH_FAILED'], ['PASSKEY_OPERATION_FAILED', 'BASELINE_KEY_UNAVAILABLE'],
  ]);
  assert.equal(report.exports.writtenAndReadBack, true);
  const text = await readFile(join(directory, 'text-reserve.txt'), 'utf8'), json = await readFile(join(directory, 'text-reserve.json'), 'utf8');
  assert.equal(text, await readFile(join(directory, 'encrypted-file.txt'), 'utf8'));
  assert.equal(json, await readFile(join(directory, 'encrypted-file.json'), 'utf8'));
  assert.equal(JSON.parse(json).text, text); assert.match(text, /Å, 界, 🦊/); assert.equal(text.charCodeAt(0), 0xfeff); assert.ok(text.includes('\r\n'));
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')), report);
  assert.equal((await readFile(join(directory, 'encrypted-backup.json'), 'utf8')).includes('Original draft'), false);
});

test('encrypted-file baseline is functional and rejects tampering, wrong policy and unavailable credential', async t => {
  const credential = { id: randomBytes(24).toString('base64url'), secret: randomBytes(32).toString('base64url') };
  const auth = textDrillAuthenticator(credential); t.after(() => auth.close());
  const config = { appId: 'text-baseline-test', recoveryOrigin: 'https://reserve.example', recoveryRpId: 'reserve.example' };
  const text = '\ufeff\r\nÅ, 界, 🦊.\0';
  const file = await createTextEncryptedFile({ text, config, credential: { credentialId: credential.id }, webAuthnClient: auth.client });
  assert.equal((await importTextEncryptedFile({ bytes: file, config, webAuthnClient: auth.client })).text, text);
  await assert.rejects(importTextEncryptedFile({ bytes: tamperTextCiphertext(file), config, webAuthnClient: auth.client }), { code: 'BASELINE_AUTH_FAILED' });
  await assert.rejects(importTextEncryptedFile({ bytes: file, config: { ...config, appId: 'other' }, webAuthnClient: auth.client }), { code: 'BASELINE_POLICY_MISMATCH' });
  await assert.rejects(importTextEncryptedFile({ bytes: undefined, config, webAuthnClient: auth.client }), { code: 'BASELINE_FILE_MISSING' });
  const lost = textDrillAuthenticator({ ...credential, secret: null }); t.after(() => lost.close());
  await assert.rejects(importTextEncryptedFile({ bytes: file, config, webAuthnClient: lost.client }), { code: 'BASELINE_KEY_UNAVAILABLE' });
});

test('an unchanged healthy primary cannot be labeled as an outage success', async () => {
  await assert.rejects(runTextRecoveryDrill({ hostFactory: async () => ({ ...await startTextDrillHosts(), setPrimaryOnline() {} }) }), { code: 'PRIMARY_NOT_OFFLINE' });
});

test('a broken corruption injection cannot produce a passing comparison', async () => {
  await assert.rejects(runTextRecoveryDrill({ hostFactory: async () => {
    const hosts = await startTextDrillHosts();
    return { ...hosts, setStoreMode(mode) { hosts.setStoreMode(mode === 'tampered' ? 'healthy' : mode); } };
  } }), { code: 'EXPECTED_OUTCOME_NOT_OBSERVED' });
});
