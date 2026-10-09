import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey, uniqueIndex, check } from 'drizzle-orm/sqlite-core';

export const workReleases = sqliteTable('work_releases', {
  namespace: text('namespace').primaryKey(),
  schema: text('schema').notNull(),
  expiresMs: integer('expires_ms').notNull(),
  purgedMs: integer('purged_ms'),
}, t => [
  check('release_schema', sql`${t.schema} = 'account-reserve-ciphertext/v1'`),
  check('release_expiry', sql`typeof(${t.expiresMs}) = 'integer' AND ${t.expiresMs} > 0`),
  check('release_purge', sql`${t.purgedMs} IS NULL OR (typeof(${t.purgedMs}) = 'integer' AND ${t.purgedMs} >= ${t.expiresMs})`),
]);

// A ciphertext and its spent enrollment ticket share one immutable row.
export const workRecords = sqliteTable('work_records', {
  namespace: text('namespace').notNull().references(() => workReleases.namespace),
  locator: text('locator').notNull(),
  ticketHash: text('ticket_hash').notNull(),
  ciphertext: text('ciphertext').notNull(),
}, t => [
  primaryKey({ columns: [t.namespace, t.locator] }),
  uniqueIndex('work_record_ticket').on(t.namespace, t.ticketHash),
  check('record_locator', sql`length(${t.locator}) = 43 AND ${t.locator} NOT GLOB '*[^A-Za-z0-9_-]*'`),
  check('record_ticket', sql`length(${t.ticketHash}) = 64 AND ${t.ticketHash} NOT GLOB '*[^0-9a-f]*'`),
  check('record_bytes', sql`length(${t.ciphertext}) BETWEEN 2 AND 87382 AND ${t.ciphertext} NOT GLOB '*[^A-Za-z0-9_-]*'`),
]);
