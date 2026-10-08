import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { preparePhysicalTest, verifyPreparedPhysicalTest } from '../scripts/prepare-physical-test.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const helper = await readFile(join(root, 'scripts/prepare-physical-test.mjs'), 'utf8');

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'physical-preparation-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const sourceRoot = join(temp, 'checkout');
  async function file(path, content) { await mkdir(dirname(join(sourceRoot, path)), { recursive: true }); await writeFile(join(sourceRoot, path), content); }
  for (const path of ['app.mjs', 'app-session.mjs', 'index.html', 'style.css', 'handoff.mjs', 'transaction.mjs', 'pending-ticket.mjs', 'vite.config.mjs', 'server.mjs', 'chain/harness.mjs', 'chain/PaymentRight.sol', 'chain/PaymentRight.artifact.json', 'sdk/index.mjs', 'starter/prism-art.mjs', 'starter/prism-art.css', 'release/browser-store.mjs', 'release/testnet-executor.mjs', 'release/client-profile.mjs', 'release/profile.mjs']) await file(path, 'fixture:' + path);
  await file('scripts/prepare-physical-test.mjs', helper);
  await file('package.json', JSON.stringify({ private: true, type: 'module' }));
  await file('package-lock.json', JSON.stringify({ packages: { 'node_modules/viem': { version: '2.0.0' }, 'node_modules/viem/node_modules/tiny': { version: '1.0.0' } } }));
  await file('node_modules/viem/package.json', JSON.stringify({ name: 'viem', version: '2.0.0', dependencies: { tiny: '1.0.0' } }));
  await file('node_modules/viem/index.mjs', "export const status = 'fixture';\n");
  await file('node_modules/viem/node_modules/tiny/package.json', JSON.stringify({ name: 'tiny', version: '1.0.0' }));
  await file('node_modules/viem/node_modules/tiny/index.js', "module.exports = 'fixture';\n");
  await file('node_modules/unrelated-secret.txt', 'must never be copied');
  const anvilPath = join(temp, 'anvil-not-to-be-run');
  await writeFile(anvilPath, '#!/bin/sh\nexit 99\n');
  await chmod(anvilPath, 0o700);
  let buildCount = 0;
  const build = async (_, output) => {
    buildCount++;
    await mkdir(join(output, 'dist'), { recursive: true });
    await writeFile(join(output, 'dist/index.html'), '<p>Frozen fixture, no executable content</p>');
  };
  return { temp, sourceRoot, anvilPath, build, get buildCount() { return buildCount; }, file, out: join(temp, 'prepared') };
}

