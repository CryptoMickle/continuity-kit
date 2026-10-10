import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['package.json','package-lock.json','README.md','config.mjs','adapter.mjs','index.html','main.mjs','style.css','vite.config.mjs','server.mjs','doctor.mjs','loopback-fetch.mjs','synthetic-client.mjs','smoke.mjs','recover-process.mjs'];
const replicaFiles = ['replica-server.mjs','replica-worker.mjs','replica-transport.mjs','replica-smoke.mjs','replica-recover-process.mjs'];
const operatorFiles = ['profile.mjs','store.mjs','host.mjs','replica-gateway.mjs'];
const within = (child, parent) => child === parent || child.startsWith(parent + sep);
const ordered = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b))));

/** Files only. No install, server, credential, wallet, provider or deployment. */
export async function createTextStarter(supplied, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'replicas') || (options.replicas !== undefined && typeof options.replicas !== 'boolean')) throw new Error('OPTIONS_INVALID');
  const replicas = options.replicas === true;
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
  const template = join(root, 'text-starter');
  const sdkManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(template, 'package-lock.json'), 'utf8'));
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
  if (replicas) {
    for (const name of replicaFiles) await cp(join(template, name), join(target, name), { errorOnExist: true });
    await mkdir(join(target, 'operator-runtime'));
    for (const name of operatorFiles) await cp(join(root, 'operator', name), join(target, 'operator-runtime', name), { errorOnExist: true });
  }
  await cp(join(root, 'LICENSE'), join(target, 'LICENSE'), { errorOnExist: true });
  await cp(join(root, 'delivery/THIRD_PARTY_NOTICES.md'), join(target, 'THIRD_PARTY_NOTICES.md'), { errorOnExist: true });
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  if (replicas) {
    manifest.scripts.dev = 'node replica-server.mjs';
    manifest.scripts.doctor = 'node doctor.mjs --replicas';
    manifest.scripts.test = 'node replica-smoke.mjs';
  }
  manifest.dependencies['@continuitykit/account-reserve'] = 'file:./' + packed.filename;
  lock.packages[''].dependencies = manifest.dependencies;
  sdkLock.integrity = packed.integrity; sdkLock.resolved = 'file:' + packed.filename; sdkLock.version = packed.version;
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(target, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(target, 'sdk-package.json'), JSON.stringify({ name: packed.name, version: packed.version, filename: packed.filename, integrity: packed.integrity }, null, 2) + '\n', { flag: 'wx' });
  return { directory: target, sdkIntegrity: packed.integrity, status: 'Files only; not installed or started', next: ['npm ci --ignore-scripts','npm run build','npm run doctor','npm test','npm run dev'], replicas, mode: 'Local synthetic credentials; never deploy this server' };
}
if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), replicas = args.includes('--replicas'), paths = args.filter(arg => arg !== '--replicas');
  if (paths.length !== 1 || args.length !== (replicas ? 2 : 1) || paths[0].startsWith('--')) throw new Error('Usage: node scripts/create-text-starter.mjs /absolute/empty/directory [--replicas]');
  console.log(JSON.stringify(await createTextStarter(paths[0], { replicas })));
}
