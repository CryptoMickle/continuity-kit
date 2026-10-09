export function configuration(primaryPort = 5073, recoveryPort = 5074) {
  return Object.freeze({
    originalOrigin: `http://work-primary.localhost:${primaryPort}`,
    recoveryOrigin: `http://work-reserve.localhost:${recoveryPort}`,
    config: Object.freeze({ appId: 'private-work-example-v1', originalRpId: 'work-primary.localhost', recoveryRpId: 'work-reserve.localhost', derivation: 'example:synthetic-work:v1' }),
  });
}
