import { base64url, decode64, validLocator, fail } from '../../release/profile.mjs';
import { LIMITS, SELF_SERVICE_SCHEMA } from './profile.mjs';

// Native D1's clock and transactional batch are the authority, not client time.
const NOW = `(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))`;
const HEADER = `EXISTS(SELECT 1 FROM ss_release WHERE id=1 AND namespace=?1 AND schema=?2 AND expires_ms=?3 AND purged_ms IS NULL)`;
const RECORDS = `(SELECT count(*) FROM ss_records)`;
const ISSUED = `(SELECT count(*) FROM ss_capabilities)`;
const PENDING = `(SELECT count(*) FROM ss_capabilities c WHERE c.expires_ms>${NOW} AND NOT EXISTS(SELECT 1 FROM ss_records r WHERE r.namespace=c.namespace AND r.capability_hash=c.capability_hash))`;
const INVALID = `(EXISTS(SELECT 1 FROM ss_release) AND NOT ${HEADER}) OR ${RECORDS}>${LIMITS.maxRecords} OR ${ISSUED}>${LIMITS.maxIssuedCapabilities}`;
const PIN = `INSERT INTO ss_release(id,namespace,schema,expires_ms) SELECT 1,?1,?2,?3 WHERE ?3>${NOW} ON CONFLICT(id) DO NOTHING`;
const ISSUE = `INSERT INTO ss_capabilities(namespace,capability_hash,expires_ms)
  SELECT ?1,?4,MIN(?3,${NOW}+${LIMITS.capabilityTtlMs}) WHERE ?3>${NOW} AND ${HEADER}
  AND ${RECORDS}+${PENDING}<${LIMITS.maxRecords} AND ${ISSUED}<${LIMITS.maxIssuedCapabilities}
  AND NOT EXISTS(SELECT 1 FROM ss_capabilities WHERE namespace=?1 AND capability_hash=?4)
  RETURNING capability_hash,expires_ms`;
const ISSUE_STATE = `SELECT CASE WHEN ?3<=${NOW} THEN 'expired' WHEN ${INVALID} THEN 'invalid'
  WHEN EXISTS(SELECT 1 FROM ss_capabilities WHERE namespace=?1 AND capability_hash=?4) THEN 'issued'
  WHEN ${RECORDS}+${PENDING}>=${LIMITS.maxRecords} OR ${ISSUED}>=${LIMITS.maxIssuedCapabilities} THEN 'limit' ELSE 'invalid' END AS state, ${NOW} AS server_now_ms`;
const LIVE_CAPABILITY = `EXISTS(SELECT 1 FROM ss_capabilities WHERE namespace=?1 AND capability_hash=?5 AND expires_ms>${NOW})`;
const INSERT = `INSERT INTO ss_records(namespace,locator,capability_hash,ciphertext)
  SELECT ?1,?4,?5,?6 WHERE ?3>${NOW} AND ${HEADER} AND ${LIVE_CAPABILITY}
  AND NOT EXISTS(SELECT 1 FROM ss_records WHERE namespace=?1 AND (locator=?4 OR capability_hash=?5))
  AND ${RECORDS}<${LIMITS.maxRecords} RETURNING locator`;
const PUT_STATE = `SELECT CASE WHEN ?3<=${NOW} THEN 'expired' WHEN ${INVALID} THEN 'invalid'
  WHEN NOT ${LIVE_CAPABILITY} THEN 'denied'
  WHEN EXISTS(SELECT 1 FROM ss_records WHERE namespace=?1 AND capability_hash=?5 AND locator=?4) THEN 'conflict'
  WHEN EXISTS(SELECT 1 FROM ss_records WHERE namespace=?1 AND capability_hash=?5) THEN 'consumed'
  WHEN EXISTS(SELECT 1 FROM ss_records WHERE namespace=?1 AND locator=?4) THEN 'conflict'
  WHEN ${RECORDS}>=${LIMITS.maxRecords} THEN 'limit' ELSE 'invalid' END AS state`;
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function rows(value) { if (!value || value.success !== true || !Array.isArray(value.results)) throw fail('STORE_UNAVAILABLE'); return value.results; }
function one(value) { const result = rows(value); if (result.length !== 1) throw fail('STORE_UNAVAILABLE'); return result[0]; }

