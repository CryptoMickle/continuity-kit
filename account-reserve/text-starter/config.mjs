const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...names].sort().join();
export const APP_ID = 'continuity-text-starter-v1';
export function configuration(primaryPort = 5973, recoveryPort = 5974) {
  for (const port of [primaryPort, recoveryPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('PORT_INVALID');
  if (primaryPort === recoveryPort) fail('PORT_COLLISION');
  const originalOrigin = `http://text-starter-primary.localhost:${primaryPort}`;
  const recoveryOrigin = `http://text-starter-reserve.localhost:${recoveryPort}`;
  return Object.freeze({ originalOrigin, recoveryOrigin, config: Object.freeze({ appId: APP_ID, recoveryOrigin, recoveryRpId: 'text-starter-reserve.localhost' }) });
}
export function validateConfiguration(value) {
  if (!exact(value, ['originalOrigin', 'recoveryOrigin', 'config'])) fail('CONFIG_INVALID');
  let a, b; try { a = new URL(value.originalOrigin); b = new URL(value.recoveryOrigin); } catch { fail('CONFIG_INVALID'); }
  if (a.origin !== value.originalOrigin || b.origin !== value.recoveryOrigin || a.protocol !== 'http:' || b.protocol !== 'http:'
    || a.hostname !== 'text-starter-primary.localhost' || b.hostname !== 'text-starter-reserve.localhost') fail('CONFIG_INVALID');
  const expected = configuration(Number(a.port), Number(b.port));
  if (!exact(value.config, ['appId', 'recoveryOrigin', 'recoveryRpId']) || Object.keys(expected.config).some(key => value.config[key] !== expected.config[key])) fail('CONFIG_INVALID');
  return expected;
}
export function validateEnvironment(value, href) {
  if (!value || typeof value !== 'object' || value.synthetic !== true || !['primary','recovery'].includes(value.role)) fail('ENVIRONMENT_INVALID');
  const config = validateConfiguration({ originalOrigin: value.originalOrigin, recoveryOrigin: value.recoveryOrigin, config: value.config });
  if (new URL(href).origin !== (value.role === 'primary' ? config.originalOrigin : config.recoveryOrigin)) fail('ORIGIN_MISMATCH');
  if (value.enrollmentToken !== undefined && (value.role !== 'recovery' || !/^[A-Za-z0-9_-]{43}$/.test(value.enrollmentToken))) fail('ENVIRONMENT_INVALID');
  if (value.replicaMode !== undefined && typeof value.replicaMode !== 'boolean') fail('ENVIRONMENT_INVALID');
  if (value.replicaMode === true) {
    if (value.enrollmentToken !== undefined || !Array.isArray(value.replicas) || value.replicas.length !== 2) fail('ENVIRONMENT_INVALID');
    for (const [index, id] of ['alpha', 'beta'].entries()) {
      const replica = value.replicas[index];
      if (!exact(replica, ['id','basePath']) || replica.id !== id || replica.basePath !== '/api/replicas/' + id + '/reserve') fail('ENVIRONMENT_INVALID');
    }
  } else if (value.replicas !== undefined) fail('ENVIRONMENT_INVALID');
  return config;
}
export function portsFromArgs(args) {
  const result = {};
  for (const arg of args) {
    const match = /^--(primary|recovery)-port=([0-9]{4,5})$/.exec(arg);
    if (!match || result[match[1] + 'Port'] !== undefined) fail('ARGUMENT_INVALID');
    result[match[1] + 'Port'] = Number(match[2]);
  }
  configuration(result.primaryPort, result.recoveryPort); return result;
}
