import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeTextStarter } from '../scripts/create-native-text-starter.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH,
  ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}), npm_config_offline: 'true', npm_config_update_notifier: 'false' };
function run(args, cwd, expected = 0) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore','pipe','pipe'] }); let stdout = '', stderr = '', timedOut = false, escalation;
    const timer = setTimeout(() => { timedOut = true; child.kill(); escalation = setTimeout(() => child.kill('SIGKILL'), 3000); }, 60000);
    child.stdout.on('data', value => { if (stdout.length < 100000) stdout += value; }); child.stderr.on('data', value => { if (stderr.length < 100000) stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(escalation); try { assert.equal(timedOut, false); assert.equal(code, expected, stderr + stdout); done({ stdout, stderr }); } catch (error) { reject(error); } });
  });
}
test('native generator protects nonempty and source-alias destinations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-paths-'));
  try {
    await assert.rejects(createNativeTextStarter(join(root, 'text-native/no-create')), /TARGET_MUST_BE_OUTSIDE_SOURCE/);
    await mkdir(join(directory, 'occupied')); await writeFile(join(directory, 'occupied/keep'), 'retain');
    await assert.rejects(createNativeTextStarter(join(directory, 'occupied')), /TARGET_MUST_BE_EMPTY/);
    assert.equal(await readFile(join(directory, 'occupied/keep'), 'utf8'), 'retain');
    await symlink(root, join(directory, 'alias'));
    await assert.rejects(createNativeTextStarter(join(directory, 'alias/no-create')), /TARGET_MUST_BE_OUTSIDE_SOURCE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('fresh installed native generator builds role-bound assets without teaching endpoints', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-installed-'));
  try {
    const bootstrap = join(directory, 'bootstrap'), target = join(directory, 'consumer');
    await createNativeTextStarter(bootstrap);
    await run([npmCli,'ci','--offline','--ignore-scripts','--no-audit','--no-fund'], bootstrap);
    const generator = join(bootstrap, 'node_modules/@continuitykit/account-reserve/scripts/create-native-text-starter.mjs');
    const created = JSON.parse((await run([generator, target], bootstrap)).stdout);
    assert.equal(created.directory, target);
    assert.doesNotMatch(created.mode, /synthetic/i);
    const names = await readdir(target);
    for (const forbidden of ['synthetic-client.mjs','server.mjs','replica-server.mjs','replica-worker.mjs','replica-smoke.mjs']) assert.ok(!names.includes(forbidden));
    for (const name of ['profile','store','host','replica-gateway','cli']) {
      assert.deepEqual(await readFile(join(target, 'operator-runtime', name + '.mjs')), await readFile(join(root, 'operator', name + '.mjs')));
      assert.deepEqual(await readFile(join(root, 'text-native/operator-runtime', name + '.mjs')), await readFile(join(root, 'operator', name + '.mjs')));
    }
    await run([npmCli,'ci','--offline','--ignore-scripts','--no-audit','--no-fund'], target);
    const profile = JSON.parse(await readFile(join(target, 'profile.example.json'), 'utf8'));
    profile.expiresAt = new Date(Date.now() + 86400000).toISOString();
    await writeFile(join(target, 'profile.json'), JSON.stringify(profile));
    await run([npmCli,'run','doctor','--','--profile','profile.json'], target, 1);
    await run([npmCli,'run','build','--','--profile','profile.json'], target);
    const report = JSON.parse((await run(['doctor.mjs','--profile','profile.json'], target)).stdout);
    assert.equal(report.ok, true); assert.equal(report.physicalPasskeyVerified, false); assert.equal(report.liveStorageChecked, false);
    for (const role of ['primary','recovery']) {
      const cfg = JSON.parse(await readFile(join(target, 'dist',role,'continuity-config.json'), 'utf8'));
      assert.equal(cfg.role, role); assert.equal(cfg.profile.appId, profile.appId);
      assert.deepEqual((await readdir(join(target, 'dist',role))).sort(), ['assets','continuity-config.json','index.html']);
      const assets = await readdir(join(target, 'dist',role,'assets'));
      for (const name of assets) { const content = await readFile(join(target, 'dist',role,'assets',name), 'utf8'); assert.doesNotMatch(content, /\/api\/(?:synthetic|replica-control|replica-enrollment|primary)|LOCAL SIMULATION|synthetic-client/); }
    }
    const nativeSource = await readFile(join(target,'main.mjs'),'utf8');
    assert.doesNotMatch(nativeSource, /webAuthnClient|syntheticClient|localStorage|sessionStorage|\.\.\/sdk/);
    assert.match(nativeSource, /@continuitykit\/account-reserve\/text-browser/);
    const duplicate = await run([npmCli,'run','build','--','--profile','profile.json'], target, 1); assert.match(duplicate.stderr, /OUTPUT_EXISTS/);
    // The normal macOS /tmp alias must work for an explicit output directory.
    const aliasOutput = join(target, 'explicit-output').replace(/^\/private\/tmp\//, '/tmp/');
    await run(['build.mjs','--profile','profile.json','--out',aliasOutput], target);
    assert.equal(JSON.parse((await run(['doctor.mjs','--profile','profile.json','--out',aliasOutput],target)).stdout).ok,true);
    const recoveryAssets = join(target,'dist/recovery/assets');
    const jsName = (await readdir(recoveryAssets)).find(name => name.endsWith('.js'));
    const jsPath = join(recoveryAssets,jsName), savedJs = await readFile(jsPath);
    await rm(jsPath);
    assert.equal(JSON.parse((await run(['doctor.mjs','--profile','profile.json'],target,1)).stdout).ok,false);
    await symlink(join(target,'dist/primary/assets',jsName),jsPath);
    assert.equal(JSON.parse((await run(['doctor.mjs','--profile','profile.json'],target,1)).stdout).ok,false);
    await rm(jsPath); await writeFile(jsPath,'/* changed deployable asset */');
    assert.equal(JSON.parse((await run(['doctor.mjs','--profile','profile.json'],target,1)).stdout).ok,false);
    await writeFile(jsPath,savedJs);
    const htmlPath = join(target,'dist/recovery/index.html'), savedHtml = await readFile(htmlPath,'utf8');
    const manifestPath = join(target,'dist/build-report.json'), manifest = JSON.parse(await readFile(manifestPath,'utf8'));
    const missingHtml = savedHtml.replace('/assets/' + jsName,'/assets/missing.js');
    await writeFile(htmlPath,missingHtml);
    const { createHash } = await import('node:crypto');
    await writeFile(manifestPath,JSON.stringify({...manifest,assetSha256:{...manifest.assetSha256,'index.html':createHash('sha256').update(missingHtml).digest('hex')}}));
    assert.equal(JSON.parse((await run(['doctor.mjs','--profile','profile.json'],target,1)).stdout).ok,false);
    await writeFile(htmlPath,savedHtml); await writeFile(manifestPath,JSON.stringify(manifest));
    assert.equal(JSON.parse((await run(['doctor.mjs','--profile','profile.json'],target)).stdout).ok,true);
    const invalid = { ...profile, recoveryRpId: 'wrong.example.test' }; await writeFile(join(target,'invalid.json'),JSON.stringify(invalid));
    await run([npmCli,'run','build','--','--profile','invalid.json','--out','never-built'], target, 1);
    assert.ok(!(await readdir(target)).includes('never-built'));
    const wrong = JSON.parse(await readFile(join(target,'dist/recovery/continuity-config.json'),'utf8')); wrong.profile.appId='different-app';
    await writeFile(join(target,'dist/recovery/continuity-config.json'),JSON.stringify(wrong));
    assert.equal(JSON.parse((await run(['doctor.mjs','--profile','profile.json'],target,1)).stdout).ok,false);
    console.log(JSON.stringify({nativeInstalledPackage:true, roles:2, nativeAssetsOnly:true, operatorRuntimeUnchanged:true, physicalPasskeyVerified:false, deployed:false}));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
