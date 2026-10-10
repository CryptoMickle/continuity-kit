import { cp, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function createOperatorPackage(target, { assets = join(root, 'dist-self-service-apps') } = {}) {
  target = resolve(target); await mkdir(target, { recursive: true, mode: 0o700 });
  const destination = await realpath(target), source = await realpath(root);
  if (destination === source || destination.startsWith(source + sep) || (await readdir(target)).length) throw fail('TARGET_MUST_BE_EMPTY_AND_OUTSIDE_SOURCE');
  // Fail before packaging if the reviewed browser build is not available.
  await readFile(join(assets, 'apps/index.html'));
  const npm = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const packedResult = spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', target], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_update_notifier: 'false' },
  });
  if (packedResult.status !== 0) throw fail('SDK_PACK_FAILED');
  const [packed] = JSON.parse(packedResult.stdout);
  for (const name of ['profile.mjs', 'store.mjs', 'host.mjs', 'cli.mjs', 'drill-worker.mjs', 'README.md', 'profile.example.json', 'package.json']) {
    await cp(join(root, 'operator', name), join(target, name), { errorOnExist: true });
  }
  await cp(assets, join(target, 'public'), { recursive: true, errorOnExist: true });
  await cp(join(root, 'LICENSE'), join(target, 'LICENSE'));
  await cp(join(root, 'delivery/THIRD_PARTY_NOTICES.md'), join(target, 'THIRD_PARTY_NOTICES.md'));
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  manifest.dependencies['@continuitykit/account-reserve'] = 'file:./' + packed.filename;
  const sdkManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  lock.name = manifest.name; lock.version = manifest.version;
  lock.packages[''] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, engines: manifest.engines };
  lock.packages['node_modules/@continuitykit/account-reserve'] = { version: packed.version, resolved: 'file:' + packed.filename,
    integrity: packed.integrity, license: sdkManifest.license, dependencies: sdkManifest.dependencies, engines: sdkManifest.engines };
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(target, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  await writeFile(join(target, 'sdk-package.json'), JSON.stringify({ name: packed.name, version: packed.version, integrity: packed.integrity }, null, 2) + '\n');
  return { directory: target, sdkIntegrity: packed.integrity, status: 'packaged-not-installed-or-deployed' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw fail('ONE_EMPTY_DESTINATION_REQUIRED');
  process.stdout.write(JSON.stringify(await createOperatorPackage(process.argv[2])) + '\n');
}
