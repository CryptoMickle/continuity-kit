import { configuration } from './config.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...names].sort().join();
const definitions = Object.freeze([
  Object.freeze({ id: 'textarea', label: 'Text draft', appId: 'continuity-collection-textarea-v1' }),
  Object.freeze({ id: 'markdown', label: 'Markdown draft', appId: 'continuity-collection-markdown-v1' }),
]);
export function collectionConfiguration(primaryPort = 6173, recoveryPort = 6174) {
  const { originalOrigin, recoveryOrigin, config } = configuration(primaryPort, recoveryPort);
  return Object.freeze({ originalOrigin, recoveryOrigin,
    apps: Object.freeze(definitions.map(({ id, label, appId }) => Object.freeze({ id, label,
      config: Object.freeze({ appId, recoveryOrigin, recoveryRpId: config.recoveryRpId }) }))),
    replicas: Object.freeze(['alpha', 'beta'].map(id => Object.freeze({ id, basePath: '/api/replicas/' + id + '/reserve' }))),
  });
}
export function validateCollectionConfiguration(value) {
  if (!exact(value, ['originalOrigin', 'recoveryOrigin', 'apps', 'replicas'])) fail('COLLECTION_CONFIG_INVALID');
  let a, b; try { a = new URL(value.originalOrigin); b = new URL(value.recoveryOrigin); } catch { fail('COLLECTION_CONFIG_INVALID'); }
  if (a.origin !== value.originalOrigin || b.origin !== value.recoveryOrigin) fail('COLLECTION_CONFIG_INVALID');
  const expected = collectionConfiguration(Number(a.port), Number(b.port));
  if (value.originalOrigin !== expected.originalOrigin || value.recoveryOrigin !== expected.recoveryOrigin
    || !Array.isArray(value.apps) || value.apps.length !== 2 || !Array.isArray(value.replicas) || value.replicas.length !== 2) fail('COLLECTION_CONFIG_INVALID');
  for (const [index, app] of expected.apps.entries()) {
    const actual = value.apps[index];
    if (!exact(actual, ['id', 'label', 'config']) || actual.id !== app.id || actual.label !== app.label
      || !exact(actual.config, ['appId', 'recoveryOrigin', 'recoveryRpId'])
      || Object.keys(app.config).some(key => actual.config[key] !== app.config[key])) fail('COLLECTION_CONFIG_INVALID');
  }
  for (const [index, replica] of expected.replicas.entries()) {
    const actual = value.replicas[index];
    if (!exact(actual, ['id', 'basePath']) || actual.id !== replica.id || actual.basePath !== replica.basePath) fail('COLLECTION_CONFIG_INVALID');
  }
  return expected;
}
export function validateCollectionEnvironment(value, href, { now = Date.now() } = {}) {
  if (!exact(value, ['originalOrigin', 'recoveryOrigin', 'apps', 'replicas', 'collectionMode', 'synthetic', 'role', 'expiresAt'])
    || value.collectionMode !== true || value.synthetic !== true || !['primary', 'recovery'].includes(value.role)) fail('COLLECTION_ENVIRONMENT_INVALID');
  const settings = validateCollectionConfiguration({ originalOrigin: value.originalOrigin, recoveryOrigin: value.recoveryOrigin, apps: value.apps, replicas: value.replicas });
  let page; try { page = new URL(href); } catch { fail('COLLECTION_ENVIRONMENT_INVALID'); }
  if (page.origin !== (value.role === 'primary' ? settings.originalOrigin : settings.recoveryOrigin)
    || page.username || page.password) fail('ORIGIN_MISMATCH');
  if (!Number.isFinite(now) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
    || new Date(value.expiresAt).toISOString() !== value.expiresAt) fail('COLLECTION_ENVIRONMENT_INVALID');
  if (Date.parse(value.expiresAt) <= now) fail('COLLECTION_EXPIRED');
  return Object.freeze({ ...settings, collectionMode: true, synthetic: true, role: value.role, expiresAt: value.expiresAt });
}
