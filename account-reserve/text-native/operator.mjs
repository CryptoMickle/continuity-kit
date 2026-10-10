import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { validateNativeProfile, nativeApps, nativeAppProfile, parseNativeGrants } from './profile.mjs';
import { requestLocalJson } from './native-host.mjs';

const fail = (code, issuedMayExist = false) => Object.assign(new Error(code), { code, issuedMayExist });
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...names].sort().join();
const within = (child, parent) => child === parent || child.startsWith(parent + sep);
const packageRoot = realpathSync(fileURLToPath(new URL('./', import.meta.url)));

export function runtimeProfile(supplied) {
  const profile = validateNativeProfile(supplied);
  return Object.freeze({ version: 1, primaryOrigin: profile.primaryOrigin, recoveryOrigin: profile.recoveryOrigin,
    expiresAt: profile.expiresAt, apps: Object.freeze(nativeApps(profile).map(({ id, label, config }) => Object.freeze({ id, label, appId: config.appId }))) });
}
function invitations(path, profile) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 16384) throw fail('INVITATIONS_INVALID');
    const bytes = readFileSync(fd); if (bytes.length > 16384) throw fail('INVITATIONS_INVALID');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!exact(value, ['replicas']) || !Array.isArray(value.replicas) || value.replicas.length !== profile.replicas.length) throw fail('INVITATIONS_INVALID');
    const ports = new Set(), secrets = new Set();
    for (const [index, replica] of value.replicas.entries()) {
      if (!exact(replica, ['id', 'invitation', 'port']) || replica.id !== profile.replicas[index].id || typeof replica.invitation !== 'string' || !/^[a-f0-9]{64}$/.test(replica.invitation)
        || !Number.isInteger(replica.port) || replica.port < 1 || replica.port > 65535 || ports.has(replica.port) || secrets.has(replica.invitation)) throw fail('INVITATIONS_INVALID');
      ports.add(replica.port); secrets.add(replica.invitation);
    }
    return value.replicas;
  } catch { throw fail('INVITATIONS_INVALID'); } finally { if (fd !== undefined) closeSync(fd); }
}
function outputTarget(output) {
  try {
    if (typeof output !== 'string' || !output || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/.test(basename(output)) || basename(output) === 'continuity-config.json') throw fail('OUTPUT_INVALID');
    const suppliedParent = dirname(resolve(output)), stat = lstatSync(suppliedParent), parent = realpathSync(suppliedParent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
      || within(parent, packageRoot) && !within(parent, join(packageRoot, 'private'))) throw fail('OUTPUT_NOT_PRIVATE');
    const target = join(parent, basename(output));
    try { lstatSync(target); throw fail('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
  } catch (error) { throw fail(['OUTPUT_EXISTS', 'OUTPUT_NOT_PRIVATE'].includes(error?.code) ? error.code : 'OUTPUT_INVALID'); }
}
async function exchange(port, profile, path, options = {}) {
  const result = await requestLocalJson({ port, origin: profile.recoveryOrigin, path, ...options, signal: AbortSignal.timeout(8000), maximum: 16384 });
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)); } catch { throw fail('OPERATOR_RESPONSE_INVALID'); }
  return { status: result.status, value };
}

/** Deliberate operator action only. All stores are checked before any grant is
 * requested; each admission is attempted once. An uncertain outcome is never
 * retried and may have consumed operator quota. No bearer is printed/returned. */
export async function issueNativeGrants({ profile: supplied, app, invitationsFile, output }) {
  const profile = validateNativeProfile(supplied), selected = nativeAppProfile(profile, app);
  const target = outputTarget(output), sources = invitations(invitationsFile, profile);
  let dispatched = false, temporary;
  try {
    const expected = nativeApps(profile);
    for (const source of sources) {
      const { status, value } = await exchange(source.port, profile, '/api/config');
      if (status !== 200 || value?.synthetic !== false || value?.operatorHosted !== true || value?.role !== 'recovery'
        || value.originalOrigin !== profile.primaryOrigin || value.recoveryOrigin !== profile.recoveryOrigin || value.expiresAt !== profile.expiresAt
        || !Array.isArray(value.apps) || value.apps.length !== expected.length
        || expected.some((app, index) => !exact(value.apps[index], ['id','label','config']) || value.apps[index].id !== app.id || value.apps[index].label !== app.label
          || !exact(value.apps[index].config, ['appId','recoveryOrigin','recoveryRpId'])
          || Object.keys(app.config).some(key => value.apps[index].config[key] !== app.config[key]))) throw fail('OPERATOR_PROFILE_MISMATCH');
    }
    const replicas = [];
    for (const source of sources) {
      dispatched = true;
      const { status, value } = await exchange(source.port, profile, '/api/enrollment/start', { method: 'POST', body: Buffer.from('{}'), authorization: 'Bearer ' + source.invitation });
      if (status !== 201 || !exact(value, ['enrollmentToken', 'expiresAt', 'serverNow']) || typeof value.serverNow !== 'string' || !Number.isFinite(Date.parse(value.serverNow))
        || new Date(value.serverNow).toISOString() !== value.serverNow || Math.abs(Date.parse(value.serverNow) - Date.now()) > 30000
        || Date.parse(value.expiresAt) <= Date.parse(value.serverNow) || Date.parse(value.expiresAt) > Date.parse(value.serverNow) + 300000) throw fail('GRANT_ISSUANCE_UNCONFIRMED', true);
      replicas.push({ id: source.id, enrollmentToken: value.enrollmentToken, expiresAt: value.expiresAt });
    }
    const bundle = parseNativeGrants(JSON.stringify({ format: 'continuitykit/native-replica-grants/v1', appId: selected.appId, recoveryOrigin: selected.recoveryOrigin, replicas }), selected);
    temporary = join(dirname(target), '.native-grants-' + randomBytes(16).toString('hex') + '.tmp');
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(bundle, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, target); unlinkSync(temporary); temporary = undefined;
    return Object.freeze({ bundleWritten: true, replicas: replicas.length, expiresAt: replicas.map(item => item.expiresAt).sort()[0] });
  } catch (error) { throw fail(dispatched ? 'GRANT_ISSUANCE_UNCONFIRMED' : /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'OPERATOR_PREFLIGHT_FAILED', dispatched); }
  finally { if (temporary) try { unlinkSync(temporary); } catch {} for (const source of sources) source.invitation = undefined; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index]?.slice(2), value = process.argv[index + 1];
      if (!process.argv[index]?.startsWith('--') || !['profile', 'app', 'invitations', 'out'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(args, key)) throw fail('ARGUMENTS_INVALID'); args[key] = value;
    }
    if (!args.profile || !args.invitations || !args.out) throw fail('ARGUMENTS_INVALID');
    const result = await issueNativeGrants({ profile: JSON.parse(readFileSync(args.profile, 'utf8')), app: args.app, invitationsFile: args.invitations, output: args.out });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ error: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'OPERATOR_FAILED', issuedMayExist: error?.issuedMayExist === true })); process.exitCode = 1;
  }
}
