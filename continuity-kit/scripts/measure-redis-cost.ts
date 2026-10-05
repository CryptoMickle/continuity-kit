/** Local synthetic benchmark. Never connects to Upstash or a chain. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { redisFixture } from "../tests/redis-fixture.ts";
import { createRedisObjectStore } from "../src/release/redis-store.ts";
import { createRedisDemoStore } from "../src/release/redis-handler.ts";
import {
  HttpMirrorStore,
  MemoryRegistry,
  MeraPasskeyAdapter,
  createPrimary,
  prepareBackup,
  finalizeEnrollment,
  saveCheckpoint,
  restorePrimary,
  discoverRecovery,
  recoverCurrent,
  LOCAL_POLICY,
} from "../src/sdk/index.ts";
import type {
  LocalRecoveryPolicy,
  PrimaryAdapters,
  Workspace,
} from "../src/sdk/types.ts";
import { SyntheticWebAuthnClient } from "../src/sdk/demo-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
if (
  process.argv.length !== 4 ||
  process.argv[2] !== "--out" ||
  !process.env.REDIS_SERVER_BIN
)
  throw new Error(
    "Set REDIS_SERVER_BIN and use --out <new delivery/local-export directory>",
  );
const out = resolve(process.argv[3]!);
if (!out.startsWith(join(root, "delivery/local-export") + "/"))
  throw new Error("Local export required");
await mkdir(out); // Do not overwrite an earlier measurement.
const sources = [
  "src/release/redis-store.ts",
  "src/release/redis-handler.ts",
  "tests/redis-fixture.ts",
  "scripts/measure-redis-cost.ts",
];
const hashes: Record<string, string> = {};
for (const path of sources) {
  const bytes = await readFile(join(root, path));
  hashes[path] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(out, path.replaceAll("/", "__")), bytes);
}
const fixture = await redisFixture(process.env.REDIS_SERVER_BIN);
const rows: Array<{
  action: string;
  commands: number;
  [key: string]: unknown;
}> = [];
const measure = async <T>(action: string, run: () => Promise<T>) => {
  const { value, metrics } = await fixture.measure(run);
  rows.push({ action, ...metrics });
  return value;
};
const profile = {
  format: "continuity-demo-release/v1" as const,
  deploymentId: "public-demo-cost-fixture",
  aOrigin: "https://a.fixture.invalid",
  bOrigin: "https://b.fixture.invalid",
  storeOrigin: "https://store.fixture.invalid",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const token = "ab".repeat(32); // Public synthetic fixture only.
const env = {
  CONTINUITY_UPLOAD_TOKEN: token,
  CONTINUITY_REDIS_REST_URL: "https://synthetic-fixture.upstash.io",
  CONTINUITY_REDIS_REST_TOKEN: "synthetic-token-not-a-real-secret",
};
const originalFetch = globalThis.fetch;
let primary: Awaited<ReturnType<typeof createPrimary>> | undefined;
try {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, profile.storeOrigin);
    // Cold handler per request, no warm cache dependency or network fallback.
    return createRedisDemoStore(profile, { fetcher: fixture.fetcher })(
      request,
      env,
    );
  };
  const urls = [0, 1].map((n) => `${profile.storeOrigin}/v1/mirrors/${n}`);
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
      (url) =>
        new HttpMirrorStore(url, undefined, 10000, () => ({
          authorization: `Bearer ${token}`,
        })),
    ),
  };
  const passkeys = () =>
    new MeraPasskeyAdapter(
      new SyntheticWebAuthnClient({ seed: "PUBLIC COST FIXTURE" }),
    );
  const content: Workspace = {
    title: "Cost fixture",
    plan: "Synthetic only",
    tasks: [],
    draft: "Version one",
  };
  primary = await createPrimary(policy, passkeys(), adapters);
  const backup = await prepareBackup(policy, passkeys(), primary);
  const enrollment = await measure("enroll-v1-two-copies", () =>
    finalizeEnrollment(primary!, backup, content, adapters),
  );
  assert.equal(enrollment.status, "prepared");
  if (enrollment.status !== "prepared")
    throw new Error("Unexpected pending enrollment");
  for (const version of [2, 3]) {
    content.draft = `Version ${version}`;
    const result: Awaited<ReturnType<typeof saveCheckpoint>> = await measure(
      `checkpoint-v${version}-two-copies`,
      (): ReturnType<typeof saveCheckpoint> =>
        saveCheckpoint(enrollment.state, content, adapters),
    );
    assert.equal(result.status, "saved");
  }
  primary.close();
  const recovery = {
    registry,
    mirrors: urls.map((url) => new HttpMirrorStore(url)),
  };
  const recovered = await measure("fresh-b-recovery-v3", async () => {
    const found = await discoverRecovery(policy, passkeys(), recovery);
    return recoverCurrent(found, passkeys(), recovery);
  });
  assert.deepEqual(recovered.content, content);
  const restored = await measure("fresh-a-restore-v3", () =>
    restorePrimary(policy, passkeys(), adapters),
  );
  assert.deepEqual(restored.recovered.content, content);
  restored.state.close();
  const serve = createRedisDemoStore(profile, { fetcher: fixture.fetcher });
  await measure("rejected-anonymous-write", async () => {
    const result = await serve(
      new Request(`${urls[0]}/index/${"a".repeat(43)}`, {
        method: "PUT",
        body: "synthetic",
      }),
      env,
    );
    assert.equal(result.status, 401);
  });
  globalThis.fetch = originalFetch;

  // Measure how read cost changes with namespace size, on the real adapter.
  const store = createRedisObjectStore(
    {
      url: env.CONTINUITY_REDIS_REST_URL,
      token: env.CONTINUITY_REDIS_REST_TOKEN,
      namespace: "cost-occupancy-fixture",
    },
    { fetcher: fixture.fetcher },
  );
  const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const bytes = new Uint8Array([0, 128, 255, 1]);
  for (let n = 1; n <= 32; n++) {
    assert.equal(
      await store.putImmutable(n <= 16 ? 0 : 1, "blob", key(n), bytes),
      "stored",
    );
    if ([1, 16, 32].includes(n)) {
      await measure(`read-existing-with-${n}-objects`, async () =>
        assert.deepEqual(await store.read(0, "blob", key(1)), bytes),
      );
      await measure(`read-missing-with-${n}-objects`, async () =>
        assert.equal(await store.read(0, "blob", key(99)), null),
      );
    }
  }
  const report = {
    format: "continuity-local-redis-cost/v1",
    observedAt: new Date().toISOString(),
    scope:
      "Disposable real Redis over a Unix socket; synthetic WebAuthn, local registry and REST-shaped transport. No live provider, native passkey, chain call or invoice.",
    method:
      "Deltas of Redis INFO commandstats, excluding INFO itself; includes EVAL and executed Lua subcommands. SDK timings include local crypto and are not hosted latency.",
    sources: hashes,
    rows,
    illustrativePricing: {
      source: "https://upstash.com/pricing/redis",
      checkedDate: "2026-10-02",
      usdPer100000Commands: 0.2,
      excludes:
        "Hosting, AI/RPC, taxes, Marketplace differences, region replication and storage/transfer overages. Not an enforced budget.",
    },
  };
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      rows.map(({ action, commands, providerRequests }) => ({
        action,
        commands,
        providerRequests,
      })),
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = originalFetch;
  primary?.close();
  await fixture.close();
}
