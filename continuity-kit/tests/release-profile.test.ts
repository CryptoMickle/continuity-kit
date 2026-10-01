import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateReleaseProfile,
  releasePolicy,
  REGISTRY_ADDRESS,
} from "../src/release/profile.ts";
import { createReleaseRuntime } from "../src/release/runtime.ts";
const profile = JSON.parse(
  readFileSync(
    new URL("../release/profile.example.json", import.meta.url),
    "utf8",
  ),
);
test("release policy fixes chain, deployed contract, quorum, disjoint domains and bounded writes", () => {
  const checked = validateReleaseProfile(profile),
    p = releasePolicy(checked);
  const r = createReleaseRuntime(profile, () => "");
  assert.ok(Object.isFrozen(checked));
  assert.ok(Object.isFrozen(p));
  assert.equal(p.chainId, "10143");
  assert.equal(p.registryAddress, REGISTRY_ADDRESS);
  assert.equal(p.rpcUrls.length, 2);
  assert.equal(r.controlUrl, null);
  assert.equal(r.requirePhysicalPasskeys, true);
  assert.equal(r.adapters.trustMode, "trusted-rpc-quorum");
  if (r.adapters.trustMode === "trusted-rpc-quorum")
    assert.equal(r.adapters.sessionLimits.maxTransactions, 2);
});
test("release configuration rejects loose origins, malformed expiry, unknown fields and overlapping RP scope", () => {
  for (const aOrigin of [
    "http://a.example.com",
    "https://a.example.com/",
    "https://a.example.com:444",
    "https://localhost",
    "https://a.localhost",
    "https://127.0.0.1",
    "https://user:password@a.example.com",
  ])
    assert.throws(() => validateReleaseProfile({ ...profile, aOrigin }));
  for (const expiresAt of [
    "tomorrow",
    "2099-02-31T00:00:00.000Z",
    "not-a-date",
  ])
    assert.throws(() => validateReleaseProfile({ ...profile, expiresAt }));
  assert.throws(() =>
    validateReleaseProfile({ ...profile, bOrigin: profile.aOrigin }),
  );
  assert.throws(() =>
    validateReleaseProfile({
      ...profile,
      aOrigin: "https://example.com",
      bOrigin: "https://b.example.com",
    }),
  );
  assert.throws(() =>
    validateReleaseProfile({ ...profile, storeOrigin: profile.aOrigin }),
  );
  assert.throws(() =>
    validateReleaseProfile({
      ...profile,
      rpcUrls: ["https://attacker.invalid"],
    }),
  );
});
test("presenter token stays out of config and every mirror write checks it before any fetch", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests++;
    throw new Error("No network allowed");
  });
  const runtime = createReleaseRuntime(profile, () => "");
  await assert.rejects(() =>
    runtime.adapters.mirrors[0]!.putIndexIfAbsent(
      "a".repeat(43),
      new Uint8Array([1]),
    ),
  );
  assert.equal(requests, 0);
});
