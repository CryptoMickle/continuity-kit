import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base64url, enrollmentTicketHash, releaseProfile, validLocator, fail } from './profile.mjs';

/** Offline operator preparation only. Never prints tokens or enables a release. */
export async function prepareReleaseFiles({ directory, recoveryOrigin, expiresAt, count = 1, locator = '*' }) {
  if (typeof directory !== 'string' || !Number.isInteger(count) || count < 1 || count > 16 || (locator !== '*' && !validLocator(locator))) throw fail('PREPARATION_INVALID');
  const releaseId = randomBytes(16).toString('hex');
  const profile = { version: 1, enabled: true, releaseId, recoveryOrigin, expiresAt };
  releaseProfile(profile, [recoveryOrigin]);
  if (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 45 * 86400000) throw fail('PREPARATION_INVALID');
  const grants = [], capabilities = [];
  for (let i = 0; i < count; i++) {
    const token = base64url(randomBytes(32));
    grants.push({ hash: await enrollmentTicketHash(token), locator });
    capabilities.push({ number: i + 1, token, locator });
  }
  const output = resolve(directory);
  await mkdir(output, { mode: 0o700 }); // Existing directories are rejected.
  const serverPath = join(output, 'release.server.json');
  const secretPath = join(output, 'enrollment.secrets.json');
  await writeFile(serverPath, JSON.stringify({ profile: { ...profile, enabled: false }, allowedOrigins: [], enrollmentTickets: grants }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(secretPath, JSON.stringify({ releaseId, capabilities }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return Object.freeze({ serverPath, secretPath, enabled: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // argv contains only output path, public B origin, expiry and ticket count.
  const [directory, recoveryOrigin, expiresAt, count = '1'] = process.argv.slice(2);
  try {
    const result = await prepareReleaseFiles({ directory, recoveryOrigin, expiresAt, count: Number(count) });
    console.log(JSON.stringify(result));
  } catch { console.error('Offline release preparation failed; no release was enabled.'); process.exitCode = 1; }
}
