/** Offline artifact verification only. Does not start a server or call fetch. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { validateReleaseProfile } from "../src/release/profile.ts";

if (process.argv.length !== 3) throw new Error("Pass one candidate directory");
const root = resolve(process.argv[2]);
const manifest = JSON.parse(
  await readFile(join(root, "MANIFEST.json"), "utf8"),
);
const profile = validateReleaseProfile(manifest.profile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of manifest.files) {
  const path = resolve(root, file.path);
  assert.ok(path.startsWith(root + "/"));
  const bytes = await readFile(path);
  assert.equal(bytes.length, file.bytes);
  assert.equal(sha(bytes), file.sha256, file.path);
}
const imported = async (role) => {
  const source = await readFile(
    join(root, "hosts", role, "dist/server/index.js"),
  );
  return (
    await import(`data:text/javascript;base64,${source.toString("base64")}`)
  ).default;
};
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Network forbidden in artifact verification");
};
const result = {
  source: root,
  filesVerified: manifest.files.length,
  assets: {},
  networkRequests: 0,
};
try {
  for (const role of ["primary", "recovery"]) {
    const origin = role === "primary" ? profile.aOrigin : profile.bOrigin;
    const worker = await imported(role);
    assert.equal(typeof worker.fetch, "function");
    const paths = manifest.files.filter((file) =>
      file.path.startsWith(role + "/"),
    );
    result.assets[role] = paths.length;
    for (const file of paths) {
      const path = "/" + file.path.slice(role.length + 1);
      const response = worker.fetch(new Request(origin + path), {});
      assert.equal(response.status, 200, file.path);
      assert.equal(
        sha(new Uint8Array(await response.arrayBuffer())),
        file.sha256,
        file.path,
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(
        response.headers.get("content-security-policy"),
        /script-src 'self'/,
      );
    }
    assert.equal(
      worker.fetch(new Request(origin + "/?enroll=1&mode=physical"), {}).status,
      200,
    );
    assert.equal(
      worker.fetch(new Request(origin + "/v1/control"), {}).status,
      404,
    );
    assert.equal(worker.fetch(new Request(origin + "/.env"), {}).status, 404);
    assert.equal(
      worker.fetch(new Request(origin + "/"), {
        CONTINUITY_PRIMARY_OFFLINE: "1",
      }).status,
      role === "primary" ? 503 : 200,
    );
  }
  const store = await imported("store");
  assert.equal(typeof store.fetch, "function");
  const denied = await store.fetch(
    new Request(profile.storeOrigin + "/v1/presenter-access"),
    {},
  );
  assert.equal(denied.status, 401);
  console.log(
    JSON.stringify({ ...result, compiledHostsPassed: true }, null, 2),
  );
} finally {
  globalThis.fetch = originalFetch;
}
