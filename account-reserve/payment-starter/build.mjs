import { constants } from 'node:fs';
import { open, lstat, readFile, readdir, mkdir, mkdtemp, copyFile, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import { validatePaymentStarterProfile, serializePaymentStarterProfile, parsePaymentStarterProfile } from './profile.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const fail = code => Object.assign(new Error(code), { code });
export const profileSha256 = profile => createHash('sha256').update(JSON.stringify(serializePaymentStarterProfile(profile))).digest('hex');
export function argumentsFrom(args, allowed = ['profile', 'out'], required = ['profile']) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.slice(2);
    if (!args[index]?.startsWith('--') || !allowed.includes(name) || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(result, name)) throw fail('ARGUMENTS_INVALID');
    result[name] = args[index + 1];
  }
  if (required.some(name => !result[name])) throw fail('ARGUMENTS_REQUIRED');
  return result;
}
export async function readPaymentStarterProfile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 16384) throw fail('PROFILE_FILE_INVALID');
    const bytes = Buffer.alloc(16385); let length = 0;
    while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null); if (!bytesRead) break; length += bytesRead; }
    const after = await handle.stat();
    if (length > 16384 || length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw fail('PROFILE_FILE_INVALID');
    return parsePaymentStarterProfile(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)));
  } finally { await handle?.close(); }
}

export async function buildPaymentStarter({ profile: supplied, out = join(root, 'dist') } = {}) {
  const profile = validatePaymentStarterProfile(supplied), requested = resolve(out);
  try { await lstat(requested); throw fail('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(requested), { recursive: true });
  const parent = await realpath(dirname(requested)), destination = join(parent, basename(requested)), source = await realpath(root);
  if (destination === source || source.startsWith(destination + sep)) throw fail('OUTPUT_INVALID');
  const stage = await mkdtemp(join(parent, '.payment-build-')); let owned;
  try {
    let helper = join(root, 'actions.mjs');
    try { await lstat(helper); } catch (error) { if (error.code !== 'ENOENT') throw error; helper = fileURLToPath(new URL('../integrations/payment-client/actions.mjs', import.meta.url)); }
    const locals = new Set(['index.html', 'main.mjs', 'page.mjs', 'style.css', 'profile.mjs', 'prism-art.mjs'].map(name => join(root, name))); locals.add(helper);
    const bundled = join(stage, 'assets-build');
    await build({ root, configFile: false, publicDir: false, logLevel: 'silent',
      plugins: [{ name: 'payment-starter-boundary', resolveId(id, importer) {
        if (id === './actions.mjs' && importer?.split('?')[0] === join(root, 'main.mjs')) return helper;
        if (id === './actions.mjs' && importer?.split('?')[0] === join(root, 'page.mjs')) return helper;
      }, generateBundle() {
        for (const raw of this.getModuleIds()) {
          const id = raw.split('?')[0]; if (!isAbsolute(id) || id.startsWith('\0') || id.includes('/vite/')) continue;
          if (/\/(?:tests|self-service|text-starter|text-native)\/|\/(?:operator|operator-runner|operator-journal|proposal|harness|synthetic-client)\.mjs$/.test(id)) throw fail('NON_PAYMENT_MODULE');
          if (!id.includes('/node_modules/') && !locals.has(id)) throw fail('NON_PAYMENT_MODULE');
        }
      } }], build: { outDir: bundled, target: 'es2022', sourcemap: false, emptyOutDir: false } });
    const files = ['index.html', ...(await readdir(join(bundled, 'assets'))).sort().map(name => 'assets/' + name)], assetSha256 = {};
    if (files.length > 64) throw fail('ASSET_INVALID');
    for (const file of files) {
      if (file !== 'index.html' && !/^assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(file)) throw fail('ASSET_INVALID');
      const bytes = await readFile(join(bundled, file)); if (bytes.length > 4 * 1024 * 1024) throw fail('ASSET_INVALID');
      if (/\/api\/(?:synthetic|replica-control|replica-enrollment)|synthetic-client|operator-runner|operator-journal|LOCAL SIMULATION/.test(bytes.toString('utf8'))) throw fail('NON_PAYMENT_ASSET');
      assetSha256[file] = createHash('sha256').update(bytes).digest('hex');
    }
    // Exclusive mkdir prevents replacing an output created while bundling.
    try { await mkdir(destination); } catch (error) { if (error.code === 'EEXIST') throw fail('OUTPUT_EXISTS'); throw error; }
    owned = await lstat(destination); await mkdir(join(destination, 'assets'));
    for (const file of files) await copyFile(join(bundled, file), join(destination, file), constants.COPYFILE_EXCL);
    await writeFile(join(destination, 'payment-config.json'), JSON.stringify(serializePaymentStarterProfile(profile)) + '\n', { flag: 'wx' });
    const report = { version: 1, mode: 'existing-account-payment', profileSha256: profileSha256(profile), assetFiles: files, assetSha256, physicalPasskeyVerified: false, deployed: false };
    await writeFile(join(destination, 'build-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return Object.freeze({ output: destination, mode: report.mode, physicalPasskeyVerified: false, deployed: false });
  } catch (error) {
    if (owned) { const current = await lstat(destination).catch(() => undefined); if (current?.dev === owned.dev && current?.ino === owned.ino) await rm(destination, { recursive: true, force: true }); }
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = argumentsFrom(process.argv.slice(2)); console.log(JSON.stringify(await buildPaymentStarter({ profile: await readPaymentStarterProfile(args.profile), out: args.out }))); }
  catch (error) { const code = Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value; console.error(['ARGUMENTS_INVALID', 'ARGUMENTS_REQUIRED', 'PROFILE_FILE_INVALID', 'OUTPUT_EXISTS', 'OUTPUT_INVALID', 'NON_PAYMENT_MODULE', 'NON_PAYMENT_ASSET', 'ASSET_INVALID'].includes(code) ? code : 'PAYMENT_STARTER_BUILD_FAILED'); process.exitCode = 1; }
}
