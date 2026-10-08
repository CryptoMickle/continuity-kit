import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { createServer } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Explicitly opt in: this starts a disposable server and fills its bounded store.
// It never uses or shuts down the user's running demo server.
const enabled = process.env.CONTINUITY_HTTP_BOUNDARIES === '1';
const directory = fileURLToPath(new URL('../', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function send(port, host, path, { method = 'GET', origin, body, contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (origin !== undefined) headers.Origin = origin;
    if (body !== undefined) headers['Content-Type'] = contentType;
    const req = request({ hostname: '127.0.0.1', port, method, path, headers, timeout: 5000, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('LOCAL_HTTP_TIMEOUT')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function startOwnedServer() {
  const primaryPort = await unusedPort();
  let recoveryPort = await unusedPort();
  while (recoveryPort === primaryPort) recoveryPort = await unusedPort();
  const primaryOrigin = `http://continuity-primary.localhost:${primaryPort}`;
  const recoveryOrigin = `http://continuity-reserve.localhost:${recoveryPort}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: directory,
    env: { ...process.env, CONTINUITY_PRIMARY_PORT: String(primaryPort), CONTINUITY_RECOVERY_PORT: String(recoveryPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Consume output but do not print RPC data, credentials, or arbitrary errors.
  let startupText = '';
  child.stdout.on('data', (chunk) => { if (startupText.length < 4000) startupText += chunk; });
  child.stderr.resume();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer);
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('OWNED_HTTP_SERVER_EXITED');
      try {
        const config = await send(primaryPort, new URL(primaryOrigin).host, '/api/config');
        if (config.status === 200 && config.json?.primaryOrigin === primaryOrigin && config.json?.recoveryOrigin === recoveryOrigin) {
          return { primaryPort, recoveryPort, primaryOrigin, recoveryOrigin, config: config.json, close };
        }
      } catch {}
      await delay(50);
    }
    throw new Error(startupText.includes(':4573') ? 'SERVER_PORT_OVERRIDE_REQUIRED' : 'OWNED_HTTP_SERVER_NOT_READY');
  } catch (error) { await close(); throw error; }
}

export async function probeHttpBoundaries(t) {
  if (!enabled) throw new Error('CONTINUITY_HTTP_BOUNDARIES_1_REQUIRED');
  const server = await startOwnedServer();
  t.after(server.close);
  const a = (path, options) => send(server.primaryPort, new URL(server.primaryOrigin).host, path, options);
  const b = (path, options) => send(server.recoveryPort, new URL(server.recoveryOrigin).host, path, options);
  const postB = (path, body) => b(path, { method: 'POST', origin: server.recoveryOrigin, body });
  const rpc = (method, params = []) => postB('/rpc', { jsonrpc: '2.0', id: 1, method, params });

  await t.test('accepts only exact Host and write Origin with JSON content type', async () => {
    assert.equal((await a('/api/config')).status, 200);
    const badHost = await send(server.primaryPort, 'attacker.invalid', '/api/config');
    assert.equal(badHost.status, 421); assert.equal(badHost.json.error, 'HOST_REJECTED');
    const siblingHost = await send(server.primaryPort, new URL(server.recoveryOrigin).host, '/api/config');
    assert.equal(siblingHost.status, 421);
    for (const origin of [undefined, 'http://attacker.invalid', server.primaryOrigin, `${server.recoveryOrigin}/`]) {
      const result = await b('/control/primary', { method: 'POST', origin, body: { online: true } });
      assert.equal(result.status, 403); assert.equal(result.json.error, 'ORIGIN_REJECTED');
    }
    const contentType = await b('/control/primary', { method: 'POST', origin: server.recoveryOrigin, body: { online: true }, contentType: 'text/plain' });
    assert.equal(contentType.status, 403);
    assert.equal((await postB('/control/primary', { online: true })).status, 200);
    assert.equal((await b('/api/config', { method: 'DELETE', origin: server.recoveryOrigin, body: {} })).status, 405);
  });

  await t.test('RPC allows a local chain read and blocks unrestricted methods and call targets', async () => {
    const chainId = await rpc('eth_chainId');
    assert.equal(chainId.status, 200); assert.equal(chainId.json.result, '0x7a69');
    for (const method of ['anvil_setBalance', 'eth_sendTransaction', 'personal_unlockAccount', 'debug_traceTransaction', 'eth_accounts']) {
      const result = await rpc(method);
      assert.equal(result.json.error.message, 'RPC_METHOD_BLOCKED');
    }
    for (const method of ['eth_call', 'eth_estimateGas']) {
      const result = await rpc(method, [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, 'latest']);
      assert.equal(result.json.error.message, 'RPC_TARGET_BLOCKED');
    }
    assert.equal((await rpc('eth_chainId', {})).json.error.message, 'RPC_INVALID');
  });

  await t.test('signed transactions cannot transfer value, target another contract, chain or method, or exceed fees', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const data = encodeFunctionData({ abi: server.config.abi, functionName: 'claim', args: [1n] });
    const base = { chainId: 31337, to: server.config.contractAddress, data, gas: 100000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n, nonce: 0, value: 0n };
    for (const change of [
      { value: 1n },
      { to: '0x0000000000000000000000000000000000000001' },
      { chainId: 10143 },
      { data: encodeFunctionData({ abi: server.config.abi, functionName: 'issue', args: [signer.address] }) },
      { data: `${data}00` },
    ]) {
      const raw = await signer.signTransaction({ ...base, ...change });
      assert.equal((await rpc('eth_sendRawTransaction', [raw])).json.error.message, 'TRANSACTION_OUTSIDE_DEMO');
    }
    for (const change of [{ gas: 300001n }, { maxFeePerGas: 100000000001n }]) {
      const raw = await signer.signTransaction({ ...base, ...change });
      assert.equal((await rpc('eth_sendRawTransaction', [raw])).json.error.message, 'TRANSACTION_FEE_LIMIT');
    }
    const status = await b('/api/status');
    assert.equal(status.json.metrics.rpcWrites, 0);
  });

  let savedPath; let savedBytes;
  await t.test('ciphertext storage is canonical, bounded, and put-if-absent', async () => {
    const put = (path, bytes) => b(path, { method: 'PUT', origin: server.recoveryOrigin, body: { bytes } });
    savedPath = `/api/store/${randomBytes(24).toString('base64url')}`;
    savedBytes = randomBytes(48).toString('base64url');
    assert.equal((await put(savedPath, savedBytes)).status, 201);
    const duplicate = await put(savedPath, randomBytes(48).toString('base64url'));
    assert.equal(duplicate.status, 409); assert.equal(duplicate.json.error, 'RESERVE_EXISTS');
    assert.equal((await b(savedPath)).json.bytes, savedBytes);
    assert.equal((await put('/api/store/short', savedBytes)).json.error, 'LOCATOR_INVALID');
    const invalidPath = `/api/store/${randomBytes(24).toString('base64url')}`;
    for (const bytes of ['', '%%%not-base64%%%', `${savedBytes}=`, randomBytes(65537).toString('base64url')]) {
      assert.equal((await put(invalidPath, bytes)).json.error, 'RECORD_INVALID');
    }
    assert.equal((await b(invalidPath)).status, 404);
    assert.equal((await put(invalidPath, randomBytes(65536).toString('base64url'))).status, 201);
    for (let count = 2; count < 16; count++) {
      assert.equal((await put(`/api/store/${randomBytes(24).toString('base64url')}`, savedBytes)).status, 201);
    }
    assert.equal((await put(`/api/store/${randomBytes(24).toString('base64url')}`, savedBytes)).json.error, 'STORE_LIMIT');
    assert.equal((await b('/api/status')).json.ciphertextRecords, 16);
    assert.equal((await b(savedPath)).json.bytes, savedBytes);
  });

  await t.test('taking A offline blocks its page, built assets, APIs and RPC while B remains usable', async () => {
    const page = await a('/');
    assert.equal(page.status, 200);
    const asset = page.text.match(/(?:src|href)="(\/assets\/[^\"]+\.js)"/)?.[1];
    assert.ok(asset, 'a built JS asset must exist for the asset outage check');
    assert.equal((await a(asset)).status, 200);
    try {
      assert.equal((await postB('/control/primary', { online: false })).json.primaryOnline, false);
      for (const path of ['/', asset, '/api/config', '/api/status', '/api/store/abcdefghijklmnopqrst']) {
        const response = await a(path);
        assert.equal(response.status, 503); assert.equal(response.json.error, 'PRIMARY_OFFLINE');
      }
      for (const path of ['/rpc', '/api/prepare-right', '/api/synthetic/credential']) {
        const response = await a(path, { method: 'POST', origin: server.primaryOrigin, body: {} });
        assert.equal(response.status, 503); assert.equal(response.json.error, 'PRIMARY_OFFLINE');
      }
      assert.equal((await b('/')).status, 200);
      assert.equal((await b('/api/config')).status, 200);
      assert.equal((await b('/api/status')).json.primaryOnline, false);
      assert.equal((await rpc('eth_chainId')).json.result, '0x7a69');
      assert.equal((await b(savedPath)).json.bytes, savedBytes);
    } finally {
      assert.equal((await postB('/control/primary', { online: true })).json.primaryOnline, true);
    }
    assert.equal((await a('/api/config')).status, 200);
  });
}

test('actual HTTP boundaries on an owned disposable local server', { skip: !enabled, timeout: 30000 }, probeHttpBoundaries);
