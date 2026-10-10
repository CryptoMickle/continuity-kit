import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fork, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createOperatorPackage } from '../operator/create.mjs';
import { canonical, hash } from '../operator/profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const texts = ['PORTABILITY-A — fictional document.\r\nÅ and 界.\n', '\ufeffPORTABILITY-B — another fictional draft.\nUnfinished: write the closing line.\n'];
async function freePort() { const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port; await new Promise(done => server.close(done)); return port; }
async function host(pkg, configuration, database, invitationFile, port) {
  const child = spawn(process.execPath, [join(pkg, 'host.mjs'), '--profile', configuration, '--database', database, '--invitation-file', invitationFile,
    '--assets', join(pkg, 'public'), '--role', 'recovery', '--port', String(port)], { cwd: pkg, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('OPERATOR_START_TIMEOUT')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error('OPERATOR_START_FAILED:' + code + ':' + errors.slice(0, 160))); });
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) { try { assert.equal(JSON.parse(output.trim()).ready, true); clearTimeout(timer); done(); } catch (error) { clearTimeout(timer); reject(error); } } });
  });
  return { pid: child.pid, async stop() { if (child.exitCode !== null) return; const ended = new Promise(done => child.once('exit', done)); child.kill('SIGTERM'); await ended; } };
}
async function worker(pkg, message) {
  const child = fork(join(pkg, 'drill-worker.mjs'), [], { cwd: pkg, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  const result = await new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('CLIENT_TIMEOUT')); }, 20000);
    child.once('message', value => { clearTimeout(timer); done(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(Error('CLIENT_FAILED:' + errors.slice(0, 160))); } });
    child.send(message);
  });
  assert.equal(result.ok, true, JSON.stringify(result)); return { pid: child.pid, ...result };
}
function command(pkg, action, profilePath, database, file) {
  const args = [join(pkg, 'cli.mjs'), action, '--profile', profilePath, '--database', database, ...(file ? ['--file', file] : [])];
  const result = spawnSync(process.execPath, args, { cwd: pkg, encoding: 'utf8' });
  assert.equal(result.status, 0, 'operator ' + action + ': ' + result.stderr); return JSON.parse(result.stdout);
}
export async function runOperatorPortabilityDrill({ assets = join(root, 'dist-self-service-apps'), output, retain = false } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'continuity-operator-portability-'));
  let running; const syntheticKey = randomBytes(32), credentialId = randomBytes(24);
  try {
    const pkg = join(work, 'installed-operator'); await createOperatorPackage(pkg, { assets });
    const npm = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    const install = spawnSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--offline'], {
      cwd: pkg, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
      env: { ...process.env, npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_update_notifier: 'false' },
    });
    assert.equal(install.status, 0, 'Offline installed-SDK consumer: ' + install.stderr.slice(0, 1000));
    const port = await freePort(), primaryPort = await freePort();
    const configuration = { version: 1, primaryOrigin: 'http://127.0.0.1:' + primaryPort, recoveryOrigin: 'http://127.0.0.1:' + port,
      expiresAt: new Date(Date.now() + 86400000).toISOString(), apps: [
        { id: 'textarea', label: 'Textarea', appId: 'continuity-textarea-v1' },
        { id: 'markdown', label: 'Markdown Studio', appId: 'continuity-markdown-v1' },
      ] };
    const profilePath = join(work, 'profile.json'), invitationFile = join(work, 'invitation.txt'), invitation = randomBytes(32).toString('hex');
    await writeFile(profilePath, JSON.stringify(configuration)); await writeFile(invitationFile, invitation + '\n', { mode: 0o600 });
    const original = join(work, 'original-instance'), replacement = join(work, 'replacement-instance'), tampered = join(work, 'tampered-instance');
    await mkdir(original); await mkdir(replacement); await mkdir(tampered);
    const sourceDb = join(original, 'reserve.db'), targetDb = join(replacement, 'reserve.db'), transfer = join(work, 'encrypted-transfer.json');
    command(pkg, 'init', profilePath, sourceDb);
    running = await host(pkg, profilePath, sourceDb, invitationFile, port); const originalPid = running.pid;
    const base = { synthetic: true, profile: configuration, key: syntheticKey.toString('hex'), credentialId: credentialId.toString('hex'), texts };
    const prepared = await worker(pkg, { ...base, mode: 'prepare', invitation });
    await running.stop(); running = undefined;
    const exported = command(pkg, 'export', profilePath, sourceDb, transfer);
    const transferBytes = await readFile(transfer), transferText = transferBytes.toString('utf8'), parsed = JSON.parse(transferText);
    assert.equal(parsed.payload.records.length, 2); assert.equal(parsed.payload.issuedCapabilities, 2);
    for (const forbidden of [...texts, invitation, base.key, base.credentialId]) assert.equal(transferText.includes(forbidden), false);
    assert.equal(Object.hasOwn(parsed.payload, 'capabilities'), false);
    await rm(original, { recursive: true }); await assert.rejects(access(sourceDb));
    const imported = command(pkg, 'import', profilePath, targetDb, transfer);
    assert.equal(imported.pendingCapabilitiesTransferred, false);
    running = await host(pkg, profilePath, targetDb, invitationFile, port); const replacementPid = running.pid;
    const recovered = await worker(pkg, { ...base, mode: 'recover' });
    const wrongOrigin = await worker(pkg, { ...base, mode: 'wrong-origin' });
    assert.notEqual(prepared.pid, recovered.pid); assert.notEqual(originalPid, replacementPid);
    // A second post-import snapshot demonstrates byte preservation and quota preservation.
    const reexport = join(work, 'reexport.json'); command(pkg, 'export', profilePath, targetDb, reexport);
    assert.deepEqual(await readFile(reexport), transferBytes);
    await running.stop(); running = undefined;
    const changed = JSON.parse(transferText);
    const outer = JSON.parse(Buffer.from(changed.payload.records[0].bytes, 'base64url').toString('utf8'));
    const corrupted = Buffer.from(outer.ciphertext, 'base64url'); corrupted[0] ^= 1; outer.ciphertext = corrupted.toString('base64url');
    // Identify app0's record via its lookup request rather than assuming SQL sort
    // matches app order: test each config in a fresh worker until AEAD rejects.
    changed.payload.records[0].bytes = Buffer.from(canonical(outer)).toString('base64url');
    changed.sha256 = hash(canonical(changed.payload));
    const altered = join(work, 'tampered-transfer.json'); await writeFile(altered, canonical(changed));
    const tamperDb = join(tampered, 'reserve.db'); command(pkg, 'import', profilePath, tamperDb, altered);
    running = await host(pkg, profilePath, tamperDb, invitationFile, port);
    const tamperResult = await worker(pkg, { ...base, mode: 'tampered-either' });
    const report = { recordedAt: new Date().toISOString(), status: 'PASSED', scope: 'Synthetic loopback operator replacement using installed SDK in separate OS processes; not native passkeys or a public hosting migration.',
      packageInstalled: true, sameRecoveryOrigin: true, originalProcessStopped: true, originalStoreRemoved: true,
      oneSyntheticCredential: true, distinctAppRecords: 2, transferContainsOnlyCiphertextAndPublicBinding: true,
      noPlaintextCredentialOrInvitationInTransfer: true, transferBytes: exported.bytes, ciphertextArchiveByteIdenticalAfterImport: true,
      lifetimeAdmissionCountPreserved: true, outstandingCapabilitiesTransferred: false,
      prepared: { creates: prepared.creates, writes: prepared.writes }, recovered: { freshProcess: true, creates: recovered.creates, writes: recovered.writes, exactTexts: recovered.textMatches },
      wrongOriginRejectedBeforeAuthenticator: wrongOrigin.assertions === 0, changedCiphertextRejected: tamperResult.rejected === 1,
      unchangedOtherAppRecovered: tamperResult.unmodifiedRecovered === 1,
      notClaimed: ['physical passkey portability', 'provider or operator independence', 'recovery after losing the RP domain', 'production security audit', 'external adoption'] };
    if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally { await running?.stop(); syntheticKey.fill(0); credentialId.fill(0); if (!retain) await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw Error('Usage: node scripts/operator-portability-drill.mjs [output.json]');
  process.stdout.write(JSON.stringify(await runOperatorPortabilityDrill({ output: process.argv[2] }), null, 2) + '\n');
}
