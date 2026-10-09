import { SCHEMA, MAX_RECORDS, MAX_RECORD_BYTES, base64url, decode64, validLocator, fail } from '../release/profile.mjs';

// Database time is authoritative even if an application clock is stale.
const NOW = `(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))`;
const COUNT = `(SELECT count(*) FROM work_records WHERE namespace = ?1)`;
const HEADER = `EXISTS (SELECT 1 FROM work_releases WHERE namespace=?1 AND schema=?2 AND expires_ms=?3 AND purged_ms IS NULL)`;
const INVALID = `(EXISTS (SELECT 1 FROM work_releases WHERE namespace=?1) AND NOT ${HEADER}) OR ${COUNT}>${MAX_RECORDS}`;
const PICK = `SELECT CASE
  WHEN ?3<=${NOW} THEN 'expired'
  WHEN ${INVALID} THEN 'invalid'
  WHEN EXISTS(SELECT 1 FROM work_records WHERE namespace=?1 AND ticket_hash=?4) THEN 'denied'
  WHEN ${COUNT}>=${MAX_RECORDS} THEN 'denied'
  ELSE 'ready' END AS state`;
const PIN = `INSERT INTO work_releases(namespace,schema,expires_ms)
  SELECT ?1,?2,?3 WHERE ?3>${NOW} ON CONFLICT(namespace) DO NOTHING`;
const INSERT = `INSERT INTO work_records(namespace,locator,ticket_hash,ciphertext)
  SELECT ?1,?4,?5,?6 WHERE ?3>${NOW} AND ${HEADER}
  AND NOT EXISTS(SELECT 1 FROM work_records WHERE namespace=?1 AND (locator=?4 OR ticket_hash=?5))
  AND ${COUNT}<${MAX_RECORDS} RETURNING locator`;
const CLASSIFY = `SELECT CASE
  WHEN ?3<=${NOW} THEN 'expired'
  WHEN NOT ${HEADER} OR ${COUNT}>${MAX_RECORDS} THEN 'invalid'
  WHEN EXISTS(SELECT 1 FROM work_records WHERE namespace=?1 AND ticket_hash=?5 AND locator=?4) THEN 'conflict'
  WHEN EXISTS(SELECT 1 FROM work_records WHERE namespace=?1 AND ticket_hash=?5) THEN 'consumed'
  WHEN EXISTS(SELECT 1 FROM work_records WHERE namespace=?1 AND locator=?4) THEN 'conflict'
  WHEN ${COUNT}>=${MAX_RECORDS} THEN 'limit'
  ELSE 'invalid' END AS state`;

function rows(result) {
  if (!result || result.success !== true || !Array.isArray(result.results)) throw fail('STORE_UNAVAILABLE');
  return result.results;
}
function one(result) { const values=rows(result); if(values.length!==1)throw fail('STORE_UNAVAILABLE');return values[0]; }

export function createWorkD1Store({ db, profile }) {
  if (!db || typeof db.prepare!=='function' || typeof db.batch!=='function' || !profile || !/^[a-f0-9]{32}$/.test(profile.releaseId) || !Number.isSafeInteger(profile.expires) || profile.expires<=0) throw fail('STORE_CONFIGURATION_INVALID');
  const namespace=`accountreserve:v1:${profile.releaseId}`;
  const base=[namespace,SCHEMA,profile.expires];
  const statement=(sql,...args)=>db.prepare(sql).bind(...base,...args);
  return Object.freeze({
    async checkEnrollment(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw fail('ENROLLMENT_DENIED');
      const state=one(await statement(PICK,hash).all()).state;
      if(!['ready','denied','expired'].includes(state))throw fail('STORE_UNAVAILABLE');
      return state;
    },
    async get(locator) {
      if(!validLocator(locator))throw fail('LOCATOR_INVALID');
      const result=one(await statement(`SELECT CASE WHEN ?3<=${NOW} THEN 'expired' WHEN ${INVALID} THEN 'invalid' ELSE 'ready' END AS state,
        (SELECT ciphertext FROM work_records WHERE namespace=?1 AND locator=?4 AND ${HEADER} AND ?3>${NOW}) AS ciphertext`,locator).all());
      if(result.state==='expired')throw fail('RELEASE_EXPIRED');
      if(result.state!=='ready')throw fail('STORE_UNAVAILABLE');
      return result.ciphertext===null?undefined:decode64(result.ciphertext,MAX_RECORD_BYTES);
    },
    async putIfAbsent(locator,bytes,hash) {
      if(!validLocator(locator)||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>MAX_RECORD_BYTES||!/^[a-f0-9]{64}$/.test(hash))throw fail('RECORD_INVALID');
      // All three statements form one D1 transaction. A lost result is never retried here.
      const result=await db.batch([statement(PIN),statement(INSERT,locator,hash,base64url(bytes)),statement(CLASSIFY,locator,hash)]);
      if(!Array.isArray(result)||result.length!==3)throw fail('STORE_WRITE_UNKNOWN');
      rows(result[0]);const inserted=rows(result[1]);const state=one(result[2]).state;
      if(inserted.length===1&&inserted[0].locator===locator&&['conflict','expired'].includes(state))return 'created';
      if(inserted.length!==0||!['expired','conflict','consumed','limit'].includes(state))throw fail('STORE_WRITE_UNKNOWN');
      return state;
    },
    async cleanupExpired() {
      // No caller-supplied namespace/date; live releases cannot be erased by this operation.
      const result=await db.batch([
        statement(`DELETE FROM work_records WHERE namespace=?1 AND ?3<=${NOW} AND ${COUNT}<=${MAX_RECORDS}
          AND EXISTS(SELECT 1 FROM work_releases WHERE namespace=?1 AND schema=?2 AND expires_ms=?3) RETURNING 1 AS removed`),
        statement(`UPDATE work_releases SET purged_ms=COALESCE(purged_ms,${NOW})
          WHERE namespace=?1 AND schema=?2 AND expires_ms=?3 AND expires_ms<=${NOW}
          AND NOT EXISTS(SELECT 1 FROM work_records WHERE namespace=?1)`),
        statement(`SELECT CASE WHEN ?3>${NOW} THEN 'not_due'
          WHEN EXISTS(SELECT 1 FROM work_releases WHERE namespace=?1 AND (schema<>?2 OR expires_ms<>?3)) THEN 'invalid'
          WHEN ${COUNT}<>0 THEN 'invalid' ELSE 'deleted' END AS state, ${COUNT} AS remaining,
          (SELECT purged_ms FROM work_releases WHERE namespace=?1) AS purgedMs`),
      ]);
      if(!Array.isArray(result)||result.length!==3)throw fail('CLEANUP_UNCONFIRMED');
      const removed=rows(result[0]).length;rows(result[1]);const status=one(result[2]);
      if(!['not_due','deleted'].includes(status.state)||!Number.isSafeInteger(status.remaining)||status.remaining<0||removed>MAX_RECORDS||(status.state==='deleted'&&status.remaining!==0))throw fail('CLEANUP_UNCONFIRMED');
      return Object.freeze({state:status.state,removed,remaining:status.remaining,purgedMs:status.purgedMs});
    },
    limits:Object.freeze({maxRecords:MAX_RECORDS,maxRecordBytes:MAX_RECORD_BYTES}),
  });
}
