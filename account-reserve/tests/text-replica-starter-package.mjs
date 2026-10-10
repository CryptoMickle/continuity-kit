import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTextStarter } from '../scripts/create-text-starter.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH,
  ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}), npm_config_update_notifier: 'false', npm_config_offline: 'true' };
function run(args, cwd) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore','pipe','pipe'] }); let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CONSUMER_TIMEOUT')); }, 90000);
    child.stdout.on('data', value => { if (stdout.length < 100000) stdout += value; }); child.stderr.on('data', value => { if (stderr.length < 100000) stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); try { assert.equal(code, 0, stderr + stdout); done(stdout); } catch (error) { reject(error); } });
  });
}
test('replica starter is runnable from the installed generator, including the unchanged operator runtime', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'text-replica-package-'));
  try {
    await assert.rejects(createTextStarter(join(directory, 'invalid'), { replicas: 'yes' }), /OPTIONS_INVALID/);
    const bootstrap = join(directory, 'bootstrap'), target = join(directory, 'consumer');
    await createTextStarter(bootstrap); await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], bootstrap);
    const installedGenerator = join(bootstrap, 'node_modules/@continuitykit/account-reserve/scripts/create-text-starter.mjs');
    const generated = JSON.parse(await run([installedGenerator, target, '--replicas'], bootstrap)); assert.equal(generated.replicas, true);
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.equal(manifest.scripts.test, 'node replica-smoke.mjs'); assert.equal(manifest.scripts.dev, 'node replica-server.mjs');
    assert.equal(manifest.scripts.doctor, 'node doctor.mjs --replicas');
    assert.deepEqual(Object.keys(manifest.dependencies), ['@continuitykit/account-reserve']);
    assert.deepEqual((await readdir(join(target, 'operator-runtime'))).sort(), ['host.mjs','profile.mjs','replica-gateway.mjs','store.mjs']);
    for (const name of ['host','profile','replica-gateway','store']) {
      const canonical = await readFile(join(root, 'operator', name + '.mjs'));
      assert.deepEqual(await readFile(join(root, 'text-starter/operator-runtime', name + '.mjs')), canonical);
      assert.deepEqual(await readFile(join(target, 'operator-runtime', name + '.mjs')), canonical);
    }
    await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], target);
    await run([npmCli, 'run', 'build'], target);
    const result = JSON.parse((await run([npmCli, 'test'], target)).trim().split('\n').at(-1));
    assert.equal(result.ok, true); assert.equal(result.independentStoreProcesses, 2); assert.equal(result.separateSqliteFiles, 2);
    assert.equal(result.freshRecoveryProcesses, 4); assert.equal(result.primaryHttp503, true);
    assert.equal(result.exactUtf8Exports, true); assert.equal(result.noRecoveryWrites, true); assert.equal(result.rejectsOnlyCorruptCopy, true);
    assert.equal(result.physicalPasskeyProof, false); assert.equal(result.independentProviders, false); assert.equal(result.productionServer, false);
    console.log(JSON.stringify({ installedReplicaStarter: result }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