/** A dedicated database is required. A singleton pins it permanently to one release. */
export function createSelfServiceStore({ db, profile }) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function' || !profile || !/^continuity-judge:v1:[a-f0-9]{32}$/.test(profile.namespace ?? '') || !Number.isSafeInteger(profile.expires) || profile.expires <= 0) throw fail('STORE_CONFIGURATION_INVALID');
  const base = [profile.namespace, SELF_SERVICE_SCHEMA, profile.expires];
  const stmt = (sql, ...args) => db.prepare(sql).bind(...base, ...args);
  return Object.freeze({
    async issue(hash) {
      if (!hashValid(hash)) throw fail('ENROLLMENT_DENIED');
      const result = await db.batch([stmt(PIN), stmt(ISSUE, hash), stmt(ISSUE_STATE, hash)]);
      if (!Array.isArray(result) || result.length !== 3) throw fail('ENROLLMENT_ISSUE_UNKNOWN');
      rows(result[0]); const created = rows(result[1]), status = one(result[2]), state = status.state, serverNow = status.server_now_ms;
      if (!Number.isSafeInteger(serverNow) || serverNow <= 0 || !Number.isFinite(new Date(serverNow).getTime())) throw fail('ENROLLMENT_ISSUE_UNKNOWN');
      if (created.length === 1 && created[0].capability_hash === hash && Number.isSafeInteger(created[0].expires_ms) && created[0].expires_ms > 0 && created[0].expires_ms <= profile.expires) {
        // Return the database clock from the final statement, not an application or device clock.
        // A record inserted just before the release ends must not advertise an already-dead grant.
        if (state === 'expired' && profile.expires <= serverNow) return Object.freeze({ state: 'expired' });
        const lifetime = created[0].expires_ms - serverNow;
        if (state === 'issued' && lifetime > 0 && lifetime <= LIMITS.capabilityTtlMs) return Object.freeze({ state: 'issued', expiresAt: new Date(created[0].expires_ms).toISOString(), serverNow: new Date(serverNow).toISOString() });
      }
      if (created.length === 0 && ['expired', 'limit'].includes(state)) return Object.freeze({ state });
      throw fail('ENROLLMENT_ISSUE_UNKNOWN');
    },
    async get(locator) {
      if (!validLocator(locator)) throw fail('LOCATOR_INVALID');
      const result = one(await stmt(`SELECT CASE WHEN ?3<=${NOW} THEN 'expired' WHEN ${INVALID} THEN 'invalid' ELSE 'ready' END AS state,
        (SELECT ciphertext FROM ss_records WHERE namespace=?1 AND locator=?4 AND ${HEADER} AND ?3>${NOW}) AS ciphertext`, locator).all());
      if (result.state === 'expired') throw fail('RELEASE_EXPIRED');
      if (result.state !== 'ready') throw fail('STORE_UNAVAILABLE');
      return result.ciphertext === null ? undefined : decode64(result.ciphertext, LIMITS.maxRecordBytes);
    },
    async putIfAbsent(locator, bytes, hash) {
      if (!validLocator(locator) || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > LIMITS.maxRecordBytes || !hashValid(hash)) throw fail('RECORD_INVALID');
      // The insertion and outcome classification are one transaction; never retry an uncertain result.
      const result = await db.batch([stmt(INSERT, locator, hash, base64url(new Uint8Array(bytes))), stmt(PUT_STATE, locator, hash)]);
      if (!Array.isArray(result) || result.length !== 2) throw fail('STORE_WRITE_UNKNOWN');
      const inserted = rows(result[0]), state = one(result[1]).state;
      if (inserted.length === 1 && inserted[0].locator === locator && ['conflict', 'expired', 'denied'].includes(state)) return 'created';
      if (inserted.length === 0 && ['expired', 'conflict', 'consumed', 'denied', 'limit'].includes(state)) return state;
      throw fail('STORE_WRITE_UNKNOWN');
    },
    async cleanupExpired() {
      const fixed = `EXISTS(SELECT 1 FROM ss_release WHERE id=1 AND namespace=?1 AND schema=?2 AND expires_ms=?3)`;
      const result = await db.batch([
        stmt(`DELETE FROM ss_records WHERE namespace=?1 AND ?3<=${NOW} AND ${fixed} RETURNING 1 AS removed`),
        stmt(`DELETE FROM ss_capabilities WHERE namespace=?1 AND ?3<=${NOW} AND ${fixed}`),
        stmt(`UPDATE ss_release SET purged_ms=COALESCE(purged_ms,${NOW}) WHERE id=1 AND namespace=?1 AND schema=?2 AND expires_ms=?3 AND ?3<=${NOW} AND ${RECORDS}=0 AND ${ISSUED}=0`),
        stmt(`SELECT CASE WHEN ?3>${NOW} THEN 'not_due' WHEN (EXISTS(SELECT 1 FROM ss_release) AND NOT ${fixed}) OR ${RECORDS}<>0 OR ${ISSUED}<>0 THEN 'invalid' ELSE 'deleted' END AS state, ${RECORDS} AS remaining, ${ISSUED} AS remainingCapabilities, (SELECT purged_ms FROM ss_release WHERE namespace=?1) AS purgedMs`),
      ]);
      if (!Array.isArray(result) || result.length !== 4) throw fail('CLEANUP_UNCONFIRMED');
      const removed = rows(result[0]).length; rows(result[1]); rows(result[2]); const status = one(result[3]);
      if (!['not_due', 'deleted'].includes(status.state) || !Number.isSafeInteger(status.remaining) || !Number.isSafeInteger(status.remainingCapabilities) || removed > LIMITS.maxRecords || (status.state === 'deleted' && (status.remaining !== 0 || status.remainingCapabilities !== 0))) throw fail('CLEANUP_UNCONFIRMED');
      return Object.freeze({ ...status, removed });
    },
  });
}
