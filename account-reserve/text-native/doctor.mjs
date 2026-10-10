import { readFile, realpath, lstat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { argumentsFrom, readProfile } from './build.mjs';
import { validateNativeEnvironment, validateNativeProfile } from './profile.mjs';

export async function runNativeDoctor({ profile, out = fileURLToPath(new URL('./dist', import.meta.url)) }) {
  profile = validateNativeProfile(profile);
  const checks = [];
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  async function regularFile(path, limit = 4 * 1024 * 1024) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error();
    return readFile(path);
  }
  async function check(name, action, advice) { try { await action(); checks.push({ name, ok: true }); } catch { checks.push({ name, ok: false, advice }); } }
  await check('Node.js 24+', () => { if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(); }, 'Use Node.js 24 or newer.');
  await check('Installed public SDK', async () => {
    const browser = await import('@continuitykit/account-reserve/text-browser'), reserve = await import('@continuitykit/account-reserve/text-reserve');
    if (typeof browser.startTextReserveReplicaSetup !== 'function' || typeof browser.createTextReserveReplicaReceiver !== 'function' || typeof reserve.recoverTextReserveFromReplicas !== 'function') throw new Error();
  }, 'Install this generated package with npm ci --ignore-scripts.');
  for (const role of ['primary','recovery']) await check(role + ' build matches profile', async () => {
    const directory = join(out, role);
    for (const path of [directory, join(directory, 'assets')]) {
      const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    }
    const saved = JSON.parse(await regularFile(join(directory, 'continuity-config.json'), 8192));
    validateNativeEnvironment(saved, role === 'primary' ? profile.primaryOrigin : profile.recoveryOrigin);
    if (saved.role !== role || JSON.stringify(saved.profile) !== JSON.stringify(profile)) throw new Error();
    const report = JSON.parse(await regularFile(join(out, 'build-report.json'), 65536));
    if (report.version !== 1 || report.mode !== 'native' || report.nativeAssetsOnly !== true || report.profileSha256 !== digest(JSON.stringify(profile)) || !Array.isArray(report.assetFiles) || report.assetFiles.length < 2 || report.assetFiles.length > 64 || new Set(report.assetFiles).size !== report.assetFiles.length) throw new Error();
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(['assets','continuity-config.json','index.html'])) throw new Error();
    const found = ['index.html', ...(await readdir(join(directory, 'assets'))).map(name => 'assets/' + name)].sort();
    if (JSON.stringify(found) !== JSON.stringify([...report.assetFiles].sort())) throw new Error();
    for (const file of report.assetFiles) {
      if (file !== 'index.html' && !/^assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(file)) throw new Error();
      if (digest(await regularFile(join(directory, file))) !== report.assetSha256?.[file]) throw new Error();
    }
    const html = (await regularFile(join(directory, 'index.html'))).toString('utf8');
    if (!html.includes('type="module"')) throw new Error();
    const references = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1].slice(1));
    if (!references.some(path => path.endsWith('.js')) || references.some(path => !report.assetFiles.includes(path))) throw new Error();
  }, 'Build with the same profile into a new output directory; never change the RP or app ID of an existing reserve.');
  return { ok: checks.every(item => item.ok), checks, physicalPasskeyVerified: false, liveStorageChecked: false, deployed: false,
    requirements: 'Operator-provided short-lived upload permissions for setup; existing passkey and one intact stored copy for recovery. Static checks do not prove origin ownership, TLS, PRF support or live storage.' };
}
if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = argumentsFrom(process.argv.slice(2)); const report = await runNativeDoctor({ profile: await readProfile(args.profile), out: args.out ? resolve(args.out) : undefined }); console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; }
  catch { console.error('Native profile or build is invalid. Use npm run doctor -- --profile profile.json [--out build-directory].'); process.exitCode = 1; }
}
