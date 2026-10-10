import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { argumentsFrom, readPaymentStarterProfile, profileSha256 } from './build.mjs';

const fail = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function readBounded(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size > maximum) throw fail('PREVIEW_BUILD_INVALID');
    const bytes = Buffer.alloc(maximum + 1); let size = 0;
    while (size < bytes.length) { const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null); if (!bytesRead) break; size += bytesRead; }
    const after = await handle.stat();
    if (size > maximum || size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail('PREVIEW_BUILD_INVALID');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

/** Local preview only. No reserve proxy, mutation route, credential or RPC access. */
export async function startPaymentPreview({ out = fileURLToPath(new URL('./dist', import.meta.url)), port = 6374, signal } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw fail('PREVIEW_PORT_INVALID');
  if (signal?.aborted) throw fail('PREVIEW_ABORTED');
  const directory = resolve(out);
  for (const path of [directory, join(directory, 'assets')]) { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('PREVIEW_BUILD_INVALID'); }
  const profile = await readPaymentStarterProfile(join(directory, 'payment-config.json'));
  const report = JSON.parse(await readBounded(join(directory, 'build-report.json'), 65536));
  const found = ['index.html', ...(await readdir(join(directory, 'assets'))).map(name => 'assets/' + name)].sort();
  if (report.version !== 1 || report.mode !== 'existing-account-payment' || report.profileSha256 !== profileSha256(profile) || !Array.isArray(report.assetFiles) || report.assetFiles.length < 2 || report.assetFiles.length > 64 || new Set(report.assetFiles).size !== report.assetFiles.length || JSON.stringify(found) !== JSON.stringify([...report.assetFiles].sort())) throw fail('PREVIEW_BUILD_INVALID');
  const files = new Map();
  for (const name of report.assetFiles) {
    if (name !== 'index.html' && !/^assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(name)) throw fail('PREVIEW_BUILD_INVALID');
    const bytes = await readBounded(join(directory, name), 4 * 1024 * 1024);
    if (digest(bytes) !== report.assetSha256?.[name]) throw fail('PREVIEW_BUILD_INVALID');
    files.set('/' + name, { bytes, type: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
  }
  files.set('/', files.get('/index.html'));
  files.set('/payment-config.json', { bytes: await readBounded(join(directory, 'payment-config.json'), 16384), type: 'application/json; charset=utf-8' });
  if (signal?.aborted) throw fail('PREVIEW_ABORTED');
  let authority;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'publickey-credentials-get=(), publickey-credentials-create=()');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (request.headers.host !== authority) { response.writeHead(421); response.end('LOCAL_PREVIEW_HOST_ONLY'); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    const item = files.get(request.url);
    if (!item) { response.writeHead(404); response.end('NOT_FOUND'); return; }
    response.writeHead(200, { 'Content-Type': item.type, 'Content-Length': item.bytes.length });
    response.end(request.method === 'HEAD' ? undefined : item.bytes);
  });
  let closed, stopping;
  const close = () => stopping ??= new Promise((done, reject) => {
    signal?.removeEventListener('abort', abort);
    if (!server.listening) { closed?.(); done(); return; }
    server.close(error => { files.clear(); closed?.(); error ? reject(fail('PREVIEW_CLOSE_FAILED')) : done(); }); server.closeAllConnections();
  });
  const abort = () => { void close().catch(() => {}); };
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, done); });
    const actualPort = server.address().port; authority = '127.0.0.1:' + actualPort;
    if (profile.recoveryOrigin === 'http://' + authority || signal?.aborted) throw fail('PREVIEW_ORIGIN_FORBIDDEN');
    signal?.addEventListener('abort', abort, { once: true });
    return Object.freeze({ port: actualPort, url: 'http://' + authority + '/', close, closed: new Promise(done => { closed = done; }), localPreview: true, reserveProxy: false, credentialsEnabled: false });
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let preview;
  const lifetime = new AbortController();
  const stop = () => { lifetime.abort(); void preview?.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const args = argumentsFrom(process.argv.slice(2), ['out', 'port'], []);
    if (args.port && !/^[0-9]{1,5}$/.test(args.port)) throw fail('PREVIEW_PORT_INVALID');
    preview = await startPaymentPreview({ out: args.out, port: args.port === undefined ? undefined : Number(args.port), signal: lifetime.signal });
    console.log(JSON.stringify({ url: preview.url, localPreview: true, reserveProxy: false, credentialsEnabled: false, message: 'Local preview only. Real recovery requires the configured existing recovery origin.' }));
    await preview.closed;
  } catch { console.error('PAYMENT_PREVIEW_FAILED: check the built files and choose an unused local port.'); process.exitCode = 1; }
}
