import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createDemoStore } from "../src/release/store.ts";
import type { DemoDatabase } from "../src/release/store.ts";

const base = new URL("../release/database/drizzle/", import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", base), "utf8"),
);
const migrated = () => {
  const db = new DatabaseSync(":memory:");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, base), "utf8");
    // Match Drizzle's statement boundary, preserving the trigger body intact.
    for (const statement of sql.split("--> statement-breakpoint"))
      if (statement.trim()) db.exec(statement);
  }
  return db;
};
const insert = (
  db: DatabaseSync,
  slot: number,
  kind: string,
  key: string,
  bytes: Uint8Array,
) =>
  db
    .prepare(
      "INSERT INTO ck_demo_objects(slot,kind,object_key,bytes) VALUES(?,?,?,?)",
    )
    .run(slot, kind, key, bytes);

test("generated migrations preserve table constraints and immutable object identity", () => {
  const db = migrated();
  const original = new DatabaseSync(":memory:");
  try {
    original.exec(
      readFileSync(
        new URL("../migrations/0001_demo_objects.sql", import.meta.url),
        "utf8",
      ),
    );
    const columns = (database: DatabaseSync) =>
      database
        .prepare("PRAGMA table_info(ck_demo_objects)")
        .all()
        .map((row) => ({ ...row, type: String(row.type).toUpperCase() }));
    assert.deepEqual(columns(db), columns(original));
    assert.equal(journal.dialect, "sqlite");
    assert.deepEqual(
      journal.entries.map((entry: { idx: number }) => entry.idx),
      [0, 1],
    );
    for (const entry of journal.entries) {
      const snapshot = JSON.parse(
        readFileSync(
          new URL(
            `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`,
            base,
          ),
          "utf8",
        ),
      );
      assert.equal(snapshot.dialect, "sqlite");
      assert.ok(snapshot.tables.ck_demo_objects);
    }
    for (const database of [db, original]) {
      assert.throws(() =>
        insert(database, 2, "blob", "bad-slot", new Uint8Array([1])),
      );
      assert.throws(() =>
        insert(database, 0, "unknown", "bad-kind", new Uint8Array([1])),
      );
      assert.throws(() =>
        insert(database, 0, "blob", "empty", new Uint8Array()),
      );
      assert.throws(() =>
        insert(database, 0, "blob", "large", new Uint8Array(1048577)),
      );
      insert(database, 0, "blob", "same", new Uint8Array([1]));
      assert.throws(() =>
        insert(database, 0, "blob", "same", new Uint8Array([2])),
      );
    }
  } finally {
    db.close();
    original.close();
  }
});

test("generated custom trigger enforces per-slot, index and global byte quotas", () => {
  const db = migrated();
  try {
    for (let i = 0; i < 16; i++)
      insert(db, 0, "blob", String(i), new Uint8Array([1]));
    assert.throws(
      () => insert(db, 0, "blob", "seventeenth", new Uint8Array([1])),
      /DEMO_QUOTA/,
    );
    insert(db, 1, "index", "a", new Uint8Array([1]));
    insert(db, 1, "index", "b", new Uint8Array([1]));
    assert.throws(
      () => insert(db, 1, "index", "c", new Uint8Array([1])),
      /DEMO_QUOTA/,
    );
  } finally {
    db.close();
  }
  const bytes = migrated();
  try {
    for (let i = 0; i < 16; i++)
      insert(bytes, i % 2, "blob", String(i), new Uint8Array(1048576));
    assert.throws(
      () => insert(bytes, 0, "blob", "over-total", new Uint8Array([1])),
      /DEMO_QUOTA/,
    );
    assert.equal(
      bytes
        .prepare("SELECT SUM(length(bytes)) AS n FROM ck_demo_objects")
        .get()!.n,
      16777216,
    );
  } finally {
    bytes.close();
  }
});

test("real store handler retains exact writes, conflicts and public recovery reads on generated schema", async () => {
  const sqlite = migrated();
  const DB: DemoDatabase = {
    prepare(sql) {
      return {
        bind(...values: unknown[]) {
          const args = values.map((v) =>
            v instanceof ArrayBuffer ? new Uint8Array(v) : v,
          ) as Parameters<ReturnType<DatabaseSync["prepare"]>["run"]>;
          return {
            async first<T>() {
              return (sqlite.prepare(sql).get(...args) ?? null) as T | null;
            },
            async run() {
              return sqlite.prepare(sql).run(...args);
            },
          };
        },
      };
    },
  };
  const profile = {
    format: "continuity-demo-release/v1" as const,
    deploymentId: "public-demo-migration-fixture",
    aOrigin: "https://a.fixture.invalid",
    bOrigin: "https://b.fixture.invalid",
    storeOrigin: "https://store.fixture.invalid",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const serve = createDemoStore(profile);
  const token = "ab".repeat(32); // Public synthetic test capability.
  const url = `${profile.storeOrigin}/v1/mirrors/0/index/${"a".repeat(43)}`;
  const env = { DB, CONTINUITY_UPLOAD_TOKEN: token };
  const put = (body: Uint8Array) =>
    serve(
      new Request(url, {
        method: "PUT",
        body: new Uint8Array(body),
        headers: {
          origin: profile.aOrigin,
          authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
        },
      }),
      env,
    );
  try {
    const payload = new Uint8Array([1, 2, 3]);
    assert.equal((await put(payload)).status, 204);
    assert.equal((await put(payload)).status, 204);
    assert.equal((await put(new Uint8Array([9]))).status, 409);
    const res = await serve(
      new Request(url, { headers: { origin: profile.bOrigin } }),
      env,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), payload);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM ck_demo_objects").get()!.n,
      1,
    );
  } finally {
    sqlite.close();
  }
});
