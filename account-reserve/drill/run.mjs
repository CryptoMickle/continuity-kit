import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDrillFixture } from './fixtures.mjs';
import { startDrillHosts } from './loopback-hosts.mjs';
import * as encryptedExport from './encrypted-export.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeError = value => /^[A-Z][A-Z0-9_]{1,63}$/.test(value?.code ?? value?.message ?? '') ? value.code ?? value.message : 'DRILL_CHECK_FAILED';
const fail = code => Object.assign(new Error(code), { code });
const clone = work => JSON.parse(JSON.stringify(work));
const countDelta = (after, before) => Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]));
const textExport = work => `${work.title}\n${work.client}\n\nBRIEF\n${work.brief}\n\nWORKING DRAFT\n${work.deliverable}\n\nNEXT STEP\n${work.nextStep}\n`;
let moduleCounter = 0;
export const loadFreshWorkSdk = () => import(new URL(`../sdk/work-reserve.mjs?drill=${moduleCounter++}-${randomUUID()}`, import.meta.url));

async function rejected(action, allowedCodes) {
  try { const result = await action(); result?.close?.(); }
  catch (error) {
    const code = safeError(error);
    if (allowedCodes && !allowedCodes.includes(code)) throw error;
    return { rejected: true, error: code };
  }
  throw fail('EXPECTED_REJECTION_NOT_OBSERVED');
}

/** Runs actual Work SDK and Mera encryption against disposable local HTTP hosts.
 * Injection is for deterministic fixtures and negative tests, not live credentials.
 * Random encryption nonces are preserved; ciphertext is intentionally not stable. */
