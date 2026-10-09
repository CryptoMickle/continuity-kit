export function configuration(primaryPort = 5373, recoveryPort = 5374) {
  return Object.freeze({
    originalOrigin: `http://textarea-primary.localhost:${primaryPort}`,
    recoveryOrigin: `http://textarea-reserve.localhost:${recoveryPort}`,
    config: Object.freeze({
      appId: 'textarea-local-work-integration-v1',
      originalRpId: 'textarea-primary.localhost',
      recoveryRpId: 'textarea-reserve.localhost',
      derivation: 'integration:disposable-example-leaf:v1',
    }),
  });
}
