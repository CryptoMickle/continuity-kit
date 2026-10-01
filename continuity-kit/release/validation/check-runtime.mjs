/** Local workerd/D1 compatibility only. No account, remote binding or deploy. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, Log, LogLevel } from "miniflare";

const [candidateFlag, candidatePath, outputFlag, outputPath] =
  process.argv.slice(2);
assert.equal(candidateFlag, "--candidate");
assert.equal(outputFlag, "--output");
assert.ok(candidatePath && outputPath);
const candidate = resolve(candidatePath);
const manifest = JSON.parse(
  await readFile(join(candidate, "MANIFEST.json"), "utf8"),
);
assert.equal(manifest.published, false);
assert.equal(manifest.scope, "local-public-demo-candidate");
const profile = manifest.profile;
assert.ok(Date.parse(profile.expiresAt) > Date.now(), "Candidate has expired");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of manifest.files) {
  const path = resolve(candidate, file.path);
  assert.ok(path.startsWith(candidate + "/"));
  const bytes = await readFile(path);
  assert.equal(bytes.length, file.bytes);
  assert.equal(digest(bytes), file.sha256);
}

const token = "ab".repeat(32); // Public synthetic fixture; never a deployed secret.
const state = await mkdtemp(join(tmpdir(), "continuity-workerd-"));
const checks = [];
let outboundRequests = 0;
const denyOutbound = async () => {
  outboundRequests++;
  throw new Error("External requests forbidden in local hosting check");
};
const common = {
  modules: true,
  modulesRoot: candidate,
  compatibilityDate: "2026-07-30",
  outboundService: denyOutbound,
};
const worker = (name, role, bindings = {}) => ({
  ...common,
  name,
  scriptPath: join(candidate, "hosts", role, "dist/server/index.js"),
  bindings,
});
const options = {
  host: "127.0.0.1",
  port: 0,
  inspectorPort: 0,
  log: new Log(LogLevel.NONE),
  d1Persist: state,
  workers: [
    {
      ...worker("store", "store", { CONTINUITY_UPLOAD_TOKEN: token }),
      d1Databases: ["DB"],
    },
    worker("primary", "primary"),
    worker("recovery", "recovery"),
    worker("primary-offline", "primary", { CONTINUITY_PRIMARY_OFFLINE: "1" }),
  ],
};
let mf;
try {
  mf = new Miniflare(options);
  const db = await mf.getD1Database("DB", "store");
  const journal = JSON.parse(
    await readFile(
      join(candidate, "hosts/store/drizzle/meta/_journal.json"),
      "utf8",
    ),
  );
  for (const entry of journal.entries) {
    const sql = await readFile(
      join(candidate, `hosts/store/drizzle/${entry.tag}.sql`),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }
  assert.equal(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='ck_demo_quota'",
        )
        .first()
    ).name,
    "ck_demo_quota",
  );
  checks.push(
    "Both generated migrations apply through local D1, including the complete quota trigger",
  );

  let assetResponses = 0;
  for (const role of ["primary", "recovery"]) {
    const client = await mf.getWorker(role);
    const origin = role === "primary" ? profile.aOrigin : profile.bOrigin;
    for (const file of manifest.files.filter((file) =>
      file.path.startsWith(`${role}/`),
    )) {
      const suffix = file.path.slice(role.length + 1);
      const response = await client.fetch(
        origin + "/" + (suffix === "index.html" ? "" : suffix),
      );
      assert.equal(response.status, 200);
      assert.equal(
        digest(Buffer.from(await response.arrayBuffer())),
        file.sha256,
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(
        response.headers.get("content-security-policy"),
        /frame-ancestors 'none'/,
      );
      assetResponses++;
    }
    assert.equal((await client.fetch(origin + "/.env")).status, 404);
    assert.equal((await client.fetch(origin + "/src/main.ts")).status, 404);
    assert.equal(
      (await client.fetch(origin + "/", { method: "POST" })).status,
      405,
    );
  }
  assert.equal(assetResponses, 12);
  assert.equal(
    (await (await mf.getWorker("primary-offline")).fetch(profile.aOrigin + "/"))
      .status,
    503,
  );
  assert.equal(
    (await (await mf.getWorker("recovery")).fetch(profile.bOrigin + "/"))
      .status,
    200,
  );
  checks.push(
    "All 12 actual client assets, private-route denial, security headers and A-only outage work in workerd",
  );

  // Public requests use Miniflare's entrypoint. getWorker().fetch() uses its
  // protected development proxy, whose Origin policy is not the app's CORS.
  const request = (path, method = "GET", body, headers = {}) =>
    mf.dispatchFetch(profile.storeOrigin + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  const put = (path, body) =>
    request(path, "PUT", body, {
      origin: profile.aOrigin,
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
    });
  const index = (slot, letter) =>
    `/v1/mirrors/${slot}/index/${letter.repeat(43)}`;
  const data = new Uint8Array([17, 23, 89]);
  const blob = `/v1/mirrors/0/blob/0x${digest(data)}`;
  assert.equal((await request("/v1/presenter-access")).status, 401);
  const presenterResponse = await request(
    "/v1/presenter-access",
    "GET",
    undefined,
    { origin: profile.aOrigin, authorization: `Bearer ${token}` },
  );
  assert.equal(presenterResponse.status, 204, await presenterResponse.text());
  assert.equal(
    (
      await request(blob, "PUT", data, {
        "content-type": "application/octet-stream",
      })
    ).status,
    401,
  );
  for (const path of ["/v1/control", "/v1/status", "/v1/registry"])
    assert.equal((await request(path)).status, 404);
  assert.equal(
    (
      await request(blob, "OPTIONS", undefined, {
        origin: profile.aOrigin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await request(blob, "OPTIONS", undefined, {
        origin: profile.bOrigin,
        "access-control-request-method": "PUT",
      })
    ).status,
    403,
  );
  checks.push(
    "Presenter authentication, closed control routes and exact CORS preflight policy work in workerd",
  );

  assert.equal((await put(blob, data)).status, 204);
  assert.equal((await put(blob, data)).status, 204);
  assert.equal((await put(index(0, "a"), data)).status, 204);
  assert.equal((await put(index(0, "a"), new Uint8Array([99]))).status, 409);
  const first = new Uint8Array([31]);
  const second = new Uint8Array([32]);
  const concurrent = await Promise.all([
    put(index(0, "b"), first),
    put(index(0, "b"), second),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [204, 409]);
  const winner = concurrent[0].status === 204 ? first : second;
  assert.equal((await put(index(0, "b"), winner)).status, 204);
  assert.equal((await put(index(0, "c"), data)).status, 503);
  const recovered = await request(blob, "GET", undefined, {
    origin: profile.bOrigin,
  });
  assert.equal(recovered.status, 200);
  assert.equal(
    recovered.headers.get("access-control-allow-origin"),
    profile.bOrigin,
  );
  assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), data);
  checks.push(
    "D1 preserves exact binary bytes, immutable conflicts, competing writes and index quota with public B reads",
  );

  for (let n = 0; n < 17; n++) {
    const bytes = new Uint8Array([70, n]);
    const response = await put(`/v1/mirrors/1/blob/0x${digest(bytes)}`, bytes);
    assert.equal(response.status, n < 16 ? 204 : 503);
  }
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM ck_demo_objects WHERE slot=1")
        .first()
    ).n,
    16,
  );
  await assert.rejects(() =>
    db
      .prepare("INSERT INTO ck_demo_objects VALUES(2,'blob','bad-slot',x'01')")
      .run(),
  );
  await assert.rejects(() =>
    db
      .prepare(
        "INSERT INTO ck_demo_objects VALUES(0,'blob','bad-size',zeroblob(1048577))",
      )
      .run(),
  );
  checks.push(
    "Actual D1 checks reject a 17th object, invalid slot and oversized row",
  );

  await mf.dispose();
  mf = new Miniflare(options);
  const afterRestart = await request(blob, "GET", undefined, {
    origin: profile.bOrigin,
  });
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(new Uint8Array(await afterRestart.arrayBuffer()), data);
  assert.equal((await put(index(0, "c"), data)).status, 503);
  checks.push(
    "Ciphertext and index quota survive a fresh local runtime using the same disposable D1 directory",
  );
  assert.equal(outboundRequests, 0);
  const result = {
    checkedAt: new Date().toISOString(),
    scope:
      "Local compiled candidate in workerd with Miniflare D1; not hosted Sites or remote Cloudflare proof",
    candidate,
    manifestSha256: digest(await readFile(join(candidate, "MANIFEST.json"))),
    miniflareVersion: "4.20260730.0",
    compatibilityDate: common.compatibilityDate,
    manifestFilesVerified: manifest.files.length,
    assetResponses,
    outboundRequests,
    checks,
    passed: true,
    notTested: [
      "Sites archive/source synchronization and cloud migration runner",
      "Public TLS, actual domains and browser CSP behavior",
      "Physical passkeys or chain transactions",
      "Platform billing or availability",
    ],
  };
  await writeFile(resolve(outputPath), JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      passed: true,
      checks: checks.length,
      assetResponses,
      outboundRequests,
      output: resolve(outputPath),
    }),
  );
} finally {
  await mf?.dispose();
  await rm(state, { recursive: true, force: true });
}
