import test from "node:test";
import assert from "node:assert/strict";
import { createRedisObjectStore } from "../src/release/redis-store.ts";
import { redisFixture } from "./redis-fixture.ts";

const config = {
  url: "https://synthetic-fixture.upstash.io",
  token: "synthetic-token-not-a-real-secret",
  namespace: "public-demo-redis-fixture",
};
const blobKey = (n = 1) => `0x${n.toString(16).padStart(64, "0")}`;
const indexKey = (n = 1) => n.toString(16).padStart(43, "a");
const bytes = (n = 1) => new Uint8Array([0, 128, 255, n]);
const respond =
  (result: unknown): typeof fetch =>
  async () =>
    Response.json({ result });

test("Redis configuration rejects credential-bearing URLs, foreign hosts and unbounded/injected config", () => {
  for (const url of [
    "http://synthetic-fixture.upstash.io",
    "https://upstash.io",
    "https://x.upstash.io.evil.test",
    "https://x.upstash.io/path",
    "https://x.upstash.io?secret=a",
    "https://x.upstash.io#x",
    "https://user:secret@x.upstash.io",
    "https://x.upstash.io:443",
    "https://localhost",
    "https://x.y.upstash.io",
    "https://-x.upstash.io",
  ])
    assert.throws(
      () => createRedisObjectStore({ ...config, url }),
      /REDIS_STORE_CONFIG_INVALID/,
    );
  for (const token of [
    "",
    "short",
    "x".repeat(5000),
    "good-token-but\nnew-header",
    "token with white space",
  ])
    assert.throws(
      () => createRedisObjectStore({ ...config, token }),
      /REDIS_STORE_CONFIG_INVALID/,
    );
  for (const namespace of [
    "",
    "../other",
    "x:y",
    "x".repeat(101),
    "other\nnamespace",
  ])
    assert.throws(
      () => createRedisObjectStore({ ...config, namespace }),
      /REDIS_STORE_CONFIG_INVALID/,
    );
  assert.throws(
    () => createRedisObjectStore(config, { timeoutMs: 10_001 }),
    /REDIS_STORE_CONFIG_INVALID/,
  );
});

test("Redis REST uses server-only auth, a fixed namespace and one bounded EVAL with canonical base64", async () => {
  const observed: RequestInit[] = [];
  const store = createRedisObjectStore(config, {
    fetcher: async (url, init) => {
      assert.equal(url, `${config.url}/`);
      observed.push(init!);
      return Response.json({
        result: observed.length === 1 ? "stored" : "AID/AQ==",
      });
    },
  });
  assert.equal(
    await store.putImmutable(1, "blob", blobKey(), bytes()),
    "stored",
  );
  assert.deepEqual(await store.read(1, "blob", blobKey()), bytes());
  for (const init of observed) {
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(init.cache, undefined);
    assert.equal(new Headers(init.headers).get("cache-control"), "no-store");
    assert.equal(new Headers(init.headers).get("pragma"), "no-cache");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      `Bearer ${config.token}`,
    );
    const args = JSON.parse(String(init.body));
    assert.equal(args[0], "EVAL");
    assert.equal(args[2], "1");
    assert.equal(args[3], `ck:demo:${config.namespace}:objects:v1`);
    assert.equal(args[5], `1:blob:${blobKey()}`);
    assert.ok(String(init.body).length < 1_450_000);
  }
  assert.equal(JSON.parse(String(observed[0].body))[6], "AID/AQ==");
});

test("Redis rejects every redirect without following its target or forwarding authorization", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const operation of ["read", "put"] as const) {
      const calls: { url: string; authorization: string | null }[] = [];
      const store = createRedisObjectStore(config, {
        fetcher: async (url, init) => {
          calls.push({
            url: String(url),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          // The same underlying transport would follow for "follow"; "error"
          // throws before transport in Workers. Only manual reaches this reply.
          assert.equal(init?.redirect, "manual");
          return new Response("Synthetic redirect; never accepted as data", {
            status,
            headers: { location: "https://redirect-target.invalid/" },
          });
        },
      });
      if (operation === "read")
        await assert.rejects(store.read(0, "blob", blobKey()), {
          message: "REDIS_STORE_UNAVAILABLE",
        });
      else
        assert.equal(
          await store.putImmutable(0, "blob", blobKey(), bytes()),
          "unavailable",
        );
      assert.deepEqual(calls, [
        { url: `${config.url}/`, authorization: `Bearer ${config.token}` },
      ]);
    }
  }
});

