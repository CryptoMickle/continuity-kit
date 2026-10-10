import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, unlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installedNativeFixture } from './native-installed-fixture.mjs';

// Test-only transport. It can contact exactly B's configured loopback port;
// fresh recovery cannot make a mutation or fall back to the original app.
function transport({ port, origin, readOnly = false, calls }) {
  return async (path, init = {}) => {
    const method = init.method ?? 'GET';
    const route = /^\/api\/replicas\/(alpha|beta)\/reserve\/[A-Za-z0-9_-]{43}$/.exec(path);
    assert.ok(route || path === '/continuity-config.json');
    assert.ok(method === 'GET' || !readOnly && method === 'PUT' && route);
    const headers = new Headers(init.headers);
    if (readOnly || method === 'GET') assert.equal(headers.has('authorization'), false);
    calls.push({ id: route?.[1] ?? 'configuration', method });
    const body = init.body === undefined ? undefined : Buffer.from(init.body);
    assert.ok(!body || body.length <= 87440);
    return new Promise((done, reject) => {
      let response, settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        response?.destroy(); req.destroy(); error ? reject(error) : done(value);
      };
      const req = request({ hostname: '127.0.0.1', port, path, method, agent: false,
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init.signal ? [init.signal] : [])]),
        headers: { host: new URL(origin).host, origin, connection: 'close',
          ...(body ? { 'content-type': 'application/json', 'content-length': body.length,
            authorization: headers.get('authorization') } : {}) } }, value => {
        response = value;
        const declared = value.headers['content-length'];
        if (value.headers['content-encoding'] || value.statusCode >= 300 && value.statusCode < 400
          || declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 87440)) return finish(Error('TEST_RESPONSE_INVALID'));
        const chunks = []; let size = 0;
        value.on('data', bytes => { if (settled) return; size += bytes.length; if (size > 87440) finish(Error('TEST_RESPONSE_INVALID')); else chunks.push(bytes); });
        value.once('end', () => { if (!settled) finish(undefined, new Response(Buffer.concat(chunks, size), {
          status: value.statusCode, headers: { 'content-type': value.headers['content-type'] ?? '' },
        })); });
        value.once('error', () => finish(Error('TEST_RESPONSE_UNAVAILABLE')));
        value.once('aborted', () => finish(Error('TEST_RESPONSE_UNAVAILABLE')));
        value.once('close', () => { if (!value.complete) finish(Error('TEST_RESPONSE_UNAVAILABLE')); });
      });
      req.once('error', () => finish(Error('TEST_TRANSPORT_UNAVAILABLE'))); req.end(body);
    });
  };
}

// These assertions are explicitly synthetic and live only in this test file.
// Native navigator credentials are trapped so a missing injection cannot prompt.
function synthetic({ key, credentialId, calls }) {
  const response = value => ({ credentialId: new Uint8Array(credentialId),
    prfOutput: new Uint8Array(createHmac('sha256', key).update(value.prfSalt).digest()) });
  return {
    async createCredential(value) { calls.create++; return { ...response(value), prfEnabled: true }; },
    async getCredential(value) { calls.get++; assert.equal(value.userVerification, 'required'); return response(value); },
  };
}

const recoverySource = `
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverTextReserveFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { restoreText, exportText } from './adapter.mjs';
import { validateNativeEnvironment, nativeConfig } from './profile.mjs';
const transport = ${transport.toString()};
const synthetic = ${synthetic.toString()};
if (!process.send) throw Error('TEST_IPC_REQUIRED');
process.once('message', async message => {
  let text = '', key; const requests = [], credentials = { create: 0, get: 0 }; let nativeCalls = 0, forbiddenNetwork = 0;
  const native = () => { nativeCalls++; throw Error('NATIVE_FORBIDDEN_IN_TEST'); };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { create: native, get: native } } });
  globalThis.fetch = () => { forbiddenNetwork++; throw Error('NETWORK_OUTSIDE_B_FORBIDDEN'); };
  try {
    assert.deepEqual(Object.keys(message).sort(), ['credentialId','key','origin','output','port']);
    key = Buffer.from(message.key, 'base64url');
    const credentialId = Buffer.from(message.credentialId, 'base64url');
    message.key = undefined; message.credentialId = undefined;
    const fetcher = transport({ port: message.port, origin: message.origin, readOnly: true, calls: requests });
    const response = await fetcher('/continuity-config.json'); assert.equal(response.status, 200);
    const env = validateNativeEnvironment(await response.json(), message.origin); assert.equal(env.role, 'recovery');
    globalThis.location = { origin: message.origin };
    const client = synthetic({ key, credentialId, calls: credentials });
    client.createCredential = () => { credentials.create++; throw Error('NEW_CREDENTIAL_FORBIDDEN'); };
    const result = await recoverTextReserveFromReplicas({ config: nativeConfig(env.profile),
      replicas: env.profile.replicas.map(({ id, basePath }) => ({ id, store: createReserveHttpStore({ basePath, fetcher }) })), webAuthnClient: client });
    const editor = { getText: () => text, applyText: value => { text = value; } };
    restoreText(result.reserve.text, editor);
    for (const format of ['txt','json']) await writeFile(join(message.output, 'original.' + format), exportText(editor, format), { flag: 'wx', mode: 0o600 });
    text += '\\nFinished with the surviving reserve.';
    for (const format of ['txt','json']) await writeFile(join(message.output, 'edited.' + format), exportText(editor, format), { flag: 'wx', mode: 0o600 });
    process.send({ ok: true, replicas: result.replicas, credentials, nativeCalls, forbiddenNetwork, requests });
  } catch (error) { process.send({ ok: false, code: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'FRESH_TEST_FAILED',
    replicas: error?.replicas, credentials, nativeCalls, forbiddenNetwork, requests }); }
  finally { text = ''; key?.fill(0); process.disconnect(); }
});
`;

