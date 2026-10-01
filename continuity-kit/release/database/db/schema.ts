import { sql } from "drizzle-orm";
import {
  blob,
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Same bounded ciphertext-only table as the original local SQL fixture.
export const demoObjects = sqliteTable(
  "ck_demo_objects",
  {
    slot: integer("slot").notNull(),
    kind: text("kind").notNull(),
    objectKey: text("object_key").notNull(),
    bytes: blob("bytes", { mode: "buffer" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.slot, table.kind, table.objectKey] }),
    check("ck_demo_slot", sql`${table.slot} IN (0,1)`),
    check("ck_demo_kind", sql`${table.kind} IN ('index','blob')`),
    check(
      "ck_demo_bytes",
      sql`length(${table.bytes}) > 0 AND length(${table.bytes}) <= 1048576`,
    ),
  ],
);
