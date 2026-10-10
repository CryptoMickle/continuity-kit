import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTextReplicaDrill } from '../scripts/text-replica-drill.mjs';

test('installed SDK survives real storage process loss and tampering through the replica gateway', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'text-replica-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = join(directory, 'assets'); await mkdir(join(assets, 'apps'), { recursive: true });
  await writeFile(join(assets, 'apps/index.html'), '<!doctype html><title>Local operator packaging test</title>');
  const output = join(directory, 'report.json');
  const result = await runTextReplicaDrill({ assets, output });
  assert.equal(result.status, 'PASSED'); assert.equal(result.sdkInstalledOffline, true); assert.equal(result.publicEntryPointsOnly, true);
  assert.equal(result.prepared.creates, 1); assert.equal(result.prepared.writes, 2); assert.equal(result.prepared.byteIdenticalEncryptedRecords, true);
  assert.equal(result.separateOnDiskDatabases, true); assert.equal(result.storageProcesses, 2); assert.equal(result.gatewayProcess, true);
  assert.equal(result.storesContainNoSamplePlaintextCredentialKeyOrInvitation, true);
  assert.equal(result.freshClientProcesses, 5); assert.equal(result.successfulExportsByteIdentical, 3);
  assert.deepEqual(result.scenarios.map(scenario => scenario.expectedVerifiedCopies), [2, 1, 1, 0]);
  for (const scenario of result.scenarios) { assert.equal(scenario.assertions, 1); assert.equal(scenario.creates, 0); assert.equal(scenario.writes, 0); assert.equal(scenario.prfOutputsZeroed, true); }
  const rejected = result.scenarios.at(-1); assert.equal(rejected.rejection, 'REPLICA_RECOVERY_FAILED'); assert.equal(rejected.plaintextReturned, false); assert.equal(rejected.exported, false);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
});
