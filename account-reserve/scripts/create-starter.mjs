import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Generates files only. Never installs, starts services, publishes, or creates keys.
const root = fileURLToPath(new URL('..', import.meta.url));
const supplied = process.argv[2];
if (!supplied) throw new Error('Usage: node scripts/create-starter.mjs /path/to/new-project');
const target = resolve(supplied);
await mkdir(target, { recursive: true });
if ((await readdir(target)).length) throw new Error('TARGET_MUST_BE_EMPTY');
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const packed = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', target], {
  cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: process.env.SDK_TEST_NPM_CACHE ?? '/tmp/continuity-reserve-npm', npm_config_update_notifier: 'false' },
});
if (packed.status !== 0) throw new Error('LOCAL_SDK_PACK_FAILED');
const [{ filename }] = JSON.parse(packed.stdout);
for (const name of await readdir(join(root, 'starter'))) await cp(join(root, 'starter', name), join(target, name), { recursive: true, errorOnExist: true });
const manifest = {
  name: 'continuity-reserve-starter', version: '0.0.0', private: true, type: 'module', engines: { node: '>=24' },
  scripts: { build: 'vite build', dev: 'npm run build && node server.mjs', doctor: 'node doctor.mjs', test: 'node smoke.mjs', typecheck: 'tsc --noEmit -p tsconfig.json' },
  dependencies: { '@continuitykit/account-reserve': `file:./${filename}`, '@category-labs/mera': '0.2.0', viem: '2.56.9' },
  devDependencies: { vite: '8.3.1', typescript: '5.9.3' },
};
await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory: target, next: ['npm install --ignore-scripts', 'npm run typecheck', 'npm test', 'npm run dev'], status: 'local-files-only', published: false }));
