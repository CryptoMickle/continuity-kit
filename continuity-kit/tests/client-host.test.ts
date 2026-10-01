import test from "node:test";
import assert from "node:assert/strict";
import { createClientHost } from "../src/release/client-host.ts";
import type { ReleaseProfile } from "../src/release/profile.ts";

const profile: ReleaseProfile = {
  format: "continuity-demo-release/v1",
  deploymentId: "public-demo-host-fixture",
  aOrigin: "https://a.fixture.invalid",
  bOrigin: "https://b.fixture.invalid",
  storeOrigin: "https://store.fixture.invalid",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const html = "<!doctype html><title>Public fixture</title>";
const bytes = new Uint8Array([0, 1, 128, 255]);
const assets = {
  "/index.html": {
    contentType: "text/html; charset=utf-8",
    base64: btoa(html),
  },
  "/logo.png": {
    contentType: "image/png",
    base64: Buffer.from(bytes).toString("base64"),
  },
};

test("client worker serves exact build bytes and useful HEAD, with no source or write routes", async () => {
  const serve = createClientHost(profile, "primary", assets);
  const get = (path: string, method = "GET") =>
    serve(new Request(profile.aOrigin + path, { method }));
  assert.equal(await get("/?enroll=1&mode=physical").text(), html);
  assert.deepEqual(new Uint8Array(await get("/logo.png").arrayBuffer()), bytes);
  const head = get("/logo.png", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-type"), "image/png");
  for (const path of [
    "/src/main.ts",
    "/.env",
    "/v1/control",
    "/constructor",
    "/logo.png.map",
  ])
    assert.equal(get(path).status, 404);
  assert.equal(get("/", "POST").status, 405);
  assert.equal(serve(new Request(profile.bOrigin)).status, 403);
});

test("headers restrict scripts, connections, framing and credential scope while preserving opener", () => {
  const serve = createClientHost(profile, "primary", assets);
  for (const path of ["/", "/logo.png", "/missing"]) {
    const headers = serve(new Request(profile.aOrigin + path)).headers;
    assert.equal(headers.get("referrer-policy"), "no-referrer");
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("cross-origin-opener-policy"), "unsafe-none");
    assert.equal(headers.has("cross-origin-embedder-policy"), false);
    assert.match(
      headers.get("permissions-policy")!,
      /publickey-credentials-get=\(self\)/,
    );
    const csp = headers.get("content-security-policy")!;
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(
      csp,
      /connect-src 'self' https:\/\/store.fixture.invalid https:\/\/testnet-rpc.monad.xyz https:\/\/rpc-testnet.monadinfra.com/,
    );
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|localhost|\*/);
  }
});

test("only the operator setting takes A offline; B and normal requests cannot activate it", () => {
  const a = createClientHost(profile, "primary", assets);
  const b = createClientHost(profile, "recovery", assets);
  const env = { CONTINUITY_PRIMARY_OFFLINE: "1" };
  assert.equal(a(new Request(profile.aOrigin), env).status, 503);
  assert.equal(a(new Request(profile.aOrigin + "/logo.png"), env).status, 503);
  assert.equal(b(new Request(profile.bOrigin), env).status, 200);
  assert.equal(
    a(
      new Request(profile.aOrigin + "/?CONTINUITY_PRIMARY_OFFLINE=1", {
        headers: { CONTINUITY_PRIMARY_OFFLINE: "1" },
      }),
    ).status,
    200,
  );
});

test("expiry blocks both clients before serving any asset without claiming deletion", async () => {
  for (const role of ["primary", "recovery"] as const) {
    const serve = createClientHost(
      { ...profile, expiresAt: "2000-01-01T00:00:00.000Z" },
      role,
      assets,
    );
    const res = serve(
      new Request(role === "primary" ? profile.aOrigin : profile.bOrigin),
    );
    assert.equal(res.status, 410);
    assert.match(await res.text(), /does not delete/);
  }
});
