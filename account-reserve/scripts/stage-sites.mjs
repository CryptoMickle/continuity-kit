import { readFile, writeFile, readdir, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateClientProfile } from '../release/client-profile.mjs';
import { httpsOrigin } from '../release/profile.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const roles = ['primary', 'recovery'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cleanPath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const secretName = name => /(?:^\.env(?:\.|$)|^\.dev\.vars(?:\.|$)|(?:secret|credential|private[-_]?key|mnemonic)|\.server\.json$|(?:token|signer)[^.]*\.json$|\.(?:pem|key|p12|pfx)$)/i.test(name);

// No arbitrary copy roots or environment discovery. CLI paths are public profiles
// inside this project; root injection exists only for isolated filesystem tests.
async function checkedPath(root, path, { missing = false } = {}) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('../') || rel === '..' || rel.startsWith('/')) fail('STAGE_PATH_REJECTED');
  const parts = rel.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (missing && error.code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) fail('STAGE_SYMLINK_REJECTED');
    if (i < parts.length - 1 ? !info.isDirectory() : !info.isDirectory() && !info.isFile()) fail('STAGE_FILE_INVALID');
    if (info.isFile() && info.nlink !== 1) fail('STAGE_HARDLINK_REJECTED');
  }
}

async function readPublic(root, path, maxBytes = 8 * 1024 * 1024) {
  await checkedPath(root, path);
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxBytes || secretName(path.split('/').at(-1))) fail('STAGE_PUBLIC_FILE_REQUIRED');
  return readFile(path);
}