async function freshRecovery(directory, message) {
  const child = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', recoverySource], {
    cwd: directory, execArgv: [], env: { PATH: process.env.PATH ?? '', LANG: 'C', TZ: 'UTC', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((done, reject) => {
    let result, expired = false, killTimer;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); }, 15000);
    child.on('message', value => { result = value; });
    child.once('error', () => { expired = true; });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (expired || code !== 0 || !result) reject(Error('FRESH_RECOVERY_PROCESS_FAILED')); else done(result);
    });
    child.send(message, error => { if (error) { expired = true; child.kill('SIGTERM'); } });
  });
}
async function freePorts(count) {
  const held = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }); held.push(server);
    }
    return held.map(server => server.address().port);
  } finally { await Promise.all(held.map(server => new Promise(done => server.close(done)))); }
}
function counts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { issued: db.prepare('SELECT issued FROM operator_meta WHERE id=1').get().issued,
    records: db.prepare('SELECT count(*) AS n FROM operator_records').get().n,
    used: db.prepare('SELECT sum(used) AS n FROM operator_capabilities').get().n }; }
  finally { db.close(); }
}
async function stopOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(Error('OWNED_CHILD_DID_NOT_EXIT')), 5000);
    child.once('close', () => { clearTimeout(timer); done(); }); child.kill('SIGKILL');
  });
}

