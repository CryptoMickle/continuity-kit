import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { validateNativeProfile, validateNativeEnvironment } from './profile.mjs';
import { readNativeOperatorState } from './operator-state.mjs';
import { runNativeDoctor } from './doctor.mjs';
import { argumentsFrom, readProfile } from './build.mjs';

const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);

// This transport cannot send a body, authorization header, mutation, external
// hostname or redirect. All ports come from validated private operator state.
async function getLocal({ port, origin, path, signal, maximum = 16384 }) {
  const allowed = /^\/(?:continuity-config\.json|api\/config|api\/(?:replicas\/[a-z][a-z0-9-]{0,31}\/)?reserve\/[A-Za-z0-9_-]{43}|assets\/[A-Za-z0-9_-]+\.(?:js|css))$/.test(path) || path === '/';
  if (!allowed || !Number.isInteger(port) || port < 1 || port > 65535) throw fail('CHECK_CONFIGURATION_INVALID');
  return new Promise((done, reject) => {
    let settled = false, response;
    const finish = (error, value) => { if (settled) return; settled = true; response?.destroy(); req.destroy(); error ? reject(error) : done(value); };
    const req = request({ hostname: '127.0.0.1', port, method: 'GET', path, agent: false, signal,
      headers: { host: new URL(origin).host, origin, connection: 'close', 'accept-encoding': 'identity' } }, res => {
      response = res;
      const length = res.headers['content-length'];
      if (res.headers['content-encoding'] || res.statusCode >= 300 && res.statusCode < 400
        || length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) return finish(fail('CHECK_RESPONSE_INVALID'));
      let size = 0; const chunks = [];
      res.on('data', bytes => { if (settled) return; size += bytes.length; if (size > maximum) finish(fail('CHECK_RESPONSE_INVALID')); else chunks.push(bytes); });
      res.once('end', () => { if (!settled) finish(undefined, { status: res.statusCode, type: res.headers['content-type'] ?? '', bytes: Buffer.concat(chunks, size) }); });
      res.once('error', () => finish(fail('CHECK_UNAVAILABLE')));
      res.once('aborted', () => finish(fail('CHECK_UNAVAILABLE')));
      res.once('close', () => { if (!res.complete) finish(fail('CHECK_UNAVAILABLE')); });
    });
    req.once('error', () => finish(fail('CHECK_UNAVAILABLE'))); req.end();
  });
}
function json(response) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.type)) throw fail('CHECK_RESPONSE_INVALID');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)); }
  catch { throw fail('CHECK_RESPONSE_INVALID'); }
}
function operatorMatches(value, profile) {
  if (value?.synthetic !== false || value?.operatorHosted !== true || value?.enrollmentRequiresInvitation !== true || value?.role !== 'recovery'
    || value.originalOrigin !== profile.primaryOrigin || value.recoveryOrigin !== profile.recoveryOrigin || value.expiresAt !== profile.expiresAt
    || !Array.isArray(value.apps) || value.apps.length !== 1 || value.apps[0].id !== 'text' || value.apps[0].label !== 'Text reserve'
    || canonical(value.apps[0].config) !== canonical({ appId: profile.appId, recoveryOrigin: profile.recoveryOrigin, recoveryRpId: profile.recoveryRpId })) throw fail('OPERATOR_PROFILE_MISMATCH');
}
function sample(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT locator, ciphertext FROM operator_records ORDER BY locator LIMIT 1').get();
    if (!row) return { locator: randomBytes(32).toString('base64url'), bytes: undefined };
    if (typeof row.locator !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(row.locator) || !(row.ciphertext instanceof Uint8Array) || row.ciphertext.length > 65536) throw fail('DATABASE_INVALID');
    return { locator: row.locator, bytes: Buffer.from(row.ciphertext) };
  } finally { db.close(); }
}

/** Read-only local consistency check. An HTTP match never establishes replica
 * identity, authenticated plaintext, TLS ownership or device compatibility. */
