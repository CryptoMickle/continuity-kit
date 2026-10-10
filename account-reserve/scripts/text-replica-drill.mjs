import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createOperatorPackage } from '../operator/create.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sample = '\ufeffREPLICA DRILL — FICTIONAL TEXT\r\n\r\nKeep the unfinished draft after a storage process fails.\r\nÅ, 界 and 🦊.\r\n';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function childRequest(pkg, file, message, timeoutMs = 20000) {
  const child = fork(join(pkg, file), [], { cwd: pkg, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  const response = new Promise((done, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; child.kill('SIGKILL'); reject(new Error('DRILL_CHILD_TIMEOUT')); }, timeoutMs);
    child.once('message', value => { if (settled) return; settled = true; clearTimeout(timer); done(value); });
    child.once('error', () => { if (settled) return; settled = true; clearTimeout(timer); reject(new Error('DRILL_CHILD_START_FAILED')); });
    child.once('exit', () => { if (settled) return; settled = true; clearTimeout(timer); reject(new Error('DRILL_CHILD_EXITED_BEFORE_RESULT')); });
    child.send({ synthetic: true, ...message });
  });
  return { child, exited, response, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref?.();
    try { return await exited; } finally { clearTimeout(timer); }
  } };
}
function records(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare('SELECT locator,ciphertext FROM operator_records ORDER BY locator').all().map(row => ({ locator: row.locator, bytes: Buffer.from(row.ciphertext) })); }
  finally { db.close(); }
}
function corruptCiphertext(database) {
  const db = new DatabaseSync(database);
  try {
    const rows = db.prepare('SELECT locator,ciphertext FROM operator_records').all(); assert.equal(rows.length, 1);
    const envelope = JSON.parse(Buffer.from(rows[0].ciphertext).toString('utf8'));
    const corrupted = Buffer.from(envelope.ciphertext, 'base64url'); corrupted[0] ^= 1; envelope.ciphertext = corrupted.toString('base64url');
    db.prepare('UPDATE operator_records SET ciphertext=? WHERE locator=?').run(Buffer.from(JSON.stringify(envelope)), rows[0].locator);
  } finally { db.close(); }
}

/** Real loopback HTTP/process/storage faults around a synthetic credential.
 * It installs the public SDK; no internal SDK helpers or prior plaintext state
 * are imported by a fresh recovery process. It does not establish independence
 * of providers, operators, devices or the reserve domain. */
