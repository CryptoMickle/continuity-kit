import { constants } from 'node:fs';
import { open, lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { argumentsFrom, readPaymentStarterProfile, profileSha256 } from './build.mjs';
import { validatePaymentStarterProfile, serializePaymentStarterProfile, parsePaymentStarterProfile, checkPaymentStarterEnvironment } from './profile.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function regularFile(path, maximum) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) fail('PAYMENT_STARTER_BUILD_INVALID');
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, Math.min(65536, buffer.length - length), null);
      if (!bytesRead) break; length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || length > maximum || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      after.dev !== before.dev || after.ino !== before.ino) fail('PAYMENT_STARTER_BUILD_INVALID');
    return buffer.subarray(0, length);
  } finally { await handle?.close(); }
}
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
async function inspectBuild(profile, out) {
  if (typeof out !== 'string' || !out.length) fail('PAYMENT_STARTER_BUILD_INVALID');
  const root = resolve(out);
  for (const directory of [root, join(root, 'assets')]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PAYMENT_STARTER_BUILD_INVALID');
  }
  const saved = parsePaymentStarterProfile(decode(await regularFile(join(root, 'payment-config.json'), 16384)));
  if (JSON.stringify(serializePaymentStarterProfile(saved)) !== JSON.stringify(serializePaymentStarterProfile(profile))) fail('PAYMENT_STARTER_BUILD_INVALID');
  const report = JSON.parse(decode(await regularFile(join(root, 'build-report.json'), 65536)));
  const fields = ['version', 'mode', 'profileSha256', 'assetFiles', 'assetSha256', 'physicalPasskeyVerified', 'deployed'];
  if (!report || Object.keys(report).length !== fields.length || fields.some(field => !Object.hasOwn(report, field)) ||
    report.version !== 1 || report.mode !== 'existing-account-payment' || report.profileSha256 !== profileSha256(profile) ||
    report.physicalPasskeyVerified !== false || report.deployed !== false || !Array.isArray(report.assetFiles) ||
    report.assetFiles.length < 2 || report.assetFiles.length > 64 || new Set(report.assetFiles).size !== report.assetFiles.length ||
    !report.assetFiles.includes('index.html') || !report.assetSha256 || typeof report.assetSha256 !== 'object') fail('PAYMENT_STARTER_BUILD_INVALID');
  if (JSON.stringify(Object.keys(report.assetSha256).sort()) !== JSON.stringify([...report.assetFiles].sort())) fail('PAYMENT_STARTER_BUILD_INVALID');
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(['assets', 'build-report.json', 'index.html', 'payment-config.json'])) fail('PAYMENT_STARTER_BUILD_INVALID');
  const found = ['index.html', ...(await readdir(join(root, 'assets'))).map(name => 'assets/' + name)].sort();
  if (JSON.stringify(found) !== JSON.stringify([...report.assetFiles].sort())) fail('PAYMENT_STARTER_BUILD_INVALID');
  for (const file of report.assetFiles) {
    if (file !== 'index.html' && (typeof file !== 'string' || !/^assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(file) || /[\r\n]/.test(file))) fail('PAYMENT_STARTER_BUILD_INVALID');
    const bytes = await regularFile(join(root, file), 4 * 1024 * 1024);
    if (digest(bytes) !== report.assetSha256[file]) fail('PAYMENT_STARTER_BUILD_INVALID');
  }
  const html = decode(await regularFile(join(root, 'index.html'), 4 * 1024 * 1024));
  const references = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1].slice(1));
  if (!html.includes('type="module"') || !references.some(file => file.endsWith('.js')) || references.some(file => !report.assetFiles.includes(file))) fail('PAYMENT_STARTER_BUILD_INVALID');
}

/** Local, read-only configuration/build inspection. The explicit origin is a
 * caller declaration, never evidence that a remote deployment serves this build.
 */
export async function runPaymentStarterDoctor({ profile: supplied, origin, out } = {}) {
  const checks = [];
  const add = (id, ok, code, action) => checks.push(Object.freeze({ id, ok, code: ok ? 'OK' : code, action: ok ? 'No action required.' : action }));
  add('node', Number(process.versions.node.split('.')[0]) >= 24, 'PAYMENT_STARTER_NODE_UNSUPPORTED', 'Use Node.js 24 or newer.');
  let profile;
  try { profile = validatePaymentStarterProfile(supplied); add('profile', true); }
  catch { add('profile', false, 'PAYMENT_STARTER_PROFILE_INVALID', 'Use the exact version 1 public profile schema, canonical decimal claim strings and the existing reserve configuration.'); }
  if (profile) {
    const declared = typeof origin === 'string' && origin === profile.recoveryOrigin;
    add('declared-origin', declared, typeof origin === 'string' && origin.length ? 'PAYMENT_STARTER_ORIGIN_MISMATCH' : 'PAYMENT_STARTER_ORIGIN_REQUIRED',
      'Supply --origin with the exact existing recovery origin. This is a declaration; verify the actual browser origin separately.');
    const snapshot = checkPaymentStarterEnvironment(profile, { origin, isSecureContext: true });
    add('reserve-binding', snapshot.checks.filter(item => ['config', 'origins', 'rp-origin-binding'].includes(item.id)).every(item => item.status === 'pass'),
      'PAYMENT_STARTER_RESERVE_BINDING_INVALID', 'Keep the existing app ID, derivation and exact origin-bound relying-party IDs.');
    add('signing-window', Date.parse(profile.payment.expiresAt) > Date.now(), 'PAYMENT_STARTER_PROFILE_EXPIRED',
      'New signing is closed. Historical receipt checks remain available; review a new explicit payment profile before enabling further signing.');
    if (out !== undefined) {
      try { await inspectBuild(profile, out); add('build', true); }
      catch { add('build', false, 'PAYMENT_STARTER_BUILD_INVALID', 'Build into a new directory using this exact profile; do not edit or add files inside the generated build.'); }
    }
  }
  return Object.freeze({ ok: checks.every(check => check.ok), checks: Object.freeze(checks), readOnly: true, declaredOriginOnly: true,
    browserEnvironmentVerified: false, physicalPasskeyVerified: false, liveStorageChecked: false, rpcChecked: false, deployed: false,
    buildChecked: checks.some(check => check.id === 'build'),
    limitations: 'Static local checks do not prove origin ownership, deployment, TLS, PRF support, stored reserves, funding or successful recovery.' });
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsFrom(process.argv.slice(2), ['profile', 'origin', 'out'], ['profile', 'origin']);
    const report = await runPaymentStarterDoctor({ profile: await readPaymentStarterProfile(args.profile), origin: args.origin, out: args.out });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) process.exitCode = 1;
  } catch {
    process.stderr.write(JSON.stringify({ ok: false, code: 'PAYMENT_STARTER_DOCTOR_INPUT_INVALID',
      action: 'Use npm run doctor -- --profile profile.json --origin https://your-existing-recovery-origin [--out build-directory]. No remote checks are performed.' }) + '\n');
    process.exitCode = 1;
  }
}
