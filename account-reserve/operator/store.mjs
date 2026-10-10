import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, ciphertext, decode, exact, fail, hash, LIMITS, locator, profile, TRANSFER_FORMAT } from './profile.mjs';

const MAX_TRANSFER_BYTES = 6 * 1024 * 1024;
const tokenHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function regular(path) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw fail('FILE_INVALID'); return stat; }
function bind(db, supplied) {
  const saved = db.prepare('SELECT config, issued FROM operator_meta WHERE id=1').get();
  if (!saved || saved.config !== canonical(supplied) || !Number.isSafeInteger(saved.issued) || saved.issued < 0 || saved.issued > LIMITS.maxIssuedCapabilities) throw fail('DATABASE_BINDING_INVALID');
  const records = db.prepare('SELECT locator, ciphertext FROM operator_records ORDER BY locator').all();
  if (records.length > LIMITS.maxRecords || saved.issued < records.length) throw fail('DATABASE_INVALID');
  for (const record of records) { if (!locator(record.locator)) throw fail('DATABASE_INVALID'); ciphertext(record.ciphertext); }
  return saved;
}
function openDatabase(path, supplied, readOnly = false) {
  regular(path); const trusted = profile(supplied), db = new DatabaseSync(path, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (!readOnly) db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=4096');
    bind(db, trusted); return { db, trusted };
  } catch (error) { db.close(); throw error; }
}
function createDatabase(path, supplied, records = [], issued = 0) {
  const trusted = profile(supplied); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600); closeSync(fd);
  let db;
  try {
    db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=4096');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE operator_meta(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, issued INTEGER NOT NULL CHECK(issued BETWEEN 0 AND 256));
      CREATE TABLE operator_records(locator TEXT PRIMARY KEY, ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 1 AND 65536));
      CREATE TABLE operator_capabilities(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used IN(0,1)));`);
    db.prepare('INSERT INTO operator_meta VALUES(1,?,?)').run(canonical(trusted), issued);
    const insert = db.prepare('INSERT INTO operator_records VALUES(?,?)');
    for (const row of records) insert.run(row.locator, ciphertext(decode(row.bytes)));
    db.exec('COMMIT'); db.close(); db = undefined; chmodSync(path, 0o600);
  } catch (error) { try { db?.close(); } catch {} try { unlinkSync(path); } catch {} throw error; }
}
export function initializeDatabase(path, supplied) { createDatabase(resolve(path), supplied); }

/** One process may serve concurrent requests. SQLite transactions also serialize
 * other writers. No raw invitation/capability, plaintext or PRF is persisted. */
export function openStore(path, supplied, { now = Date.now } = {}) {
  const { db, trusted } = openDatabase(path, supplied), expires = Date.parse(trusted.expiresAt);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const alive = () => { const time = now(); if (!Number.isSafeInteger(time) || time >= expires) throw fail('STORE_EXPIRED'); return time; };
  return Object.freeze({
    issue(capabilityHash) {
      if (!tokenHash(capabilityHash)) throw fail('ENROLLMENT_DENIED');
      return transaction(() => {
        const time = alive(), count = db.prepare('SELECT count(*) AS n FROM operator_records').get().n;
        const pending = db.prepare('SELECT count(*) AS n FROM operator_capabilities WHERE used=0 AND expires>?').get(time).n;
        const issued = db.prepare('SELECT issued FROM operator_meta WHERE id=1').get().issued;
        if (count + pending >= LIMITS.maxRecords || issued >= LIMITS.maxIssuedCapabilities) throw fail('ENROLLMENT_LIMIT');
        const until = Math.min(expires, time + LIMITS.capabilityTtlMs);
        db.prepare('INSERT INTO operator_capabilities(hash,expires) VALUES(?,?)').run(capabilityHash, until);
        db.prepare('UPDATE operator_meta SET issued=issued+1 WHERE id=1').run();
        return { expiresAt: new Date(until).toISOString(), serverNow: new Date(time).toISOString() };
      });
    },
    get(key) {
      alive(); if (!locator(key)) throw fail('LOCATOR_INVALID');
      const row = db.prepare('SELECT ciphertext FROM operator_records WHERE locator=?').get(key);
      return row ? ciphertext(row.ciphertext) : undefined;
    },
    putIfAbsent(key, bytes, capabilityHash) {
      if (!locator(key) || !tokenHash(capabilityHash)) throw fail('RECORD_INVALID'); const safe = ciphertext(bytes);
      return transaction(() => {
        const time = alive(), cap = db.prepare('SELECT expires,used FROM operator_capabilities WHERE hash=?').get(capabilityHash);
        if (!cap || cap.used || cap.expires <= time) throw fail('ENROLLMENT_DENIED');
        // One authorized attempt consumes the capability, including a conflict.
        db.prepare('UPDATE operator_capabilities SET used=1 WHERE hash=?').run(capabilityHash);
        if (db.prepare('SELECT 1 FROM operator_records WHERE locator=?').get(key)) return false;
        if (db.prepare('SELECT count(*) AS n FROM operator_records').get().n >= LIMITS.maxRecords) throw fail('ENROLLMENT_LIMIT');
        db.prepare('INSERT INTO operator_records VALUES(?,?)').run(key, safe); return true;
      });
    },
    counts() { const row = db.prepare('SELECT issued FROM operator_meta WHERE id=1').get(); return { records: db.prepare('SELECT count(*) AS n FROM operator_records').get().n, issued: row.issued }; },
    close() { db.close(); },
  });
}

export function exportDatabase(path, supplied, out) {
  const { db, trusted } = openDatabase(path, supplied, true);
  try {
    db.exec('BEGIN');
    const saved = bind(db, trusted), rows = db.prepare('SELECT locator,ciphertext FROM operator_records ORDER BY locator').all();
    const payload = { format: TRANSFER_FORMAT, profile: trusted, issuedCapabilities: saved.issued,
      records: rows.map(row => ({ locator: row.locator, bytes: Buffer.from(row.ciphertext).toString('base64url') })) };
    const encoded = canonical({ payload, sha256: hash(canonical(payload)) });
    if (Buffer.byteLength(encoded) > MAX_TRANSFER_BYTES) throw fail('TRANSFER_TOO_LARGE');
    const target = resolve(out), temporary = target + '.export-' + randomBytes(12).toString('hex');
    try {
      writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 });
      // No partially written archive becomes the named output; existing files
      // are never overwritten. Checksum verification still precedes import.
      linkSync(temporary, target);
    } finally { try { unlinkSync(temporary); } catch {} }
    db.exec('COMMIT');
    return { records: rows.length, bytes: Buffer.byteLength(encoded), issuedCapabilities: saved.issued };
  } finally { db.close(); }
}
export function validateTransfer(bytes, supplied) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_TRANSFER_BYTES) throw fail('TRANSFER_INVALID');
  let text, value; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text); } catch { throw fail('TRANSFER_INVALID'); }
  if (!exact(value, ['payload', 'sha256']) || canonical(value) !== text || !tokenHash(value.sha256) || hash(canonical(value.payload)) !== value.sha256) throw fail('TRANSFER_INVALID');
  const payload = value.payload;
  if (!exact(payload, ['format', 'profile', 'issuedCapabilities', 'records']) || payload.format !== TRANSFER_FORMAT
    || canonical(profile(payload.profile)) !== canonical(profile(supplied)) || !Number.isSafeInteger(payload.issuedCapabilities)
    || payload.issuedCapabilities < 0 || payload.issuedCapabilities > LIMITS.maxIssuedCapabilities || !Array.isArray(payload.records)
    || payload.records.length > LIMITS.maxRecords || payload.records.length > payload.issuedCapabilities) throw fail('TRANSFER_INVALID');
  const seen = new Set();
  for (const row of payload.records) {
    if (!exact(row, ['locator', 'bytes']) || !locator(row.locator) || seen.has(row.locator)) throw fail('TRANSFER_INVALID');
    seen.add(row.locator); ciphertext(decode(row.bytes));
  }
  return payload;
}
export function importDatabase(input, supplied, destination) {
  const target = resolve(destination); if (existsSync(target)) throw fail('DESTINATION_EXISTS');
  const stat = regular(input); if (stat.size > MAX_TRANSFER_BYTES) throw fail('TRANSFER_INVALID');
  const value = validateTransfer(readFileSync(input), supplied);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + '.import-' + randomBytes(12).toString('hex');
  try {
    createDatabase(temporary, supplied, value.records, value.issuedCapabilities);
    // Hard-link is atomic and fails if any file (including a symlink) already
    // occupies destination; rename would overwrite an active runtime DB.
    linkSync(temporary, target);
  } finally { try { unlinkSync(temporary); } catch {} }
  return { records: value.records.length, issuedCapabilities: value.issuedCapabilities, pendingCapabilitiesTransferred: false };
}