export async function checkNativeOperator({ profile: supplied, state, out = fileURLToPath(new URL('./dist', import.meta.url)), signal } = {}) {
  const checks = [];
  const report = () => ({ ok: checks.length > 0 && checks.every(item => item.ok), checks, readOnly: true,
    grantsIssued: false, physicalPasskeyVerified: false, cryptographicRecoveryVerified: false, targetIdentityVerified: false,
    scope: 'Local configured services and stored-response consistency only. Managed child ownership supplies target bindings; empty or identical responses do not identify a store. Public TLS and native recovery remain unchecked.' });
  async function check(name, action, advice) {
    try { const details = await action(); checks.push({ name, ok: true, ...(details ?? {}) }); return true; }
    catch (error) { checks.push({ name, ok: false, code: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'CHECK_FAILED', advice }); return false; }
  }
  let profile, saved, manifest;
  if (!await check('Private state and profile', async () => {
    profile = validateNativeProfile(supplied); saved = await readNativeOperatorState({ profile, state });
  }, 'Use the original profile and intact private state. Do not reinitialize existing databases or change passkey bindings.')) return report();
  if (!await check('Built native assets', async () => {
    const doctor = await runNativeDoctor({ profile, out }); if (!doctor.ok) throw fail('BUILD_CHECK_FAILED');
    manifest = JSON.parse(await readFile(join(out, 'build-report.json'), 'utf8'));
  }, 'Run the static doctor with the same profile and build directory. Rebuild into a new directory if assets are incomplete.')) return report();
  const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 15000);
  const combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
  const get = options => getLocal({ ...options, signal: combined });
  try {
    const profiles = await Promise.all([
      ...['primary','recovery'].map(role => check(role + ' frontend', async () => {
        const origin = role === 'primary' ? profile.primaryOrigin : profile.recoveryOrigin, port = saved.ports[role];
        const cfg = await get({ port, origin, path: '/continuity-config.json' });
        if (cfg.status !== 200) throw fail('FRONTEND_CONFIG_UNAVAILABLE');
        const value = validateNativeEnvironment(json(cfg), origin);
        if (value.role !== role || canonical(value.profile) !== canonical(profile)) throw fail('FRONTEND_PROFILE_MISMATCH');
        for (const file of manifest.assetFiles) {
          const fetched = await get({ port, origin, path: file === 'index.html' ? '/' : '/' + file, maximum: 4 * 1024 * 1024 });
          const type = file === 'index.html' ? /^text\/html(?:;charset=utf-8)?$/ : file.endsWith('.js') ? /^text\/javascript$/ : /^text\/css$/;
          if (fetched.status !== 200 || !type.test(fetched.type) || hash(fetched.bytes) !== manifest.assetSha256[file]) throw fail('FRONTEND_ASSET_MISMATCH');
        }
      }, 'Check the intended frontend port, exact origin and built role assets. This check does not configure a TLS proxy.')),
      ...saved.ports.replicas.map(replica => check(replica.id + ' store profile', async () => {
        const response = await get({ port: replica.port, origin: profile.recoveryOrigin, path: '/api/config' });
        if (response.status !== 200) throw fail('OPERATOR_PROFILE_UNAVAILABLE'); operatorMatches(json(response), profile);
      }, 'Start the matching store on its configured port with the original profile and database.')),
    ]);
    if (profiles.some(value => !value)) return report();
    for (const replica of saved.ports.replicas) await check(replica.id + ' read path', async () => {
      const record = sample(saved.databasePaths.find(item => item.id === replica.id).database);
      try {
        const routed = '/api/replicas/' + replica.id + '/reserve/' + record.locator;
        for (const destination of [
          { port: replica.port, path: '/api/reserve/' + record.locator },
          { port: saved.ports.gateway, path: routed },
          { port: saved.ports.recovery, path: routed },
        ]) {
          const response = await get({ ...destination, origin: profile.recoveryOrigin, maximum: 87440 }), value = json(response);
          if (!record.bytes) {
            if (response.status !== 404 || canonical(value) !== canonical({ error: 'RESERVE_MISSING' })) throw fail('EMPTY_ROUTE_UNCONFIRMED');
          } else {
            if (response.status !== 200 || typeof value?.bytes !== 'string' || Object.keys(value).length !== 1) throw fail('STORED_READ_MISMATCH');
            const bytes = Buffer.from(value.bytes, 'base64url');
            try { if (bytes.toString('base64url') !== value.bytes || !bytes.equals(record.bytes)) throw fail('STORED_READ_MISMATCH'); }
            finally { bytes.fill(0); }
          }
        }
        return { result: record.bytes ? 'storedReadMatched' : 'emptyRouteReachable' };
      } finally { record.bytes?.fill(0); record.locator = undefined; }
    }, 'Inspect the configured gateway mapping and surviving stores. This check never writes, repairs or retries a snapshot.');
    return report();
  } finally { clearTimeout(deadline); abort.abort(); }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsFrom(process.argv.slice(2), ['profile','state','out']);
    if (!args.state || !args.out) throw fail('ARGUMENTS_INVALID');
    const result = await checkNativeOperator({ profile: await readProfile(args.profile), state: args.state, out: args.out });
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } catch { console.error('OPERATOR_READINESS_FAILED'); process.exitCode = 1; }
}
