import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACK,
  parseTestnetArgs,
  readTestnetConfig,
} from "../scripts/testnet-dev.mjs";

test("testnet launch needs exact operator arguments; query/physical/approval shorthand cannot enable it", () => {
  for (const args of [
    [],
    ["--physical"],
    ["--approved"],
    ["--config", "x"],
    ["--config", "x", ACK, "extra"],
  ])
    assert.throws(() => parseTestnetArgs(args), /DORMANT/);
  assert.equal(
    parseTestnetArgs(["--config", "/synthetic/reviewed.json", ACK]),
    "/synthetic/reviewed.json",
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/testnet-dev.mjs", import.meta.url))],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No service started/);
});

test("invalid, oversized or absent config fails before importing the server launcher", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuity-config-"));
  try {
    const file = join(dir, "config.json");
    await assert.rejects(readTestnetConfig(file));
    await writeFile(file, "null");
    await assert.rejects(
      readTestnetConfig(file),
      /POLICY_INVALID|Invalid explicit testnet runtime/,
    );
    await writeFile(file, " ".repeat(16385));
    await assert.rejects(readTestnetConfig(file), /TOO_LARGE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