test("Redis rejects invalid arguments locally and keeps unknown backend outcomes unavailable", async () => {
  let calls = 0;
  const store = createRedisObjectStore(config, {
    fetcher: async () => {
      calls++;
      return Response.json({ result: "unexpected" });
    },
  });
  for (const body of [new Uint8Array(0), new Uint8Array(1_048_577)])
    assert.equal(
      await store.putImmutable(0, "blob", blobKey(), body),
      "unavailable",
    );
  assert.equal(
    await store.putImmutable(0, "index", indexKey(), new Uint8Array(100_001)),
    "unavailable",
  );
  assert.equal(
    await store.putImmutable(2, "blob", blobKey(), bytes()),
    "unavailable",
  );
  await assert.rejects(
    store.read(0, "blob", "malformed"),
    /REDIS_STORE_UNAVAILABLE/,
  );
  assert.equal(calls, 0);
  assert.equal(
    await store.putImmutable(0, "blob", blobKey(), bytes()),
    "unavailable",
  );
  assert.equal(
    await createRedisObjectStore(config, {
      fetcher: respond("conflict"),
    }).putImmutable(0, "blob", blobKey(), bytes()),
    "conflict",
  );
  assert.equal(
    await createRedisObjectStore(config, { fetcher: respond(null) }).read(
      0,
      "blob",
      blobKey(),
    ),
    null,
  );
});

test("Redis read failures and malformed/oversized base64 never become missing objects or leak provider details", async () => {
  for (const result of [
    "",
    "AA",
    "AB==",
    "AA==\n",
    "%%%%",
    1,
    {},
    "A".repeat(1_450_001),
  ]) {
    const store = createRedisObjectStore(config, { fetcher: respond(result) });
    await assert.rejects(store.read(0, "blob", blobKey()), {
      message: "REDIS_STORE_UNAVAILABLE",
    });
  }
  for (const fetcher of [
    async () => Response.json({ error: `secret ${config.token}` }),
    async () => Response.json({ result: null, error: "failure" }),
    async () => new Response("unparseable"),
    async () => new Response("secret", { status: 503 }),
    async () =>
      new Response("{}", { headers: { "content-length": "99999999" } }),
    async () => {
      throw new Error(config.token);
    },
  ]) {
    const store = createRedisObjectStore(config, { fetcher });
    await assert.rejects(store.read(0, "blob", blobKey()), {
      message: "REDIS_STORE_UNAVAILABLE",
    });
    assert.equal(
      await store.putImmutable(0, "blob", blobKey(), bytes()),
      "unavailable",
    );
  }
});

test("Redis timeout bounds fetch and stalled response bodies, and aborts transport", async () => {
  let aborted = false;
  const store = createRedisObjectStore(config, {
    timeoutMs: 20,
    fetcher: async (_url, init) => {
      init!.signal!.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<Response>(() => {});
    },
  });
  await assert.rejects(
    store.read(0, "blob", blobKey()),
    /REDIS_STORE_UNAVAILABLE/,
  );
  assert.equal(aborted, true);
  let cancelled = false;
  const streaming = createRedisObjectStore(config, {
    timeoutMs: 20,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  assert.equal(
    await streaming.putImmutable(0, "blob", blobKey(), bytes()),
    "unavailable",
  );
  assert.equal(cancelled, true);
});

test("provider failures back off without retrying; missing data and conflicts do not block healthy reads", async () => {
  for (const failure of [429, 503, "network", "body"] as const) {
    let now = 10_000,
      calls = 0;
    const store = createRedisObjectStore(config, {
      now: () => now,
      fetcher: async () => {
        calls++;
        if (calls === 1) {
          if (failure === "network") throw new Error("Synthetic network loss");
          if (failure === "body")
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("Synthetic response stream loss"));
                },
              }),
            );
          return new Response(null, { status: failure });
        }
        return Response.json({ result: "AID/AQ==" });
      },
    });
    await assert.rejects(
      store.read(0, "blob", blobKey()),
      /REDIS_STORE_UNAVAILABLE/,
    );
    await assert.rejects(
      store.read(0, "blob", blobKey()),
      /REDIS_STORE_UNAVAILABLE/,
    );
    assert.equal(
      await store.putImmutable(0, "blob", blobKey(), bytes()),
      "unavailable",
    );
    assert.equal(calls, 1);
    now += 1_999;
    await assert.rejects(
      store.read(0, "blob", blobKey()),
      /REDIS_STORE_UNAVAILABLE/,
    );
    assert.equal(calls, 1);
    now++;
    assert.deepEqual(await store.read(0, "blob", blobKey()), bytes());
    assert.equal(calls, 2);
  }
  let calls = 0;
  const results = [null, "conflict", "unavailable", "%%%%", "AID/AQ=="];
  const store = createRedisObjectStore(config, {
    fetcher: async () => Response.json({ result: results[calls++] }),
  });
  assert.equal(await store.read(0, "blob", blobKey()), null);
  assert.equal(
    await store.putImmutable(0, "blob", blobKey(), bytes()),
    "conflict",
  );
  assert.equal(
    await store.putImmutable(0, "blob", blobKey(), bytes()),
    "unavailable",
  );
  await assert.rejects(
    store.read(0, "blob", blobKey()),
    /REDIS_STORE_UNAVAILABLE/,
  );
  assert.deepEqual(await store.read(1, "blob", blobKey()), bytes());
  assert.equal(calls, 5);
});

