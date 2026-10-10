import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['package.json','README.md','profile.mjs','profile.example.json','ports.example.json','adapter.mjs','index.html','main.mjs','style.css','build.mjs','doctor.mjs','operator.mjs','native-host.mjs','operator-state.mjs','operator-readiness.mjs','operate.mjs','operator-worker.mjs'];
const operatorFiles = ['profile.mjs','store.mjs','host.mjs','replica-gateway.mjs','cli.mjs'];
const within = (child, parent) => child === parent || child.startsWith(parent + sep);
const ordered = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b))));

/** Files only. No install, server, credential, wallet, provider or deployment. */
export async function createNativeTextStarter(supplied) {
  if (typeof supplied !== 'string' || !supplied.trim()) throw new Error('TARGET_REQUIRED');
  const target = resolve(supplied), canonicalRoot = await realpath(root);
  if (within(target, resolve(root)) || within(target, canonicalRoot)) throw new Error('TARGET_MUST_BE_OUTSIDE_SOURCE');
  // Resolve the nearest existing ancestor before mkdir: a symlinked parent must
  // not create directories inside the source as a side effect of rejection.
  let ancestor = target, suffix = [];
  while (true) {
    try { const canonical = await realpath(ancestor); if (within(resolve(canonical, ...suffix), canonicalRoot)) throw new Error('TARGET_MUST_BE_OUTSIDE_SOURCE'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(ancestor); if (parent === ancestor) throw error; suffix.unshift(ancestor.slice(parent.length + (parent === sep ? 0 : 1))); ancestor = parent; }
  }
  await mkdir(target, { recursive: true });
  if (within(await realpath(target), canonicalRoot)) throw new Error('TARGET_MUST_BE_OUTSIDE_SOURCE');
  if ((await readdir(target)).length) throw new Error('TARGET_MUST_BE_EMPTY');
  const template = join(root, 'text-native');
  const sdkManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'text-starter/package-lock.json'), 'utf8'));
  const sdkLock = lock.packages['node_modules/@continuitykit/account-reserve'];
  if (ordered(sdkLock.dependencies) !== ordered(sdkManifest.dependencies)) throw new Error('SDK_DEPENDENCIES_CHANGED_REFRESH_STARTER_LOCK');
  const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const pack = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', target], {
    cwd: root, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}), npm_config_update_notifier: 'false', npm_config_offline: 'true' },
  });
  if (pack.status !== 0) throw new Error('LOCAL_SDK_PACK_FAILED');
  const [packed] = JSON.parse(pack.stdout);
  if (!packed?.filename || !/^[a-z0-9][a-z0-9._-]+\.tgz$/.test(packed.filename) || !packed.integrity?.startsWith('sha512-')) throw new Error('LOCAL_SDK_PACK_INVALID');
  for (const name of files) if (name !== 'package-lock.json') await cp(join(template, name), join(target, name), { errorOnExist: true });
  await mkdir(join(target, 'operator-runtime'));
  for (const name of operatorFiles) await cp(join(root, 'operator', name), join(target, 'operator-runtime', name), { errorOnExist: true });
  await cp(join(root, 'LICENSE'), join(target, 'LICENSE'), { errorOnExist: true });
  await cp(join(root, 'delivery/THIRD_PARTY_NOTICES.md'), join(target, 'THIRD_PARTY_NOTICES.md'), { errorOnExist: true });
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  manifest.dependencies['@continuitykit/account-reserve'] = 'file:./' + packed.filename;
  lock.name = manifest.name; lock.packages[''].name = manifest.name;
  lock.packages[''].dependencies = manifest.dependencies;
  sdkLock.integrity = packed.integrity; sdkLock.resolved = 'file:' + packed.filename; sdkLock.version = packed.version;
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(target, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(target, 'sdk-package.json'), JSON.stringify({ name: packed.name, version: packed.version, filename: packed.filename, integrity: packed.integrity }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(target, '.gitignore'), 'node_modules/\n/private/\n/dist/\n*.tgz\n*.log\n', { flag: 'wx' });
  return { directory: target, sdkIntegrity: packed.integrity, status: 'Files only; not installed, configured, authenticated or deployed', next: ['npm ci --ignore-scripts','Copy profile.example.json to profile.json and configure owned origins and expiry','npm run build -- --profile profile.json','npm run doctor -- --profile profile.json'], mode: 'Native WebAuthn integration; physical-device behavior remains unverified' };
}
if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2].startsWith('--')) throw new Error('Usage: node scripts/create-native-text-starter.mjs /absolute/empty/directory');
  console.log(JSON.stringify(await createNativeTextStarter(process.argv[2])));
}
