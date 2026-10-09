import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey, foreignKey, unique, check } from 'drizzle-orm/sqlite-core';

// One dedicated database is permanently pinned to one demo namespace/deadline.
export const selfServiceRelease = sqliteTable('ss_release', {
  id: integer('id').primaryKey(),
  namespace: text('namespace').notNull(),
  schema: text('schema').notNull(),
  expiresMs: integer('expires_ms').notNull(),
  purgedMs: integer('purged_ms'),
}, t => [
  unique('ss_release_namespace_unique').on(t.namespace),
  check('ss_release_singleton', sql`${t.id} = 1`),
  check('ss_release_schema', sql`${t.schema} = 'continuity-judge-ciphertext/v1'`),
  check('ss_release_expiry', sql`typeof(${t.expiresMs}) = 'integer' AND ${t.expiresMs} > 0`),
  check('ss_release_purge', sql`${t.purgedMs} IS NULL OR (typeof(${t.purgedMs}) = 'integer' AND ${t.purgedMs} >= ${t.expiresMs})`),
]);

// Public upload capabilities are random; only their SHA-256 hashes are persisted.
export const selfServiceCapabilities = sqliteTable('ss_capabilities', {
  namespace: text('namespace').notNull().references(() => selfServiceRelease.namespace),
  capabilityHash: text('capability_hash').notNull(),
  expiresMs: integer('expires_ms').notNull(),
}, t => [
  primaryKey({ columns: [t.namespace, t.capabilityHash] }),
  check('ss_capability_hash', sql`length(${t.capabilityHash}) = 64 AND ${t.capabilityHash} NOT GLOB '*[^0-9a-f]*'`),
  check('ss_capability_expiry', sql`typeof(${t.expiresMs}) = 'integer' AND ${t.expiresMs} > 0`),
]);

// A record is immutable and a capability can be attached to at most one record.
export const selfServiceRecords = sqliteTable('ss_records', {
  namespace: text('namespace').notNull(),
  locator: text('locator').notNull(),
  capabilityHash: text('capability_hash').notNull(),
  ciphertext: text('ciphertext').notNull(),
}, t => [
  primaryKey({ columns: [t.namespace, t.locator] }),
  foreignKey({ columns: [t.namespace, t.capabilityHash], foreignColumns: [selfServiceCapabilities.namespace, selfServiceCapabilities.capabilityHash] }),
  unique('ss_record_capability_unique').on(t.namespace, t.capabilityHash),
  check('ss_record_locator', sql`length(${t.locator}) = 43 AND ${t.locator} NOT GLOB '*[^A-Za-z0-9_-]*'`),
  check('ss_record_bytes', sql`length(${t.ciphertext}) BETWEEN 2 AND 87382 AND ${t.ciphertext} NOT GLOB '*[^A-Za-z0-9_-]*'`),
]);
