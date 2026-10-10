import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { validateNativeProfile } from './profile.mjs';
import { runtimeProfile } from './operator.mjs';
import { nativeOperatorDirectory, readNativeOperatorState, restoreNativeOperatorState } from './operator-state.mjs';
import { exportDatabase, validateTransfer } from './operator-runtime/store.mjs';
import { canonical } from './operator-runtime/profile.mjs';

const FORMAT = 'continuitykit/native-operator-backup/v1';
const TRANSFER_LIMIT = 6 * 1024 * 1024;
export const MAX_NATIVE_BACKUP_BYTES = 3 * TRANSFER_LIMIT + 16384;
const packageRoot = realpathSync(fileURLToPath(new URL('./', import.meta.url)));
const within = (child, parent) => child === parent || child.startsWith(parent + sep);
const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owned = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
function check(condition, code) { if (!condition) throw fail(code); }
function safeError(error) {
  const code = error?.code;
  return fail(typeof code === 'string' && /^(?:NATIVE_BACKUP_[A-Z_]+|NATIVE_STATE_[A-Z_]+|NATIVE_PROFILE_(?:INVALID|EXPIRED)|NATIVE_OPERATOR_LOCKED)$/.test(code) ? code : 'NATIVE_BACKUP_FAILED');
}
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function optionsRecord(input, fields) {
  try {
    check(input && typeof input === 'object' && !Array.isArray(input)
      && [Object.prototype, null].includes(Object.getPrototypeOf(input)) && !Object.getOwnPropertySymbols(input).length
      && Object.getOwnPropertyNames(input).sort().join(',') === [...fields].sort().join(','), 'NATIVE_BACKUP_ARGUMENTS_INVALID');
    const output = {};
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'NATIVE_BACKUP_ARGUMENTS_INVALID'); output[key] = descriptor.value;
    }
    return output;
  } catch { throw fail('NATIVE_BACKUP_ARGUMENTS_INVALID'); }
}
function aliases(path) {
  for (const prefix of ['/tmp','/var']) if (within(path, prefix)) {
    try { if (realpathSync(prefix) === '/private' + prefix) return '/private' + path; } catch { /* normal validation follows */ }
  }
  return path;
}
function exists(path) { try { return lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
function privatePath(value, creating) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && !value.split(sep).includes('..'), 'NATIVE_BACKUP_PATH_INVALID');
  const target = aliases(resolve(value)), parent = dirname(target), stat = lstatSync(parent);
  check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(basename(target)) && basename(target) !== 'continuity-config.json', 'NATIVE_BACKUP_PATH_INVALID');
  check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o7777) === 0o700 && owned(stat)
    && realpathSync(parent) === parent, 'NATIVE_BACKUP_PATH_INVALID');
  check(!within(parent, packageRoot) || within(parent, join(packageRoot, 'private')), 'NATIVE_BACKUP_PATH_INVALID');
  for (let ancestor = parent;; ancestor = dirname(ancestor)) {
    check(!exists(join(ancestor, 'continuity-config.json')), 'NATIVE_BACKUP_PATH_INVALID');
    if (ancestor === dirname(ancestor)) break;
  }
  if (creating) check(!exists(target), 'NATIVE_BACKUP_OUTPUT_EXISTS');
  return target;
}
function boundedRead(fd, maximum) {
  const chunks = []; let size = 0;
  while (size <= maximum) {
    const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - size)), count = readSync(fd, chunk, 0, chunk.length, null);
    if (!count) break; chunks.push(chunk.subarray(0, count)); size += count;
  }
  check(size <= maximum, 'NATIVE_BACKUP_FILE_INVALID'); return Buffer.concat(chunks, size);
}
function privateBytes(path, maximum) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600 && owned(stat)
      && stat.size > 0 && stat.size <= maximum, 'NATIVE_BACKUP_FILE_INVALID');
    const bytes = boundedRead(fd, maximum), after = fstatSync(fd);
    check(bytes.length > 0 && bytes.length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs
      && after.ctimeMs === stat.ctimeMs, 'NATIVE_BACKUP_FILE_INVALID');
    return { bytes, stat };
  } finally { if (fd !== undefined) closeSync(fd); }
}
function sameFile(path, stat) {
  const current = exists(path);
  return Boolean(current?.isFile() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino);
}
function removeOwned(path, stat) { if (sameFile(path, stat)) unlinkSync(path); }
function parse(bytes) {
  let text, value;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text); }
  catch { throw fail('NATIVE_BACKUP_INVALID'); }
  check(Buffer.from(canonical(value)).equals(bytes), 'NATIVE_BACKUP_INVALID'); return value;
}
function lockState(directory) {
  const directoryStat = lstatSync(directory);
  const path = join(directory, 'runtime.lock'), text = JSON.stringify({ version: 1, nonce: randomBytes(32).toString('hex') }) + '\n';
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) { throw fail(error.code === 'EEXIST' ? 'NATIVE_OPERATOR_LOCKED' : 'NATIVE_BACKUP_LOCK_FAILED'); }
  const stat = fstatSync(fd);
  try { writeFileSync(fd, text); fsyncSync(fd); }
  catch { try { removeOwned(path, stat); } finally { closeSync(fd); } throw fail('NATIVE_BACKUP_LOCK_FAILED'); }
  const sameDirectory = () => {
    try {
      const currentDirectory = lstatSync(directory);
      return currentDirectory.isDirectory() && !currentDirectory.isSymbolicLink() && currentDirectory.dev === directoryStat.dev
        && currentDirectory.ino === directoryStat.ino && realpathSync(directory) === directory;
    } catch { return false; }
  };
  const current = () => {
    try {
      if (!sameDirectory()) return false;
      const captured = privateBytes(path, Buffer.byteLength(text));
      return captured.stat.dev === stat.dev && captured.stat.ino === stat.ino && captured.bytes.toString('utf8') === text
        && sameDirectory() && sameFile(path, stat);
    } catch { return false; }
  };
  return { sameDirectory, assertOwned() { check(current(), 'NATIVE_BACKUP_LOCK_CHANGED'); }, close() {
    try { check(current(), 'NATIVE_BACKUP_LOCK_CHANGED'); unlinkSync(path); } finally { closeSync(fd); }
  } };
}
function publish(path, bytes, parentStat) {
  const parent = dirname(path);
  const sameParent = () => {
    try { const stat = lstatSync(parent); return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === parentStat.dev && stat.ino === parentStat.ino; }
    catch { return false; }
  };
  const assertParent = () => { check(sameParent(), 'NATIVE_BACKUP_PATH_CHANGED'); privatePath(path, true); };
  const temporary = join(dirname(path), '.native-backup-' + randomBytes(16).toString('hex') + '.tmp');
  let fd, stat;
  try {
    assertParent();
    fd = openSync(temporary, 'wx', 0o600); stat = fstatSync(fd); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    assertParent();
    try { linkSync(temporary, path); } catch (error) { throw error.code === 'EEXIST' ? fail('NATIVE_BACKUP_OUTPUT_EXISTS') : error; }
  } finally { if (fd !== undefined) closeSync(fd); if (stat && sameParent()) removeOwned(temporary, stat); }
}

