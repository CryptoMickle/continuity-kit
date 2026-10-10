import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeTextStarter } from '../scripts/create-native-text-starter.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
function run(args, cwd, expected = 0) {
  return new Promise((done, reject) => {
    const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH, NODE_PATH: '', npm_config_offline: 'true', npm_config_update_notifier: 'false', ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}) };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '', timeout = false, escalation;
    const timer = setTimeout(() => { timeout = true; child.kill(); escalation = setTimeout(() => child.kill('SIGKILL'), 2000); }, 60000);
    child.stdout.on('data', bytes => { if (stdout.length < 100000) stdout += bytes; }); child.stderr.on('data', bytes => { if (stderr.length < 100000) stderr += bytes; });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); clearTimeout(escalation); try { assert.equal(timeout, false); assert.equal(code, expected, stderr + stdout); done({ stdout, stderr }); } catch (error) { reject(error); } });
  });
}

test('installed native generator builds separate v1 and collection entrypoints bound to their exact profiles', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-collection-package-'));
  try {
    const bootstrap = join(directory, 'bootstrap'), target = join(directory, 'consumer');
    await createNativeTextStarter(bootstrap); await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], bootstrap);
    const generator = join(bootstrap, 'node_modules/@continuitykit/account-reserve/scripts/create-native-text-starter.mjs');
    const generated = JSON.parse((await run([generator, target], bootstrap)).stdout); assert.equal(generated.directory, target);
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')); assert.deepEqual(Object.keys(manifest.dependencies), ['@continuitykit/account-reserve']);
    for (const name of ['synthetic-client.mjs', 'collection-server.mjs', 'collection-smoke.mjs', 'replica-server.mjs']) await assert.rejects(access(join(target, name)), { code: 'ENOENT' });
    for (const name of ['profile', 'store', 'host', 'replica-gateway', 'cli']) assert.deepEqual(await readFile(join(target, 'operator-runtime', name + '.mjs')), await readFile(join(root, 'operator', name + '.mjs')));
    await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], target);
    const one = JSON.parse(await readFile(join(target, 'profile.example.json'), 'utf8'));
    const collection = JSON.parse(await readFile(join(target, 'profile.collection.example.json'), 'utf8'));
    const expiresAt = new Date(Date.now() + 86400000).toISOString(); one.expiresAt = expiresAt; collection.expiresAt = expiresAt;
    assert.equal(one.version, 1); assert.equal(collection.version, 2); assert.equal(collection.apps.length, 2); assert.equal(Object.hasOwn(collection, 'appId'), false);
    await writeFile(join(target, 'one.json'), JSON.stringify(one)); await writeFile(join(target, 'collection.json'), JSON.stringify(collection));
    const outputs = [];
    for (const [name, profile] of [['one', one], ['collection', collection]]) {
      const out = join(target, 'dist-' + name); outputs.push(out);
      await run([npmCli, 'run', 'build', '--', '--profile', name + '.json', '--out', out], target);
      const doctor = JSON.parse((await run(['doctor.mjs', '--profile', name + '.json', '--out', out], target)).stdout);
      assert.equal(doctor.ok, true); assert.equal(doctor.physicalPasskeyVerified, false); assert.equal(doctor.liveStorageChecked, false);
      const runtime = JSON.parse(await readFile(join(out, 'operator-profile.json'), 'utf8'));
      assert.deepEqual(runtime.apps, profile.version === 2 ? profile.apps : [{ id: 'text', label: 'Text reserve', appId: profile.appId }]);
      for (const role of ['primary', 'recovery']) {
        const rolePath = join(out, role), config = JSON.parse(await readFile(join(rolePath, 'continuity-config.json'), 'utf8'));
        assert.deepEqual(config, { profile, role }); assert.deepEqual((await readdir(rolePath)).sort(), ['assets', 'continuity-config.json', 'index.html']);
        const html = await readFile(join(rolePath, 'index.html'), 'utf8'); assert.doesNotMatch(html, /synthetic|simulation|test storage failures/i);
        for (const file of await readdir(join(rolePath, 'assets'))) {
          assert.match(file, /^[A-Za-z0-9_-]+\.(?:js|css)$/); const source = await readFile(join(rolePath, 'assets', file), 'utf8');
          assert.doesNotMatch(source, /\/api\/(?:synthetic|replica-control|replica-enrollment|primary)|synthetic-client|LOCAL SIMULATION|test-only.*credential|collection-server|operator-worker/);
          assert.doesNotMatch(source, /\/Users\/|\.\.\/sdk\/|text-starter\//);
        }
      }
    }
    assert.notEqual(await readFile(join(outputs[0], 'primary', 'index.html'), 'utf8'), await readFile(join(outputs[1], 'primary', 'index.html'), 'utf8'));
    assert.equal(JSON.parse((await run(['doctor.mjs', '--profile', 'collection.json', '--out', outputs[0]], target, 1)).stdout).ok, false);
    assert.equal(JSON.parse((await run(['doctor.mjs', '--profile', 'one.json', '--out', outputs[1]], target, 1)).stdout).ok, false);
    const source = await readFile(join(target, 'collection-main.mjs'), 'utf8');
    assert.match(source, /@continuitykit\/account-reserve\/text-reserve/); assert.doesNotMatch(source, /syntheticClient|synthetic-client|localStorage|sessionStorage|text-starter|from\s+['"]\.\.\//);
    const invalid = { ...collection, apps: [collection.apps[0], collection.apps[0]] }; await writeFile(join(target, 'invalid.json'), JSON.stringify(invalid));
    await run(['build.mjs', '--profile', 'invalid.json', '--out', join(target, 'never-built')], target, 1); await assert.rejects(access(join(target, 'never-built')), { code: 'ENOENT' });
    const cfgPath = join(outputs[1], 'recovery', 'continuity-config.json'), saved = await readFile(cfgPath);
    const wrong = JSON.parse(saved); wrong.profile.apps.reverse(); await writeFile(cfgPath, JSON.stringify(wrong));
    assert.equal(JSON.parse((await run(['doctor.mjs', '--profile', 'collection.json', '--out', outputs[1]], target, 1)).stdout).ok, false);
    await writeFile(cfgPath, saved); assert.equal(JSON.parse((await run(['doctor.mjs', '--profile', 'collection.json', '--out', outputs[1]], target)).stdout).ok, true);
    console.log(JSON.stringify({ installedNativeCollectionPackage: true, publicSdkOnly: true, offlineInstall: true, v1AndV2Builds: true, exactRoleAndAppBinding: true, independentEntrypoints: true, nativeAssetsOnly: true, syntheticAndIssuerEndpointsAbsent: true, physicalPasskeyVerified: false, deployed: false }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
