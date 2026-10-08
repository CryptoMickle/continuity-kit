import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROLES = ['deploy', 'fund-beneficiary-gas', 'issue-fixed-right'];
const fail = code => Object.assign(new Error(code), { code });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Exclusive, fsynced public tickets. No signed raw bytes or credentials persist.
 * A crashed writer leaves the .lock file: never automatically break a stale lock.
 * Read-only reconciliation works without acquiring/removing that lock.
 * Use one protected, durable directory for this proposal; deleting/copying it or
 * substituting a dishonest adapter defeats durable one-attempt protection.
 */
export async function createFileOperatorJournal({ directory, proposalHash, readOnly = false }) {
  if (typeof directory !== 'string' || !directory || !/^[0-9a-f]{64}$/.test(proposalHash)) throw fail('OPERATOR_JOURNAL_OPTIONS_INVALID');
  const root = resolve(directory);
  if (!readOnly) await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('OPERATOR_JOURNAL_DIRECTORY_INVALID');
  } catch (error) { if (!readOnly || error.code !== 'ENOENT') throw error; }
  const path = (role, phase) => { if (!ROLES.includes(role)) throw fail('OPERATOR_ROLE_NOT_APPROVED'); return join(root, `${proposalHash}-${role}-${phase}.journal.json`); };
  const syncDirectory = async () => { const handle = await open(root, 'r'); try { await handle.sync(); } finally { await handle.close(); } };
  const load = async file => {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw fail('OPERATOR_JOURNAL_FILE_INVALID');
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  async function read(role) {
    const reserved = await load(path(role, 'reserved')), signed = await load(path(role, 'signed'));
    if (signed && (!reserved || reserved.phase !== 'reserved' || reserved.hash !== null || !equal({ ...signed, phase: 'reserved', hash: null }, reserved))) throw fail('OPERATOR_JOURNAL_HISTORY_INVALID');
    return signed ?? reserved;
  }
  async function writeExclusive(entry) {
    if (entry.proposalHash !== proposalHash || !['reserved', 'signed'].includes(entry.phase)) throw fail('OPERATOR_JOURNAL_SCOPE_INVALID');
    const handle = await open(path(entry.role, entry.phase), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(entry) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory();
  }
  async function readResume(role) { return load(path(role, 'resume')); }
  async function reserveResume(entry) {
    const original = await read(entry.role);
    if (!lockHeld || entry.proposalHash !== proposalHash || entry.format !== 'account-reserve-operator-resume/v1' || !original || original.phase !== 'reserved' || original.hash !== null || entry.gas !== original.gas || await readResume(entry.role)) throw fail('OPERATOR_RESUME_RESERVATION_INVALID');
    const handle = await open(path(entry.role, 'resume'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(entry) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory();
  }
  let lockHeld = false;
  return Object.freeze({
    durable: true,
    read,
    readResume,
    reserveResume,
    async reserve(entry) {
      if (!lockHeld || entry.phase !== 'reserved' || entry.hash !== null || await read(entry.role)) throw fail('OPERATOR_JOURNAL_RESERVATION_INVALID');
      await writeExclusive(entry);
    },
    async pin(entry) {
      const reserved = await read(entry.role);
      if (!lockHeld || entry.phase !== 'signed' || !reserved || reserved.phase !== 'reserved' || !equal({ ...entry, phase: 'reserved', hash: null }, reserved)) throw fail('OPERATOR_JOURNAL_PIN_INVALID');
      await writeExclusive(entry);
    },
    async withLock(callback) {
      if (readOnly) throw fail('OPERATOR_JOURNAL_READ_ONLY');
      if (lockHeld) throw fail('OPERATOR_JOURNAL_LOCKED');
      const lockPath = join(root, `${proposalHash}.lock`);
      let handle;
      try { handle = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('OPERATOR_JOURNAL_LOCKED'); throw error; }
      lockHeld = true;
      try { await handle.writeFile(JSON.stringify({ pid: process.pid }) + '\n'); await handle.sync(); await syncDirectory(); return await callback(); }
      finally { lockHeld = false; await handle.close(); await unlink(lockPath); await syncDirectory(); }
    },
  });
}
