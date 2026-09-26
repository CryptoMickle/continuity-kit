import { test } from "node:test";
import assert from "node:assert/strict";
import { ContinuityError } from "../src/sdk/index.ts";
import {
  fromCheckpoint,
  hasMeaningfulChange,
  MAX_NOTES,
  toCheckpoint,
} from "../examples/passport-recovery/adapter.ts";
import type { PassportData } from "../examples/passport-recovery/adapter.ts";
import { runPassportScenario } from "../examples/passport-recovery/scenario.ts";

const key = (n: number) => `10143:0x${"12".repeat(20)}:${n}`;
const passport: PassportData = {
  v: 1,
  name: "Public Øya 🎵",
  notes: { [key(1)]: { text: "Public example <not HTML>.", at: 1234 } },
};
const invalid = (e: unknown) =>
  e instanceof ContinuityError && e.code === "SCHEMA_INVALID";

test("passport adapter losslessly preserves supported Unicode content and an empty passport", () => {
  for (const value of [passport, { v: 1, name: "", notes: {} }]) {
    assert.deepEqual(fromCheckpoint(toCheckpoint(value)), value);
  }
  const original = structuredClone(passport);
  const capsule = toCheckpoint(original);
  original.notes[key(1)]!.text = "Edited after capture";
  assert.deepEqual(fromCheckpoint(capsule), passport);
});

test("passport adapter rejects unsupported versions, fields, invalid keys and oversize input instead of dropping data", () => {
  for (const bad of [
    { ...passport, v: 2 },
    { ...passport, walletKey: "PUBLIC INVALID FIELD" },
    { ...passport, name: "x".repeat(41) },
    { ...passport, notes: { unsafe: { text: "example", at: 1 } } },
    { ...passport, notes: { [key(1)]: { text: " ", at: 1 } } },
    { ...passport, notes: { [key(1)]: { text: "x".repeat(281), at: 1 } } },
    { ...passport, notes: { [key(1)]: { text: "example", at: Infinity } } },
    {
      ...passport,
      notes: Object.fromEntries(
        Array.from({ length: MAX_NOTES + 1 }, (_, i) => [
          key(i),
          { text: "x", at: 1 },
        ]),
      ),
    },
    {
      ...passport,
      notes: Object.fromEntries(
        Array.from({ length: MAX_NOTES }, (_, i) => [
          key(i),
          { text: "界".repeat(280), at: 1 },
        ]),
      ),
    },
  ])
    assert.throws(() => toCheckpoint(bad), invalid);
});

test("passport consumer rejects wrong format, source and duplicate keys after recovery", () => {
  const workspace = toCheckpoint(passport);
  const raw = JSON.parse(workspace.draft);
  for (const bad of [
    { ...raw, format: "continuity-passport-example/v2" },
    { ...raw, sourceApplication: "another-app" },
    { ...raw, passport: { ...passport, v: 2 } },
    { ...raw, extra: true },
  ])
    assert.throws(
      () => fromCheckpoint({ ...workspace, draft: JSON.stringify(bad) }),
      invalid,
    );
  assert.throws(
    () =>
      fromCheckpoint({
        ...workspace,
        draft: workspace.draft.replace(
          '{"format":',
          '{"format":"ignored","format":',
        ),
      }),
    invalid,
  );
  assert.throws(() => fromCheckpoint({ ...workspace, draft: "{" }), invalid);
  assert.throws(
    () => fromCheckpoint({ ...workspace, title: "another wrapper" }),
    invalid,
  );
});

test("passport checkpoint trigger counts corrections and deletion but ignores timestamps, whitespace and key ordering", () => {
  const unchanged = structuredClone(passport);
  unchanged.name += " ";
  unchanged.notes[key(1)]!.at++;
  unchanged.notes[key(1)]!.text += " ";
  assert.equal(hasMeaningfulChange(passport, unchanged), false);
  const corrected = structuredClone(passport);
  corrected.notes[key(1)]!.text = "A real correction in this public fixture.";
  assert.equal(hasMeaningfulChange(passport, corrected), true);
  assert.equal(hasMeaningfulChange(passport, { ...passport, notes: {} }), true);
  assert.equal(
    hasMeaningfulChange(passport, { ...passport, name: "Changed" }),
    true,
  );
  const first: PassportData = {
    ...passport,
    notes: {
      [key(1)]: { text: "one", at: 1 },
      [key(2)]: { text: "two", at: 2 },
    },
  };
  const reversed: PassportData = {
    ...first,
    notes: Object.fromEntries(Object.entries(first.notes).reverse()),
  };
  assert.equal(hasMeaningfulChange(first, reversed), false);
  assert.equal(toCheckpoint(first).draft, toCheckpoint(reversed).draft);
});

test("synthetic passport consumer recovers exact latest checkpoint with A closed and fails closed on stale/missing/context failures", async () => {
  const report = await runPassportScenario();
  assert.equal(report.checkpointVersion, "2");
  assert.equal(report.localRegistryWrites, 2);
  assert.equal(report.freshRecoveryAttempts, 6);
  assert.equal(report.blockchainTransactions, 0);
  assert.equal(report.turnstileIntegration, false);
});