export async function runTextReplicaDrill({ assets = join(root, 'dist-self-service-apps'), output } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'continuity-text-replicas-'));
  const hosts = new Set(), key = randomBytes(32), credentialId = randomBytes(24), invitation = randomBytes(32).toString('hex');
  try {
    const pkg = join(temporary, 'installed-operator');
    const packaged = await createOperatorPackage(pkg, { assets });
    for (const file of ['text-replica-host.mjs', 'text-replica-client.mjs']) await cp(join(root, 'tests/fixtures', file), join(pkg, file));
    const npm = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    const install = spawnSync(process.execPath, [npm, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'], {
      cwd: pkg, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
      env: { ...process.env, npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_update_notifier: 'false' },
    });
    assert.equal(install.status, 0, 'Offline installed-SDK setup failed');
    const configuration = { version: 1, primaryOrigin: 'https://replica-primary.example', recoveryOrigin: 'https://replica-reserve.example',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), apps: [{ id: 'textarea', label: 'Textarea', appId: 'continuity-textarea-v1' }] };
    const config = { appId: configuration.apps[0].appId, recoveryOrigin: configuration.recoveryOrigin, recoveryRpId: 'replica-reserve.example' };
    const invitationFile = join(temporary, 'invitation.txt'); await writeFile(invitationFile, invitation + '\n', { mode: 0o600 });
    const databases = ['alpha', 'beta'].map(id => join(temporary, id, 'reserve.db'));
    async function startHost(request) {
      const launched = childRequest(pkg, 'text-replica-host.mjs', request); hosts.add(launched);
      const ready = await launched.response; assert.equal(ready.ready, true, ready.error); assert.ok(Number.isInteger(ready.port));
      return { ...launched, port: ready.port };
    }
    let alpha = await startHost({ kind: 'store', configuration, database: databases[0], invitationFile, initialize: true });
    const beta = await startHost({ kind: 'store', configuration, database: databases[1], invitationFile, initialize: true });
    const alphaPort = alpha.port, originalAlphaPid = alpha.child.pid;
    assert.notEqual(alpha.child.pid, beta.child.pid); assert.notEqual(databases[0], databases[1]);
    const gateway = await startHost({ kind: 'gateway', configuration: { recoveryOrigin: config.recoveryOrigin, replicas: [{ id: 'alpha', port: alpha.port }, { id: 'beta', port: beta.port }] } });
    const base = { config, gateway: 'http://127.0.0.1:' + gateway.port, key: key.toString('hex'), credentialId: credentialId.toString('hex') };
    const clientPids = new Set();
    async function client(mode, name) {
      const exportPath = join(temporary, name + '.txt');
      const launched = childRequest(pkg, 'text-replica-client.mjs', { ...base, mode, exportPath, ...(mode === 'prepare' ? { invitation, text: sample } : {}) });
      clientPids.add(launched.child.pid);
      let result;
      try { result = await launched.response; assert.equal(result.ok, true, result.error + ':' + result.stage + (result.actualStatus ? ':' + result.actualStatus : '')); await launched.exited; }
      finally { if (launched.child.exitCode === null) await launched.stop(); }
      if (mode === 'recover') assert.deepEqual(await readFile(exportPath), Buffer.from(sample));
      else await assert.rejects(access(exportPath));
      return result;
    }
    const prepared = await client('prepare', 'prepared');
    const rows = databases.map(records); assert.equal(rows[0].length, 1); assert.equal(rows[1].length, 1);
    assert.equal(rows[0][0].locator, rows[1][0].locator); assert.deepEqual(rows[0][0].bytes, rows[1][0].bytes);
    for (const database of databases) {
      const bytes = await readFile(database);
      for (const forbidden of [Buffer.from(sample), key, credentialId, Buffer.from(invitation), Buffer.from(key.toString('hex')), Buffer.from(credentialId.toString('hex'))]) assert.equal(bytes.includes(forbidden), false);
    }
    const healthy = await client('recover', 'healthy');
    assert.equal(healthy.replicas.filter(item => item.status === 'verified').length, 2);
    const stopAlpha = await alpha.stop(); assert.equal(stopAlpha.code, 0);
    const oneStopped = await client('recover', 'one-stopped');
    assert.equal(oneStopped.replicas.find(item => item.id === 'alpha').status, 'unavailable');
    assert.equal(oneStopped.replicas.find(item => item.id === 'beta').status, 'verified');
    corruptCiphertext(databases[0]);
    alpha = await startHost({ kind: 'store', configuration, database: databases[0], invitationFile, initialize: false, port: alphaPort });
    assert.notEqual(alpha.child.pid, originalAlphaPid);
    const oneCorrupt = await client('recover', 'one-corrupt');
    assert.equal(oneCorrupt.replicas.find(item => item.id === 'alpha').status, 'rejected');
    assert.equal(oneCorrupt.replicas.find(item => item.id === 'beta').status, 'verified');
    const stopBeta = await beta.stop(); assert.equal(stopBeta.code, 0);
    const noGoodCopy = await client('reject', 'no-good-copy');
    assert.equal(noGoodCopy.replicas.find(item => item.id === 'alpha').status, 'rejected');
    assert.equal(noGoodCopy.replicas.find(item => item.id === 'beta').status, 'unavailable');
    assert.equal(noGoodCopy.exported, false); assert.equal(clientPids.size, 5);
    const report = { recordedAt: new Date().toISOString(), status: 'PASSED', protocol: 'account-continuity/text-reserve-v1',
      scope: 'Installed public SDK; synthetic credential; two real operator HTTP processes and SQLite databases behind a stable loopback replica gateway. Fresh OS client and byte-checked TXT export for every recovery.',
      sdkInstalledOffline: true, sdkIntegrity: packaged.sdkIntegrity, publicEntryPointsOnly: true,
      storageProcesses: 2, separateOnDiskDatabases: true, gatewayProcess: true, stableRecoveryOriginAndRp: true,
      prepared: { creates: prepared.creates, assertions: prepared.assertions, writes: prepared.writes, replicas: prepared.replicas, byteIdenticalEncryptedRecords: true, recordBytesEach: rows[0][0].bytes.length },
      storesContainNoSamplePlaintextCredentialKeyOrInvitation: true,
      scenarios: [
        { name: 'both-stores-healthy', ...safeResult(healthy), expectedVerifiedCopies: 2 },
        { name: 'alpha-process-stopped', ...safeResult(oneStopped), processExitObserved: true, expectedVerifiedCopies: 1 },
        { name: 'alpha-ciphertext-corrupted-and-process-restarted', ...safeResult(oneCorrupt), corruptionPersistedOnDisk: true, freshStorageProcess: true, expectedVerifiedCopies: 1 },
        { name: 'beta-stopped-with-only-corrupt-alpha-surviving', ...safeResult(noGoodCopy), processExitObserved: true, expectedVerifiedCopies: 0, plaintextReturned: false },
      ],
      successfulExportsByteIdentical: 3, sampleUtf8Bytes: Buffer.byteLength(sample), sampleSha256: sha256(Buffer.from(sample)), freshClientProcesses: clientPids.size,
      notClaimed: ['physical passkeys or Face ID prompt count', 'browser CORS or TLS deployment validation', 'independent providers or operators', 'survival after losing the recovery RP domain', 'automatic ongoing snapshot replication', 'rollback protection or a security audit', 'external adoption'] };
    if (output) await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return report;
  } finally {
    await Promise.allSettled([...hosts].map(host => host.stop()));
    key.fill(0); credentialId.fill(0);
    await rm(temporary, { recursive: true, force: true });
  }
}
function safeResult(result) { return { creates: result.creates, assertions: result.assertions, reads: result.reads, writes: result.writes,
  replicas: result.replicas, exported: result.exported, ...(result.exported ? { exportBytes: result.exportBytes, exportDigest: result.exportDigest } : {}),
  ...(result.rejection ? { rejection: result.rejection } : {}), prfOutputsZeroed: result.prfOutputsZeroed }; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/text-replica-drill.mjs [new-report.json]');
  process.stdout.write(JSON.stringify(await runTextReplicaDrill({ output: process.argv[2] }), null, 2) + '\n');
}
