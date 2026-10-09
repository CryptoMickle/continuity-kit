export function configuration(primaryPort = 5473, recoveryPort = 5474) {
  const originalOrigin = `http://textarea-text-primary.localhost:${primaryPort}`;
  const recoveryOrigin = `http://textarea-text-reserve.localhost:${recoveryPort}`;
  return Object.freeze({ originalOrigin, recoveryOrigin, config: Object.freeze({
    appId: 'textarea-local-text-integration-v1', recoveryOrigin, recoveryRpId: 'textarea-text-reserve.localhost',
  }) });
}
