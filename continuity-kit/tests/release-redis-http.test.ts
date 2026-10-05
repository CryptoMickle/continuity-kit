import test from "node:test";
import assert from "node:assert/strict";
import { createRedisDemoStore } from "../src/release/redis-handler.ts";
import { redisFixture } from "./redis-fixture.ts";
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
  deploymentId: "public-demo-redis-sdk-fixture",
  aOrigin: "https://a.fixture.invalid",
  bOrigin: "https://b.fixture.invalid",
  storeOrigin: "https://store.fixture.invalid",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const token = "ab".repeat(32); // Disposable public test value.

test("Redis worker validates access before provider configuration and fails closed when configuration is missing", async () => {
  const serve = createRedisDemoStore(profile, {
    fetcher: async () => {
      throw new Error("Unexpected network call");
    },
  });
  const path = profile.storeOrigin + "/v1/mirrors/0/index/" + "a".repeat(43);
  assert.equal(
    (await serve(new Request(path, { method: "PUT", body: "test" }), {}))
      .status,
    401,
  );
  const missing = await serve(new Request(path), {});
  assert.equal(missing.status, 503);
  assert.equal(await missing.text(), "");
  assert.equal(
    (
      await serve(
        new Request(profile.storeOrigin + "/v1/presenter-access", {
          headers: { authorization: `Bearer ${token}` },
        }),
        { CONTINUITY_UPLOAD_TOKEN: token },
      )
    ).status,
    204,
  );
});

test("warm HTTP handler retains provider cooldown, keeps authorization fresh and replaces rotated configuration", async () => {
  let now = 10_000;
  const auth: Array<string | null> = [];
  const serve = createRedisDemoStore(profile, {
    now: () => now,
    fetcher: async (_url, init) => {
      auth.push(new Headers(init?.headers).get("authorization"));
      return auth.length === 1
        ? new Response(null, { status: 429 })
        : Response.json({ result: null });
    },
  });
  const env = {
    CONTINUITY_UPLOAD_TOKEN: token,
    CONTINUITY_REDIS_REST_URL: "https://synthetic-fixture.upstash.io",
    CONTINUITY_REDIS_REST_TOKEN: "synthetic-token-not-a-real-secret",
  };
  const path = profile.storeOrigin + "/v1/mirrors/0/index/" + "a".repeat(43);
  assert.equal((await serve(new Request(path), env)).status, 503);
  assert.equal((await serve(new Request(path), env)).status, 503);
  assert.equal(
    (await serve(new Request(path, { method: "PUT", body: "x" }), env)).status,
    401,
  );
  assert.equal(auth.length, 1);
  now += 2_000;
  assert.equal((await serve(new Request(path), env)).status, 404);
  assert.equal(auth.length, 2);
  const rotated = {
    ...env,
    CONTINUITY_REDIS_REST_TOKEN: "synthetic-rotated-token-only",
  };
  assert.equal((await serve(new Request(path), rotated)).status, 404);
  assert.equal(auth.at(-1), `Bearer ${rotated.CONTINUITY_REDIS_REST_TOKEN}`);
  const missing = { ...env, CONTINUITY_REDIS_REST_TOKEN: undefined };
  assert.equal((await serve(new Request(path), missing)).status, 503);
  assert.equal(auth.length, 3); // Never fall back to the old credential.
});

test(
  "Redis HTTP target: SDK encrypted v1/v2 survives a fresh recovery client with no upload capability",
  {
    skip: !process.env.REDIS_SERVER_BIN
      ? "Set REDIS_SERVER_BIN for real Redis integration"
      : false,
  },
  async (t) => {
    const fixture = await redisFixture(process.env.REDIS_SERVER_BIN!);
    const env = {
      CONTINUITY_UPLOAD_TOKEN: token,
      CONTINUITY_REDIS_REST_URL: "https://synthetic-fixture.upstash.io",
      CONTINUITY_REDIS_REST_TOKEN: "synthetic-token-not-a-real-secret",
    };
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
            assert.equal(
              request.headers.get("authorization"),
              `Bearer ${token}`,
            );
          } else {
            reads.push(request.url);
            assert.equal(request.headers.get("authorization"), null);
          }
          // Recreate the worker handler on every request: no A-session or warm
          // provider client is needed to discover the already persisted objects.
          const serve = createRedisDemoStore(profile, {
            fetcher: fixture.fetcher,
          });
          return serve(request, env);
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
      const enrollment = await finalizeEnrollment(
        primary,
        backup,
        v1,
        adapters,
      );
      assert.equal(enrollment.status, "prepared");
      if (enrollment.status !== "prepared")
        throw new Error("Unexpected pending");
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
      // Corrupt only one current stored copy. Fresh recovery must still reach
      // the valid other slot; reads must not audit unrelated payloads first.
      const v2url = writes.filter((url) => url.includes("/0/blob/")).at(-1)!;
      const v2digest = new URL(v2url).pathname.split("/").at(-1)!;
      await fixture.command([
        "HSET",
        `ck:demo:${profile.deploymentId}:objects:v1`,
        `0:blob:${v2digest}`,
        "%%%%",
      ]);
      const afterCorruption = await discoverRecovery(
        policy,
        passkeys(),
        recovery,
      );
      const surviving = await recoverCurrent(
        afterCorruption,
        passkeys(),
        recovery,
      );
      assert.deepEqual(surviving.content, v2);
      assert.equal(surviving.version, "2");
    } finally {
      primary?.close();
      await fixture.close();
    }
  },
);
