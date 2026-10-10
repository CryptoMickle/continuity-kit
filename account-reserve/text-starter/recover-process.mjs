// A deliberately fresh OS process: receives only B's origin and export folder.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverTextReserve } from '@continuitykit/account-reserve/text-reserve';
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
    const fetcher = loopbackFetch(message.origin), response = await fetcher('/api/config'), env = await response.json();
    validateEnvironment(env, message.origin); assert.equal(env.role, 'recovery'); assert.equal(env.enrollmentToken, undefined);
    globalThis.location = { origin: message.origin };
    const reserve = await recoverTextReserve({ config: env.config, store: createReserveHttpStore({ fetcher }), webAuthnClient: syntheticClient(fetcher) });
    const editor = { getText: () => text, applyText: value => { text = value; } };
    restoreText(reserve.text, editor);
    await writeFile(join(message.directory, 'original.txt'), exportText(editor), { flag: 'wx', mode: 0o600 });
    await writeFile(join(message.directory, 'original.json'), exportText(editor, 'json'), { flag: 'wx', mode: 0o600 });
    text += '\nFinished in B.';
    await writeFile(join(message.directory, 'edited.txt'), exportText(editor), { flag: 'wx', mode: 0o600 });
    process.send({ ok: true, exported: ['original.txt','original.json','edited.txt'], noSetupInputs: true });
  } catch (error) { process.send({ ok: false, error: error?.code ?? 'FRESH_RECOVERY_FAILED' }); }
  finally { text = ''; process.disconnect(); }
});
