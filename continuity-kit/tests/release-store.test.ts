import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDemoStore } from "../src/release/store.ts";
import type { DemoDatabase } from "../src/release/store.ts";
import type { ReleaseProfile } from "../src/release/profile.ts";
import { HttpMirrorStore, MemoryRegistry } from "../src/sdk/stores.ts";
import {
  MeraPasskeyAdapter,
  createPrimary,
  prepareBackup,
  finalizeEnrollment,
  saveCheckpoint,
  discoverRecovery,
  recoverCurrent,
  LOCAL_POLICY,
} from "../src/sdk/index.ts";
import { SyntheticWebAuthnClient } from "../src/sdk/demo-fixture.ts";
import type {
  LocalRecoveryPolicy,
  PrimaryAdapters,
  Workspace,
} from "../src/sdk/types.ts";

const profile: ReleaseProfile = {
  format: "continuity-demo-release/v1",
  deploymentId: "public-demo-store-fixture",
  aOrigin: "https://a.fixture.invalid",
  bOrigin: "https://b.fixture.invalid",
  storeOrigin: "https://store.fixture.invalid",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const token = "ab".repeat(32); // Public synthetic upload capability only.
const migration = readFileSync(
  new URL("../migrations/0001_demo_objects.sql", import.meta.url),
  "utf8",
);
function fixture(path = ":memory:", initialize = true) {
  const sqlite = new DatabaseSync(path);
  if (initialize) sqlite.exec(migration);
  const DB: DemoDatabase = {
    prepare(sql) {
      return {
        bind(...values: unknown[]) {
          const args = values.map((v) =>
            v instanceof ArrayBuffer ? new Uint8Array(v) : v,
          ) as Parameters<ReturnType<DatabaseSync["prepare"]>["run"]>;
          return {
            async first<T>() {
              const row = sqlite.prepare(sql).get(...args);
              return (row ?? null) as T | null;
            },
            async run() {
              return sqlite.prepare(sql).run(...args);
            },
          };
        },
      };
    },
  };
  const serve = createDemoStore(profile);
  const request = (
    path: string,
    method = "GET",
    body?: Uint8Array,
    headers: Record<string, string> = {},
  ) =>
    serve(
      new Request(profile.storeOrigin + path, {
        method,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
      }),
      { DB, CONTINUITY_UPLOAD_TOKEN: token },
    );
  const put = (
    path: string,
    bytes: Uint8Array,
    headers: Record<string, string> = {},
  ) =>
    request(path, "PUT", bytes, {
      "content-type": "application/octet-stream",
      authorization: `Bearer ${token}`,
      origin: profile.aOrigin,
      ...headers,
    });
  return { sqlite, DB, serve, request, put, close: () => sqlite.close() };
}
const blobPath = (bytes: Uint8Array, slot = 0) =>
  `/v1/mirrors/${slot}/blob/0x${createHash("sha256").update(bytes).digest("hex")}`;
const indexPath = (letter: string, slot = 0) =>
  `/v1/mirrors/${slot}/index/${letter.repeat(43)}`;

test("public store denies unauthenticated writers even without Origin and exposes no control/list/registry routes", async () => {
  const f = fixture();
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    const path = blobPath(bytes);
    for (const authorization of ["", `Bearer ${"cd".repeat(32)}`])
      assert.equal(
        (
          await f.request(path, "PUT", bytes, {
            authorization,
            "content-type": "application/octet-stream",
          })
        ).status,
        401,
      );
    assert.equal(
      (await f.put(path, bytes, { origin: profile.bOrigin })).status,
      401,
    );
    assert.equal(
      (await f.put(path, bytes, { origin: "https://attacker.invalid" })).status,
      403,
    );
    for (const route of [
      "/v1/control",
      "/v1/status",
      "/v1/registry",
      "/v1/mirrors/0",
      "/",
    ])
      assert.equal((await f.request(route, "POST")).status, 404);
    assert.equal((await f.request(path, "DELETE")).status, 405);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM ck_demo_objects").get()!.n,
      0,
    );
  } finally {
    f.close();
  }
});
test("exact immutable bytes survive idempotent and competing requests, with public B reads", async () => {
  const f = fixture();
  try {
    const a = new Uint8Array([4, 5]),
      b = new Uint8Array([6, 7]),
      path = indexPath("a");
    const results = await Promise.all([f.put(path, a), f.put(path, b)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [204, 409]);
    // Either authorized request may win: cryptographic checks are asynchronous.
    const winner = results[0]!.status === 204 ? a : b;
    const loser = results[0]!.status === 204 ? b : a;
    assert.equal((await f.put(path, winner)).status, 204);
    assert.equal((await f.put(path, loser)).status, 409);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM ck_demo_objects").get()!.n,
      1,
    );
    const response = await f.request(path, "GET", undefined, {
      origin: profile.bOrigin,
    });
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      profile.bOrigin,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), winner);
    assert.equal((await f.request(indexPath("b"))).status, 404);
  } finally {
    f.close();
  }
});
test("blob digest and exact preflight origin/method/header allowlists are enforced", async () => {
  const f = fixture();
  try {
    const bytes = new Uint8Array([8]);
    const path = blobPath(bytes);
    assert.equal((await f.put(path, new Uint8Array([9]))).status, 422);
    assert.equal(
      (await f.put(path, bytes, { "content-type": "text/plain" })).status,
      415,
    );
    for (const origin of [profile.aOrigin, profile.bOrigin]) {
      const res = await f.request(path, "OPTIONS", undefined, {
        origin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "Authorization, Content-Type",
      });
      assert.equal(res.status, origin === profile.aOrigin ? 204 : 403);
    }
    assert.equal(
      (
        await f.request(path, "OPTIONS", undefined, {
          origin: profile.aOrigin,
          "access-control-request-method": "PUT",
          "access-control-request-headers": "X-Unreviewed",
        })
      ).status,
      403,
    );
    assert.equal((await f.request(path + "?token=ignored")).status, 403);
  } finally {
    f.close();
  }
});
test("quota is atomic across requests; full-store exact retries do not consume space", async () => {
  const f = fixture();
  try {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const bytes = new Uint8Array([i]);
        return f.put(blobPath(bytes), bytes);
      }),
    );
    assert.equal(responses.filter((r) => r.status === 204).length, 16);
    assert.equal(responses.filter((r) => r.status === 503).length, 4);
    for (let i = 0; i < responses.length; i++) {
      if (responses[i]!.status !== 204) continue;
      const bytes = new Uint8Array([i]);
      assert.equal((await f.put(blobPath(bytes), bytes)).status, 204);
    }
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM ck_demo_objects").get()!.n,
      16,
    );
    const indexes = await Promise.all(
      ["a", "b", "c"].map((c) => f.put(indexPath(c, 1), new Uint8Array([10]))),
    );
    assert.equal(indexes.filter((r) => r.status === 204).length, 2);
  } finally {
    f.close();
  }
});
test("global byte budget is shared by the two slots and a restart preserves immutable objects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "continuity-store-fixture-"));
  const path = join(dir, "synthetic.db");
  let f = fixture(path);
  try {
    // Exercise the real SQL quota with public synthetic opaque fixture bytes.
    for (let i = 0; i < 16; i++) {
      const bytes = new Uint8Array(1048576).fill(i);
      assert.equal((await f.put(blobPath(bytes, i % 2), bytes)).status, 204);
    }
    assert.equal(
      (await f.put(blobPath(new Uint8Array([100])), new Uint8Array([100])))
        .status,
      503,
    );
    f.close();
    f = fixture(path, false);
    const response = await f.request(blobPath(new Uint8Array(1048576).fill(0)));
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 1048576);
    assert.equal(
      (await f.put(blobPath(new Uint8Array([100])), new Uint8Array([100])))
        .status,
      503,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("expired profile, missing secret and failed DB all refuse success", async () => {
  const f = fixture();
  try {
    const bytes = new Uint8Array([1]);
    const request = new Request(profile.storeOrigin + blobPath(bytes), {
      method: "PUT",
      body: bytes,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
      },
    });
    assert.equal(
      (
        await createDemoStore({
          ...profile,
          expiresAt: "2000-01-01T00:00:00.000Z",
        })(request, { DB: f.DB, CONTINUITY_UPLOAD_TOKEN: token })
      ).status,
      410,
    );
    assert.equal((await f.serve(request, { DB: f.DB })).status, 401);
    const badDB: DemoDatabase = {
      prepare() {
        throw new Error("Synthetic storage outage");
      },
    };
    assert.equal(
      (
        await f.serve(new Request(profile.storeOrigin + blobPath(bytes)), {
          DB: badDB,
        })
      ).status,
      503,
    );
  } finally {
    f.close();
  }
});
test("oversized, empty and malformed-key writes add no object", async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.put(indexPath("a"), new Uint8Array(100001))).status,
      413,
    );
    assert.equal((await f.put(indexPath("a"), new Uint8Array())).status, 400);
    assert.equal(
      (await f.put("/v1/mirrors/0/index/bad", new Uint8Array([1]))).status,
      400,
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM ck_demo_objects").get()!.n,
      0,
    );
  } finally {
    f.close();
  }
});
test("actual SDK uploads encrypted v1/v2 and fresh B recovers through the store with no upload capability", async (t) => {
  const f = fixture();
  let primary: Awaited<ReturnType<typeof createPrimary>> | undefined;
  try {
    const writes: string[] = [];
    const reads: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).origin, profile.storeOrigin);
        if (request.method === "PUT") {
          writes.push(request.url);
          assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
        } else {
          reads.push(request.url);
          assert.equal(request.headers.get("authorization"), null);
        }
        return f.serve(request, { DB: f.DB, CONTINUITY_UPLOAD_TOKEN: token });
      },
    );
    const urls = [
      `${profile.storeOrigin}/v1/mirrors/0`,
      `${profile.storeOrigin}/v1/mirrors/1`,
    ];
    const policy: LocalRecoveryPolicy = {
      ...LOCAL_POLICY,
      aOrigin: profile.aOrigin,
      bOrigin: profile.bOrigin,
      aRpId: new URL(profile.aOrigin).hostname,
      bRpId: new URL(profile.bOrigin).hostname,
      mirrorUrls: urls,
    };
    const registry = new MemoryRegistry(policy);
    const adapters: PrimaryAdapters = {
      trustMode: "local-model",
      registry,
      localWriter: registry,
      mirrors: urls.map(
        (u) =>
          new HttpMirrorStore(u, undefined, 10000, () => ({
            authorization: `Bearer ${token}`,
          })),
      ),
    };
    const passkeys = () =>
      new MeraPasskeyAdapter(
        new SyntheticWebAuthnClient({
          seed: "PUBLIC STORE INTEGRATION FIXTURE",
        }),
      );
    const v1: Workspace = {
      title: "Public store fixture",
      plan: "No chain or physical calls",
      tasks: [],
      draft: "Old public example",
    };
    primary = await createPrimary(policy, passkeys(), adapters);
    const backup = await prepareBackup(policy, passkeys(), primary);
    const enrollment = await finalizeEnrollment(primary, backup, v1, adapters);
    assert.equal(enrollment.status, "prepared");
    if (enrollment.status !== "prepared") throw new Error("Unexpected pending");
    const v2 = { ...v1, draft: "Corrected public example" };
    const result = await saveCheckpoint(enrollment.state, v2, adapters);
    assert.equal(result.status, "saved");
    primary.close();
    const recovery = {
      registry,
      mirrors: urls.map((u) => new HttpMirrorStore(u)),
    };
    const found = await discoverRecovery(policy, passkeys(), recovery);
    const recovered = await recoverCurrent(found, passkeys(), recovery);
    assert.deepEqual(recovered.content, v2);
    assert.equal(recovered.version, "2");
    assert.equal(writes.length, 8);
    assert.ok(reads.length > 0);
  } finally {
    primary?.close();
    f.close();
  }
});

test("presenter validation is read-only and never available from recovery origin", async () => {
  const f = fixture();
  try {
    assert.equal((await f.request("/v1/presenter-access")).status, 401);
    assert.equal(
      (
        await f.request("/v1/presenter-access", "GET", undefined, {
          origin: profile.aOrigin,
          authorization: `Bearer ${token}`,
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await f.request("/v1/presenter-access", "GET", undefined, {
          origin: profile.bOrigin,
          authorization: `Bearer ${token}`,
        })
      ).status,
      403,
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM ck_demo_objects").get()!.n,
      0,
    );
  } finally {
    f.close();
  }
});
