import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upstreamSource } from './upstream-build.mjs';

// Copy only this reviewed integration and a packed SDK; never install or run upstream scripts.
export async function createIntegration(target) {
  const source = fileURLToPath(new URL('./', import.meta.url));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  target = resolve(target);
  const rootPath = resolve(root);
  if (target === rootPath || target.startsWith(rootPath + sep)) throw new Error('TARGET_MUST_BE_OUTSIDE_REPOSITORY');
  await mkdir(target, { recursive: true });
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  if (canonicalTarget === canonicalRoot || canonicalTarget.startsWith(canonicalRoot + sep)) throw new Error('TARGET_MUST_BE_OUTSIDE_REPOSITORY');
  if ((await readdir(target)).length) throw new Error('TARGET_MUST_BE_EMPTY');
  await upstreamSource(); // Fail on any change to the pinned upstream copy.
  const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', target], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_update_notifier: 'false' },
  });
  if (result.status !== 0) throw new Error('LOCAL_SDK_PACK_FAILED: ' + result.stderr);
  const [packed] = JSON.parse(result.stdout);
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'create.mjs', 'package-lock.json'].includes(item.name) || item.name.startsWith('.') || item.name.endsWith('.tgz')) continue;
    await cp(join(source, item.name), join(target, item.name), { recursive: true, errorOnExist: true });
  }
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  manifest.dependencies['@continuitykit/account-reserve'] = 'file:./' + packed.filename;
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'));
  const sdkManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const sdkLock = lock.packages['node_modules/@continuitykit/account-reserve'];
  const ordered = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  if (ordered(sdkLock.dependencies) !== ordered(sdkManifest.dependencies)) throw new Error('SDK_DEPENDENCIES_CHANGED_REFRESH_CONSUMER_LOCK');
  lock.packages[''].dependencies = manifest.dependencies;
  sdkLock.integrity = packed.integrity;
  sdkLock.resolved = 'file:' + packed.filename;
  sdkLock.version = packed.version;
  await writeFile(join(target, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  await writeFile(join(target, 'sdk-package.json'), JSON.stringify({ name: packed.name, version: packed.version, integrity: packed.integrity, shasum: packed.shasum, filename: packed.filename }, null, 2) + '\n');
  return { directory: target, sdkIntegrity: packed.integrity, status: 'files-only; not installed or started' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node integrations/textarea-text/create.mjs /absolute/empty/directory');
  console.log(JSON.stringify(await createIntegration(process.argv[2])));
}
