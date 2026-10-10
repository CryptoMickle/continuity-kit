import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTextReserveCredential, prepareTextReserve } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { configuration } from './config.mjs';
import { startTextStarter } from './server.mjs';
import { loopbackFetch } from './loopback-fetch.mjs';
import { syntheticClient } from './synthetic-client.mjs';
import { runDoctor } from './doctor.mjs';
import { captureText, restoreText, exportText, textareaAdapter } from './adapter.mjs';

async function port() { const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }); const value = server.address().port; await new Promise(done => server.close(done)); return value; }
async function fresh(origin, directory) {
  await mkdir(directory);
  return await new Promise((done, reject) => {
    const child = fork(new URL('./recover-process.mjs', import.meta.url), [], { stdio: ['ignore','ignore','pipe','ipc'] });
    let report, errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('FRESH_RECOVERY_TIMEOUT')); }, 15000);
    child.stderr.on('data', data => { if (errors.length < 3000) errors += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('message', value => { report = value; });
    child.on('exit', code => { clearTimeout(timer); if (code || !report?.ok) reject(new Error(JSON.stringify(report ?? { error: errors }))); else done(report); });
    child.send({ origin, directory });
  });
}
const primaryPort = await port(); let recoveryPort = await port(); while (recoveryPort === primaryPort) recoveryPort = await port();
const settings = configuration(primaryPort, recoveryPort), directory = await mkdtemp(join(tmpdir(), 'continuity-text-starter-test-'));
let app, credential, store;
const previousLocation = globalThis.location;
try {
  assert.equal((await runDoctor({ settings })).ok, true);
  assert.equal((await runDoctor({ settings: { ...settings, recoveryOrigin: settings.originalOrigin } })).ok, false);
  app = await startTextStarter({ primaryPort, recoveryPort });
  assert.equal((await runDoctor({ settings, live: true })).ok, true);
  assert.equal((await runDoctor({ settings })).ok, false, 'occupied ports produce an actionable failure');
  const a = loopbackFetch(app.originalOrigin), b = loopbackFetch(app.recoveryOrigin);
  const env = await (await b('/api/config')).json(); globalThis.location = { origin: app.recoveryOrigin };
  const sample = '\uFEFF# Fictional brief — ÆØÅ 📝\r\n\r\nKeep this correction.\r\nLiteral <script> stays text.\r\n';
  // Browsers normalize textarea CRLF on assignment; unchanged exports preserve
  // the original bytes. Real editing intentionally uses browser text semantics.
  let view = ''; const element = { get value() { return view; }, set value(value) { view = value.replace(/\r\n?/g, '\n'); } };
  const editor = textareaAdapter(element); restoreText(sample, editor); assert.equal(captureText(editor), sample); assert.equal(exportText(editor), sample);
  element.value += 'Edit'; assert.equal(exportText(editor), sample.replaceAll('\r\n', '\n') + 'Edit'); editor.clear();
  assert.throws(() => restoreText('\ud800', editor), /TEXT_INVALID/); assert.throws(() => restoreText('x'.repeat(16385), editor), /TEXT_TOO_LARGE/);
  const auth = syntheticClient(b); credential = await createTextReserveCredential({ config: env.config, webAuthnClient: auth, user: { name: 'Fictional starter test', displayName: 'LOCAL SIMULATION' } });
  store = createReserveHttpStore({ enrollmentToken: env.enrollmentToken, fetcher: b });
  const ready = await prepareTextReserve({ config: env.config, recoveryCredential: credential, text: sample, store, webAuthnClient: auth });
  assert.equal(ready.independentlyVerified, true); assert.equal(ready.text, sample); credential.close(); store.clearEnrollmentCapability();
  assert.equal((await b('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"online":false}' })).status, 200);
  assert.equal((await a('/')).status, 503); assert.equal((await a('/api/config')).status, 503);
  const before = await (await b('/api/status')).json();
  for (const name of ['first','second']) {
    const target = join(directory, name); assert.equal((await fresh(app.recoveryOrigin, target)).noSetupInputs, true);
    assert.deepEqual(await readFile(join(target, 'original.txt')), Buffer.from(sample, 'utf8'));
    assert.equal(JSON.parse(await readFile(join(target, 'original.json'), 'utf8')).text, sample);
    assert.deepEqual(await readFile(join(target, 'edited.txt')), Buffer.from(sample + '\nFinished in B.', 'utf8'));
  }
  const after = await (await b('/api/status')).json();
  assert.equal(after.counts.primary, before.counts.primary, 'fresh recovery does not contact A');
  assert.equal(after.counts.creates, 1); assert.equal(after.counts.writes, 1); assert.equal(after.counts.assertions - before.counts.assertions, 2);
  assert.equal(after.records, 1); assert.equal(after.primaryOnline, false);
  console.log(JSON.stringify({ ok: true, mode: 'synthetic local only', publicSdk: true, freshRecoveryProcesses: 2, primaryHttp503: true, noPrimaryRecoveryRequests: true, exactUtf8Exports: true, immutableSnapshotUnchanged: true, physicalPasskeyProof: false, productionServer: false }));
} finally { credential?.close(); store?.clearEnrollmentCapability(); globalThis.location = previousLocation; await app?.close(); await rm(directory, { recursive: true, force: true }); }
