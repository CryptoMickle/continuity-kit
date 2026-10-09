import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stageSites } from '../scripts/stage-sites.mjs';
import { APPROVED_TESTNET_RPCS, validateClientProfile } from '../release/client-profile.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const roles = ['primary', 'recovery'];
const worker = "export default {fetch(){return new Response('disabled',{status:503})}};\n";

async function fixture(t, { enabled = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reserve-sites-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), typeof value === 'string' ? value : json(value)); };
  const sites = roles.map((role, i) => ({ role, id: 'appgprj_' + String(i + 1).repeat(32), expected_url: 'https://' + role + '.example.com' }));
  const registration = { status: 'registered-private-unpublished', sites, localCheckouts: { primary: 'sites/primary', recovery: 'sites/recovery' } };
  const profile = enabled ? validateClientProfile({
    format: 'account-reserve-public/v1', enabled: true, chainId: 10143,
    contractAddress: '0x1000000000000000000000000000000000000001', issuer: '0x2000000000000000000000000000000000000002', expectedRuntimeCodeHash: '0x' + 'ab'.repeat(32),
    primaryOrigin: sites[0].expected_url, recoveryOrigin: sites[1].expected_url,
    namespace: 'account-reserve-' + 'ac'.repeat(16), expiresAt: new Date(Date.now() + 86400000).toISOString(), physicalPasskeysVerified: false,
    rpcUrls: [...APPROVED_TESTNET_RPCS], claim: { rightId: '1', gasLimit: '300000', maxFeePerGasWei: '200000000000', maxPriorityFeePerGasWei: '2000000000', valueWei: '0' },
  }) : { enabled: false };
  const candidate = { status: enabled ? 'configured-local-only-unpublished' : 'disabled-unpublished-build', profile, redisCredentialIncluded: false, enrollmentTokenIncluded: false,
    outputs: roles.map(role => ({ role, path: join(root, 'artifacts/sites-' + role), workerSha256: sha(worker) })) };
  const sources = ['app.mjs', 'release/worker-entry.mjs', 'release/client-profile.mjs', 'scripts/build-sites.mjs', 'scripts/stage-sites.mjs'];
  const verification = { stages: ['build', 'tests', 'onboarding', 'http-boundaries', 'release-tests', 'sites-build'].map(name => ({ name, passed: true, exitCode: 0 })), sourceHashes: {} };
  for (const path of sources) { const content = '// Synthetic source fixture: ' + path; await put(path, content); verification.sourceHashes[path] = sha(content); }
  await put('evidence/sites-registration-2026-10-08.json', registration);
  await put('evidence/verification.json', verification);
  await put('artifacts/sites-candidate.json', candidate);
  await put('release/profile.json', profile);
  for (const site of sites) {
    await put('artifacts/sites-' + site.role + '/dist/server/index.js', worker);
    await put('artifacts/sites-' + site.role + '/package.json', { private: true, type: 'module' });
    await put('sites/' + site.role + '/.openai/hosting.json', '{ "project_id" : "' + site.id + '" }\n');
    await put('sites/' + site.role + '/package.json', { private: true, type: 'module' });
    await put('sites/' + site.role + '/worker.mjs', '// Previous preserved fixture');
  }
  const stage = () => stageSites({ root, profilePath: 'release/profile.json' });
  const unchanged = async () => {
    for (const role of roles) assert.equal(await readFile(join(root, 'sites/' + role + '/worker.mjs'), 'utf8'), '// Previous preserved fixture');
  };
  return { root, put, profile, registration, verification, candidate, stage, unchanged };
}