test(
  "real Redis Lua: immutable encrypted bytes, quotas, races and corrupt-state refusal",
  {
    timeout: 60_000,
    skip: !process.env.REDIS_SERVER_BIN
      ? "Set REDIS_SERVER_BIN to run disposable real-Redis verification"
      : false,
  },
  async (t) => {
    const fixture = await redisFixture(process.env.REDIS_SERVER_BIN!);
    const create = (suffix: string) =>
      createRedisObjectStore(
        { ...config, namespace: `${config.namespace}-${suffix}` },
        { fetcher: fixture.fetcher },
      );
    const redisKey = (suffix: string) =>
      `ck:demo:${config.namespace}-${suffix}:objects:v1`;
    try {
      await t.test(
        "binary round trips, immutable retry/conflict, namespace and slot isolation",
        async () => {
          const a = create("roundtrip"),
            b = create("other");
          assert.equal(await a.read(0, "blob", blobKey()), null);
          for (const size of [1, 2, 3, 4, 8193, 1_048_576]) {
            const data = new Uint8Array(size).fill(251);
            assert.equal(
              await a.putImmutable(0, "blob", blobKey(size), data),
              "stored",
            );
            assert.deepEqual(await a.read(0, "blob", blobKey(size)), data);
            assert.equal(
              await a.putImmutable(0, "blob", blobKey(size), data),
              "stored",
            );
            assert.equal(
              await a.putImmutable(0, "blob", blobKey(size), bytes()),
              "conflict",
            );
          }
          assert.equal(await a.read(1, "blob", blobKey()), null);
          assert.equal(await b.read(0, "blob", blobKey()), null);
          assert.equal(
            await fixture.command(["PTTL", redisKey("roundtrip")]),
            -1,
          );
          assert.deepEqual(
            await create("roundtrip").read(0, "blob", blobKey()),
            new Uint8Array([251]),
          );
        },
      );
      await t.test(
        "slot limit admits exactly one of concurrent final-slot writers; retry at capacity succeeds",
        async () => {
          const store = create("slot-race");
          for (let i = 0; i < 15; i++)
            assert.equal(
              await store.putImmutable(0, "blob", blobKey(i), bytes()),
              "stored",
            );
          const outcomes = await Promise.all(
            [15, 16, 17].map((i) =>
              store.putImmutable(0, "blob", blobKey(i), bytes()),
            ),
          );
          assert.equal(outcomes.filter((x) => x === "stored").length, 1);
          assert.equal(outcomes.filter((x) => x === "unavailable").length, 2);
          assert.equal(
            await store.putImmutable(0, "blob", blobKey(0), bytes()),
            "stored",
          );
          assert.equal(
            await store.putImmutable(0, "blob", blobKey(0), bytes(2)),
            "conflict",
          );
          assert.equal(
            await fixture.command(["HLEN", redisKey("slot-race")]),
            17,
          );
          assert.equal(
            await store.putImmutable(1, "blob", blobKey(0), bytes()),
            "stored",
          );
        },
      );
      await t.test(
        "concurrent conflicting writes to one key preserve exactly one value",
        async () => {
          const store = create("conflict-race");
          const outcomes = await Promise.all(
            [1, 2, 3].map((i) =>
              store.putImmutable(0, "blob", blobKey(), bytes(i)),
            ),
          );
          assert.equal(outcomes.filter((x) => x === "stored").length, 1);
          assert.equal(outcomes.filter((x) => x === "conflict").length, 2);
          assert.equal(
            await fixture.command(["HLEN", redisKey("conflict-race")]),
            2,
          );
          assert.deepEqual(
            await store.read(0, "blob", blobKey()),
            bytes(outcomes.indexOf("stored") + 1),
          );
        },
      );
      await t.test(
        "index quota is two per slot, separate from object quota",
        async () => {
          const store = create("indexes");
          const outcomes = await Promise.all(
            [1, 2, 3].map((i) =>
              store.putImmutable(
                0,
                "index",
                indexKey(i),
                new Uint8Array(100_000),
              ),
            ),
          );
          assert.equal(outcomes.filter((x) => x === "stored").length, 2);
          assert.equal(outcomes.filter((x) => x === "unavailable").length, 1);
          assert.equal(
            await store.putImmutable(1, "index", indexKey(1), bytes()),
            "stored",
          );
        },
      );
      await t.test(
        "global raw-byte quota is atomic across both slots, including base64 padding",
        async () => {
          const store = create("byte-race");
          for (let i = 0; i < 15; i++)
            assert.equal(
              await store.putImmutable(
                i % 2,
                "blob",
                blobKey(i),
                new Uint8Array(1_048_576),
              ),
              "stored",
            );
          assert.equal(
            await store.putImmutable(
              0,
              "blob",
              blobKey(15),
              new Uint8Array(1_048_575),
            ),
            "stored",
          );
          const outcomes = await Promise.all(
            [0, 1].map((slot) =>
              store.putImmutable(
                slot,
                "blob",
                blobKey(16 + slot),
                new Uint8Array([251]),
              ),
            ),
          );
          assert.equal(outcomes.filter((x) => x === "stored").length, 1);
          assert.equal(outcomes.filter((x) => x === "unavailable").length, 1);
          assert.equal(
            await store.putImmutable(
              0,
              "blob",
              blobKey(0),
              new Uint8Array(1_048_576),
            ),
            "stored",
          );
          assert.equal(
            await store.putImmutable(
              1,
              "blob",
              blobKey(30),
              new Uint8Array([1]),
            ),
            "unavailable",
          );
          const start = performance.now();
          assert.deepEqual(
            await store.read(0, "blob", blobKey(0)),
            new Uint8Array(1_048_576),
          );
          t.diagnostic(
            `Local requested-object read at full byte quota: ${Math.round(performance.now() - start)}ms (not hosted latency evidence)`,
          );
        },
      );
      await t.test(
        "corrupted schema, requested base64, wrong Redis type or expiry refuse reads and writes",
        async () => {
          const corruptions: Array<(key: string) => Promise<unknown>> = [
            (key) => fixture.command(["HSET", key, "__schema", "unknown"]),
            (key) => fixture.command(["HDEL", key, "__schema"]),
            (key) =>
              fixture.command(["HSET", key, `0:blob:${blobKey()}`, "AB=="]),
            (key) =>
              fixture.command(["HSET", key, `0:blob:${blobKey()}`, "%%%%"]),
            (key) => fixture.command(["HSET", key, `0:blob:${blobKey()}`, ""]),
            (key) =>
              fixture.command([
                "HSET",
                key,
                `0:blob:${blobKey()}`,
                "A".repeat(1_398_108),
              ]),
            (key) => fixture.command(["PEXPIRE", key, 60_000]),
            async (key) => {
              await fixture.command(["DEL", key]);
              return fixture.command(["SET", key, "wrong-type"]);
            },
          ];
          for (const [i, corrupt] of corruptions.entries()) {
            const store = create(`corrupt-${i}`);
            assert.equal(
              await store.putImmutable(0, "blob", blobKey(), bytes()),
              "stored",
            );
            await corrupt(redisKey(`corrupt-${i}`));
            await assert.rejects(
              store.read(0, "blob", blobKey()),
              /REDIS_STORE_UNAVAILABLE/,
            );
            assert.equal(
              await store.putImmutable(0, "blob", blobKey(2), bytes()),
              "unavailable",
            );
          }
        },
      );
      await t.test(
        "an unrelated corrupt object does not hide surviving bytes; all new writes still refuse the corrupt namespace",
        async () => {
          const store = create("unrelated-corruption");
          assert.equal(
            await store.putImmutable(0, "blob", blobKey(), bytes()),
            "stored",
          );
          await fixture.command([
            "HSET",
            redisKey("unrelated-corruption"),
            "bogus",
            "%%%%",
          ]);
          assert.deepEqual(await store.read(0, "blob", blobKey()), bytes());
          assert.equal(
            await store.putImmutable(1, "blob", blobKey(2), bytes()),
            "unavailable",
          );
          assert.equal(
            await fixture.command(["HLEN", redisKey("unrelated-corruption")]),
            3,
          );
        },
      );
      await t.test(
        "reads cost seven actual Redis commands at 1, 16 and 32 objects; no unrelated object scan",
        async () => {
          const store = create("read-cost");
          for (let n = 1; n <= 32; n++) {
            assert.equal(
              await store.putImmutable(
                n <= 16 ? 0 : 1,
                "blob",
                blobKey(n),
                bytes(),
              ),
              "stored",
            );
            if (![1, 16, 32].includes(n)) continue;
            for (const key of [blobKey(1), blobKey(99)]) {
              const measured = await fixture.measure(() =>
                store.read(0, "blob", key),
              );
              assert.deepEqual(
                measured.value,
                key === blobKey(1) ? bytes() : null,
              );
              assert.equal(measured.metrics.commands, 7);
              assert.equal(measured.metrics.providerRequests, 1);
              assert.equal(measured.metrics.byCommand.hkeys, undefined);
              assert.equal(measured.metrics.byCommand.hget, 2);
            }
          }
          await fixture.command([
            "HSET",
            redisKey("read-cost"),
            `1:blob:${blobKey(100)}`,
            "AA==",
          ]);
          await assert.rejects(
            store.read(0, "blob", blobKey(1)),
            /REDIS_STORE_UNAVAILABLE/,
          );
          assert.equal(
            await store.putImmutable(0, "blob", blobKey(1), bytes()),
            "unavailable",
          );
        },
      );
      await t.test(
        "Redis memory refusal leaves the namespace unchanged and reports unavailable",
        async () => {
          const store = create("oom");
          assert.equal(
            await store.putImmutable(0, "blob", blobKey(), bytes()),
            "stored",
          );
          try {
            await fixture.command(["CONFIG", "SET", "maxmemory", "1"]);
            assert.equal(
              await store.putImmutable(0, "blob", blobKey(2), bytes()),
              "unavailable",
            );
          } finally {
            await fixture.command(["CONFIG", "SET", "maxmemory", "0"]);
          }
          assert.equal(await fixture.command(["HLEN", redisKey("oom")]), 2);
          assert.deepEqual(await store.read(0, "blob", blobKey()), bytes());
          assert.equal(await store.read(0, "blob", blobKey(2)), null);
        },
      );
      await t.test(
        "lost acknowledgement can be retried after cooldown without changing existing bytes",
        async () => {
          let loseResponse = true;
          let now = 10_000;
          const store = createRedisObjectStore(
            { ...config, namespace: `${config.namespace}-lost-ack` },
            {
              now: () => now,
              fetcher: async (url, init) => {
                const response = await fixture.fetcher(url, init);
                if (loseResponse) {
                  loseResponse = false;
                  throw new Error("Synthetic dropped connection after write");
                }
                return response;
              },
            },
          );
          assert.equal(
            await store.putImmutable(0, "blob", blobKey(), bytes()),
            "unavailable",
          );
          assert.equal(
            await store.putImmutable(0, "blob", blobKey(), bytes()),
            "unavailable",
          );
          assert.equal(
            await fixture.command(["HLEN", redisKey("lost-ack")]),
            2,
          );
          now += 2_000;
          assert.equal(
            await store.putImmutable(0, "blob", blobKey(), bytes()),
            "stored",
          );
          assert.deepEqual(await store.read(0, "blob", blobKey()), bytes());
        },
      );
    } finally {
      await fixture.close();
    }
  },
);
