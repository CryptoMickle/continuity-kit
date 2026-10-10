// SYNTHETIC TEST ONLY. Never imported by the host or browser assets. The parent
// injects a fake authenticator over IPC; no test credential enters the transfer.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTextReserveCredential, selectTextReserveCredential, prepareTextReserve, recoverTextReserve } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';

if (!process.send) throw Error('IPC_TEST_ONLY');
process.once('message', async request => {
  try {
    const url = new URL(request.profile.recoveryOrigin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || request.synthetic !== true) throw Error('LOOPBACK_TEST_ONLY');
    globalThis.location = { origin: url.origin };
    const key = Buffer.from(request.key, 'hex'), id = Buffer.from(request.credentialId, 'hex');
    let creates = 0, assertions = 0, reads = 0, writes = 0;
    const result = salt => ({ credentialId: new Uint8Array(id), prfOutput: new Uint8Array(createHmac('sha256', key).update(salt).digest()) });
    const client = {
      async createCredential(options) { assert.equal(options.rp.id, url.hostname); creates++; return { ...result(options.prfSalt), prfEnabled: true }; },
      async getCredential(options) { assert.equal(options.rpId, url.hostname); assertions++; if (options.allowCredential) assert.deepEqual(Buffer.from(options.allowCredential.credentialId), id); return result(options.prfSalt); },
    };
    const fetcher = (path, options = {}) => {
      if (options.method === 'PUT') writes++; else reads++;
      return fetch(new URL(path, url), { ...options, headers: { ...options.headers, origin: url.origin } });
    };
    const configs = request.profile.apps.map(app => ({ appId: app.appId, recoveryOrigin: url.origin, recoveryRpId: url.hostname }));
    if (request.mode === 'prepare') {
      for (const [index, config] of configs.entries()) {
        const response = await fetch(new URL('/api/enrollment/start', url), { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', authorization: 'Bearer ' + request.invitation }, body: '{}' });
        assert.equal(response.status, 201); const { enrollmentToken } = await response.json();
        const options = { config, webAuthnClient: client };
        const handle = index === 0 ? await createTextReserveCredential({ ...options, user: { name: 'Synthetic portability test', displayName: 'Synthetic portability test' } }) : await selectTextReserveCredential(options);
        const ready = await prepareTextReserve({ ...options, recoveryCredential: handle, text: request.texts[index], store: createReserveHttpStore({ enrollmentToken, fetcher }) });
        assert.equal(ready.text, request.texts[index]); assert.equal(ready.independentlyVerified, true);
      }
      assert.equal(creates, 1); assert.equal(writes, configs.length);
    } else if (request.mode === 'recover') {
      for (const [index, config] of configs.entries()) {
        const recovered = await recoverTextReserve({ config, webAuthnClient: client, store: createReserveHttpStore({ fetcher }) });
        assert.equal(recovered.text, request.texts[index]);
      }
      assert.equal(creates, 0); assert.equal(writes, 0);
    } else if (request.mode === 'wrong-origin') {
      const other = { ...configs[0], recoveryOrigin: 'http://localhost:' + url.port, recoveryRpId: 'localhost' };
      await assert.rejects(recoverTextReserve({ config: other, webAuthnClient: client, store: createReserveHttpStore({ fetcher }) }), error => error?.code === 'RECOVERY_ORIGIN_MISMATCH');
      assert.equal(assertions, 0); assert.equal(reads, 0);
    } else if (request.mode === 'tampered-either') {
      let rejected = 0, unmodifiedRecovered = 0;
      for (const [index, config] of configs.entries()) {
        try { const opened = await recoverTextReserve({ config, webAuthnClient: client, store: createReserveHttpStore({ fetcher }) }); assert.equal(opened.text, request.texts[index]); unmodifiedRecovered++; }
        catch (error) { assert.equal(error?.code, 'MANIFEST_AUTH_FAILED'); rejected++; }
      }
      assert.equal(rejected, 1); assert.equal(unmodifiedRecovered, 1);
      key.fill(0); id.fill(0); process.send({ ok: true, mode: request.mode, rejected, unmodifiedRecovered }); return;
    } else throw Error('TEST_MODE_INVALID');
    key.fill(0); id.fill(0);
    process.send({ ok: true, mode: request.mode, creates, assertions, reads, writes, textMatches: request.mode === 'recover' ? configs.length : undefined });
  } catch (error) { process.send({ ok: false, error: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'DRILL_ASSERTION_FAILED', detail: error?.message?.slice(0, 220) }); }
  finally { process.disconnect(); }
});
