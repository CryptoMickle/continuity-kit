// Synthetic credential proof in a fresh OS process, using installed public
// exports exclusively. Never import this fixture into a browser or hosted app.
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { createTextReserveCredential, prepareTextReserveReplicas, recoverTextReserveFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';

if (!process.send) throw new Error('IPC_TEST_ONLY');
process.once('message', async request => {
  let key, credentialId, handle;
  const outputs = [], stores = [], counts = { creates: 0, assertions: 0, reads: 0, writes: 0 };
  let stage = 'validate';
  try {
    const gateway = new URL(request.gateway), origin = new URL(request.config.recoveryOrigin);
    assert.equal(request.synthetic, true);
    assert.equal(gateway.protocol, 'http:'); assert.equal(gateway.hostname, '127.0.0.1'); assert.equal(gateway.pathname, '/');
    assert.ok(['prepare', 'recover', 'reject'].includes(request.mode));
    globalThis.location = { origin: origin.origin };
    key = Buffer.from(request.key, 'hex'); credentialId = Buffer.from(request.credentialId, 'hex');
    assert.equal(key.length, 32); assert.equal(credentialId.length, 24);
    const result = salt => { const value = { credentialId: new Uint8Array(credentialId), prfOutput: new Uint8Array(createHmac('sha256', key).update(salt).digest()) }; outputs.push(value); return value; };
    const webAuthnClient = {
      async createCredential(options) { counts.creates++; assert.equal(options.rp.id, origin.hostname); assert.equal(options.userVerification, 'required'); return { ...result(options.prfSalt), prfEnabled: true }; },
      async getCredential(options) { counts.assertions++; assert.equal(options.rpId, origin.hostname); assert.equal(options.userVerification, 'required'); if (options.allowCredential) assert.deepEqual(Buffer.from(options.allowCredential.credentialId), credentialId); return result(options.prfSalt); },
    };
    // Node's explicitly trusted transport routes the stable B API to a local
    // gateway process. This does not test native browser origin/CORS behavior.
    const fetcher = (path, init = {}) => {
      assert.ok(path.startsWith('/api/replicas/'));
      if (init.method === 'PUT') counts.writes++; else if (!init.method || init.method === 'GET') counts.reads++;
      return new Promise((resolve, reject) => {
        // node:http preserves the explicit virtual Host header; native Node
        // fetch may replace it with the loopback address. Bodies remain bounded.
        const request = httpRequest(new URL(path, gateway), { method: init.method ?? 'GET',
          headers: { ...init.headers, host: origin.host, origin: origin.origin }, signal: init.signal ?? AbortSignal.timeout(5000), agent: false }, response => {
          const chunks = []; let size = 0;
          response.on('data', chunk => { size += chunk.length; if (size > 87440) { response.destroy(); reject(new Error('RESPONSE_TOO_LARGE')); } else chunks.push(chunk); });
          response.on('error', reject);
          response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
            headers: { 'content-type': response.headers['content-type'] ?? 'application/json' } })));
        });
        request.on('error', reject); request.end(init.body);
      });
    };
    const replicas = [];
    for (const id of ['alpha', 'beta']) {
      let enrollmentToken;
      if (request.mode === 'prepare') {
        stage = 'admission-' + id;
        const admission = await fetcher('/api/replicas/' + id + '/enrollment/start', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + request.invitation }, body: '{}' });
        assert.equal(admission.status, 201);
        ({ enrollmentToken } = await admission.json());
      }
      const store = createReserveHttpStore({ basePath: '/api/replicas/' + id + '/reserve', fetcher, enrollmentToken, timeoutMs: 1500 });
      stores.push(store); replicas.push({ id, store });
    }
    let diagnostics, exported = false, rejection, exportBytes, exportDigest;
    if (request.mode === 'prepare') {
      stage = 'prepare';
      handle = await createTextReserveCredential({ config: request.config, webAuthnClient,
        user: { name: 'Synthetic replica drill', displayName: 'Synthetic replica drill' } });
      const prepared = await prepareTextReserveReplicas({ config: request.config, recoveryCredential: handle, text: request.text, replicas, webAuthnClient });
      assert.equal(prepared.status, 'ready'); assert.equal(prepared.independentlyVerified, true); assert.equal(prepared.text, request.text);
      assert.equal(prepared.replicas.filter(item => item.status === 'verified').length, 2);
      diagnostics = prepared.replicas;
      assert.equal(counts.creates, 1); assert.equal(counts.writes, 2);
    } else if (request.mode === 'recover') {
      stage = 'recover';
      assert.equal(Object.hasOwn(request, 'text'), false, 'fresh recovery process must receive no expected plaintext');
      const opened = await recoverTextReserveFromReplicas({ config: request.config, replicas, webAuthnClient });
      diagnostics = opened.replicas;
      assert.equal(counts.creates, 0); assert.equal(counts.assertions, 1); assert.equal(counts.writes, 0);
      stage = 'export';
      const bytes = Buffer.from(opened.reserve.text, 'utf8');
      await writeFile(request.exportPath, bytes, { flag: 'wx', mode: 0o600 }); exported = true;
      exportBytes = bytes.length; exportDigest = createHash('sha256').update(bytes).digest('hex'); bytes.fill(0);
    } else {
      stage = 'reject';
      assert.equal(Object.hasOwn(request, 'text'), false);
      await assert.rejects(recoverTextReserveFromReplicas({ config: request.config, replicas, webAuthnClient }), error => {
        rejection = error.code; diagnostics = error.replicas;
        return error.code === 'REPLICA_RECOVERY_FAILED';
      });
      assert.equal(counts.creates, 0); assert.equal(counts.assertions, 1); assert.equal(counts.writes, 0);
      assert.equal(diagnostics.filter(item => item.status === 'verified').length, 0);
    }
    assert.ok(outputs.every(value => value.prfOutput.every(byte => byte === 0)));
    process.send({ ok: true, mode: request.mode, ...counts, replicas: diagnostics, exported, rejection,
      ...(exported ? { exportBytes, exportDigest } : {}),
      prfOutputsZeroed: true });
  } catch (error) { process.send({ ok: false, error: 'REPLICA_DRILL_ASSERTION_FAILED', stage, ...(Number.isInteger(error.actual) ? { actualStatus: error.actual } : {}) }); }
  finally { handle?.close(); for (const store of stores) store.clearEnrollmentCapability(); key?.fill(0); credentialId?.fill(0); process.disconnect(); }
});
