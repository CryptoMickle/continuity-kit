import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const POLICY = '(version 1)\n(allow default)\n(deny network*)\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-bind (local ip "localhost:*"))\n';
const PORTS = Object.freeze({ primary: 4873, recovery: 4874 });
const SOURCES = [
  'app.mjs', 'index.html', 'style.css', 'handoff.mjs', 'transaction.mjs', 'pending-ticket.mjs',
  'vite.config.mjs', 'package.json', 'package-lock.json', 'server.mjs',
  'chain/harness.mjs', 'chain/PaymentRight.sol', 'chain/PaymentRight.artifact.json',
  'sdk', 'starter/prism-art.mjs', 'starter/prism-art.css',
  'release/browser-store.mjs', 'release/testnet-executor.mjs', 'release/client-profile.mjs', 'release/profile.mjs',
  'scripts/prepare-physical-test.mjs',
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha256(JSON.stringify(value));
const fail = code => { throw new Error(code); };
const inside = (base, path) => path === base || path.startsWith(base + sep);

async function ordinary(path, kind) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) fail('SYMLINK_OR_SPECIAL_FILE_REJECTED');
  return stat;
}

// No symlinks are retained: later edits to the working checkout cannot change a prepared runtime.
async function copyTree(source, target, { skipModules = false } = {}) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) fail('SYMLINK_OR_SPECIAL_FILE_REJECTED');
  if (stat.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of (await readdir(source)).sort()) {
      if (skipModules && entry === 'node_modules') continue;
      await copyTree(join(source, entry), join(target, entry), { skipModules });
    }
  } else if (stat.isFile()) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(source), { flag: 'wx', mode: stat.mode & 0o777 });
  } else fail('SYMLINK_OR_SPECIAL_FILE_REJECTED');
}

async function hashes(directory, prefix = '') {
  const result = {};
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix ? prefix + '/' + name : name;
    const stat = await lstat(join(directory, path));
    if (stat.isSymbolicLink()) fail('SYMLINK_OR_SPECIAL_FILE_REJECTED');
    if (stat.isDirectory()) Object.assign(result, await hashes(directory, path));
    else if (stat.isFile()) result[path] = sha256(await readFile(join(directory, path)));
    else fail('SYMLINK_OR_SPECIAL_FILE_REJECTED');
  }
  return result;
}

async function sourcePaths(root) {
  const paths = [...SOURCES];
  for (const path of ['app-session.mjs', 'app-setup.mjs', 'app-progress.mjs']) {
    try { await ordinary(join(root, path), 'file'); paths.push(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return paths;
}

async function selectedHashes(root) {
  const result = {};
  for (const path of await sourcePaths(root)) {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) fail('SYMLINK_OR_SPECIAL_FILE_REJECTED');
    if (stat.isDirectory()) {
      for (const [child, hash] of Object.entries(await hashes(join(root, path)))) result[path + '/' + child] = hash;
    } else { await ordinary(join(root, path), 'file'); result[path] = sha256(await readFile(join(root, path))); }
  }
  return result;
}

async function runtimePackages(root, lock) {
  const packages = new Map();
  async function resolvePackage(name, from) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) fail('DEPENDENCY_NAME_INVALID');
    for (let cursor = from; inside(root, cursor); cursor = dirname(cursor)) {
      const path = join(cursor, 'node_modules', name);
      try { await ordinary(path, 'directory'); await ordinary(join(path, 'package.json'), 'file'); return path; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (cursor === root) break;
    }
    fail('INSTALLED_RUNTIME_DEPENDENCY_MISSING');
  }
  async function visit(name, from) {
    const path = await resolvePackage(name, from);
    const key = relative(root, path).split(sep).join('/');
    if (packages.has(key)) return;
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    if (manifest.name !== name || lock.packages[key]?.version !== manifest.version) fail('RUNTIME_DEPENDENCY_LOCK_MISMATCH');
    packages.set(key, manifest.version);
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) await visit(dependency, path);
  }
  await visit('viem', root);
  return Object.fromEntries([...packages].sort(([a], [b]) => a.localeCompare(b)));
}