test('preparation snapshots a separate build and installed runtime dependencies without starting a server', async t => {
  const f = await fixture(t);
  const result = await preparePhysicalTest(f);
  assert.equal(result.status, 'prepared-not-started');
  assert.equal(f.buildCount, 1);
  assert.deepEqual(result.ports, { primary: 4873, recovery: 4874 });
  const manifest = await verifyPreparedPhysicalTest(f.out);
  assert.equal(manifest.serverStarted, false);
  assert.equal(manifest.credentialsCreated, 0);
  assert.equal(manifest.publicNetwork, false);
  assert.equal(manifest.chainId, 31337);
  assert.deepEqual(Object.keys(manifest.dependencies), ['node_modules/viem', 'node_modules/viem/node_modules/tiny']);
  assert.ok(manifest.sourceHashes['app-session.mjs']);
  assert.equal(manifest.buildHashes['dist/index.html'], manifest.files['dist/index.html']);
  assert.ok(!(await readdir(join(f.out, 'node_modules'))).includes('unrelated-secret.txt'));
  await f.file('server.mjs', 'changed checkout server');
  await f.file('node_modules/viem/index.mjs', 'changed checkout dependency');
  assert.equal((await verifyPreparedPhysicalTest(f.out)).snapshotSha256, result.snapshotSha256, 'working checkout edits cannot change copied runtime');
  assert.equal(await readFile(join(f.out, 'server.mjs'), 'utf8'), 'fixture:server.mjs');
  const check = spawnSync(process.execPath, [join(f.out, 'start-physical.mjs'), '--verify-only'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, 'verified-not-started');
});

test('manual launch refuses absent, unknown or additional approval arguments before any server import', async t => {
  const f = await fixture(t);
  await preparePhysicalTest(f);
  for (const args of [[], ['--yes'], ['--physical-approved', '--anything-else']]) {
    const result = spawnSync(process.execPath, [join(f.out, 'start-physical.mjs'), ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EXPLICIT_PHYSICAL_APPROVAL_FLAG_REQUIRED/);
    assert.doesNotMatch(result.stderr, /fixture:server/);
  }
});

test('files, added files, symlinks and pinned executables cannot drift silently', async t => {
  const f = await fixture(t);
  await preparePhysicalTest(f);
  await writeFile(join(f.out, 'unexpected.txt'), 'unexpected');
  await assert.rejects(verifyPreparedPhysicalTest(f.out), /SNAPSHOT_FILES_CHANGED/);
  await rm(join(f.out, 'unexpected.txt'));
  const source = await readFile(join(f.out, 'server.mjs'));
  await writeFile(join(f.out, 'server.mjs'), 'tampered');
  await assert.rejects(verifyPreparedPhysicalTest(f.out), /SNAPSHOT_FILES_CHANGED/);
  await writeFile(join(f.out, 'server.mjs'), source);
  await symlink(join(f.sourceRoot, 'server.mjs'), join(f.out, 'unexpected-link'));
  await assert.rejects(verifyPreparedPhysicalTest(f.out), /SYMLINK_OR_SPECIAL_FILE_REJECTED/);
  await rm(join(f.out, 'unexpected-link'));
  await writeFile(f.anvilPath, 'changed anvil');
  await assert.rejects(verifyPreparedPhysicalTest(f.out), /PINNED_EXECUTABLE_CHANGED/);
});

test('unsafe destinations are rejected and existing content is preserved', async t => {
  const f = await fixture(t);
  await assert.rejects(preparePhysicalTest({ ...f, out: 'relative-path' }), /ABSOLUTE_EMPTY_OUTPUT_REQUIRED/);
  await assert.rejects(preparePhysicalTest({ ...f, out: join(f.sourceRoot, 'candidate') }), /OUTPUT_MUST_BE_SEPARATE_FROM_CHECKOUT/);
  await mkdir(f.out);
  await writeFile(join(f.out, 'keep.txt'), 'preserve me');
  await assert.rejects(preparePhysicalTest(f), /TARGET_MUST_BE_EMPTY/);
  assert.equal(await readFile(join(f.out, 'keep.txt'), 'utf8'), 'preserve me');
  const linked = join(f.temp, 'linked');
  await symlink(f.out, linked);
  await assert.rejects(preparePhysicalTest({ ...f, out: linked }), /SYMLINK_OR_SPECIAL_FILE_REJECTED/);
  assert.equal(f.buildCount, 0);
});

test('changed build inputs, dependency versions or dependency symlinks cannot produce a completed manifest', async t => {
  const f = await fixture(t);
  await assert.rejects(preparePhysicalTest({ ...f, build: async (...args) => { await f.build(...args); await f.file('app-session.mjs', 'changed during build'); } }), /SOURCE_CHANGED_DURING_PREPARATION/);
  await assert.rejects(readFile(join(f.out, 'physical-test-manifest.json')), { code: 'ENOENT' });
  await f.file('node_modules/viem/package.json', JSON.stringify({ name: 'viem', version: 'unlocked' }));
  await assert.rejects(preparePhysicalTest({ ...f, out: join(f.temp, 'bad-version') }), /RUNTIME_DEPENDENCY_LOCK_MISMATCH/);
  await f.file('node_modules/viem/package.json', JSON.stringify({ name: 'viem', version: '2.0.0' }));
  await rm(join(f.sourceRoot, 'node_modules/viem/index.mjs'));
  await symlink(join(f.sourceRoot, 'app.mjs'), join(f.sourceRoot, 'node_modules/viem/index.mjs'));
  await assert.rejects(preparePhysicalTest({ ...f, out: join(f.temp, 'bad-link') }), /SYMLINK_OR_SPECIAL_FILE_REJECTED/);
});
