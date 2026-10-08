export function configuration(primaryPort = 4673, recoveryPort = 4674) {
  return Object.freeze({
    originalOrigin: `http://reserve-demo-primary.localhost:${primaryPort}`,
    recoveryOrigin: `http://reserve-demo-recovery.localhost:${recoveryPort}`,
    config: Object.freeze({ appId: 'my-first-reserve', originalRpId: 'reserve-demo-primary.localhost', recoveryRpId: 'reserve-demo-recovery.localhost', derivation: 'starter:direct-prf:v1' }),
  });
}