test('stages disabled Workers locally, preserves manifest bytes, and standalone builds reproduce frozen bytes', async t => {
  const f = await fixture(t);
  const hosting = await Promise.all(roles.map(role => readFile(join(f.root, 'sites/' + role + '/.openai/hosting.json'))));
  const result = await f.stage();
  assert.equal(result.deployed, false);
  for (const [index, role] of roles.entries()) {
    const checkout = join(f.root, 'sites/' + role);
    assert.deepEqual(await readFile(join(checkout, '.openai/hosting.json')), hosting[index]);
    const record = JSON.parse(await readFile(join(checkout, 'staged.json')));
    assert.equal(record.enabled, false); assert.equal(record.transactionsAuthorized, false); assert.equal(record.serverSecretsConfigured, false);
    assert.equal(record.status, 'disabled-local-only-unpublished');
    assert.equal(sha(await readFile(join(checkout, 'worker.mjs'))), record.workerSha256);
    await rm(join(checkout, 'dist'), { recursive: true });
    const build = spawnSync(process.execPath, ['build.mjs'], { cwd: checkout, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    assert.equal(await readFile(join(checkout, 'dist/server/index.js'), 'utf8'), worker);
  }
  // Restaging remains local and does not alter either identity.
  assert.equal((await f.stage()).sites.length, 2);
});

test('enabled candidate requires the exact public profile and both registered origins', async t => {
  const f = await fixture(t, { enabled: true });
  assert.equal((await f.stage()).sites[0].enabled, true);
  const g = await fixture(t, { enabled: true });
  g.registration.sites[1].expected_url = 'https://wrong-reserve.example.com';
  await g.put('evidence/sites-registration-2026-10-08.json', g.registration);
  await assert.rejects(g.stage(), /STAGE_PROFILE_ORIGIN_MISMATCH/); await g.unchanged();
});

test('a mismatched second Site identity rejects the whole stage before changing primary', async t => {
  const f = await fixture(t);
  await f.put('sites/recovery/.openai/hosting.json', { project_id: 'appgprj_' + '9'.repeat(32) });
  await assert.rejects(f.stage(), /STAGE_SITE_ID_MISMATCH/); await f.unchanged();
});

test('missing or changed worker hashes fail before any checkout write', async t => {
  const f = await fixture(t);
  await f.put('artifacts/sites-recovery/dist/server/index.js', worker + '// stale bytes');
  await assert.rejects(f.stage(), /STAGE_WORKER_CHANGED/); await f.unchanged();
  const g = await fixture(t); delete g.candidate.outputs[1].workerSha256;
  await g.put('artifacts/sites-candidate.json', g.candidate);
  await assert.rejects(g.stage(), /STAGE_ARTIFACT_INVALID/); await g.unchanged();
});

test('changed source or incomplete verification is refused', async t => {
  const f = await fixture(t); await f.put('app.mjs', '// changed after verification');
  await assert.rejects(f.stage(), /STAGE_VERIFICATION_STALE/); await f.unchanged();
  const g = await fixture(t); g.verification.stages[4].passed = false;
  await g.put('evidence/verification.json', g.verification);
  await assert.rejects(g.stage(), /STAGE_VERIFICATION_REQUIRED/); await g.unchanged();
});

test('a different reviewed profile cannot reuse an older compiled candidate', async t => {
  const f = await fixture(t, { enabled: true });
  await f.put('release/profile.json', { ...f.profile, namespace: 'account-reserve-' + 'df'.repeat(16) });
  await assert.rejects(f.stage(), /STAGE_CANDIDATE_MISMATCH/); await f.unchanged();
});

test('secret-named files in artifact or checkout are rejected without copying or reading them', async t => {
  for (const path of ['artifacts/sites-recovery/.env.local', 'sites/primary/operator.secrets.json', 'sites/recovery/.dev.vars']) {
    const f = await fixture(t); await f.put(path, 'SYNTHETIC-SECRET-NOT-TO-READ');
    await assert.rejects(f.stage(), /STAGE_SECRET_FILE_REJECTED/); await f.unchanged();
  }
});

test('symlinks and hardlinks cannot supply workers or redirect a hosting directory', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'artifacts/sites-recovery/dist/server/index.js'));
  await symlink(join(f.root, 'artifacts/sites-primary/dist/server/index.js'), join(f.root, 'artifacts/sites-recovery/dist/server/index.js'));
  await assert.rejects(f.stage(), /STAGE_SYMLINK_REJECTED/); await f.unchanged();
  const g = await fixture(t);
  await rm(join(g.root, 'sites/recovery/.openai'), { recursive: true });
  await symlink(join(g.root, 'sites/primary/.openai'), join(g.root, 'sites/recovery/.openai'));
  await assert.rejects(g.stage(), /STAGE_SYMLINK_REJECTED/); await g.unchanged();
  const h = await fixture(t);
  await rm(join(h.root, 'artifacts/sites-recovery/dist/server/index.js'));
  await link(join(h.root, 'artifacts/sites-primary/dist/server/index.js'), join(h.root, 'artifacts/sites-recovery/dist/server/index.js'));
  await assert.rejects(h.stage(), /STAGE_FILE_INVALID/); await h.unchanged();
});

test('unexpected files and profiles outside the project cannot enter a staged source', async t => {
  const f = await fixture(t); await f.put('sites/recovery/accidental.txt', 'unreviewed');
  await assert.rejects(f.stage(), /STAGE_UNEXPECTED_FILE/); await f.unchanged();
  await assert.rejects(stageSites({ root: f.root, profilePath: '../outside-profile.json' }), /STAGE_PATH_REJECTED/);
});

test('standalone build rejects changed worker, changed identity and output symlinks', async t => {
  for (const change of ['worker', 'identity', 'symlink']) {
    const f = await fixture(t); await f.stage();
    const checkout = join(f.root, 'sites/primary');
    if (change === 'worker') await f.put('sites/primary/worker.mjs', worker + '// changed');
    if (change === 'identity') await f.put('sites/primary/.openai/hosting.json', { project_id: f.registration.sites[1].id });
    if (change === 'symlink') { await rm(join(checkout, 'dist'), { recursive: true }); await symlink(join(f.root, 'artifacts/sites-primary/dist'), join(checkout, 'dist')); }
    const build = spawnSync(process.execPath, ['build.mjs'], { cwd: checkout, encoding: 'utf8' });
    assert.notEqual(build.status, 0);
    assert.match(build.stderr, /BUILD_(?:WORKER_CHANGED|SITE_ID_MISMATCH|PATH_REJECTED)/);
  }
});

test('legacy Site staging accepts complete added work verification but rejects failed or unknown extensions', async t => {
  for (const count of [3, 5]) {
    const f = await fixture(t);
    f.verification.stages.push(...['work-build', 'work-types', 'work-tests', 'work-release-tests', 'work-sites-build'].slice(0, count).map(name => ({ name, passed: true, exitCode: 0 })));
    await f.put('evidence/verification.json', f.verification);
    assert.equal((await f.stage()).deployed, false);
  }
  for (const change of [stage => { stage.passed = false; }, stage => { stage.name = 'unreviewed'; }]) {
    const f = await fixture(t);
    const extra = ['work-build', 'work-types', 'work-tests'].map(name => ({ name, passed: true, exitCode: 0 }));
    change(extra[2]); f.verification.stages.push(...extra);
    await f.put('evidence/verification.json', f.verification);
    await assert.rejects(f.stage(), /STAGE_VERIFICATION_REQUIRED/); await f.unchanged();
  }
});
