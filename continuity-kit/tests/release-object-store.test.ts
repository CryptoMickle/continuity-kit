import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDemoStore, createD1ObjectStore } from "../src/release/store.ts";
import type { DemoDatabase } from "../src/release/store.ts";
import type { DemoObjectStore } from "../src/release/object-store.ts";
import type { ReleaseProfile } from "../src/release/profile.ts";

const profile: ReleaseProfile = {
  format: "continuity-demo-release/v1",
  deploymentId: "public-demo-object-fixture",
  aOrigin: "https://a.fixture.invalid",
  bOrigin: "https://b.fixture.invalid",
  storeOrigin: "https://store.fixture.invalid",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const token = "ab".repeat(32); // Disposable public test value.
const bytes = new Uint8Array([0, 255, 128, 42]);
const path =
  "/v1/mirrors/0/blob/0x" + createHash("sha256").update(bytes).digest("hex");
const serve = createDemoStore(profile);
const request = (
  method: string,
  headers: Record<string, string> = {},
  body?: Uint8Array,
) =>
  new Request(profile.storeOrigin + path, {
    method,
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
const auth = {
  origin: profile.aOrigin,
  authorization: `Bearer ${token}`,
  "content-type": "application/octet-stream",
};

test("provider interface retains authentication, digest validation and expiry before any storage call", async () => {
  let calls = 0;
  const OBJECTS: DemoObjectStore = {
    async read() {
      calls++;
      throw new Error("unexpected call");
    },
    async putImmutable() {
      calls++;
      throw new Error("unexpected call");
    },
  };
  const env = { OBJECTS, CONTINUITY_UPLOAD_TOKEN: token };
  assert.equal((await serve(request("PUT", {}, bytes), env)).status, 401);
  assert.equal(
    (
      await serve(
        request("PUT", { ...auth, origin: profile.bOrigin }, bytes),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await serve(
        request("PUT", { ...auth, origin: "https://bad.invalid" }, bytes),
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (await serve(request("PUT", auth, new Uint8Array([7])), env)).status,
    422,
  );
  assert.equal(
    (
      await serve(
        request("PUT", { ...auth, "content-type": "text/plain" }, bytes),
        env,
      )
    ).status,
    415,
  );
  const expired = createDemoStore({
    ...profile,
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  assert.equal((await expired(request("GET"), env)).status, 410);
  assert.equal(
    (
      await serve(
        new Request(profile.storeOrigin + "/v1/presenter-access", {
          headers: { authorization: `Bearer ${token}` },
        }),
        env,
      )
    ).status,
    204,
  );
  assert.equal(calls, 0);
});

test("provider results preserve failure responses and exact binary recovery bytes", async () => {
  let result: Awaited<ReturnType<DemoObjectStore["putImmutable"]>> = "stored";
  let fail = false;
  let missing = false;
  const OBJECTS: DemoObjectStore = {
    async read(slot, kind, key) {
      assert.equal(slot, 0);
      assert.equal(kind, "blob");
      assert.ok(path.endsWith(key));
      if (fail) throw new Error("private provider error must not be returned");
      return missing ? null : bytes;
    },
    async putImmutable(slot, kind, key, value) {
      assert.equal(slot, 0);
      assert.equal(kind, "blob");
      assert.ok(path.endsWith(key));
      assert.deepEqual(value, bytes);
      if (fail) throw new Error("private provider error must not be returned");
      return result;
    },
  };
  const env = { OBJECTS, CONTINUITY_UPLOAD_TOKEN: token };
  for (const [outcome, status] of [
    ["stored", 204],
    ["conflict", 409],
    ["unavailable", 503],
  ] as const) {
    result = outcome;
    assert.equal(
      (await serve(request("PUT", auth, bytes), env)).status,
      status,
    );
  }
  const restored = await serve(
    request("GET", { origin: profile.bOrigin }),
    env,
  );
  assert.equal(restored.status, 200);
  assert.equal(
    restored.headers.get("access-control-allow-origin"),
    profile.bOrigin,
  );
  assert.equal(restored.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), bytes);
  missing = true;
  assert.equal((await serve(request("GET"), env)).status, 404);
  fail = true;
  for (const req of [request("GET"), request("PUT", auth, bytes)]) {
    const response = await serve(req, env);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "");
  }
});

test("D1 never labels an unobserved insert as success or an existing conflict", async () => {
  const db: DemoDatabase = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
            async run() {},
          };
        },
      };
    },
  };
  assert.equal(
    await createD1ObjectStore(db).putImmutable(
      0,
      "blob",
      path.split("/").at(-1)!,
      bytes,
    ),
    "unavailable",
  );
});
