import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startStarter } from '../starter/server.mjs';
import { loopbackFetch } from '../starter/loopback-fetch.mjs';

test('starter grant remains one-write when a slow request races another enrollment', async () => {
  const app = await startStarter({ primaryPort: 4783, recoveryPort: 4784 });
  let slow;
  try {
    const fetcher = loopbackFetch(app.recoveryOrigin);
    const { enrollmentToken } = await (await fetcher('/api/config')).json();
    const outcome = new Promise((resolve, reject) => {
      slow = request({ hostname: '127.0.0.1', port: 4784, path: '/api/reserve/' + 'A'.repeat(43), method: 'PUT', headers: { host: new URL(app.recoveryOrigin).host, origin: app.recoveryOrigin, 'content-type': 'application/json', authorization: `Bearer ${enrollmentToken}` } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      slow.on('error', reject); slow.write('{"bytes":"');
    });
    // Status crosses the same event loop after the slow headers were sent.
    await fetcher('/api/status');
    const complete = await fetcher('/api/reserve/' + 'B'.repeat(43), { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${enrollmentToken}` }, body: '{"bytes":"AQ"}' });
    assert.equal(complete.status, 201);
    slow.end('Ag"}');
    assert.equal(await outcome, 403);
    assert.equal((await (await fetcher('/api/status')).json()).counts.writes, 1);
    assert.equal((await fetcher('/api/reserve/' + 'A'.repeat(43))).status, 404);
  } finally { slow?.destroy(); await app.close(); }
});
