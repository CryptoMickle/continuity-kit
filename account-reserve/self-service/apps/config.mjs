// Operator configuration is authoritative; page/opener parameters cannot select an appId.
const fail = (code = 'UI_CONFIG_INVALID') => { throw Object.assign(new Error(code), { code }); };
const check = value => { if (!value) fail(); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
function origin(value) {
  let url; try { url = new URL(value); } catch { fail(); }
  check(url.origin === value && !url.username && !url.password && url.protocol === 'https:'
    && !url.port && /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]+$/.test(url.hostname)
    && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost'));
  return url;
}
export function validateEnvironment(env, href, now = Date.now()) {
  check(Number.isFinite(now));
  check(exact(env, ['hosted','physicalEnabled','synthetic','selfService','fictionalOnly','operatorHosted','enrollmentRequiresInvitation','role','apps','originalOrigin','recoveryOrigin','expiresAt','limits']));
  check(env.hosted === true && env.physicalEnabled === true && env.synthetic === false && env.selfService === true && env.fictionalOnly === true);
  check(typeof env.operatorHosted === 'boolean' && env.enrollmentRequiresInvitation === env.operatorHosted);
  check(['primary','recovery'].includes(env.role));
  const a = origin(env.originalOrigin), b = origin(env.recoveryOrigin);
  let current; try { current = new URL(href); } catch { fail(); }
  check(a.hostname !== b.hostname && current.origin === (env.role === 'primary' ? a.origin : b.origin));
  check(!current.search && !current.username && !current.password);
  check(Array.isArray(env.apps) && env.apps.length === 2);
  const allowed = [{id:'textarea',label:'Textarea',appId:'continuity-textarea-v1'}, {id:'markdown',label:'Markdown Studio',appId:'continuity-markdown-v1'}];
  for (let i=0;i<2;i++) {
    const app = env.apps[i], expected = allowed[i];
    check(exact(app,['id','label','config']) && app.id === expected.id && app.label === expected.label);
    check(exact(app.config,['appId','recoveryOrigin','recoveryRpId']));
    check(app.config.appId === expected.appId && app.config.recoveryOrigin === b.origin && app.config.recoveryRpId === b.hostname);
  }
  const path = /^\/apps(?:\/(textarea|markdown))?\/?$/.exec(current.pathname);
  check(path);
  const expiresAtMs = Date.parse(env.expiresAt);
  check(typeof env.expiresAt === 'string' && Number.isFinite(expiresAtMs) && new Date(expiresAtMs).toISOString() === env.expiresAt);
  if (expiresAtMs <= now) fail('DEMO_EXPIRED');
  check(expiresAtMs - now <= 45 * 86400000);
  check(exact(env.limits,['maxRecords','maxRecordBytes','maxIssuedCapabilities','capabilityTtlMs']));
  check(env.limits.maxRecords === 64 && env.limits.maxRecordBytes === 65536 && env.limits.maxIssuedCapabilities === 256 && env.limits.capabilityTtlMs === 300000);
  return Object.freeze({primary:env.role==='primary',expiresAtMs,selected:env.apps.find(app=>app.id===path[1])});
}
export { validateCapability } from '../client/config.mjs';