test('installed managed B recovers and exports real SDK ciphertext after losing an owned store, without accessing A or upload grants', { timeout: 90000 }, async t => {
  const installed = await installedNativeFixture(); t.after(() => installed.close());
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-managed-recovery-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const load = file => import(pathToFileURL(join(installed.directory, file)));
  // A disposable test-only bridge exercises the installed public export map.
  // It is outside both frontend asset directories and is never served by B.
  await writeFile(join(installed.directory, 'managed-sdk-test.mjs'),
    "export * from '@continuitykit/account-reserve/text-reserve';\nexport { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';\n", { flag: 'wx', mode: 0o600 });
  const sdk = await load('managed-sdk-test.mjs'), { createReserveHttpStore } = sdk;
  const { buildNative } = await load('build.mjs'), { startNativeOperator } = await load('operate.mjs');
  const { initializeNativeOperator, readNativeOperatorState } = await load('operator-state.mjs');
  const { issueNativeGrants } = await load('operator.mjs');
  const [primary, recovery, gateway, alpha, beta] = await freePorts(5);
  const profile = { version: 1, appId: 'managed-sdk-recovery-test-v1', primaryOrigin: 'https://writer.native.test',
    recoveryOrigin: 'https://reserve.native.test', recoveryRpId: 'reserve.native.test', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    replicas: [{ id: 'alpha', basePath: '/api/replicas/alpha/reserve' }, { id: 'beta', basePath: '/api/replicas/beta/reserve' }] };
  const ports = { primary, recovery, gateway, replicas: [{ id: 'alpha', port: alpha }, { id: 'beta', port: beta }] };
  const config = { appId: profile.appId, recoveryOrigin: profile.recoveryOrigin, recoveryRpId: profile.recoveryRpId };
  const state = join(root, 'private'), out = join(root, 'dist'), children = [], key = randomBytes(32), credentialId = randomBytes(24);
  const sample = '\ufeffA fictional native-operator recovery drill.\r\nÆ, 界 and 🦊.\n';
  const originalFork = childProcess.fork, nativeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let app, credential, nativeCalls = 0;
  try {
    await buildNative({ profile, out }); initializeNativeOperator({ profile, state, ports });
    const bound = readNativeOperatorState({ profile, state });
    const workerPath = await realpath(join(installed.directory, 'operator-worker.mjs'));
    childProcess.fork = (...args) => { assert.equal(args[0], workerPath); const child = originalFork(...args); children.push(child); return child; };
    syncBuiltinESMExports();
    try { app = await startNativeOperator({ profile, state, out }); }
    finally { childProcess.fork = originalFork; syncBuiltinESMExports(); }
    assert.deepEqual(app.status(), { state: 'ready', unavailableReplicas: [] }); assert.equal(children.length, 2);
    const grantPath = join(state, 'grants.json');
    await issueNativeGrants({ profile, invitationsFile: bound.invitationsFile, output: grantPath });
    const grants = JSON.parse(await readFile(grantPath, 'utf8')), calls = [], credentials = { create: 0, get: 0 };
    const native = () => { nativeCalls++; throw Error('NATIVE_FORBIDDEN_IN_TEST'); };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { create: native, get: native } } });
    const fetcher = transport({ port: recovery, origin: profile.recoveryOrigin, calls });
    const webAuthnClient = synthetic({ key, credentialId, calls: credentials });
    credential = await sdk.createTextReserveCredential({ config, user: { name: 'Fictional drill', displayName: 'Test-only synthetic credential' }, webAuthnClient });
    const replicas = profile.replicas.map(({ id, basePath }, index) => ({ id, store: createReserveHttpStore({ basePath, fetcher, enrollmentToken: grants.replicas[index].enrollmentToken }) }));
    const ready = await sdk.prepareTextReserveReplicas({ config, replicas, recoveryCredential: credential, text: sample, webAuthnClient });
    assert.equal(ready.text, sample); assert.equal(ready.independentlyVerified, true);
    assert.deepEqual(ready.replicas, profile.replicas.map(({ id }) => ({ id, stage: 'verify', status: 'verified' })));
    assert.deepEqual(credentials, { create: 1, get: 1 }); assert.equal(nativeCalls, 0);
    for (const { store } of replicas) store.clearEnrollmentCapability();
    credential.close(); credential = undefined;
    for (const grant of grants.replicas) grant.enrollmentToken = undefined;
    await unlink(grantPath);
    const before = await Promise.all(bound.databasePaths.map(item => readFile(item.database)));
    for (const item of bound.databasePaths) assert.deepEqual(counts(item.database), { issued: 1, records: 1, used: 1 });

    await stopOwned(children[0]);
    assert.deepEqual(app.status(), { state: 'degraded', unavailableReplicas: ['alpha'] });
    assert.equal(children[1].exitCode, null); assert.equal(children[1].signalCode, null);
    await access(join(state, 'runtime.lock')); assert.equal(children.length, 2);
    const exported = join(root, 'survivor-export'); await mkdir(exported, { mode: 0o700 });
    const result = await freshRecovery(installed.directory, { origin: profile.recoveryOrigin, port: recovery,
      key: key.toString('base64url'), credentialId: credentialId.toString('base64url'), output: exported });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.replicas.map(item => [item.id, item.status]), [['alpha', 'unavailable'], ['beta', 'verified']]);
    assert.deepEqual(result.credentials, { create: 0, get: 1 }); assert.equal(result.nativeCalls, 0); assert.equal(result.forbiddenNetwork, 0);
    assert.ok(result.requests.every(item => item.method === 'GET')); assert.deepEqual(result.requests.map(item => item.id).sort(), ['alpha', 'beta', 'configuration']);
    assert.equal(await readFile(join(exported, 'original.txt'), 'utf8'), sample);
    assert.deepEqual(JSON.parse(await readFile(join(exported, 'original.json'), 'utf8')), { format: 'continuity-text-export/v1', text: sample });
    const edited = sample + '\nFinished with the surviving reserve.';
    assert.equal(await readFile(join(exported, 'edited.txt'), 'utf8'), edited);
    assert.equal(JSON.parse(await readFile(join(exported, 'edited.json'), 'utf8')).text, edited);

    await stopOwned(children[1]);
    assert.deepEqual(app.status(), { state: 'unavailable', unavailableReplicas: ['alpha', 'beta'] });
    const empty = join(root, 'unavailable-export'); await mkdir(empty, { mode: 0o700 });
    const unavailable = await freshRecovery(installed.directory, { origin: profile.recoveryOrigin, port: recovery,
      key: key.toString('base64url'), credentialId: credentialId.toString('base64url'), output: empty });
    assert.equal(unavailable.ok, false); assert.equal(unavailable.code, 'REPLICA_RECOVERY_FAILED');
    assert.ok(unavailable.replicas.every(item => item.status === 'unavailable'));
    assert.deepEqual(unavailable.credentials, { create: 0, get: 1 }); assert.equal(unavailable.nativeCalls, 0); assert.equal(unavailable.forbiddenNetwork, 0);
    assert.deepEqual(await readdir(empty), []); assert.ok(unavailable.requests.every(item => item.method === 'GET'));
    for (const [index, item] of bound.databasePaths.entries()) {
      assert.deepEqual(await readFile(item.database), before[index]); assert.deepEqual(counts(item.database), { issued: 1, records: 1, used: 1 });
    }
    assert.equal(children.length, 2); await app.close(); assert.equal(await app.failure, undefined);
    await assert.rejects(access(join(state, 'runtime.lock')), { code: 'ENOENT' });
  } finally {
    childProcess.fork = originalFork; syncBuiltinESMExports(); credential?.close(); key.fill(0); credentialId.fill(0);
    if (nativeDescriptor) Object.defineProperty(globalThis, 'navigator', nativeDescriptor); else delete globalThis.navigator;
    await app?.close(); await Promise.all(children.map(stopOwned));
    await rm(root, { recursive: true, force: true }); await installed.close();
  }
});