async function checkTree(root, path, allowed, prefix = '', allowGit = false) {
  await checkedPath(root, path);
  for (const item of await readdir(path, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + item.name : item.name;
    const child = join(path, item.name);
    if (item.isSymbolicLink()) fail('STAGE_SYMLINK_REJECTED');
    if (secretName(item.name)) fail('STAGE_SECRET_FILE_REJECTED');
    const gitMetadata = allowGit && (rel === '.git' || rel.startsWith('.git/'));
    if (!gitMetadata && !allowed.has(rel)) fail('STAGE_UNEXPECTED_FILE');
    if (item.isDirectory()) await checkTree(root, child, allowed, rel, allowGit);
    else if (!item.isFile() || (await lstat(child)).nlink !== 1) fail('STAGE_FILE_INVALID');
  }
}

function standaloneBuild(projectId, workerHash) {
  return `// Frozen compiled Worker. Local build only; no network, dependencies or secrets.\n` +
    `import {readFile,mkdir,writeFile,lstat,rename} from 'node:fs/promises';\n` +
    `import {createHash} from 'node:crypto';\n` +
    `import {fileURLToPath} from 'node:url';\n` +
    `import {join} from 'node:path';\n` +
    `const root=fileURLToPath(new URL('.',import.meta.url));\n` +
    `async function check(path,optional=false){try{const s=await lstat(path);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||(s.isFile()&&s.nlink!==1))throw new Error('BUILD_PATH_REJECTED');}catch(e){if(!(optional&&e.code==='ENOENT'))throw e;}}\n` +
    `for(const p of ['.openai','.openai/hosting.json','worker.mjs'])await check(join(root,p));\n` +
    `const hosting=JSON.parse(await readFile(join(root,'.openai/hosting.json'),'utf8'));\n` +
    `if(Object.keys(hosting).join(',')!=='project_id'||hosting.project_id!==${JSON.stringify(projectId)})throw new Error('BUILD_SITE_ID_MISMATCH');\n` +
    `const worker=await readFile(join(root,'worker.mjs'));\n` +
    `if(createHash('sha256').update(worker).digest('hex')!==${JSON.stringify(workerHash)})throw new Error('BUILD_WORKER_CHANGED');\n` +
    `for(const p of ['dist','dist/server','dist/server/index.js','dist/server/.index-stage'])await check(join(root,p),true);\n` +
    `await mkdir(join(root,'dist/server'),{recursive:true});\n` +
    `await writeFile(join(root,'dist/server/.index-stage'),worker,{flag:'wx',mode:0o600});\n` +
    `await rename(join(root,'dist/server/.index-stage'),join(root,'dist/server/index.js'));\n`;
}

// This prepares source and a local Workers build. It never uploads, deploys,
// configures server secrets, changes the audience or authorizes transactions.
export async function stageSites({ profilePath, root = projectRoot } = {}) {
  root = resolve(root);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail('STAGE_ROOT_REJECTED');
  if (typeof profilePath !== 'string' || !profilePath) fail('STAGE_PROFILE_REQUIRED');
  const profileFile = resolve(root, profilePath);
  const profileBytes = await readPublic(root, profileFile, 32768);
  const supplied = JSON.parse(profileBytes);
  const profile = supplied.enabled === false && isDeepStrictEqual(supplied, { enabled: false }) ? supplied : validateClientProfile(supplied);
  const registrationBytes = await readPublic(root, join(root, 'evidence/sites-registration-2026-10-08.json'), 65536);
  const registration = JSON.parse(registrationBytes);
  if (registration.status !== 'registered-private-unpublished' || registration.sites?.length !== 2) fail('STAGE_REGISTRATION_INVALID');
  const verification = JSON.parse(await readPublic(root, join(root, 'evidence/verification.json'), 256 * 1024));
  const expectedStages = ['build', 'tests', 'onboarding', 'http-boundaries', 'release-tests', 'sites-build'];
  const additionalStages = ['work-build', 'work-types', 'work-tests', 'work-release-tests', 'work-sites-build'];
  if (![6, 9, 11].includes(verification.stages?.length) || verification.stages.slice(6).some((stage, i) => stage.name !== additionalStages[i] || stage.passed !== true || stage.exitCode !== 0) || expectedStages.some((name, i) => verification.stages[i].name !== name || verification.stages[i].passed !== true || verification.stages[i].exitCode !== 0)) fail('STAGE_VERIFICATION_REQUIRED');
  const requiredSources = ['app.mjs', 'release/worker-entry.mjs', 'release/client-profile.mjs', 'scripts/build-sites.mjs', 'scripts/stage-sites.mjs'];
  if (requiredSources.some(path => !digest(verification.sourceHashes?.[path]))) fail('STAGE_SOURCE_HASHES_MISSING');
  for (const [path, expected] of Object.entries(verification.sourceHashes)) {
    if (!cleanPath(path) || !digest(expected) || hash(await readPublic(root, join(root, path))) !== expected) fail('STAGE_VERIFICATION_STALE');
  }
  const candidateBytes = await readPublic(root, join(root, 'artifacts/sites-candidate.json'), 65536);
  const candidate = JSON.parse(candidateBytes);
  const status = profile.enabled ? 'configured-local-only-unpublished' : 'disabled-unpublished-build';
  if (candidate.status !== status || !isDeepStrictEqual(candidate.profile, profile) || candidate.outputs?.length !== 2 || candidate.redisCredentialIncluded !== false || candidate.enrollmentTokenIncluded !== false) fail('STAGE_CANDIDATE_MISMATCH');
  const ids = new Set(), origins = new Set(), plans = [];
  const artifactFiles = new Set(['package.json', 'dist', 'dist/server', 'dist/server/index.js']);
  const checkoutFiles = new Set(['.openai', '.openai/hosting.json', '.gitignore', 'package.json', 'worker.mjs', 'build.mjs', 'staged.json', 'dist', 'dist/server', 'dist/server/index.js']);
  for (const role of roles) {
    const site = registration.sites.find(item => item.role === role);
    if (!site || !/^appgprj_[a-f0-9]{32}$/.test(site.id) || ids.has(site.id) || registration.localCheckouts?.[role] !== 'sites/' + role) fail('STAGE_REGISTRATION_INVALID');
    const origin = httpsOrigin(site.expected_url);
    if (origins.has(origin) || (profile.enabled && profile[role === 'primary' ? 'primaryOrigin' : 'recoveryOrigin'] !== origin)) fail('STAGE_PROFILE_ORIGIN_MISMATCH');
    ids.add(site.id); origins.add(origin);
    const output = candidate.outputs.find(item => item.role === role);
    const artifact = join(root, 'artifacts/sites-' + role), checkout = join(root, 'sites/' + role);
    if (!output || output.path !== artifact || !digest(output.workerSha256)) fail('STAGE_ARTIFACT_INVALID');
    await checkTree(root, artifact, artifactFiles);
    await checkTree(root, checkout, checkoutFiles, '', true);
    const hosting = await readPublic(root, join(checkout, '.openai/hosting.json'), 8192);
    if (!isDeepStrictEqual(JSON.parse(hosting), { project_id: site.id })) fail('STAGE_SITE_ID_MISMATCH');
    const worker = await readPublic(root, join(artifact, 'dist/server/index.js'));
    if (hash(worker) !== output.workerSha256) fail('STAGE_WORKER_CHANGED');
    const packageBytes = await readPublic(root, join(artifact, 'package.json'), 8192);
    if (!isDeepStrictEqual(JSON.parse(packageBytes), { private: true, type: 'module' })) fail('STAGE_ARTIFACT_PACKAGE_INVALID');
    const files = {
      'worker.mjs': worker,
      'build.mjs': Buffer.from(standaloneBuild(site.id, output.workerSha256)),
      'package.json': jsonBytes({ private: true, type: 'module', scripts: { build: 'node build.mjs' } }),
      'dist/server/index.js': worker,
    };
    const receipt = {
      format: 'account-reserve-sites-stage/v1', stagedAt: new Date().toISOString(),
      status: profile.enabled ? 'configured-local-only-unpublished' : 'disabled-local-only-unpublished',
      role, projectId: site.id, expectedOrigin: origin, enabled: profile.enabled,
      registrationSha256: hash(registrationBytes), candidateSha256: hash(candidateBytes), profileSha256: hash(profileBytes),
      hostingSha256: hash(hosting), workerSha256: output.workerSha256,
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])),
      deployed: false, sourceUploaded: false, serverSecretsConfigured: false, transactionsAuthorized: false,
    };
    plans.push({ checkout, hosting, files, receipt });
  }
  // Both identities, all source hashes and every file are checked before any
  // mutation. Individual writes are atomic; receipt is the last commit marker.
  for (const plan of plans) {
    if (!(await readFile(join(plan.checkout, '.openai/hosting.json'))).equals(plan.hosting)) fail('STAGE_SITE_ID_CHANGED');
    await unlink(join(plan.checkout, 'staged.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const [name, bytes] of Object.entries({ ...plan.files, 'staged.json': jsonBytes(plan.receipt) })) {
      const destination = join(plan.checkout, name);
      await checkedPath(root, destination, { missing: true });
      await mkdir(dirname(destination), { recursive: true });
      const temporary = join(dirname(destination), '.stage-' + randomUUID());
      try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, destination); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    if (!(await readFile(join(plan.checkout, '.openai/hosting.json'))).equals(plan.hosting)) fail('STAGE_SITE_ID_CHANGED');
  }
  return { status: 'staged-local-only-unpublished', sites: plans.map(plan => plan.receipt), deployed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) fail('USE_EXACT_PUBLIC_PROFILE_PATH');
  console.log(JSON.stringify(await stageSites({ profilePath: process.argv[2] })));
}