export async function runRecoveryDrill({ fixture: fixtureOptions, fixtureFactory = createDrillFixture, hostFactory = startDrillHosts, loadSdk = loadFreshWorkSdk, baseline = encryptedExport, outputDirectory } = {}) {
  const report = {
    format: 'continuity-work-recovery-drill/v1', generatedAt: new Date().toISOString(), status: 'running', synthetic: true,
    scope: 'Developer drill using real Work SDK and Mera encryption, synthetic PRF credential and two disposable loopback HTTP hosts. No native passkeys, public hosting, blockchain, funds or human timing.',
    checks: [], comparison: [], operations: {},
    limitations: [
      'Fixture credentials and unfunded account are public deterministic test material. Never use them for real work or funds.',
      'This tests local application unavailability, not browser isolation, cross-device sync, provider durability or production security.',
      'The encrypted-export baseline protects the same private work and owner binding with the same credential. It does not export the optional account leaf; Work preparation also verifies that separate vault.',
      'API/assertion and storage-call counts are measured operations, not Face ID prompts, human steps or elapsed usability time.',
      'Both methods need trusted recovery/import code, the retained credential and their surviving encrypted bytes. Neither recovers a lost credential.',
      'Both protect one prepared snapshot. Continued edits need another intentional export and do not update the reserve.',
    ],
  };
  let fixture, hosts, credential, opened, retainedFile, finished;
  async function prove(id, action) {
    try { const observed = await action(); report.checks.push({ id, status: 'passed', observed }); return observed; }
    catch (error) { report.checks.push({ id, status: 'failed', error: safeError(error) }); throw error; }
  }
  let freshLoads = 0;
  async function freshRecovery(phase, options) {
    const sdk = await loadSdk(); freshLoads++;
    return sdk.recoverWorkReserve({ config: fixture.config, store: hosts.newStore(), webAuthnClient: fixture.client(phase, { workOnly: true, ...options }) });
  }
  const verifyWork = result => {
    assert.deepEqual(result.work, fixture.work);
    assert.equal(result.owner, fixture.owner);
    assert.equal('account' in result || 'session' in result || 'privateKey' in result, false);
  };
  try {
    report.implementation = {
      node: process.version,
      workSdkSha256: digest(await readFile(new URL('../sdk/work-reserve.mjs', import.meta.url))),
      baselineSha256: digest(await readFile(new URL('./encrypted-export.mjs', import.meta.url))),
      injectedTestAdapters: fixtureFactory !== createDrillFixture || hostFactory !== startDrillHosts || loadSdk !== loadFreshWorkSdk || baseline !== encryptedExport,
    };
    fixture = fixtureFactory(fixtureOptions); report.fixtureId = fixture.fixtureId;
    const sdk = await loadSdk();
    hosts = await hostFactory({ enrollmentToken: fixture.enrollmentToken });
    await prove('prepare-real-work-sdk', async () => {
      assert.equal(await hosts.primaryStatus(), 200);
      credential = await sdk.createWorkReserveCredential({ config: fixture.config, user: { name: 'Synthetic developer drill', displayName: 'Synthetic developer drill' }, webAuthnClient: fixture.client('sharedCredentialCreation') });
      const before = hosts.counts();
      const ready = await sdk.prepareWorkReserve({ privateKey: fixture.privateKey, policy: { ...fixture.config, expectedOwner: fixture.owner }, work: fixture.work, recoveryCredential: credential, store: hosts.newStore({ writable: true }), webAuthnClient: fixture.client('workPreparation') });
      assert.equal(ready.independentlyVerified, true); assert.equal(ready.owner, fixture.owner);
      report.operations.workPreparationStorage = countDelta(hosts.counts(), before);
      return { independentlyVerified: ready.independentlyVerified, ownerBound: true, immutableRecords: hosts.storedBytes().length };
    });
    await prove('prepare-and-independently-import-encrypted-file', async () => {
      retainedFile = await baseline.createEncryptedExport({ work: fixture.work, owner: fixture.owner, config: fixture.config, credential, webAuthnClient: fixture.client('exportProtection') });
      const checked = await baseline.importEncryptedExport({ bytes: retainedFile, config: fixture.config, webAuthnClient: fixture.client('exportReadbackVerification') });
      verifyWork(checked);
      assert.equal(new TextDecoder().decode(retainedFile).includes(fixture.work.deliverable), false);
      return { samePreparedWork: true, sameCredential: true, independentlyImported: true, encryptedFileBytes: retainedFile.length };
    });
    credential.close(); credential = undefined; fixture.privateKey.fill(0);
    const originalRecord = hosts.storedBytes()[0];
    await prove('fresh-work-recovery-during-primary-outage', async () => {
      hosts.setPrimaryOnline(false);
      assert.equal(await hosts.primaryStatus(), 503);
      const before = hosts.counts();
      opened = await freshRecovery('workRecovery'); verifyWork(opened);
      assert.equal(fixture.operations().workRecovery.accountPrfDenied, 0);
      assert.equal(hosts.counts().primary, before.primary);
      report.operations.workRecoveryStorage = countDelta(hosts.counts(), before);
      finished = sdk.validateWork({ ...clone(opened.work), deliverable: opened.work.deliverable + '\n\nAddress error: Check the postcode and delivery address before continuing.\nConfirmation: Your order is confirmed. Keep this confirmation for your records.', nextStep: 'Fictional copy handoff ready for review.' });
      opened.close(); opened = undefined;
      assert.equal(await hosts.primaryStatus(), 503);
      return { primaryBefore: 503, primaryAfter: 503, allFiveFieldsMatch: true, expectedOwnerMatches: true, originalAppRequestsDuringRecovery: 0, signerExposed: false, accountVaultPrfRequests: 0, suppliedLocatorOrOwnerOrPrivateKey: false };
    });
    await prove('retained-encrypted-file-also-recovers-during-outage', async () => {
      const before = hosts.counts();
      verifyWork(await baseline.importEncryptedExport({ bytes: retainedFile, config: fixture.config, webAuthnClient: fixture.client('exportRecovery') }));
      assert.deepEqual(hosts.counts(), before);
      report.comparison.push({ condition: 'Primary unavailable; file and reserve storage retained', workReserve: 'recovered', encryptedExport: 'recovered', dependencyDifference: 'Reserve discovers bytes through credential + host. Export imports retained file + credential.' });
      return { recovered: true, hostRequests: 0 };
    });
    await prove('missing-file-retained-host', async () => {
      const rejection = await rejected(() => baseline.importEncryptedExport({ bytes: undefined, config: fixture.config, webAuthnClient: fixture.client('missingFile') }), ['BASELINE_FILE_MISSING']);
      const context = await freshRecovery('workWithNoExportFile'); try { verifyWork(context); } finally { context.close(); }
      report.comparison.push({ condition: 'Encrypted export file missing; reserve storage retained', workReserve: 'recovered', encryptedExport: rejection.error, dependencyDifference: 'Credential-driven reserve discovery avoids requiring the retained file.' });
      return { ...rejection, workReserveRecovered: true };
    });
    for (const [mode, expected] of [['missing', 'RESERVE_MISSING'], ['unavailable', 'STORE_UNAVAILABLE']]) await prove(`retained-file-${mode}-host`, async () => {
      hosts.setStoreMode(mode);
      const rejection = await rejected(() => freshRecovery('workHost' + mode), [expected]);
      const before = hosts.counts();
      verifyWork(await baseline.importEncryptedExport({ bytes: retainedFile, config: fixture.config, webAuthnClient: fixture.client('exportHost' + mode) }));
      assert.deepEqual(hosts.counts(), before);
      report.comparison.push({ condition: `Reserve host ${mode}; encrypted file retained`, workReserve: rejection.error, encryptedExport: 'recovered', dependencyDifference: 'The retained file wins here: no reserve host or database is needed.' });
      hosts.setStoreMode('healthy');
      return { workReserve: rejection.error, encryptedExportRecovered: true, exportHostRequests: 0 };
    });
    await prove('tampered-ciphertext-rejected-by-both', async () => {
      hosts.setStoreMode('tampered');
      const reserve = await rejected(() => freshRecovery('tamperedWork'), ['MANIFEST_AUTH_FAILED']);
      const file = await rejected(() => baseline.importEncryptedExport({ bytes: encryptedExport.tamperEncryptedExport(retainedFile), config: fixture.config, webAuthnClient: fixture.client('tamperedExport') }), ['BASELINE_AUTH_FAILED']);
      hosts.setStoreMode('healthy');
      report.comparison.push({ condition: 'Encrypted bytes altered', workReserve: reserve.error, encryptedExport: file.error, dependencyDifference: 'Both must reject unauthenticated content.' });
      return { workReserve: reserve.error, encryptedExport: file.error };
    });
    await prove('lost-credential-is-not-recovered-by-either-method', async () => {
      const reserve = await rejected(() => freshRecovery('lostCredentialWork', { credentialLost: true }));
      const file = await rejected(() => baseline.importEncryptedExport({ bytes: retainedFile, config: fixture.config, webAuthnClient: fixture.client('lostCredentialExport', { credentialLost: true }) }), ['BASELINE_AUTH_FAILED']);
      report.comparison.push({ condition: 'Recovery credential unavailable', workReserve: reserve.error, encryptedExport: file.error, dependencyDifference: 'Neither design solves credential loss.' });
      return { workReserve: reserve.error, encryptedExport: file.error };
    });
    await prove('continued-edit-export-preserves-original-reserve', async () => {
      const json = JSON.stringify(finished, null, 2) + '\n', text = textExport(finished);
      assert.deepEqual(sdk.validateWork(JSON.parse(json)), finished);
      assert.notEqual(finished.deliverable, fixture.work.deliverable);
      assert.equal(finished.brief, fixture.work.brief);
      assert.deepEqual(hosts.storedBytes()[0], originalRecord);
      assert.equal(hosts.counts().storeWrites, 1);
      const context = await freshRecovery('immutableSnapshotCheck'); try { verifyWork(context); } finally { context.close(); }
      assert.equal(await hosts.primaryStatus(), 503);
      report.exports = { json: 'finished-work.json', text: 'finished-work.txt', encryptedBaseline: 'encrypted-export.json', editedJsonSha256: digest(json), editedTextSha256: digest(text), storedSnapshotUnchanged: true };
      return { editedContentPresent: true, originalBriefPreserved: true, snapshotStillOriginal: true, totalReserveWrites: 1, primaryStill503: true };
    });
    report.operations.credentialApiCalls = fixture.operations();
    report.operations.freshSdkRecoveryLoads = freshLoads;
    report.operations.totalHttp = hosts.counts();
    report.operations.nativePromptsMeasured = false;
    report.verdict = 'Both methods recovered the same private work. Work Reserve avoids supplying a retained file, but adds host-storage availability. A correctly retained encrypted export worked even when the reserve host or stored record was unavailable. This drill does not establish user preference or general superiority.';
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = safeError(error);
    if (fixture) report.operations.credentialApiCalls = fixture.operations();
  } finally { opened?.close(); credential?.close(); fixture?.close(); await hosts?.close(); }
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    if ((await lstat(outputDirectory)).isSymbolicLink()) throw fail('OUTPUT_SYMLINK_REJECTED');
    if (report.status === 'passed') {
      const outputs = { 'finished-work.json': JSON.stringify(finished, null, 2) + '\n', 'finished-work.txt': textExport(finished), 'encrypted-export.json': retainedFile };
      for (const [path, bytes] of Object.entries(outputs)) {
        await writeFile(join(outputDirectory, path), bytes, { flag: 'wx' });
        assert.equal(digest(await readFile(join(outputDirectory, path))), digest(bytes));
      }
      report.exports.writtenAndReadBack = true;
    }
    await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(outputDirectory, 'summary.txt'), formatDrillSummary(report), { flag: 'wx' });
  }
  return report;
}

export function formatDrillSummary(report) {
  const lines = [`ContinuityKit recovery drill — ${report.status.toUpperCase()}`, 'SYNTHETIC FIXTURES. No native passkey, blockchain, funds or human timing.', ''];
  for (const check of report.checks) lines.push(`${check.status === 'passed' ? 'PASS' : 'FAIL'} ${check.id}${check.error ? ' (' + check.error + ')' : ''}`);
  if (report.failure) lines.push('Stopped: ' + report.failure);
  lines.push('', 'Functional comparison:');
  for (const row of report.comparison) lines.push(`- ${row.condition}: reserve=${row.workReserve}; export=${row.encryptedExport}. ${row.dependencyDifference}`);
  lines.push('', 'Measured credential API operations (not device prompts):');
  for (const [phase, counts] of Object.entries(report.operations.credentialApiCalls ?? {})) lines.push(`- ${phase}: create=${counts.creates}, assertions=${counts.assertions}, account-PRF denied=${counts.accountPrfDenied}`);
  if (report.verdict) lines.push('', report.verdict);
  lines.push('', ...report.limitations.map(value => 'Boundary: ' + value), '');
  return lines.join('\n');
}
