import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createTextStarter } from '../scripts/create-text-starter.mjs';
import { configuration, validateConfiguration, validateEnvironment, portsFromArgs } from '../text-starter/config.mjs';
import { validateText } from '../sdk/text-reserve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH,
  npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_update_notifier: 'false', npm_config_offline: 'true' };
function run(args, cwd, ok = true) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore','pipe','pipe'] }); let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CONSUMER_TIMEOUT')); }, 60000);
    child.stdout.on('data', value => { if (stdout.length < 100000) stdout += value; }); child.stderr.on('data', value => { if (stderr.length < 100000) stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); try { if (ok) assert.equal(code, 0, stderr + stdout); else assert.notEqual(code, 0); done({ code, stdout, stderr }); } catch (error) { reject(error); } });
  });
}
test('text starter validates exact origins and refuses occupied or source-alias destinations', async () => {
  assert.throws(() => configuration(5973, 5973), /PORT_COLLISION/);
  assert.throws(() => configuration(0, 5974), /PORT_INVALID/);
  assert.throws(() => portsFromArgs(['--primary-port=5973','--primary-port=5975']), /ARGUMENT_INVALID/);
  assert.throws(() => validateConfiguration({ ...configuration(), config: { ...configuration().config, recoveryRpId: 'localhost' } }), /CONFIG_INVALID/);
  assert.throws(() => validateConfiguration({ ...configuration(), recoveryOrigin: configuration().recoveryOrigin + '/' }), /CONFIG_INVALID/);
  await assert.rejects(createTextStarter(join(root, 'text-starter/not-created')), /TARGET_MUST_BE_OUTSIDE_SOURCE/);
  const directory = await mkdtemp(join(tmpdir(), 'text-starter-paths-'));
  try {
    await mkdir(join(directory, 'occupied')); await mkdir(join(directory, 'occupied/keep'));
    await assert.rejects(createTextStarter(join(directory, 'occupied')), /TARGET_MUST_BE_EMPTY/);
    assert.deepEqual(await readdir(join(directory, 'occupied')), ['keep']);
    await symlink(root, join(directory, 'source-alias'));
    await assert.rejects(createTextStarter(join(directory, 'source-alias/not-created')), /TARGET_MUST_BE_OUTSIDE_SOURCE/);
    await assert.rejects(createTextStarter(join(directory, 'source-alias')), /TARGET_MUST_BE_OUTSIDE_SOURCE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('late configuration completion cannot restore plaintext or start enrollment after pagehide', async () => {
  const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
  const { JSDOM } = require('jsdom');
  const html = await readFile(join(root, 'text-starter/index.html'), 'utf8');
  const main = (await readFile(join(root, 'text-starter/main.mjs'), 'utf8')).replace(/^import .*;\n/gm, '');
  const adapterSource = (await readFile(join(root, 'text-starter/adapter.mjs'), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ');
  const { captureText, restoreText, exportText, textareaAdapter } = new Function('validateText', adapterSource + '\nreturn {captureText,restoreText,exportText,textareaAdapter};')(validateText);
  for (const role of ['primary', 'recovery']) {
    const settings = configuration(), origin = role === 'primary' ? settings.originalOrigin : settings.recoveryOrigin;
    const dom = new JSDOM(html, { url: origin + '/', runScripts: 'outside-only' });
    const { window } = dom; let finishJson, receives = 0, stores = 0;
    window.AbortController = AbortController; window.AbortSignal = AbortSignal;
    window.fetch = async () => ({ ok: true, json: () => new Promise(done => { finishJson = done; }) });
    window.__deps = { captureText, restoreText, exportText, textareaAdapter, validateEnvironment,
      syntheticClient: () => ({}), startTextReserveSetup() { throw new Error('UNEXPECTED_SETUP'); },
      createTextReserveReceiver() { receives++; throw new Error('UNEXPECTED_RECEIVER'); },
      createReserveHttpStore() { stores++; throw new Error('UNEXPECTED_STORE'); }, recoverTextReserve() { throw new Error('UNEXPECTED_RECOVERY'); } };
    try {
      const boot = window.eval('(async () => { const { ' + Object.keys(window.__deps).join(',') + ' } = window.__deps;\n' + main + '\n})()');
      await new Promise(done => setImmediate(done)); assert.equal(typeof finishJson, 'function');
      window.dispatchEvent(new window.Event('pagehide'));
      finishJson({ ...settings, synthetic: true, role, ...(role === 'recovery' ? { enrollmentToken: 'a'.repeat(43) } : {}) }); await boot;
      assert.equal(window.document.getElementById('draft').value, '');
      assert.equal(window.document.getElementById('draft').disabled, true);
      assert.match(window.document.getElementById('status').textContent, /This view is closed/);
      assert.equal(receives, 0); assert.equal(stores, 0);
    } finally { window.close(); }
  }
});
test('recovery preserves visible edits, and late or uncertain operations never restart setup', async () => {
  const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url)), { JSDOM } = require('jsdom');
  const html = await readFile(join(root, 'text-starter/index.html'), 'utf8');
  const main = (await readFile(join(root, 'text-starter/main.mjs'), 'utf8')).replace(/^import .*;\n/gm, '');
  const adapterSource = (await readFile(join(root, 'text-starter/adapter.mjs'), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ');
  const adapter = new Function('validateText', adapterSource + '\nreturn {captureText,restoreText,exportText,textareaAdapter};')(validateText);
  const tick = () => new Promise(done => setImmediate(done));
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  async function fixture(enrollment) {
    const settings = configuration(), dom = new JSDOM(html, { url: settings.recoveryOrigin + '/', runScripts: 'outside-only' });
    const { window } = dom, pending = [], preparation = deferred(), counts = { prepare: 0, clear: 0, native: 0, storage: 0 };
    const synthetic = {}, $ = id => window.document.getElementById(id);
    window.AbortController = AbortController; window.AbortSignal = AbortSignal;
    Object.defineProperty(window.navigator, 'credentials', { value: { get() { counts.native++; throw new Error('NATIVE_FORBIDDEN'); }, create() { counts.native++; throw new Error('NATIVE_FORBIDDEN'); } } });
    window.Storage.prototype.setItem = () => { counts.storage++; throw new Error('STORAGE_FORBIDDEN'); };
    window.fetch = async path => { assert.ok(['/api/config','/api/status'].includes(path)); return { ok: true, json: async () => path === '/api/config'
      ? { ...settings, synthetic: true, role: 'recovery', ...(enrollment ? { enrollmentToken: 'a'.repeat(43) } : {}) }
      : { primaryOnline: true } }; };
    window.__deps = { ...adapter, validateEnvironment, syntheticClient: () => synthetic,
      startTextReserveSetup() { throw new Error('UNEXPECTED_SETUP'); },
      createTextReserveReceiver() { return { isEnrollment: enrollment, dispose() {}, prepare(options) { counts.prepare++; assert.equal(options.webAuthnClient, synthetic); return preparation.promise; } }; },
      createReserveHttpStore() { return { clearEnrollmentCapability() { counts.clear++; } }; },
      recoverTextReserve(options) { assert.equal(options.webAuthnClient, synthetic); const result = deferred(); pending.push({ ...result, signal: options.signal }); return result.promise; } };
    await window.eval('(async () => { const { ' + Object.keys(window.__deps).join(',') + ' } = window.__deps;\n' + main + '\n})()');
    return { window, $, pending, preparation, counts, close: () => dom.window.close() };
  }
  const recovery = await fixture(false);
  try {
    recovery.$('recover').click(); assert.equal(recovery.pending.length, 1);
    recovery.pending[0].resolve({ text: 'Original snapshot.' }); await tick();
    assert.equal(recovery.$('draft').value, 'Original snapshot.'); assert.equal(recovery.$('recover').hidden, true);
    recovery.$('draft').value = 'Changed locally, not saved back.';
    assert.equal(recovery.$('recover').hidden, true, 'no exposed action silently replaces unsaved edits');
    assert.equal(recovery.$('clear').hidden, false); recovery.$('clear').click(); assert.equal(recovery.$('draft').value, '');
    assert.equal(recovery.$('recover').hidden, false); recovery.$('recover').click();
    assert.equal(recovery.pending.length, 2); recovery.window.dispatchEvent(new recovery.window.Event('pagehide'));
    assert.equal(recovery.pending[1].signal.aborted, true); recovery.pending[1].resolve({ text: 'Must not reappear after navigation.' }); await tick();
    assert.equal(recovery.$('draft').value, ''); assert.match(recovery.$('status').textContent, /This view is closed/);
    assert.equal(recovery.counts.native, 0); assert.equal(recovery.counts.storage, 0);
  } finally { recovery.close(); }
  for (const outcome of ['unknown', 'late']) {
    const enrollment = await fixture(true);
    try {
      enrollment.$('receive').click(); assert.equal(enrollment.counts.prepare, 1); assert.equal(enrollment.$('receive').hidden, true);
      if (outcome === 'unknown') {
        enrollment.preparation.reject(Object.assign(new Error('STORE_WRITE_UNKNOWN'), { code: 'STORE_WRITE_UNKNOWN', recordMayExist: true })); await tick();
        assert.equal(enrollment.$('recover').hidden, false); assert.equal(enrollment.$('receive').hidden, true);
        assert.match(enrollment.$('status').textContent, /STORE_WRITE_UNKNOWN/); assert.equal(enrollment.counts.clear, 1);
      } else {
        enrollment.window.dispatchEvent(new enrollment.window.Event('pagehide'));
        enrollment.preparation.resolve({ text: 'Late prepared text must remain hidden.' }); await tick();
        assert.equal(enrollment.$('draft').value, ''); assert.match(enrollment.$('status').textContent, /This view is closed/);
      }
      assert.equal(enrollment.counts.prepare, 1); assert.equal(enrollment.counts.native, 0); assert.equal(enrollment.counts.storage, 0);
    } finally { enrollment.close(); }
  }
});
test('installed account-free starter builds, diagnoses and recovers in fresh processes with A unavailable', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'text-starter-consumer-'));
  try {
    const report = await createTextStarter(directory); assert.equal(report.status, 'Files only; not installed or started');
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies), ['@continuitykit/account-reserve']); assert.deepEqual(Object.keys(manifest.devDependencies), ['vite']);
    assert.equal(manifest.devDependencies.vite, '8.3.1');
    const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/@continuitykit/account-reserve'].integrity, report.sdkIntegrity);
    assert.ok(!Object.hasOwn(lock.packages, 'node_modules/jsdom'));
    // No package present: doctor must explain the missing installed SDK/build.
    const missing = JSON.parse((await run(['doctor.mjs','--primary-port=5975','--recovery-port=5976'], directory, false)).stdout);
    assert.equal(missing.checks.find(item => item.name === 'Installed public SDK entrypoints').ok, false);
    assert.match(missing.checks.find(item => item.name === 'Installed public SDK entrypoints').advice, /npm ci/);
    await run([npmCli,'ci','--offline','--ignore-scripts','--no-audit','--no-fund'], directory);
    const installedTarget = join(directory, 'installed-generator-output');
    // Explicitly invoke through macOS's /tmp alias: argv and import.meta.url
    // can otherwise disagree, silently skipping a broken CLI main guard.
    const alias = directory.replace(/^\/private\/tmp\//, '/tmp/');
    const installed = await run([join(alias, 'node_modules/@continuitykit/account-reserve/scripts/create-text-starter.mjs'), installedTarget], directory);
    assert.equal(JSON.parse(installed.stdout).directory, installedTarget);
    assert.ok((await readdir(installedTarget)).includes('package-lock.json'));
    await run([npmCli,'run','build'], directory);
    // Smoke chooses fresh ports and includes static/live doctor, native-free
    // assertions, two fresh recovery processes, exports and a real A HTTP 503.
    const smoke = await run([npmCli,'test'], directory);
    const result = JSON.parse(smoke.stdout.trim().split('\n').at(-1));
    assert.equal(result.exactUtf8Exports, true); assert.equal(result.freshRecoveryProcesses, 2);
    assert.equal(result.noPrimaryRecoveryRequests, true); assert.equal(result.immutableSnapshotUnchanged, true);
    assert.equal(result.physicalPasskeyProof, false); assert.equal(result.productionServer, false);
    const main = await readFile(join(directory, 'main.mjs'), 'utf8');
    assert.match(main, /@continuitykit\/account-reserve\/text-browser/);
    assert.doesNotMatch(main, /localStorage|sessionStorage|navigator\.credentials|\.\.\/sdk/);
    assert.match(main, /webAuthnClient = syntheticClient/);
    const html = await readFile(join(directory, 'dist/index.html'), 'utf8'); assert.match(html, /Local simulation/);
    assert.match(await readFile(join(directory, 'README.md'), 'utf8'), /Never deploy/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
