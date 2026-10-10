import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTextStarter } from '../scripts/create-text-starter.mjs';

const require = createRequire(new URL('../integrations/multi-app/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const tick = () => new Promise(done => setImmediate(done));
function run(args, cwd) {
  return new Promise((done, reject) => {
    const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH, NODE_PATH: '', npm_config_offline: 'true', npm_config_update_notifier: 'false', ...(process.env.SDK_TEST_NPM_CACHE ? { npm_config_cache: process.env.SDK_TEST_NPM_CACHE } : {}) };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', expired = false, force;
    const timer = setTimeout(() => { expired = true; child.kill(); force = setTimeout(() => child.kill('SIGKILL'), 2000); }, 90000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { if (output.length < 100000) output += value; });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); clearTimeout(force); code === 0 && !expired ? done(output) : reject(Error('CONSUMER_CHECK_FAILED: ' + output)); });
  });
}
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const encode = value => new TextEncoder().encode(JSON.stringify(sorted(value)));
const digest = bytes => new Uint8Array(createHash('sha256').update(bytes).digest());
const unb64 = text => new Uint8Array(Buffer.from(text, 'base64url'));
const b64 = bytes => Buffer.from(bytes).toString('base64url');

// A test-only, authentic re-encryption of the same manifest with a fresh nonce.
// Equal plaintext must still conflict under the immutable v1 record policy.
async function rebox({ config, locator, record, client, protocol }) {
  const output = await client.getCredential({ rpId: config.recoveryRpId, prfSalt: digest(Buffer.from(protocol + '/prf')), userVerification: 'required' });
  let manifest;
  try {
    const credentialId = b64(output.credentialId), material = await crypto.subtle.importKey('raw', output.prfOutput, 'HKDF', false, ['deriveKey']); output.prfOutput.fill(0);
    const salt = digest(encode({ format: protocol + '/hkdf', config, credentialId }));
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(protocol + '/manifest-aes-gcm') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const value = JSON.parse(Buffer.from(record).toString('utf8')), aad = encode({ format: protocol + '/index', config, locator, credentialId });
    manifest = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(value.nonce), additionalData: aad }, key, unb64(value.ciphertext)));
    const nonce = randomBytes(12); return encode({ format: value.format, nonce: b64(nonce), ciphertext: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, manifest)) });
  } finally { output.prfOutput.fill(0); output.credentialId.fill(0); manifest?.fill(0); }
}

