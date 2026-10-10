import { lstat, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNativeProfile } from './profile.mjs';
import { nativeOperatorDirectory, readNativeOperatorState } from './operator-state.mjs';
import { runNativeDoctor } from './doctor.mjs';
import { argumentsFrom, readProfile } from './build.mjs';

// Every displayed sentence is fixed here. Filesystem paths, labels, invitations,
// database contents and exception messages never enter the report.
const guidance = Object.freeze({
  OPTIONS_INVALID: ['Diagnostic options are invalid.', 'Supply profile, state and out, with optional boolean checkPorts. CLI: npm run operator:diagnose -- --profile profile.json --state private/state --out dist [--check-ports true|false].'],
  PROFILE_VALID: ['The supplied native profile is valid.', 'Keep this original profile for existing reserves.'],
  PROFILE_INVALID: ['The supplied native profile is invalid.', 'Check the original profile against the native profile example. Do not change existing app IDs, origins or RP bindings to bypass validation.'],
  PROFILE_EXPIRED: ['The supplied native profile has expired.', 'This bounded operator cannot start after its original expiry. Preserve state and backups; do not extend an existing profile to bypass its expiry.'],
  STATE_PATH_VALID: ['The private state directory passes path checks.', 'Keep the state outside published frontend directories.'],
  STATE_PATH_INVALID: ['The private state directory is missing or its path is unsafe.', 'Use the existing private state directory and a canonical path without symlinks or traversal, outside published frontend directories. Initialize only a new empty target for a new operator.'],
  PRIVATE_PERMISSIONS_INVALID: ['Private state ownership or permissions do not match the required policy.', 'Have the operator inspect ownership and permissions: private directories require mode 0700 and required state files mode 0600, owned by the current user. Correct only the intended private paths; this command makes no permission changes.'],
  RUNTIME_LOCK_ABSENT: ['No managed runtime lock was observed.', 'This is advisory; startup must acquire its own exclusive lock.'],
  RUNTIME_LOCK_PRESENT: ['A runtime lock exists; ownership is unconfirmed.', 'If the managed operator is running, stop it through its owning terminal or handle. Otherwise investigate ownership and any interrupted shutdown. Do not delete the lock based on age, free ports or this report.'],
  RUNTIME_LOCK_CHECK_FAILED: ['The runtime lock could not be checked safely.', 'Inspect access to the intended private state directory before retrying. Do not remove an unreadable lock.'],
  STATE_VALID: ['The existing state matches the supplied profile.', 'Keep this profile and state together; no grants or database changes were made.'],
  PROFILE_STATE_MISMATCH: ['The supplied profile and saved operator bindings do not match.', 'Use the original profile with the exact app list and order, origins, RP, expiry and replica order saved with this state. Do not rewrite the manifest or reinitialize these databases.'],
  STATE_INVALID: ['The existing operator state is incomplete or invalid.', 'Preserve the state for inspection. Check the committed manifest and required private files, or restore a verified backup into a new directory. Do not reinitialize or overwrite this state.'],
  BUILD_VALID: ['The installed SDK and built native assets pass the static doctor.', 'Startup still revalidates the assets and checks the running services.'],
  BUILD_INVALID: ['The installed SDK or native build does not match this profile.', 'Run npm run doctor with this same profile and output directory for build checks. Install the generated package with npm ci --ignore-scripts if needed; rebuild into a new directory using the original profile.'],
  PORT_AVAILABLE: ['This configured loopback port was briefly available.', 'Availability is advisory and does not identify a service or reserve the port for startup.'],
  PORT_OCCUPIED: ['This configured loopback port is occupied.', 'Identify the process using this port. Stop it only if you own it and intend to stop it. This command neither connects to nor controls the occupant; do not change origin or saved port bindings just to bypass the conflict.'],
  PORT_CHECK_FAILED: ['Availability of this configured loopback port could not be checked.', 'Inspect local permission or listener restrictions. No endpoint identity or ownership was established.'],
});
const field = (value, name) => { try { const descriptor = Object.getOwnPropertyDescriptor(value, name); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined; } catch { return undefined; } };
function options(input) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length) throw new Error();
  const names = Object.getOwnPropertyNames(input), allowed = ['profile','state','out','checkPorts'];
  if (names.some(name => !allowed.includes(name)) || ['profile','state','out'].some(name => !names.includes(name))) throw new Error();
  const result = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
    result[name] = descriptor.value;
  }
  for (const name of ['state','out']) if (typeof result[name] !== 'string' || !result[name].trim() || result[name].length > 4096 || result[name].includes('\0')) throw new Error();
  if (names.includes('checkPorts') && typeof result.checkPorts !== 'boolean') throw new Error();
  return result;
}
function stateCode(error, fallback) {
  if (field(error, 'diagnosticCode') === 'PRIVATE_PERMISSIONS_INVALID' || ['EACCES', 'EPERM'].includes(field(error, 'code'))) return 'PRIVATE_PERMISSIONS_INVALID';
  if (field(error, 'code') === 'NATIVE_STATE_BINDING_INVALID') return 'PROFILE_STATE_MISMATCH';
  if (field(error, 'code') === 'NATIVE_PROFILE_EXPIRED') return 'PROFILE_EXPIRED';
  return fallback;
}
async function portCode(port) {
  // A brief bind is necessary to test bind availability. No request is sent to
  // an existing listener; any connection to our temporary probe is discarded.
  const server = createServer(socket => socket.destroy()), controller = new AbortController();
  return new Promise(done => {
    let settled = false;
    const finish = code => {
      if (settled) return; settled = true; clearTimeout(timer); controller.abort();
      server.close(() => done(code));
    };
    server.on('error', error => finish(field(error, 'code') === 'EADDRINUSE' ? 'PORT_OCCUPIED' : 'PORT_CHECK_FAILED'));
    const timer = setTimeout(() => finish('PORT_CHECK_FAILED'), 1000);
    try { server.listen({ host: '127.0.0.1', port, signal: controller.signal, exclusive: true }, () => finish('PORT_AVAILABLE')); }
    catch { finish('PORT_CHECK_FAILED'); }
  });
}

