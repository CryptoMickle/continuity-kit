import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const env = { ...process.env, NODE_PATH: '', PATH: dirname(process.execPath) + ':' + process.env.PATH, npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_update_notifier: 'false' };
function run(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''));
  return r.stdout;
}
test('generated starter installs only packed public APIs, typechecks and recovers after original HTTP outage', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clean-reserve-starter-'));
  const start = Date.now();
  try {
    run([join(root, 'scripts/create-starter.mjs'), dir], root);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.match(manifest.dependencies['@continuitykit/account-reserve'], /^file:\.\/[^/]+\.tgz$/);
    for (const name of await readdir(dir)) {
      if (!/\.(mjs|ts)$/.test(name)) continue;
      const source = await readFile(join(dir, name), 'utf8');
      assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"]\.\.\//, `${name} escapes starter`);
      assert.doesNotMatch(source, /tests\/sdk-|sdk-fixture|mera-account-exit/, `${name} uses internal fixture`);
    }
    run([npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
    const pkg = JSON.parse(await readFile(join(dir, 'node_modules/@continuitykit/account-reserve/package.json'), 'utf8'));
    for (const name of ['.', './browser', './http-store', './preflight']) {
      assert.ok(pkg.exports[name]?.types); assert.ok(pkg.exports[name]?.import);
      await readFile(join(dir, 'node_modules/@continuitykit/account-reserve', pkg.exports[name].types));
    }
    run([npmCli, 'run', 'typecheck'], dir);
    // Also validate declarations themselves, not just consumers using skipLibCheck.
    run(['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json', '--skipLibCheck', 'false'], dir);
    run([npmCli, 'run', 'build'], dir);
    const report = JSON.parse(run(['smoke.mjs'], dir));
    assert.equal(report.sameExistingAccount, true); assert.equal(report.signerClosed, true);
    assert.equal(report.originalRequestsDuringRecovery, 0);
    console.log(JSON.stringify({ experiment: 'documented-starter-clean-install', elapsedMs: Date.now() - start, measurement: 'automated cached install/build/test; not developer onboarding time', copiedInternalFixtures: false, report }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
