import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installedNativeFixture } from './native-installed-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const sentinel = 'FICTIONAL_PRIVATE_PACK_SENTINEL_NOT_A_CREDENTIAL';
const forbiddenFiles = [
  'private/operator/alpha.db', 'private/operator/native-state.json',
  'private/operator/invitations.json', 'private/operator/setup-grants.json',
  'private/operator/reserve-backup.json', 'private/operator/runtime.lock',
  'private/operator/otherwise-ordinary.json', 'dist/recovery/index.html',
  'dist-review/recovery/index.html', 'stray.db', 'stray.db-wal',
  'stray.sqlite', 'stray.sqlite3-shm', 'stray-journal', 'runtime.lock',
  'administrator-invitation.txt', 'invitations.json', 'setup-grants.json',
  'operator-backup.json', '.env.local', 'private-key.pem', 'signing.key',
];
function command(binary, args, cwd) {
  return new Promise((done, reject) => {
    const env = { ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''), NODE_PATH: '',
      npm_config_offline: 'true', npm_config_update_notifier: 'false',
      ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}) };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure = false, escalation;
    const timer = setTimeout(() => { failure = true; child.kill(); escalation = setTimeout(() => child.kill('SIGKILL'), 2000); }, 60000);
    const collect = (value, key) => {
      if (stdout.length + stderr.length + value.length > 2 * 1024 * 1024) { failure = true; child.kill('SIGKILL'); return; }
      if (key === 'stdout') stdout += value; else stderr += value;
    };
    child.stdout.on('data', bytes => collect(bytes, 'stdout')); child.stderr.on('data', bytes => collect(bytes, 'stderr'));
    child.once('error', () => { failure = true; });
    child.once('close', code => { clearTimeout(timer); clearTimeout(escalation);
      if (failure || code !== 0) reject(Error('PRIVATE_PACKAGE_REPLAY_FAILED'));
      else done(stdout);
    });
  });
}
async function placeSentinels(directory) {
  for (const name of forbiddenFiles) {
    const path = join(directory, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, sentinel, { flag: 'wx', mode: 0o600 });
  }
}
async function entries(archive) {
  return (await command('/usr/bin/tar', ['-tzf', archive], dirname(archive))).trim().split('\n');
}
async function proveNoSecrets(archive, prefix) {
  const names = await entries(archive);
  for (const name of forbiddenFiles) assert.equal(names.includes('package/' + prefix + name), false, 'private fixture must stay outside the real tarball');
  assert.equal(names.some(name => name.startsWith('package/' + prefix + 'private/')), false);
  assert.equal(names.some(name => name.startsWith('package/' + prefix + 'dist/')), false);
  return names;
}
async function pack(directory, destination) {
  const result = JSON.parse(await command(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination], directory));
  assert.equal(result.length, 1); assert.match(result[0].filename, /^[a-z0-9][a-z0-9._-]+\.tgz$/);
  return join(destination, result[0].filename);
}

test('native private state is excluded from actual source, installed-SDK and generated-project tarballs', { timeout: 180000 }, async t => {
  const installed = await installedNativeFixture();
  const directory = await mkdtemp(join(tmpdir(), 'native-private-package-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await installed.close(); });
  const sdk = join(installed.directory, 'node_modules/@continuitykit/account-reserve');
  const sourceIgnore = await readFile(join(root, 'text-native/.npmignore'), 'utf8');
  assert.equal(await readFile(join(root, 'text-native/.gitignore'), 'utf8'), sourceIgnore);
  // npm removes ignore files; the installed SDK must remain safe without them.
  await assert.rejects(access(join(sdk, 'text-native/.npmignore')), { code: 'ENOENT' });
  const manifest = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
  assert.equal(manifest.files.includes('text-native'), false);
  const nativeFiles = manifest.files.filter(name => name.startsWith('text-native/'));
  assert.ok(nativeFiles.length > 20); assert.ok(nativeFiles.every(name => !/[!*?]/.test(name)));
  await placeSentinels(join(sdk, 'text-native'));
  await writeFile(join(sdk, 'text-native/unknown-runtime-state.json'), sentinel, { flag: 'wx', mode: 0o600 });
  const sdkArchive = await pack(sdk, directory);
  const sdkNames = await proveNoSecrets(sdkArchive, 'text-native/');
  assert.equal(sdkNames.includes('package/text-native/unknown-runtime-state.json'), false);
  for (const name of nativeFiles) assert.ok(sdkNames.includes('package/' + name), 'required native source must remain packaged');
  // Adding source ignore rules also keeps the same explicit source set safe.
  await writeFile(join(sdk, 'text-native/.npmignore'), sourceIgnore, { flag: 'wx' });
  const sourceOut = join(directory, 'source-pack'); await mkdir(sourceOut);
  await proveNoSecrets(await pack(sdk, sourceOut), 'text-native/');
  await rm(join(sdk, 'text-native/.npmignore'));
  const generated = join(directory, 'generated');
  await command(process.execPath, [join(sdk, 'scripts/create-native-text-starter.mjs'), generated], installed.directory);
  for (const name of ['.npmignore', '.gitignore']) assert.equal(await readFile(join(generated, name), 'utf8'), sourceIgnore);
  const generatedManifest = JSON.parse(await readFile(join(generated, 'package.json'), 'utf8'));
  const dependency = generatedManifest.dependencies['@continuitykit/account-reserve'];
  assert.match(dependency, /^file:\.\/[a-z0-9][a-z0-9._-]+\.tgz$/);
  await proveNoSecrets(join(generated, dependency.slice('file:./'.length)), 'text-native/');
  await command(process.execPath, [npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], generated);
  await placeSentinels(generated);
  const generatedOut = join(directory, 'generated-pack'); await mkdir(generatedOut);
  const generatedNames = await proveNoSecrets(await pack(generated, generatedOut), '');
  for (const name of ['profile.mjs', 'profile.example.json', 'profile.collection.example.json', 'operator-backup.mjs', 'operator-runtime/host.mjs'])
    assert.ok(generatedNames.includes('package/' + name));
  // Packing must not modify or erase the private files it excluded.
  for (const base of [join(sdk, 'text-native'), generated]) for (const name of forbiddenFiles)
    assert.equal(await readFile(join(base, name), 'utf8'), sentinel);
  console.log(JSON.stringify({ nativePrivatePackageBoundary: true, actualTarballsInspected: 4,
    installedSdkRepackSafeWithoutIgnoreFile: true, installedGeneratorSafe: true,
    generatedIgnoreRulesPreserved: true, offlineInstall: true, onlyFictionalSecretsUsed: true }));
});
