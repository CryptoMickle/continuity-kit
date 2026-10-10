import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPaymentStarter } from '../scripts/create-payment-starter.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
process.env.SDK_TEST_NPM_CACHE ??= '/tmp/continuity-reserve-npm';
function run(args, cwd, expected = 0) {
  return new Promise((done, reject) => {
    const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH, NODE_PATH: '', npm_config_offline: 'true', npm_config_update_notifier: 'false', ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}) };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, escalation;
    const timer = setTimeout(() => { timedOut = true; child.kill(); escalation = setTimeout(() => child.kill('SIGKILL'), 2000); }, 60000);
    child.stdout.on('data', bytes => { if (stdout.length < 100000) stdout += bytes; }); child.stderr.on('data', bytes => { if (stderr.length < 100000) stderr += bytes; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(escalation); try { assert.equal(timedOut, false); assert.equal(code, expected, stderr + stdout); done({ stdout, stderr }); } catch (error) { reject(error); } });
  });
}

test('payment generator refuses occupied targets and source aliases before creating their child paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'payment-starter-paths-'));
  try {
    await assert.rejects(createPaymentStarter(), { code: 'TARGET_REQUIRED' });
    await assert.rejects(createPaymentStarter(join(directory, 'unused'), {}), { code: 'TARGET_REQUIRED' });
    await assert.rejects(createPaymentStarter(join(root, 'payment-starter/never-create')), { code: 'TARGET_MUST_BE_OUTSIDE_SOURCE' });
    await mkdir(join(directory, 'occupied')); await writeFile(join(directory, 'occupied/keep'), 'retained');
    await assert.rejects(createPaymentStarter(join(directory, 'occupied')), { code: 'TARGET_MUST_BE_EMPTY' });
    assert.equal(await readFile(join(directory, 'occupied/keep'), 'utf8'), 'retained');
    await symlink(root, join(directory, 'source-alias'));
    await assert.rejects(createPaymentStarter(join(directory, 'source-alias/never-parent/child')), { code: 'TARGET_MUST_BE_OUTSIDE_SOURCE' });
    await assert.rejects(access(join(root, 'never-parent')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('installed payment generator builds an offline consumer with the exact helper, fixed profile and credential-free smoke', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'payment-starter-installed-'));
  try {
    const bootstrap = join(directory, 'bootstrap'), target = join(directory, 'consumer');
    const initial = await createPaymentStarter(bootstrap); assert.equal(initial.status, 'files-only'); assert.equal(initial.installed, false);
    await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], bootstrap);
    const installed = join(bootstrap, 'node_modules/@continuitykit/account-reserve');
    const generator = join(installed, 'scripts/create-payment-starter.mjs').replace(/^\/private\/tmp\//, '/tmp/');
    const generated = JSON.parse((await run([generator, target], bootstrap)).stdout);
    assert.equal(generated.directory, target); assert.equal(generated.sdkIntegrity, initial.sdkIntegrity);
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies), ['@continuitykit/account-reserve']); assert.deepEqual(manifest.devDependencies, { vite: '8.3.1' });
    assert.deepEqual(await readFile(join(target, 'actions.mjs')), await readFile(join(root, 'integrations/payment-client/actions.mjs')));
    assert.deepEqual(await readFile(join(installed, 'integrations/payment-client/actions.mjs')), await readFile(join(target, 'actions.mjs')));
    const templateFiles = ['README.md', 'build.mjs', 'doctor.mjs', 'index.html', 'main.mjs', 'package.json', 'page.mjs', 'prism-art.mjs', 'profile.example.json', 'profile.mjs', 'serve.mjs', 'smoke.mjs', 'style.css'].sort();
    assert.deepEqual((await readdir(join(installed, 'payment-starter'))).sort(), templateFiles);
    for (const name of ['profile.json', 'private', 'synthetic-client.mjs', 'operator.mjs', 'testnet.mjs', 'server.mjs']) await assert.rejects(access(join(target, name)), { code: 'ENOENT' });
    await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], target);
    const profile = JSON.parse(await readFile(join(target, 'profile.example.json'), 'utf8'));
    profile.payment.expiresAt = new Date(Date.now() + 86400000).toISOString(); profile.payment.claims.push({ rightId: '2', amount: '10000000000000000', nonce: 1 });
    await writeFile(join(target, 'profile.json'), JSON.stringify(profile));
    const before = await readFile(join(target, 'profile.json'));
    await run([npmCli, 'run', 'build', '--', '--profile', 'profile.json', '--out', 'dist'], target);
    assert.deepEqual(await readFile(join(target, 'profile.json')), before);
    const out = join(target, 'dist'); assert.deepEqual((await readdir(out)).sort(), ['assets', 'build-report.json', 'index.html', 'payment-config.json']);
    const config = JSON.parse(await readFile(join(out, 'payment-config.json'), 'utf8')); assert.deepEqual(config, profile);
    const report = JSON.parse(await readFile(join(out, 'build-report.json'), 'utf8'));
    assert.equal(report.profileSha256, createHash('sha256').update(JSON.stringify(profile)).digest('hex'));
    assert.equal(report.mode, 'existing-account-payment'); assert.equal(report.deployed, false); assert.equal(report.physicalPasskeyVerified, false);
    for (const name of report.assetFiles) {
      const content = await readFile(join(out, name), 'utf8');
      assert.equal(createHash('sha256').update(content).digest('hex'), report.assetSha256[name]);
      assert.doesNotMatch(content, /\/Users\/|\.\.\/sdk\/|synthetic-client|operator-runner|operator-journal|\/api\/(?:synthetic|replica-control|replica-enrollment)|UNEXPECTED_AUTHENTICATION/);
    }
    for (const name of ['main.mjs', 'page.mjs', 'actions.mjs', 'profile.mjs']) {
      const source = await readFile(join(target, name), 'utf8'); assert.doesNotMatch(source, /from\s*['"]\.\.\//);
    }
    const doctorArgs = ['doctor.mjs', '--profile', 'profile.json', '--origin', profile.recoveryOrigin, '--out', 'dist'];
    const doctor = JSON.parse((await run(doctorArgs, target)).stdout); assert.equal(doctor.ok, true); assert.equal(doctor.physicalPasskeyVerified, false);
    const wrongOrigin = JSON.parse((await run(['doctor.mjs', '--profile', 'profile.json', '--origin', 'http://127.0.0.1:6374', '--out', 'dist'], target, 1)).stdout); assert.equal(wrongOrigin.ok, false);
    const smoke = await run([npmCli, 'test', '--', '--profile', 'profile.json', '--out', 'dist'], target); assert.match(smoke.stdout, /"paymentsSent":0/); assert.match(smoke.stdout, /"physicalPasskeyVerified":false/);
    const duplicate = await run(['build.mjs', '--profile', 'profile.json', '--out', 'dist'], target, 1); assert.match(duplicate.stderr, /OUTPUT_EXISTS/);
    assert.deepEqual(JSON.parse(await readFile(join(out, 'payment-config.json'), 'utf8')), profile);
    await writeFile(join(target, 'invalid.json'), JSON.stringify({ ...profile, reserve: { ...profile.reserve, recoveryRpId: 'other.example.org' } }));
    await run(['build.mjs', '--profile', 'invalid.json', '--out', 'never-built'], target, 1); await assert.rejects(access(join(target, 'never-built')), { code: 'ENOENT' });
    const asset = report.assetFiles.find(name => name.endsWith('.js')), original = await readFile(join(out, asset));
    await writeFile(join(out, asset), '/* modified asset */'); assert.equal(JSON.parse((await run(doctorArgs, target, 1)).stdout).ok, false);
    await writeFile(join(out, asset), original);
    await writeFile(join(target, 'preview-boundaries.mjs'), `
      import assert from 'node:assert/strict';
      import {request} from 'node:http';
      import {createServer} from 'node:net';
      import {startPaymentPreview} from './serve.mjs';
      const preview=await startPaymentPreview({out:'dist',port:0});
      const get=(path,host,method='GET')=>new Promise((done,reject)=>{const req=request({hostname:'127.0.0.1',port:preview.port,path,method,headers:{Host:host}},response=>{response.resume();response.on('end',()=>done(response.statusCode));});req.on('error',reject);req.end();});
      try {
        assert.equal(await get('/', 'foreign.example.org'),421);
        assert.equal(await get('/', '127.0.0.1:'+preview.port),200);
        for(const path of ['/api/reserve/'+ 'a'.repeat(64), '/profile.json','/build-report.json','/../package.json','/%2e%2e/package.json','//index.html','/?unexpected=1']) assert.equal(await get(path,'127.0.0.1:'+preview.port),404);
        assert.equal(await get('/','127.0.0.1:'+preview.port,'PUT'),405);
        const response=await fetch(preview.url);assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);assert.match(response.headers.get('permissions-policy'),/publickey-credentials-get=\\(\\)/);
        await assert.rejects(startPaymentPreview({out:'dist',port:preview.port}),error=>error.code==='EADDRINUSE');
        assert.equal((await fetch(preview.url)).status,200);
      } finally {await preview.close();await preview.close();}
      const probe=createServer();await new Promise((done,reject)=>{probe.once('error',reject);probe.listen(preview.port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
      console.log(JSON.stringify({previewOnly:true,foreignHostDenied:true,reserveProxy:false,ownedPortReleased:true}));
    `);
    const preview = await run(['preview-boundaries.mjs'], target); assert.match(preview.stdout, /"ownedPortReleased":true/);
    // A terminal signal while the CLI awaits a profile read must cancel startup,
    // not disappear before the eventual preview handle has been assigned.
    await writeFile(join(target, 'stop-during-read.mjs'), `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const original=fs.promises.open;
      let signalled=false;
      fs.promises.open=async(...args)=>{
        const handle=await original(...args);
        if(!signalled&&String(args[0]).endsWith('payment-config.json')){
          signalled=true;process.kill(process.pid,'SIGTERM');
          await new Promise(done=>setTimeout(done,20));
        }
        return handle;
      };
      syncBuiltinESMExports();
    `);
    const interrupted = await run(['--import', './stop-during-read.mjs', 'serve.mjs', '--out', 'dist', '--port', '0'], target, 1);
    assert.match(interrupted.stderr, /PAYMENT_PREVIEW_FAILED/); assert.doesNotMatch(interrupted.stdout, /"url"/);
    console.log(JSON.stringify({ installedPaymentStarter: true, offlineInstall: true, installedGenerator: true, helperBytesUnchanged: true, publicSdkOnly: true, localPreviewOnly: true, physicalPasskeyVerified: false, paymentsSent: 0 }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