/** Stopped-stack export under the launcher's exclusive lock. The returned hash
 * detects change against a separately retained value; it is neither a signature
 * nor proof that this is the latest snapshot or that ciphertext can decrypt. */
export function backupNativeOperator(options) {
  let lock;
  try {
    const { profile: supplied, state, output } = optionsRecord(options, ['profile','state','output']);
    const profile = validateNativeProfile(supplied), target = privatePath(output, true);
    const outputParent = lstatSync(dirname(target));
    const directory = nativeOperatorDirectory(state); lock = lockState(directory);
    // Only now may state files and SQLite records be read.
    lock.assertOwned();
    const saved = readNativeOperatorState({ profile, state: directory }), expected = runtimeProfile(profile), replicas = [], summary = [];
    for (const item of saved.databasePaths) {
      lock.assertOwned();
      const temporary = join(directory, 'backup-transfer-' + randomBytes(16).toString('hex') + '.json'); let stat;
      try {
        exportDatabase(item.database, expected, temporary);
        stat = lstatSync(temporary); const captured = privateBytes(temporary, TRANSFER_LIMIT);
        const payload = validateTransfer(captured.bytes, expected);
        replicas.push({ id: item.id, transfer: parse(captured.bytes) });
        summary.push(Object.freeze({ id: item.id, records: payload.records.length, issuedCapabilities: payload.issuedCapabilities }));
      } finally { if (stat && lock.sameDirectory()) removeOwned(temporary, stat); }
    }
    const bytes = Buffer.from(canonical({ format: FORMAT, profile, replicas }));
    check(bytes.length <= MAX_NATIVE_BACKUP_BYTES, 'NATIVE_BACKUP_TOO_LARGE'); lock.assertOwned();
    publish(target, bytes, outputParent);
    return Object.freeze({ backupWritten: true, sha256: hash(bytes), bytes: bytes.length, replicas: Object.freeze(summary), pendingCapabilitiesTransferred: false });
  } catch (error) { throw safeError(error); }
  finally { if (lock) try { lock.close(); } catch (error) { throw safeError(error); } }
}

