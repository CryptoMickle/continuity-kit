import { lstat, readFile, readdir, mkdir, mkdtemp, cp, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import { validateNativeProfile, nativeApps } from './profile.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const fail = code => Object.assign(new Error(code), { code });
export function argumentsFrom(args, allowed = ['profile','out']) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.slice(2);
    if (!args[index]?.startsWith('--') || !allowed.includes(name) || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(result, name)) throw fail('ARGUMENTS_INVALID');
    result[name] = args[index + 1];
  }
  if (!result.profile) throw fail('PROFILE_REQUIRED');
  return result;
}
export async function readProfile(path) {
  const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw fail('PROFILE_FILE_INVALID');
  return validateNativeProfile(JSON.parse(await readFile(path, 'utf8')));
}
export async function buildNative({ profile: supplied, out = join(root, 'dist') } = {}) {
  const profile = validateNativeProfile(supplied), requested = resolve(out);
  let destination = requested;
  try { await lstat(destination); throw fail('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(destination), { recursive: true });
  const parent = await realpath(dirname(destination));
  destination = join(parent, basename(requested));
  const source = await realpath(root);
  if (destination === source || source.startsWith(destination + sep)) throw fail('OUTPUT_INVALID');
  const stage = await mkdtemp(join(parent, '.native-build-'));
  try {
    const bundled = join(stage, 'assets-build');
    await build({ root, configFile: false, publicDir: false, logLevel: 'silent',
      plugins: [{ name: 'native-entrypoint-boundary', generateBundle() {
        for (const id of this.getModuleIds()) {
          if (/\/(?:text-starter|tests|release|self-service)\/|synthetic-client|replica-server|replica-worker|native-host\.mjs|operator\.mjs/.test(id)) throw fail('NON_NATIVE_MODULE');
        }
      } }],
      build: { outDir: bundled, target: 'es2022', sourcemap: false, emptyOutDir: false,
        ...(profile.version === 2 ? { rollupOptions: { input: join(root, 'collection-index.html') } } : {}) } });
    if (profile.version === 2) await rename(join(bundled, 'collection-index.html'), join(bundled, 'index.html'));
    const files = ['index.html', ...(await readdir(join(bundled, 'assets'))).map(name => 'assets/' + name)];
    const assetSha256 = {};
    for (const file of files) {
      if (file !== 'index.html' && !/^assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(file)) throw fail('ASSET_INVALID');
      const source = await readFile(join(bundled, file), 'utf8');
      if (/\/api\/(?:synthetic|replica-control|replica-enrollment|primary)|synthetic-client|LOCAL SIMULATION|Test storage failures/.test(source)) throw fail('SYNTHETIC_ASSET_FORBIDDEN');
      assetSha256[file] = createHash('sha256').update(source).digest('hex');
    }
    for (const role of ['primary','recovery']) {
      const directory = join(stage, role); await cp(bundled, directory, { recursive: true, errorOnExist: true });
      await writeFile(join(directory, 'continuity-config.json'), JSON.stringify({ profile, role }) + '\n', { flag: 'wx' });
    }
    const operatorProfile = { version: 1, primaryOrigin: profile.primaryOrigin, recoveryOrigin: profile.recoveryOrigin, expiresAt: profile.expiresAt,
      apps: nativeApps(profile).map(({ id, label, config }) => ({ id, label, appId: config.appId })) };
    await writeFile(join(stage, 'operator-profile.json'), JSON.stringify(operatorProfile, null, 2) + '\n', { flag: 'wx' });
    await rm(bundled, { recursive: true });
    const digest = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    await writeFile(join(stage, 'build-report.json'), JSON.stringify({ version: 1, mode: 'native', profileSha256: digest, nativeAssetsOnly: true,
      roles: ['primary','recovery'], assetFiles: files, assetSha256, physicalPasskeyVerified: false, deployed: false }, null, 2) + '\n');
    // Existing destinations are checked again; no previous build is removed.
    try { await lstat(destination); throw fail('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(stage, destination);
    return { output: destination, mode: 'native', physicalPasskeyVerified: false, deployed: false };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = argumentsFrom(process.argv.slice(2)); console.log(JSON.stringify(await buildNative({ profile: await readProfile(args.profile), out: args.out }))); }
  catch (error) { console.error(/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'NATIVE_BUILD_FAILED'); process.exitCode = 1; }
}
