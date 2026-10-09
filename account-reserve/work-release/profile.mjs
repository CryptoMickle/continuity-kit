import { exact, httpsOrigin, fail } from '../release/profile.mjs';

export const WORK_APP_ID = 'continuity-private-work-v1';
export const WORK_DERIVATION = 'demo-existing-eoa:v1';
const profileFields = ['version', 'enabled', 'releaseId', 'primaryOrigin', 'recoveryOrigin', 'expiresAt'];

/** Fixed protocol configuration; request bodies cannot select an app or RP. */
export function workReserveConfig(profile) {
  const primaryOrigin = httpsOrigin(profile?.primaryOrigin);
  const recoveryOrigin = httpsOrigin(profile?.recoveryOrigin);
  if (primaryOrigin === recoveryOrigin) throw fail('WORK_RELEASE_CONFIG_INVALID');
  return Object.freeze({
    appId: WORK_APP_ID,
    originalRpId: new URL(primaryOrigin).hostname,
    recoveryRpId: new URL(recoveryOrigin).hostname,
    derivation: WORK_DERIVATION,
  });
}

// Called at request time, not module initialization. An enabled profile expresses
// configuration only; it is not evidence of approval or a successful deployment.
export function validateWorkReleaseProfile(input, { now = Date.now(), allowExpired = false } = {}) {
  if (exact(input, ['enabled']) && input.enabled === false) return undefined;
  if (!exact(input, profileFields) || input.version !== 1 || input.enabled !== true || typeof input.releaseId !== 'string' || !/^[0-9a-f]{32}$/.test(input.releaseId)) throw fail('WORK_RELEASE_CONFIG_INVALID');
  if (!Number.isSafeInteger(now) || now <= 0) throw fail('WORK_RELEASE_CONFIG_INVALID');
  try { workReserveConfig(input); } catch { throw fail('WORK_RELEASE_CONFIG_INVALID'); }
  const expires = Date.parse(input.expiresAt);
  if (typeof input.expiresAt !== 'string' || !Number.isSafeInteger(expires) || expires <= 0 || expires > now + 45 * 86400000 || new Date(expires).toISOString() !== input.expiresAt) throw fail('WORK_RELEASE_CONFIG_INVALID');
  if (!allowExpired && expires <= now) throw fail('WORK_RELEASE_EXPIRED');
  return Object.freeze({ ...input });
}