/** Validate the entire pinned archive and original policy before initializing
 * new state. Ports are explicit destination configuration and never imported.
 * No keys, grants, invitations or existing directory are adopted or overwritten. */
export function restoreNativeOperator(options) {
  try {
    const { profile: supplied, ports, input, expectedSha256, state } = optionsRecord(options, ['profile','ports','input','expectedSha256','state']);
    check(typeof expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedSha256), 'NATIVE_BACKUP_DIGEST_INVALID');
    const profile = validateNativeProfile(supplied), path = privatePath(input, false), { bytes } = privateBytes(path, MAX_NATIVE_BACKUP_BYTES);
    check(hash(bytes) === expectedSha256, 'NATIVE_BACKUP_DIGEST_MISMATCH');
    const bundle = parse(bytes);
    check(exact(bundle, ['format','profile','replicas']) && bundle.format === FORMAT, 'NATIVE_BACKUP_INVALID');
    const storedProfile = validateNativeProfile(bundle.profile);
    check(canonical(storedProfile) === canonical(profile), 'NATIVE_BACKUP_PROFILE_MISMATCH');
    check(Array.isArray(bundle.replicas) && bundle.replicas.length === profile.replicas.length, 'NATIVE_BACKUP_INVALID');
    const expected = runtimeProfile(profile), transfers = bundle.replicas.map((replica, index) => {
      check(exact(replica, ['id','transfer']) && replica.id === profile.replicas[index].id, 'NATIVE_BACKUP_INVALID');
      const bytes = Buffer.from(canonical(replica.transfer));
      check(bytes.length <= TRANSFER_LIMIT, 'NATIVE_BACKUP_TOO_LARGE');
      try { validateTransfer(bytes, expected); } catch { throw fail('NATIVE_BACKUP_INVALID'); }
      return { id: replica.id, bytes };
    });
    return restoreNativeOperatorState({ profile, ports, state, transfers });
  } catch (error) { throw safeError(error); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2], args = {}, fields = action === 'backup' ? ['profile','state','out'] : action === 'restore' ? ['profile','ports','in','sha256','state'] : [];
    check(fields.length > 0, 'NATIVE_BACKUP_ARGUMENTS_INVALID');
    for (let index = 3; index < process.argv.length; index += 2) {
      const name = process.argv[index]?.slice(2), value = process.argv[index + 1];
      check(process.argv[index]?.startsWith('--') && fields.includes(name) && typeof value === 'string' && value.length > 0 && !value.startsWith('--') && !Object.hasOwn(args, name), 'NATIVE_BACKUP_ARGUMENTS_INVALID'); args[name] = value;
    }
    check(Object.keys(args).length === fields.length, 'NATIVE_BACKUP_ARGUMENTS_INVALID');
    if (action === 'restore') check(/^[a-f0-9]{64}$/.test(args.sha256), 'NATIVE_BACKUP_DIGEST_INVALID');
    const publicJson = path => { let fd; try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = fstatSync(fd); check(stat.isFile() && stat.nlink === 1 && stat.size <= 16384, 'NATIVE_BACKUP_ARGUMENTS_INVALID'); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(boundedRead(fd, 16384))); } finally { if (fd !== undefined) closeSync(fd); } };
    const profile = publicJson(args.profile);
    const result = action === 'backup' ? backupNativeOperator({ profile, state: args.state, output: args.out })
      : restoreNativeOperator({ profile, ports: publicJson(args.ports), input: args.in, expectedSha256: args.sha256, state: args.state });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(safeError(error).code + '\n'); process.exitCode = 1; }
}
