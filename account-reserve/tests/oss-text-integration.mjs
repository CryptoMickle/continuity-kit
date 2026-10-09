import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createIntegration } from '../integrations/textarea-text/create.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const env = { ...process.env, NODE_PATH: '', PATH: dirname(process.execPath) + ':' + process.env.PATH,
  npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_update_notifier: 'false' };
function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', maxBuffer: 6 * 1024 * 1024 });
  assert.equal(result.status, 0, (result.stdout ?? '') + (result.stderr ?? ''));
  return result.stdout;
}
test('pinned Textarea edits survive packed text SDK preparation, A outage and fresh-process recovery', { timeout: 120000 }, async () => {
  const target = await mkdtemp(join(tmpdir(), 'continuity-textarea-text-test-'));
  try {
    await assert.rejects(() => createIntegration(join(root, 'integrations/textarea-text')), /TARGET_MUST_BE_OUTSIDE_REPOSITORY/);
    await createIntegration(target);
    await assert.rejects(() => createIntegration(target), /TARGET_MUST_BE_EMPTY/);
    for (const name of ['main.mjs', 'adapter.mjs', 'smoke.mjs']) {
      const source = await readFile(join(target, name), 'utf8');
      assert.doesNotMatch(source, /from ['"]\.\.\//, name + ' must not escape the consumer');
      assert.doesNotMatch(source, /viem|privateKeyToAccount|createSecp256k1AccountContext|captureWork|work-reserve/, name + ' must use the text-only API');
      assert.doesNotMatch(source, /sdk-fixture|sdk-authenticator|mera-account-exit|tests\//, name + ' must not borrow internal fixtures');
    }
    run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], target);
    const installed = JSON.parse(await readFile(join(target, 'node_modules/@continuitykit/account-reserve/package.json'), 'utf8'));
    assert.ok(installed.exports['./text-reserve']); assert.ok(installed.exports['./text-browser']);
    run([npmCli, 'run', 'build'], target);
    const report = JSON.parse(run(['smoke.mjs'], target));
    for (const field of ['success', 'actualUpstreamEditorExecuted', 'exactTextPreserved', 'noAccountModel', 'upstreamTxtExportExecuted', 'exportsReadBack', 'editBeforeSnapshotPreserved', 'freshRecoveryProcess', 'immutableSnapshotVerified', 'editedExportVerified', 'plainTextPastePreserved', 'blockDomLineBreaksPreserved', 'pasteUndoVerified', 'selectAllPasteTerminalNewlinePreserved']) assert.equal(report[field], true, field);
    assert.equal(report.originalRequestsDuringRecovery, 0); assert.equal(report.writes, 1);
    assert.equal(report.physicalBrowser, false); assert.equal(report.upstreamAdoption, false);
    console.log(JSON.stringify(report));
  } finally { await rm(target, { recursive: true, force: true }); }
});