test('installed collection UI authenticates two apps through B after actual A503 and storage loss, with isolated failures and exact exports', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'text-collection-browser-package-')), bootstrap = join(directory, 'bootstrap'), target = join(directory, 'consumer');
  let app; const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(async () => { await app?.close(); if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete globalThis.location; await rm(directory, { recursive: true, force: true }); });
  await createTextStarter(bootstrap);
  await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], bootstrap);
  const generator = join(bootstrap, 'node_modules/@continuitykit/account-reserve/scripts/create-text-starter.mjs');
  const generated = JSON.parse(await run([generator, target, '--collection-replicas'], bootstrap)); assert.equal(generated.collectionReplicas, true);
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.test, 'node collection-smoke.mjs'); assert.equal(manifest.scripts.dev, 'node collection-server.mjs'); assert.match(manifest.scripts.doctor, /--collection-replicas/);
  assert.deepEqual(Object.keys(manifest.dependencies), ['@continuitykit/account-reserve']);
  for (const name of ['host', 'profile', 'replica-gateway', 'store']) assert.deepEqual(await readFile(join(target, 'operator-runtime', name + '.mjs')), await readFile(join(root, 'operator', name + '.mjs')));
  for (const name of ['main.mjs', 'adapter.mjs', 'collection-config.mjs', 'synthetic-client.mjs']) {
    const source = await readFile(join(target, name), 'utf8'); assert.doesNotMatch(source, /from\s+['"](?:\.\.\/|\/Users\/|file:)/); assert.doesNotMatch(source, /node_modules\//);
  }
  await run([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], target);
  await run([npmCli, 'run', 'build'], target);
  const { prepareCollectionExamples, collectionDatabaseSnapshot, unusedPort, COLLECTION_SAMPLES } = await import(pathToFileURL(join(target, 'collection-smoke.mjs')));
  const doctorA = await unusedPort(); let doctorB = await unusedPort(); while (doctorB === doctorA) doctorB = await unusedPort();
  await run([npmCli, 'run', 'doctor', '--', '--primary-port=' + doctorA, '--recovery-port=' + doctorB], target);
  const smoke = JSON.parse((await run([npmCli, 'test'], target)).trim().split('\n').at(-1));
  assert.equal(smoke.ok, true); assert.equal(smoke.primaryHttp503, true); assert.equal(smoke.freshRecoveryProcesses, 4); assert.equal(smoke.sdkAssertionsPerCollection, 1); assert.equal(smoke.noRecoveryWrites, true); assert.equal(smoke.corruptedAppIsolated, true);
  const { mountCollection } = await import(pathToFileURL(join(target, 'main.mjs')));
  const { startCollectionStarter } = await import(pathToFileURL(join(target, 'collection-server.mjs')));
  const { loopbackFetch } = await import(pathToFileURL(join(target, 'loopback-fetch.mjs')));
  const { syntheticClient } = await import(pathToFileURL(join(target, 'synthetic-client.mjs')));
  await writeFile(join(target, 'test-sdk-bridge.mjs'), "export {recoverTextReservesFromReplicas,TEXT_PROTOCOL} from '@continuitykit/account-reserve/text-reserve';\n", { flag: 'wx' });
  const sdk = await import(pathToFileURL(join(target, 'test-sdk-bridge.mjs')));
  const primaryPort = await unusedPort(); let recoveryPort = await unusedPort(); while (recoveryPort === primaryPort) recoveryPort = await unusedPort();
  app = await startCollectionStarter({ primaryPort, recoveryPort });
  const a = loopbackFetch(app.originalOrigin), b = loopbackFetch(app.recoveryOrigin);
  assert.equal((await a('/')).status, 200); assert.equal((await a('/api/config')).status, 200);
  globalThis.location = { origin: app.recoveryOrigin };
  const prepared = await prepareCollectionExamples(app), environment = prepared.environment;
  const local = app.inspect(), original = local.replicas.map(item => collectionDatabaseSnapshot(item.database)); assert.deepEqual(original[0], original[1]);
  const post = async (path, body) => { const response = await b(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok, 'control must succeed'); return response.json(); };
  const control = (id, action) => post('/api/replica-control', { id, action });
  await post('/api/primary', { online: false }); assert.equal((await a('/')).status, 503); assert.equal((await a('/api/config')).status, 503);
  const cases = [];
  async function openView(name, expected, { edit = false } = {}) {
    const baseline = local.replicas.map(item => collectionDatabaseSnapshot(item.database)), bytes = await Promise.all(local.replicas.map(item => readFile(item.database)));
    const response = await b('/'); assert.equal(response.status, 200);
    const dom = new JSDOM(await response.text(), { url: app.recoveryOrigin, runScripts: 'outside-only' }), { window } = dom;
    const $ = id => window.document.getElementById(id), blobs = [], urls = new Set(), calls = [], pending = [], outputs = []; let assertions = 0, nativeCalls = 0, persistence = 0, instance;
    window.AbortController = AbortController; window.AbortSignal = AbortSignal; window.Blob = Blob;
    window.URL.createObjectURL = blob => { blobs.push(blob); const url = 'blob:installed-' + blobs.length; urls.add(url); return url; }; window.URL.revokeObjectURL = url => urls.delete(url); window.HTMLAnchorElement.prototype.click = () => {};
    window.Storage.prototype.setItem = () => { persistence++; throw Error('PERSISTENCE_FORBIDDEN'); };
    Object.defineProperty(window.navigator, 'credentials', { value: { create() { nativeCalls++; throw Error('NATIVE_FORBIDDEN'); }, get() { nativeCalls++; throw Error('NATIVE_FORBIDDEN'); } } });
    const fetcher = async (path, options = {}) => {
      const method = options.method ?? 'GET';
      assert.ok(path === '/api/status' && method === 'GET' || path === '/api/synthetic' && method === 'POST' || /^\/api\/replicas\/(alpha|beta)\/reserve\/[A-Za-z0-9_-]{43}$/.test(path) && method === 'GET');
      if (path.includes('/reserve/')) assert.equal(new Headers(options.headers).has('authorization'), false);
      calls.push({ path, method }); return b(path, options);
    };
    const client = syntheticClient(fetcher), webAuthnClient = { createCredential() { throw Error('CREATION_FORBIDDEN'); }, async getCredential(input) { assertions++; const output = await client.getCredential(input); outputs.push(output); return output; } };
    try {
      instance = mountCollection(window.document, window, { environment: await (await b('/api/config')).json(), fetcher, webAuthnClient,
        recover(options) { const value = sdk.recoverTextReservesFromReplicas(options); pending.push(value); return value; } });
      await instance.ready; assert.equal(assertions, 0); assert.equal(pending.length, 0);
      $('recover').click(); assert.equal(assertions, 1); assert.equal(pending.length, 1);
      const result = await pending[0]; await tick(); assert.deepEqual(result.map(item => item.status), expected);
      for (const [index, status] of expected.entries()) {
        const id = environment.apps[index].id; assert.equal($('card-' + id).dataset.state, status);
        if (status === 'recovered') {
          assert.equal($('draft-' + id).value, COLLECTION_SAMPLES[index].replaceAll('\r\n', '\n'));
          $('export-' + id + '-txt').click(); assert.deepEqual(Buffer.from(await blobs.at(-1).arrayBuffer()), Buffer.from(COLLECTION_SAMPLES[index]));
          $('export-' + id + '-json').click(); assert.deepEqual(JSON.parse(await blobs.at(-1).text()), { format: 'continuity-text-export/v1', text: COLLECTION_SAMPLES[index] });
          if (edit) { $('draft-' + id).value += '\nFinished in B.'; const edited = $('draft-' + id).value; $('export-' + id + '-txt').click(); assert.deepEqual(Buffer.from(await blobs.at(-1).arrayBuffer()), Buffer.from(edited)); }
        } else {
          assert.equal($('draft-' + id).value, ''); const before = blobs.length;
          for (const format of ['txt', 'json']) { assert.equal($('export-' + id + '-' + format).hidden, true); $('export-' + id + '-' + format).dispatchEvent(new window.Event('click')); }
          assert.equal(blobs.length, before);
        }
      }
      assert.equal(assertions, 1); assert.equal(nativeCalls, 0); assert.equal(persistence, 0); assert.equal(calls.filter(item => item.path.includes('/reserve/')).length, 4);
      assert.ok(outputs.every(output => output.prfOutput.every(byte => byte === 0)));
      instance.dispose(); assert.equal(urls.size, 0); for (const { id } of environment.apps) assert.equal($('draft-' + id).value, '');
      for (const [index, replica] of local.replicas.entries()) { assert.deepEqual(await readFile(replica.database), bytes[index]); assert.deepEqual(collectionDatabaseSnapshot(replica.database), baseline[index]); }
      const report = { name, statuses: result.map(item => item.status), ...(result[0].code ? { firstCode: result[0].code } : {}), oneAssertion: true, exactExports: true, noRecoveryWrites: true }; cases.push(report); return result;
    } finally { instance?.dispose(); window.close(); }
  }
  await openView('both-stores', ['recovered', 'recovered']);
  const alphaPid = local.replicas[0].pid; await control('alpha', 'stop'); assert.throws(() => process.kill(alphaPid, 0), { code: 'ESRCH' });
  await openView('A503-and-alpha-stopped', ['recovered', 'recovered'], { edit: true });
  async function resetRecords(change) {
    for (const state of app.inspect().replicas) if (state.running) await control(state.id, 'stop');
    for (const [index, replica] of local.replicas.entries()) {
      const records = original[index].records.map(item => ({ locator: item.locator, bytes: Buffer.from(item.bytes) })); change?.(records, index);
      const db = new DatabaseSync(replica.database); try { db.exec('BEGIN'); db.exec('DELETE FROM operator_records'); for (const row of records) db.prepare('INSERT INTO operator_records VALUES(?,?)').run(row.locator, row.bytes); db.exec('COMMIT'); } finally { db.close(); }
    }
    for (const replica of local.replicas) await control(replica.id, 'start');
  }
  const locator = prepared.ready[0].locator;
  await resetRecords(records => { const row = records.find(item => item.locator === locator), value = JSON.parse(row.bytes), bytes = Buffer.from(value.ciphertext, 'base64url'); bytes[0] ^= 1; value.ciphertext = bytes.toString('base64url'); row.bytes = Buffer.from(JSON.stringify(value)); });
  await openView('one-app-corrupt', ['rejected', 'recovered']);
  await resetRecords(records => { records.splice(records.findIndex(item => item.locator === locator), 1); });
  await openView('one-app-missing', ['missing', 'recovered']);
  const alternate = await rebox({ config: environment.apps[0].config, locator, record: original[0].records.find(item => item.locator === locator).bytes, client: syntheticClient(b), protocol: sdk.TEXT_PROTOCOL });
  await resetRecords((records, index) => { if (!index) records.find(item => item.locator === locator).bytes = Buffer.from(alternate); }); alternate.fill(0);
  const conflict = await openView('equal-plaintext-different-valid-records', ['rejected', 'recovered']); assert.equal(conflict[0].code, 'REPLICA_CONFLICT'); assert.ok(conflict[0].replicas.every(item => item.status === 'verified'));
  for (const replica of local.replicas) await control(replica.id, 'stop'); await openView('both-stores-unavailable', ['unavailable', 'unavailable']);
  assert.equal((await a('/')).status, 503);
  const dbDirectory = local.directory; await app.close(); app = undefined; await assert.rejects(readdir(dbDirectory), { code: 'ENOENT' });
  console.log(JSON.stringify({ installedCollectionBrowser: true, offlineInstallBuildDoctor: true, generatedSmoke: { freshRecoveryProcesses: smoke.freshRecoveryProcesses, primaryHttp503: smoke.primaryHttp503, oneAssertion: true },
    freshUiMounts: cases.length, realAHttp503: true, terminatedStoreProcess: true, authenticatedCollection: true, exactPerAppExports: true, corruptMissingAndConflictIsolation: true, noRecoveryWrites: true,
    physicalPasskeyProof: false, browserEngineProof: false, independentProviders: false, productionServer: false, cases }));
});
