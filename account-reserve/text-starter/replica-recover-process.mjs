// A fresh test process receives only B's origin and an empty output directory.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverTextReserveFromReplicas } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { loopbackFetch } from './loopback-fetch.mjs';
import { syntheticClient } from './synthetic-client.mjs';
import { restoreText, exportText } from './adapter.mjs';
import { validateEnvironment } from './config.mjs';
if (!process.send) throw new Error('LOCAL_TEST_IPC_ONLY');
process.once('message', async message => {
  let text = '';
  try {
    assert.deepEqual(Object.keys(message).sort(), ['directory','origin']);
    const transport = loopbackFetch(message.origin);
    const fetcher = (path, init = {}) => {
      // Recovery may read B and assert its existing simulated credential only.
      const method = init.method ?? 'GET';
      if (method !== 'GET' && !(path === '/api/synthetic' && method === 'POST' && JSON.parse(init.body).action === 'get')) throw new Error('RECOVERY_WRITE_FORBIDDEN');
      return transport(path, init);
    };
    const env = await (await fetcher('/api/config')).json();
    validateEnvironment(env, message.origin); assert.equal(env.role, 'recovery'); assert.equal(env.replicaMode, true);
    globalThis.location = { origin: message.origin };
    const result = await recoverTextReserveFromReplicas({ config: env.config,
      replicas: env.replicas.map(({ id, basePath }) => ({ id, store: createReserveHttpStore({ fetcher, basePath }) })),
      webAuthnClient: syntheticClient(fetcher) });
    const editor = { getText: () => text, applyText: value => { text = value; } };
    restoreText(result.reserve.text, editor);
    await writeFile(join(message.directory, 'original.txt'), exportText(editor), { flag: 'wx', mode: 0o600 });
    await writeFile(join(message.directory, 'original.json'), exportText(editor, 'json'), { flag: 'wx', mode: 0o600 });
    text += '\nFinished in B.';
    await writeFile(join(message.directory, 'edited.txt'), exportText(editor), { flag: 'wx', mode: 0o600 });
    process.send({ ok: true, replicas: result.replicas, noSetupInputs: true, noRecoveryWrites: true });
  } catch (error) { process.send({ ok: false, error: error?.code ?? 'FRESH_RECOVERY_FAILED', replicas: error?.replicas }); }
  finally { text = ''; process.disconnect(); }
});
