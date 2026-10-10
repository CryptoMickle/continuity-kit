import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readSync, readFileSync, writeFileSync, fsyncSync, mkdirSync, rmdirSync, unlinkSync, linkSync } from 'node:fs';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateNativeProfile, nativeApps } from './profile.mjs';
import { initializeDatabase, importDatabase, validateTransfer } from './operator-runtime/store.mjs';
import { canonical, ciphertext, locator, LIMITS } from './operator-runtime/profile.mjs';

const packageRoot = realpathSync(fileURLToPath(new URL('./', import.meta.url)));
const privateRoot = join(packageRoot, 'private');
const within = (child, parent) => child === parent || child.startsWith(parent + sep);
const fail = code => Object.assign(new Error(code), { code });
const check = (condition, code) => { if (!condition) throw fail(code); };
const codes = new Set(['NATIVE_STATE_INVALID', 'NATIVE_STATE_PATH_INVALID', 'NATIVE_STATE_EXISTS', 'NATIVE_STATE_PORTS_INVALID', 'NATIVE_STATE_BINDING_INVALID', 'NATIVE_STATE_DATABASE_INVALID', 'NATIVE_STATE_TRANSFER_INVALID', 'NATIVE_STATE_INITIALIZATION_FAILED', 'NATIVE_PROFILE_INVALID', 'NATIVE_PROFILE_EXPIRED']);
function errorField(error, field) { try { const value = Object.getOwnPropertyDescriptor(error, field); return value && Object.hasOwn(value, 'value') ? value.value : undefined; } catch { return undefined; } }
function permissionError(error) { return errorField(error, 'diagnosticCode') === 'PRIVATE_PERMISSIONS_INVALID' || ['EACCES', 'EPERM'].includes(errorField(error, 'code')); }
function safeError(error, fallback = 'NATIVE_STATE_INVALID') {
  const code = errorField(error, 'code'), result = fail(codes.has(code) ? code : fallback);
  if (permissionError(error)) Object.defineProperty(result, 'diagnosticCode', { value: 'PRIVATE_PERMISSIONS_INVALID' });
  return result;
}
function privatePermissions(stat, mode, code) {
  if ((stat.mode & 0o7777) !== mode || !owned(stat)) {
    const error = fail(code); Object.defineProperty(error, 'diagnosticCode', { value: 'PRIVATE_PERMISSIONS_INVALID' }); throw error;
  }
}
function object(value, fields, code = 'NATIVE_STATE_INVALID') {
  try {
    check(value && typeof value === 'object' && !Array.isArray(value), code);
    check([Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Object.getOwnPropertySymbols(value).length, code);
    check(Object.getOwnPropertyNames(value).sort().join(',') === [...fields].sort().join(','), code);
    const result = {};
    for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, code); result[field] = descriptor.value; }
    return result;
  } catch { throw fail(code); }
}
function portsCopy(input, profile) {
  const code = 'NATIVE_STATE_PORTS_INVALID', value = object(input, ['primary', 'recovery', 'gateway', 'replicas'], code), used = new Set();
  const port = number => { check(Number.isInteger(number) && number > 0 && number <= 65535 && !used.has(number), code); used.add(number); return number; };
  const primary = port(value.primary), recovery = port(value.recovery), gateway = port(value.gateway);
  const length = value.replicas && Object.getOwnPropertyDescriptor(value.replicas, 'length');
  check(Array.isArray(value.replicas) && length && Object.hasOwn(length, 'value') && length.value === profile.replicas.length
    && Object.getOwnPropertyNames(value.replicas).length === length.value + 1 && !Object.getOwnPropertySymbols(value.replicas).length, code);
  const replicas = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.replicas, String(index)); check(descriptor && Object.hasOwn(descriptor, 'value'), code);
    const target = object(descriptor.value, ['id', 'port'], code); check(target.id === profile.replicas[index].id, code);
    replicas.push(Object.freeze({ id: target.id, port: port(target.port) }));
  }
  for (const [origin, number] of [[profile.primaryOrigin, primary], [profile.recoveryOrigin, recovery]]) {
    const url = new URL(origin); if (url.protocol === 'http:') check(Number(url.port || 80) === number, code);
  }
  return Object.freeze({ primary, recovery, gateway, replicas: Object.freeze(replicas) });
}
function runtimeProfile(profile) { return Object.freeze({ version: 1, primaryOrigin: profile.primaryOrigin, recoveryOrigin: profile.recoveryOrigin, expiresAt: profile.expiresAt, apps: Object.freeze(nativeApps(profile).map(({ id, label, config }) => Object.freeze({ id, label, appId: config.appId }))) }); }
function gatewayConfiguration(profile, ports) { return Object.freeze({ recoveryOrigin: profile.recoveryOrigin, replicas: Object.freeze(ports.replicas.map(item => Object.freeze({ ...item }))) }); }
function exists(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
function owned(stat) { return typeof process.getuid !== 'function' || stat.uid === process.getuid(); }
function directory(path) { const stat = lstatSync(path); check(stat.isDirectory() && !stat.isSymbolicLink(), 'NATIVE_STATE_PATH_INVALID'); privatePermissions(stat, 0o700, 'NATIVE_STATE_PATH_INVALID'); return stat; }
function systemAliases(path) {
  for (const alias of ['/tmp', '/var']) if (within(path, alias)) {
    try { const real = realpathSync(alias); if (real === '/private' + alias) return real + path.slice(alias.length); } catch { /* ordinary path validation follows */ }
  }
  return path;
}
function planDirectory(state, initializing) {
  check(typeof state === 'string' && state.length > 0 && state.length <= 4096 && !state.includes('\0') && !state.split(sep).includes('..'), 'NATIVE_STATE_PATH_INVALID');
  const target = systemAliases(resolve(state));
  check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(basename(target)), 'NATIVE_STATE_PATH_INVALID');
  check(!within(target, packageRoot) || within(target, privateRoot), 'NATIVE_STATE_PATH_INVALID');
  const planned = []; let parent = dirname(target);
  while (!exists(parent)) { check(within(parent, privateRoot), 'NATIVE_STATE_PATH_INVALID'); planned.unshift(parent); parent = dirname(parent); }
  check(realpathSync(parent) === parent && !lstatSync(parent).isSymbolicLink(), 'NATIVE_STATE_PATH_INVALID');
  if (parent !== packageRoot || !within(target, privateRoot)) directory(parent);
  // State must never be nested under a deployable native role, even when that
  // role was built outside this package and later chmodded to a private mode.
  for (let ancestor = parent;; ancestor = dirname(ancestor)) {
    check(!exists(join(ancestor, 'continuity-config.json')), 'NATIVE_STATE_PATH_INVALID');
    if (ancestor === dirname(ancestor)) break;
  }
  for (let ancestor = parent; within(ancestor, privateRoot); ancestor = dirname(ancestor)) directory(ancestor);
  if (initializing) check(!exists(target), 'NATIVE_STATE_EXISTS');
  else { directory(target); check(realpathSync(target) === target, 'NATIVE_STATE_PATH_INVALID'); }
  return { target, planned };
}
// Metadata-only path check used before taking the shared runtime lock. No state
// file or database is read until the caller owns that lock.
export function nativeOperatorDirectory(state) { return planDirectory(state, false).target; }
function privateFile(path, limit) {
  let fd;
  try {
    const before = lstatSync(path);
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= limit, 'NATIVE_STATE_INVALID');
    privatePermissions(before, 0o600, 'NATIVE_STATE_INVALID');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= limit && stat.dev === before.dev && stat.ino === before.ino, 'NATIVE_STATE_INVALID');
    privatePermissions(stat, 0o600, 'NATIVE_STATE_INVALID');
    const chunks = []; let size = 0;
    while (size <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - size)), count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break; size += count; chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd);
    check(size <= limit && size === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'NATIVE_STATE_INVALID');
    return { bytes: Buffer.concat(chunks, size), stat };
  } finally { if (fd !== undefined) closeSync(fd); }
}
function json(path, limit = 16384) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(privateFile(path, limit).bytes)); }
function validateDatabase(path, expected) {
  let db;
  try {
    const { stat } = privateFile(path, 20 * 1024 * 1024);
    db = new DatabaseSync(path, { readOnly: true });
    const current = lstatSync(path); check(current.ino === stat.ino && current.dev === stat.dev && current.nlink === 1 && !current.isSymbolicLink(), 'NATIVE_STATE_DATABASE_INVALID');
    db.exec('BEGIN'); // Read transaction only; never change journal or pragmas.
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    check(tables.map(item => item.name).join(',') === 'operator_capabilities,operator_meta,operator_records', 'NATIVE_STATE_DATABASE_INVALID');
    check(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type IN ('trigger','view')").get().n === 0, 'NATIVE_STATE_DATABASE_INVALID');
    const meta = db.prepare('SELECT id,config,issued FROM operator_meta LIMIT 2').all();
    check(meta.length === 1 && meta[0].id === 1 && meta[0].config === canonical(expected) && Number.isSafeInteger(meta[0].issued) && meta[0].issued >= 0 && meta[0].issued <= LIMITS.maxIssuedCapabilities, 'NATIVE_STATE_DATABASE_INVALID');
    const rows = db.prepare('SELECT locator,ciphertext FROM operator_records LIMIT 65').all();
    check(rows.length <= LIMITS.maxRecords && rows.length <= meta[0].issued && new Set(rows.map(row => row.locator)).size === rows.length, 'NATIVE_STATE_DATABASE_INVALID');
    for (const row of rows) { check(locator(row.locator), 'NATIVE_STATE_DATABASE_INVALID'); ciphertext(row.ciphertext); }
    const capabilities = db.prepare('SELECT hash,expires,used FROM operator_capabilities LIMIT 257').all();
    check(capabilities.length <= meta[0].issued && new Set(capabilities.map(item => item.hash)).size === capabilities.length, 'NATIVE_STATE_DATABASE_INVALID');
    for (const cap of capabilities) check(typeof cap.hash === 'string' && /^[a-f0-9]{64}$/.test(cap.hash) && Number.isSafeInteger(cap.expires) && cap.expires > 0 && cap.expires <= Date.parse(expected.expiresAt) && (cap.used === 0 || cap.used === 1), 'NATIVE_STATE_DATABASE_INVALID');
    db.exec('COMMIT');
  } catch (error) { const result = fail('NATIVE_STATE_DATABASE_INVALID'); if (permissionError(error)) Object.defineProperty(result, 'diagnosticCode', { value: 'PRIVATE_PERMISSIONS_INVALID' }); throw result; }
  finally { try { db?.close(); } catch { /* errors never include database paths */ } }
}
function output(directory, profile, ports) {
  return Object.freeze({ directory, profile, ports,
    databasePaths: Object.freeze(profile.replicas.map(({ id }) => Object.freeze({ id, database: join(directory, id + '.db'), invitationFile: join(directory, id + '-invitation.txt') }))),
    invitationsFile: join(directory, 'invitations.json'), gatewayConfiguration: gatewayConfiguration(profile, ports), operatorProfilePath: join(directory, 'operator-profile.json') });
}

/** Validate fixed paths without chmod, repair, admission, PRAGMA mutation or
 * recursive inspection of unrelated private files. Returns no bearer values.
 */
export function readNativeOperatorState(options) {
  try {
    const { profile: supplied, state } = object(options, ['profile', 'state']);
    const profile = validateNativeProfile(supplied), { target } = planDirectory(state, false);
    const saved = object(json(join(target, 'native-state.json')), ['version', 'profile', 'ports']);
    check(saved.version === 1, 'NATIVE_STATE_INVALID');
    const savedProfile = validateNativeProfile(saved.profile);
    check(canonical(savedProfile) === canonical(profile), 'NATIVE_STATE_BINDING_INVALID');
    const ports = portsCopy(saved.ports, profile), paths = output(target, profile, ports), expected = runtimeProfile(profile);
    check(canonical(json(paths.operatorProfilePath)) === canonical(expected), 'NATIVE_STATE_BINDING_INVALID');
    check(canonical(json(join(target, 'gateway.json'))) === canonical(paths.gatewayConfiguration), 'NATIVE_STATE_BINDING_INVALID');
    const invitations = object(json(paths.invitationsFile), ['replicas']);
    check(Array.isArray(invitations.replicas) && invitations.replicas.length === profile.replicas.length, 'NATIVE_STATE_INVALID');
    const secrets = new Set();
    for (const [index, item] of paths.databasePaths.entries()) {
      const value = object(invitations.replicas[index], ['id', 'port', 'invitation']);
      check(value.id === item.id && value.port === ports.replicas[index].port && typeof value.invitation === 'string' && /^[a-f0-9]{64}$/.test(value.invitation) && !secrets.has(value.invitation), 'NATIVE_STATE_BINDING_INVALID');
      secrets.add(value.invitation);
      check(privateFile(item.invitationFile, 65).bytes.toString('utf8') === value.invitation + '\n', 'NATIVE_STATE_BINDING_INVALID');
      validateDatabase(item.database, expected); value.invitation = undefined;
    }
    return paths;
  } catch (error) { throw safeError(error); }
}

/** No-overwrite initialization. The directory is reserved exclusively; a
 * committed manifest is published last, so incomplete state is never usable.
 * Invitations are local administrator secrets, not passkeys or grants.
 */
function createNativeOperatorState(options, transfers) {
  const created = [], parents = []; let target, ownedDirectory;
  const remember = path => { const stat = lstatSync(path); created.push({ path, ino: stat.ino, dev: stat.dev }); };
  const write = (path, value) => {
    const fd = openSync(path, 'wx', 0o600);
    try { const stat = fstatSync(fd); created.push({ path, ino: stat.ino, dev: stat.dev }); writeFileSync(fd, value); fsyncSync(fd); }
    finally { closeSync(fd); }
  };
  try {
    const { profile: supplied, state, ports: suppliedPorts } = object(options, ['profile', 'state', 'ports']);
    const profile = validateNativeProfile(supplied), ports = portsCopy(suppliedPorts, profile), plan = planDirectory(state, true);
    target = plan.target;
    for (const parent of plan.planned) {
      try { mkdirSync(parent, { mode: 0o700 }); const stat = lstatSync(parent); parents.push({ path: parent, ino: stat.ino, dev: stat.dev }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; directory(parent); }
    }
    try { mkdirSync(target, { mode: 0o700 }); const stat = lstatSync(target); ownedDirectory = { ino: stat.ino, dev: stat.dev }; }
    catch (error) { if (error.code === 'EEXIST') throw fail('NATIVE_STATE_EXISTS'); throw error; }
    directory(target);
    const expected = runtimeProfile(profile), invitations = [], secrets = new Set();
    write(join(target, 'operator-profile.json'), JSON.stringify(expected) + '\n');
    write(join(target, 'gateway.json'), JSON.stringify(gatewayConfiguration(profile, ports)) + '\n');
    for (const { id, port } of ports.replicas) {
      let invitation; do { invitation = randomBytes(32).toString('hex'); } while (secrets.has(invitation)); secrets.add(invitation);
      write(join(target, id + '-invitation.txt'), invitation + '\n');
      const database = join(target, id + '.db');
      if (transfers) {
        const temporary = join(target, '.native-transfer-' + randomBytes(12).toString('hex') + '.json');
        write(temporary, transfers.find(item => item.id === id).bytes);
        importDatabase(temporary, expected, database); remember(database); unlinkSync(temporary);
      } else { initializeDatabase(database, expected); remember(database); }
      invitations.push({ id, port, invitation });
    }
    write(join(target, 'invitations.json'), JSON.stringify({ replicas: invitations }) + '\n');
    const temporary = join(target, '.native-state-' + randomBytes(12).toString('hex') + '.tmp');
    write(temporary, JSON.stringify({ version: 1, profile, ports }) + '\n');
    const manifest = join(target, 'native-state.json'); linkSync(temporary, manifest); remember(manifest); unlinkSync(temporary);
    readNativeOperatorState({ profile, state: target });
    return Object.freeze({ initialized: true, replicas: profile.replicas.length, passkeysCreated: false, servicesStarted: false });
  } catch (error) {
    for (const item of created.reverse()) try { const current = lstatSync(item.path); if (current.ino === item.ino && current.dev === item.dev && !current.isDirectory()) unlinkSync(item.path); } catch { /* missing or changed files are retained */ }
    if (ownedDirectory) try { const current = lstatSync(target); if (current.ino === ownedDirectory.ino && current.dev === ownedDirectory.dev) rmdirSync(target); } catch { /* never recursively remove unexpected contents or replacement directories */ }
    for (const item of parents.reverse()) try { const current = lstatSync(item.path); if (current.ino === item.ino && current.dev === item.dev) rmdirSync(item.path); } catch { /* another user may now need it */ }
    throw safeError(error, 'NATIVE_STATE_INITIALIZATION_FAILED');
  }
}

export function initializeNativeOperator(options) { return createNativeOperatorState(options); }

/** Restore is a separate, explicit entrypoint. Capture and validate all ordered
 * transfers before creating any directory. Pending capabilities never import;
 * invitations are generated by the same no-overwrite initialization path. */
export function restoreNativeOperatorState(options) {
  try {
    const { profile: supplied, state, ports, transfers: input } = object(options, ['profile','state','ports','transfers']);
    const profile = validateNativeProfile(supplied), expected = runtimeProfile(profile), length = input && Object.getOwnPropertyDescriptor(input, 'length');
    check(Array.isArray(input) && length && Object.hasOwn(length, 'value') && length.value === profile.replicas.length
      && Object.getOwnPropertyNames(input).length === length.value + 1 && !Object.getOwnPropertySymbols(input).length, 'NATIVE_STATE_TRANSFER_INVALID');
    const transfers = [];
    for (let index = 0; index < length.value; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); check(descriptor && Object.hasOwn(descriptor, 'value'), 'NATIVE_STATE_TRANSFER_INVALID');
      const transfer = object(descriptor.value, ['id','bytes'], 'NATIVE_STATE_TRANSFER_INVALID');
      check(transfer.id === profile.replicas[index].id && transfer.bytes instanceof Uint8Array && transfer.bytes.length > 0 && transfer.bytes.length <= 6 * 1024 * 1024, 'NATIVE_STATE_TRANSFER_INVALID');
      const bytes = Buffer.from(transfer.bytes); let payload;
      try { payload = validateTransfer(bytes, expected); } catch { throw fail('NATIVE_STATE_TRANSFER_INVALID'); }
      transfers.push({ id: transfer.id, bytes, records: payload.records.length, issuedCapabilities: payload.issuedCapabilities });
    }
    createNativeOperatorState({ profile, state, ports }, transfers);
    return Object.freeze({ restored: true, replicas: Object.freeze(transfers.map(({ id, records, issuedCapabilities }) => Object.freeze({ id, records, issuedCapabilities }))),
      pendingCapabilitiesTransferred: false, passkeysCreated: false, servicesStarted: false });
  } catch (error) { throw safeError(error, 'NATIVE_STATE_TRANSFER_INVALID'); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    check(process.argv[2] === 'init', 'NATIVE_STATE_INVALID');
    for (let index = 3; index < process.argv.length; index += 2) {
      const name = process.argv[index]?.slice(2), value = process.argv[index + 1];
      check(process.argv[index]?.startsWith('--') && ['profile', 'state', 'ports'].includes(name) && value && !value.startsWith('--') && !Object.hasOwn(args, name), 'NATIVE_STATE_INVALID'); args[name] = value;
    }
    check(args.profile && args.state && args.ports, 'NATIVE_STATE_INVALID');
    // Configuration contains no invitations; capabilities are generated only
    // after both bounded public files and all destination checks succeed.
    const publicJson = path => { const stat = lstatSync(path); check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16384, 'NATIVE_STATE_INVALID'); return JSON.parse(readFileSync(path, 'utf8')); };
    console.log(JSON.stringify(initializeNativeOperator({ profile: publicJson(args.profile), state: args.state, ports: publicJson(args.ports) })));
  } catch (error) { console.error(safeError(error).code); process.exitCode = 1; }
}