function cleanEnvironment() {
  return { HOME: homedir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC', NODE_PATH: '', NODE_OPTIONS: '' };
}

async function buildOffline(root, output, node) {
  if (process.platform !== 'darwin') fail('MACOS_SANDBOX_REQUIRED_FOR_BUILD');
  const policy = join(output, 'loopback-only.sb');
  const result = spawnSync('/usr/bin/sandbox-exec', ['-f', policy, node, join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', join(output, 'dist'), '--emptyOutDir'], {
    cwd: root, env: cleanEnvironment(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('ISOLATED_BUILD_FAILED: ' + (result.stderr ?? result.error?.message ?? '').slice(-1600));
  await writeFile(join(output, 'build-output.txt'), result.stdout);
}

/** Prepare files only. This does not import the server or chain harness, bind ports, create credentials or start Anvil. */
export async function preparePhysicalTest({ out, sourceRoot = repository, nodePath = process.execPath, anvilPath = process.env.CONTINUITY_ANVIL ?? join(homedir(), '.foundry/bin/anvil'), build = buildOffline } = {}) {
  if (typeof out !== 'string' || !isAbsolute(out)) fail('ABSOLUTE_EMPTY_OUTPUT_REQUIRED');
  const root = await realpath(sourceRoot);
  const target = resolve(out);
  // Resolve existing ancestors before creating anything; an alias into the checkout must also be rejected.
  let ancestor = target;
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  await ordinary(ancestor, 'directory');
  const resolvedTarget = resolve(await realpath(ancestor), relative(ancestor, target));
  if (inside(root, resolvedTarget) || inside(resolvedTarget, root)) fail('OUTPUT_MUST_BE_SEPARATE_FROM_CHECKOUT');
  await mkdir(target, { recursive: true });
  await ordinary(target, 'directory');
  if ((await readdir(target)).length) fail('TARGET_MUST_BE_EMPTY');
  const node = await realpath(nodePath), anvil = await realpath(anvilPath);
  await ordinary(node, 'file'); await ordinary(anvil, 'file');
  const executables = {
    node: { path: node, sha256: sha256(await readFile(node)) },
    anvil: { path: anvil, sha256: sha256(await readFile(anvil)) },
  };
  const sourceHashes = await selectedHashes(root);
  for (const path of await sourcePaths(root)) await copyTree(join(root, path), join(target, 'source', path));
  for (const [path, hash] of Object.entries(sourceHashes)) {
    if (sha256(await readFile(join(target, 'source', path))) !== hash) fail('SOURCE_CHANGED_DURING_PREPARATION');
  }
  for (const path of ['server.mjs', 'chain/harness.mjs', 'chain/PaymentRight.sol', 'chain/PaymentRight.artifact.json', 'scripts/prepare-physical-test.mjs']) {
    await copyTree(join(target, 'source', path), join(target, path));
  }
  await writeFile(join(target, 'package.json'), JSON.stringify({ private: true, type: 'module', engines: { node: '>=24' } }, null, 2) + '\n');
  await writeFile(join(target, 'loopback-only.sb'), POLICY);
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const dependencies = await runtimePackages(root, lock);
  for (const path of Object.keys(dependencies)) await copyTree(join(root, path), join(target, path), { skipModules: true });
  await build(root, target, node);
  await ordinary(join(target, 'dist/index.html'), 'file');
  if (digest(sourceHashes) !== digest(await selectedHashes(root))) fail('SOURCE_CHANGED_DURING_PREPARATION');
  for (const path of Object.keys(dependencies)) {
    // Compare only this package's own copied files; nested modules are recorded separately.
    const copied = await hashes(join(target, path));
    for (const [file, hash] of Object.entries(copied)) {
      if (sha256(await readFile(join(root, path, file))) !== hash) fail('DEPENDENCY_CHANGED_DURING_PREPARATION');
    }
  }
  await writeFile(join(target, 'start-physical.mjs'), "import { dirname } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { launchPreparedPhysicalTest } from './scripts/prepare-physical-test.mjs';\nawait launchPreparedPhysicalTest(dirname(fileURLToPath(import.meta.url)), process.argv.slice(2));\n");
  await writeFile(join(target, 'READ_BEFORE_START.txt'), [
    'PREPARED ONLY — no server, credential, signing key or chain has been started.',
    'This is a separate local physical-passkey test, not a public deployment or Monad testnet.',
    'Start only after the user expressly approves this exact physical test.',
    'Native passkey prompts must be completed by the human.',
    '',
    `Verify without starting anything: ${JSON.stringify(node)} ./start-physical.mjs --verify-only`,
    `After approval, manual start: ${JSON.stringify(node)} ./start-physical.mjs --physical-approved`,
    '',
    'Original app: http://continuity-primary.localhost:4873/?model=iris',
    'Reserve: http://continuity-reserve.localhost:4874/?model=iris',
    'RP IDs: continuity-primary.localhost / continuity-reserve.localhost (ports do not change RP IDs).',
    'Use one new example account and one dedicated new recovery credential for this run.',
    'The app creates only a local, valueless 0.001 TEST payment. No public network is allowed.',
    'Ciphertext and the disposable chain are held in RAM. Restarting loses the reserve and payment.',
    'Previously running demos on 4573/4574 and 4673/4674 are not stopped or reused.',
    'Stopping this isolated run does not delete passkeys from the password manager.',
    'File hashes detect accidental changes; this package is not a signed or audited release.',
  ].join('\n') + '\n');
  const files = await hashes(target);
  const manifest = {
    format: 'continuity-physical-preparation-v1', status: 'prepared-not-started', generatedAt: new Date().toISOString(),
    scope: 'Local physical credentials and a disposable loopback Anvil chain, after separate express approval',
    ports: PORTS, rpIds: { primary: 'continuity-primary.localhost', recovery: 'continuity-reserve.localhost' },
    chainId: 31337, publicNetwork: false, publicTransactions: 0, realFunds: false, credentialsCreated: 0,
    serverStarted: false, statePersistence: 'RAM only; restart destroys reserve and local chain',
    nodeVersion: process.version, executables, dependencies, sourceHashes,
    buildHashes: Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('dist/'))),
    files,
  };
  manifest.snapshotSha256 = digest(manifest);
  await writeFile(join(target, 'physical-test-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await chmod(join(target, 'physical-test-manifest.json'), 0o444);
  return { directory: target, status: manifest.status, snapshotSha256: manifest.snapshotSha256, fileCount: Object.keys(files).length, ports: PORTS };
}

export async function verifyPreparedPhysicalTest(directory) {
  await ordinary(directory, 'directory');
  const manifest = JSON.parse(await readFile(join(directory, 'physical-test-manifest.json'), 'utf8'));
  const { snapshotSha256, ...unsigned } = manifest;
  if (manifest.format !== 'continuity-physical-preparation-v1' || digest(unsigned) !== snapshotSha256) fail('SNAPSHOT_MANIFEST_INVALID');
  if (manifest.ports.primary !== PORTS.primary || manifest.ports.recovery !== PORTS.recovery || manifest.chainId !== 31337 || manifest.publicNetwork !== false) fail('SNAPSHOT_SCOPE_INVALID');
  const current = await hashes(directory);
  delete current['physical-test-manifest.json'];
  if (digest(current) !== digest(manifest.files)) fail('SNAPSHOT_FILES_CHANGED');
  for (const executable of Object.values(manifest.executables)) {
    await ordinary(executable.path, 'file');
    if (sha256(await readFile(executable.path)) !== executable.sha256) fail('PINNED_EXECUTABLE_CHANGED');
  }
  return manifest;
}

export async function launchPreparedPhysicalTest(directory, args) {
  if (args.length !== 1 || !['--verify-only', '--physical-approved'].includes(args[0])) fail('EXPLICIT_PHYSICAL_APPROVAL_FLAG_REQUIRED');
  const manifest = await verifyPreparedPhysicalTest(directory);
  if (args[0] === '--verify-only') {
    console.log(JSON.stringify({ status: 'verified-not-started', snapshotSha256: manifest.snapshotSha256, serverStarted: false, credentialsCreated: 0 }));
    return;
  }
  if (process.platform !== 'darwin') fail('MACOS_SANDBOX_REQUIRED_FOR_PHYSICAL_START');
  const child = spawn('/usr/bin/sandbox-exec', ['-f', join(directory, 'loopback-only.sb'), manifest.executables.node.path, join(directory, 'server.mjs'), '--physical-approved'], {
    cwd: directory, stdio: 'inherit', env: { ...cleanEnvironment(), CONTINUITY_PRIMARY_PORT: String(PORTS.primary), CONTINUITY_RECOVERY_PORT: String(PORTS.recovery), CONTINUITY_ANVIL: manifest.executables.anvil.path },
  });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))); });
    if (code !== 0) fail('ISOLATED_PHYSICAL_SERVER_FAILED');
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') fail('Usage: node scripts/prepare-physical-test.mjs --out /absolute/new-empty-directory');
  console.log(JSON.stringify(await preparePhysicalTest({ out: process.argv[3] })));
}
