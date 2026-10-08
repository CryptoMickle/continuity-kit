import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const run = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024,
  env: { ...process.env, npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_update_notifier: 'false' },
});

test('packed SDK installs into two clean offline consumers with different real derivation libraries and competent exports', { timeout: 120000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'reserve-package-consumers-'));
  try {
    const packed = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root));
    assert.equal(packed.length, 1);
    const files = packed[0].files.map((file) => file.path);
    assert.ok(files.includes('sdk/index.mjs'));
    assert.equal(files.some((path) => path.includes('node_modules') || path.includes('mera-account-exit') || path.startsWith('tests/')), false);
    const reports = [];
    for (const kind of ['iris', 'accrue']) {
      const target = join(temp, kind); await mkdir(target);
      await writeFile(join(target, 'package.json'), JSON.stringify({ name: `isolated-${kind}-consumer`, version: '0.0.0', private: true, type: 'module' }));
      run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', join(temp, packed[0].filename)], target);
      for (const filename of ['sdk-authenticator.mjs', 'sdk-fixture.mjs', 'sdk-derived-fixture.mjs', 'sdk-consumer.mjs']) {
        let source = await readFile(new URL(filename, import.meta.url), 'utf8');
        source = source.replace("from '../sdk/index.mjs'", "from '@continuitykit/account-reserve'");
        await writeFile(join(target, filename), source);
      }
      const output = execFileSync(process.execPath, [join(target, 'sdk-consumer.mjs'), '--consumer', kind], {
        cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024,
      });
      const report = JSON.parse(output);
      assert.equal(report.kind, kind); assert.equal(report.success, true);
      assert.equal(report.competentAvailableExportAlsoWorks, true);
      reports.push(report);
    }
    console.log(JSON.stringify({ experiment: 'installed-package-two-source-derived-consumers', packageVersion: packed[0].version, packageIntegrity: packed[0].integrity, reports }));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
