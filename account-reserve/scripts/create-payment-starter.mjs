import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const templateFiles = ['package.json', 'README.md', 'profile.mjs', 'profile.example.json', 'index.html', 'main.mjs', 'page.mjs', 'style.css', 'prism-art.mjs', 'build.mjs', 'doctor.mjs', 'serve.mjs', 'smoke.mjs'];
const within = (child, parent) => child === parent || child.startsWith(parent + sep);
const ordered = value => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))));
const ignored = 'node_modules/\n/dist/\n/dist-*/\n/private/\nprofile.json\n*.tgz\n*.log\n.env\n.env.*\n*.db\n*.db-*\n*.key\n*.pem\n*grants*.json\n*invitation*.json\n';
const fail = code => Object.assign(new Error(code), { code });

/** Generates local files only. Never installs, starts a server, enrolls or deploys. */
export async function createPaymentStarter(supplied) {
  if (arguments.length !== 1 || typeof supplied !== 'string' || !supplied.trim()) throw fail('TARGET_REQUIRED');
  const target = resolve(supplied), canonicalRoot = await realpath(root);
  if (within(target, resolve(root)) || within(target, canonicalRoot)) throw fail('TARGET_MUST_BE_OUTSIDE_SOURCE');
  let ancestor = target;
  const suffix = [];
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      if (within(resolve(canonical, ...suffix), canonicalRoot)) throw fail('TARGET_MUST_BE_OUTSIDE_SOURCE');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor); if (parent === ancestor) throw error;
      suffix.unshift(ancestor.slice(parent.length + (parent === sep ? 0 : 1))); ancestor = parent;
    }
  }
  await mkdir(target, { recursive: true });
  if (within(await realpath(target), canonicalRoot)) throw fail('TARGET_MUST_BE_OUTSIDE_SOURCE');
  if ((await readdir(target)).length) throw fail('TARGET_MUST_BE_EMPTY');
  const sdkManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'payment-starter/package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'text-starter/package-lock.json'), 'utf8'));
  const sdkLock = lock.packages['node_modules/@continuitykit/account-reserve'];
  if (ordered(sdkLock.dependencies) !== ordered(sdkManifest.dependencies) || ordered(manifest.devDependencies) !== ordered(lock.packages[''].devDependencies)) throw fail('SDK_DEPENDENCIES_CHANGED_REFRESH_STARTER_LOCK');
  const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const pack = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', target], {
    cwd: root, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}), npm_config_update_notifier: 'false', npm_config_offline: 'true' },
  });
  if (pack.status !== 0) throw fail('LOCAL_SDK_PACK_FAILED');
  const [packed] = JSON.parse(pack.stdout);
  if (packed?.name !== sdkManifest.name || packed.version !== sdkManifest.version || !/^[a-z0-9][a-z0-9._-]+\.tgz$/.test(packed.filename ?? '') || !packed.integrity?.startsWith('sha512-')) throw fail('LOCAL_SDK_PACK_INVALID');
  for (const name of templateFiles) await cp(join(root, 'payment-starter', name), join(target, name), { errorOnExist: true, force: false });
  // One canonical implementation: no fork of lifecycle/payment logic in the template.
  await cp(join(root, 'integrations/payment-client/actions.mjs'), join(target, 'actions.mjs'), { errorOnExist: true, force: false });
  await cp(join(root, 'LICENSE'), join(target, 'LICENSE'), { errorOnExist: true, force: false });
  await cp(join(root, 'delivery/THIRD_PARTY_NOTICES.md'), join(target, 'THIRD_PARTY_NOTICES.md'), { errorOnExist: true, force: false });
  manifest.dependencies['@continuitykit/account-reserve'] = 'file:./' + packed.filename;
  lock.name = manifest.name; lock.packages[''].name = manifest.name; lock.packages[''].dependencies = manifest.dependencies;
  sdkLock.integrity = packed.integrity; sdkLock.resolved = 'file:' + packed.filename; sdkLock.version = packed.version;
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(target, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(target, 'sdk-package.json'), JSON.stringify({ name: packed.name, version: packed.version, filename: packed.filename, integrity: packed.integrity }, null, 2) + '\n', { flag: 'wx' });
  for (const name of ['.gitignore', '.npmignore']) await writeFile(join(target, name), ignored, { flag: 'wx' });
  return Object.freeze({ directory: target, sdkIntegrity: packed.integrity, status: 'files-only', installed: false, deployed: false, physicalPasskeyVerified: false,
    next: ['npm ci --ignore-scripts', 'Configure profile.json using the exact existing account reserve and reviewed payment profile', 'npm run build -- --profile profile.json', 'npm run doctor -- --profile profile.json --origin YOUR_EXISTING_RECOVERY_ORIGIN --out dist', 'npm test -- --profile profile.json --out dist', 'npm run serve -- --out dist'] });
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2].startsWith('--')) throw fail('ARGUMENTS_INVALID');
    console.log(JSON.stringify(await createPaymentStarter(process.argv[2])));
  } catch (error) {
    const code = Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value;
    console.error(['TARGET_REQUIRED', 'TARGET_MUST_BE_OUTSIDE_SOURCE', 'TARGET_MUST_BE_EMPTY', 'SDK_DEPENDENCIES_CHANGED_REFRESH_STARTER_LOCK', 'LOCAL_SDK_PACK_FAILED', 'LOCAL_SDK_PACK_INVALID', 'ARGUMENTS_INVALID'].includes(code) ? code : 'PAYMENT_STARTER_GENERATION_FAILED'); process.exitCode = 1;
  }
}
