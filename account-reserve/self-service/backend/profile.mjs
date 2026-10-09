import { exact, httpsOrigin, fail } from '../../release/profile.mjs';

export const LIMITS = Object.freeze({ maxRecords: 64, maxRecordBytes: 65536, maxIssuedCapabilities: 256, capabilityTtlMs: 300000 });
export const SELF_SERVICE_SCHEMA = 'continuity-judge-ciphertext/v1';
export const SELF_SERVICE_APP_ID = 'continuity-judge-work-v1';
const FIELDS = ['version', 'enabled', 'releaseId', 'primaryOrigin', 'recoveryOrigin', 'expiresAt'];

export function selfServiceConfig(profile) {
  const primary = httpsOrigin(profile?.primaryOrigin), recovery = httpsOrigin(profile?.recoveryOrigin);
  if (primary === recovery) throw fail('DEMO_CONFIGURATION_INVALID');
  return Object.freeze({ appId: SELF_SERVICE_APP_ID, originalRpId: new URL(primary).hostname,
    recoveryRpId: new URL(recovery).hostname, derivation: 'demo-existing-eoa:v1' });
}

export function validateSelfServiceProfile(input, now = Date.now()) {
  if (exact(input, ['enabled']) && input.enabled === false) return undefined;
  if (!exact(input, FIELDS) || input.version !== 1 || input.enabled !== true || !/^[0-9a-f]{32}$/.test(input.releaseId ?? '') || !Number.isSafeInteger(now) || now <= 0) throw fail('DEMO_CONFIGURATION_INVALID');
  selfServiceConfig(input);
  const expires = Date.parse(input.expiresAt);
  if (typeof input.expiresAt !== 'string' || !Number.isSafeInteger(expires) || expires <= 0 || expires > now + 45 * 86400000 || new Date(expires).toISOString() !== input.expiresAt) throw fail('DEMO_CONFIGURATION_INVALID');
  return Object.freeze({ ...input, expires, namespace: `continuity-judge:v1:${input.releaseId}` });
}