/** Advisory, read-only preflight. Optional port probes briefly bind and release
 * only validated local ports. No application service, child, grant or native
 * credential starts. The managed launcher independently revalidates later. */
export async function diagnoseNativeOperator(input) {
  const checks = []; let portAvailabilityChecked = false;
  const add = (id, ok, code, details = {}) => {
    const [message, action] = guidance[code]; checks.push(Object.freeze({ id, ok, code, message, action, ...details }));
  };
  const report = () => Object.freeze({ ok: checks.length > 0 && checks.every(item => item.ok), checks: Object.freeze([...checks]),
    readOnly: true, advisory: true, applicationServicesStarted: false, grantsIssued: false,
    physicalPasskeyVerified: false, cryptographicRecoveryVerified: false, portAvailabilityChecked });
  let captured, profile, directory, saved;
  try { captured = options(input); }
  catch { add('options', false, 'OPTIONS_INVALID'); return report(); }
  try { profile = validateNativeProfile(captured.profile); add('profile', true, 'PROFILE_VALID'); }
  catch (error) { add('profile', false, field(error, 'code') === 'NATIVE_PROFILE_EXPIRED' ? 'PROFILE_EXPIRED' : 'PROFILE_INVALID'); return report(); }
  try { directory = nativeOperatorDirectory(captured.state); add('state-path', true, 'STATE_PATH_VALID'); }
  catch (error) { add('state-path', false, stateCode(error, 'STATE_PATH_INVALID')); return report(); }
  try { await lstat(join(directory, 'runtime.lock')); add('runtime-lock', false, 'RUNTIME_LOCK_PRESENT'); return report(); }
  catch (error) {
    if (field(error, 'code') !== 'ENOENT') { add('runtime-lock', false, 'RUNTIME_LOCK_CHECK_FAILED'); return report(); }
    add('runtime-lock', true, 'RUNTIME_LOCK_ABSENT');
  }
  try { saved = readNativeOperatorState({ profile, state: directory }); add('state', true, 'STATE_VALID'); }
  catch (error) { add('state', false, stateCode(error, 'STATE_INVALID')); return report(); }
  try {
    const doctor = await runNativeDoctor({ profile, out: captured.out });
    if (!doctor.ok) throw new Error(); add('build', true, 'BUILD_VALID');
  } catch { add('build', false, 'BUILD_INVALID'); return report(); }
  if (captured.checkPorts === true) {
    for (const [target, port] of [
      ['primary', saved.ports.primary], ['recovery', saved.ports.recovery], ['gateway', saved.ports.gateway],
      ...saved.ports.replicas.map((item, index) => ['replica-' + (index + 1), item.port]),
    ]) {
      portAvailabilityChecked = true;
      const code = await portCode(port); add('port', code === 'PORT_AVAILABLE', code, { target, port });
    }
  }
  return report();
}

export function nativeDiagnosticInputFailure(error) {
  // CLI file/argument failures happen before the API receives an object. Keep
  // the same fixed report format and never expose the original file error.
  const code = ['ARGUMENTS_INVALID','PROFILE_REQUIRED'].includes(field(error, 'code')) ? 'OPTIONS_INVALID'
    : field(error, 'code') === 'NATIVE_PROFILE_EXPIRED' ? 'PROFILE_EXPIRED' : 'PROFILE_INVALID';
  const [message, action] = guidance[code];
  return Object.freeze({ ok: false, checks: Object.freeze([Object.freeze({ id: code === 'OPTIONS_INVALID' ? 'options' : 'profile', ok: false, code, message, action })]),
    readOnly: true, advisory: true, applicationServicesStarted: false, grantsIssued: false,
    physicalPasskeyVerified: false, cryptographicRecoveryVerified: false, portAvailabilityChecked: false });
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report;
  try {
    const args = argumentsFrom(process.argv.slice(2), ['profile','state','out','check-ports']);
    if (!args.state || !args.out || args['check-ports'] !== undefined && !['true','false'].includes(args['check-ports'])) throw Object.assign(new Error(), { code: 'ARGUMENTS_INVALID' });
    report = await diagnoseNativeOperator({ profile: await readProfile(args.profile), state: args.state, out: args.out, checkPorts: args['check-ports'] === 'true' });
  } catch (error) { report = nativeDiagnosticInputFailure(error); }
  console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
}
