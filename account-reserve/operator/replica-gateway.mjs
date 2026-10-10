import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail, locator, origin } from './profile.mjs';

const MAX_BODY = 87440;
const MAX_RESPONSE = 87440;
const TIMEOUT_MS = 8000;
const headers = Object.freeze({ 'content-type': 'application/json', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'connection': 'close',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getOwnPropertySymbols(value).length
    || Object.getOwnPropertyNames(value).sort().join(',') !== [...fields].sort().join(',')) return false;
  return fields.every(name => Object.hasOwn(Object.getOwnPropertyDescriptor(value, name), 'value'));
}
function configuration(value) {
  if (!exact(value, ['recoveryOrigin', 'replicas'])) throw fail('GATEWAY_CONFIGURATION_INVALID');
  let recoveryOrigin;
  try { recoveryOrigin = origin(value.recoveryOrigin); } catch { throw fail('GATEWAY_CONFIGURATION_INVALID'); }
  if (!Array.isArray(value.replicas) || value.replicas.length < 2 || value.replicas.length > 3) throw fail('GATEWAY_CONFIGURATION_INVALID');
  const ids = new Set(), ports = new Set(), replicas = new Map();
  for (const replica of value.replicas) {
    if (!exact(replica, ['id', 'port']) || typeof replica.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(replica.id)
      || !Number.isInteger(replica.port) || replica.port < 1 || replica.port > 65535 || ids.has(replica.id) || ports.has(replica.port)) throw fail('GATEWAY_CONFIGURATION_INVALID');
    ids.add(replica.id); ports.add(replica.port); replicas.set(replica.id, replica.port);
  }
  return { recoveryOrigin, expectedHost: new URL(recoveryOrigin).host, replicas };
}
function boundedBody(stream, maximum, signal, code) {
  return new Promise((resolve, reject) => {
    const length = stream.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) { reject(fail(code)); return; }
    const chunks = []; let size = 0, settled = false;
    const cleanup = () => {
      for (const [event, fn] of [['data', data], ['end', end], ['error', error], ['aborted', error], ['close', closed]]) stream.removeListener(event, fn);
      signal.removeEventListener('abort', abort);
    };
    const finish = (problem, value) => { if (settled) return; settled = true; cleanup(); if (problem) { stream.pause(); reject(problem); } else resolve(value); };
    const data = chunk => { size += chunk.length; if (size > maximum) finish(fail(code)); else chunks.push(chunk); };
    const end = () => finish(undefined, Buffer.concat(chunks, size));
    const error = () => finish(fail(code));
    const closed = () => { if (!stream.complete) error(); };
    const abort = () => finish(fail('REPLICA_UNAVAILABLE'));
    for (const [event, fn] of [['data', data], ['end', end], ['error', error], ['aborted', error], ['close', closed]]) stream.on(event, fn);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function upstream({ port, path, method, forwardHeaders, body, signal }) {
  let request, response;
  try {
    response = await new Promise((resolve, reject) => {
      // Targets are fixed loopback ports. There is no URL, DNS, redirect,
      // retry, replica selection, or operator capability sharing here.
      request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: forwardHeaders, agent: false, signal }, resolve);
      request.once('error', () => reject(fail('REPLICA_UNAVAILABLE')));
      request.end(body);
    });
    if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 600
      || (response.statusCode >= 300 && response.statusCode < 400)
      || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '')
      || response.headers['content-encoding']) throw fail('REPLICA_RESPONSE_INVALID');
    return { status: response.statusCode, bytes: await boundedBody(response, MAX_RESPONSE, signal, 'REPLICA_RESPONSE_INVALID') };
  } finally { response?.destroy(); request?.destroy(); }
}

/** API-only same-origin gateway to 2–3 separately configured local processes.
 * It transports bounded ciphertext; the SDK authenticates each replica. Run
 * behind the TLS proxy for the unchanged B origin. No static assets or secrets
 * are served and no request headers, paths, bodies or upstream errors are logged.
 */
export async function startReplicaGateway({ configuration: supplied, port = 0 }) {
  const trusted = configuration(supplied);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || [...trusted.replicas.values()].includes(port)) throw fail('GATEWAY_CONFIGURATION_INVALID');
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    let timer;
    const send = (status, value) => {
      if (!response.destroyed && !response.headersSent) { response.writeHead(status, headers); response.end(Buffer.isBuffer(value) ? value : JSON.stringify(value)); }
    };
    const disconnect = () => controller.abort();
    request.once('aborted', disconnect); response.once('close', disconnect);
    try {
      if (request.headers.host !== trusted.expectedHost || typeof request.url !== 'string' || request.url.length > 4096) return send(421, { error: 'HOST_REJECTED' });
      const route = /^\/api\/replicas\/([a-z][a-z0-9-]{0,31})\/(enrollment\/start|reserve\/([A-Za-z0-9_-]{43}))$/.exec(request.url);
      if (!route || !trusted.replicas.has(route[1]) || (route[3] && !locator(route[3]))) return send(404, { error: 'NOT_FOUND' });
      const enrolling = route[2] === 'enrollment/start', mutation = request.method !== 'GET';
      if (!(enrolling ? request.method === 'POST' : ['GET', 'PUT'].includes(request.method))) return send(405, { error: 'METHOD_BLOCKED' });
      if ((request.headers.origin !== trusted.recoveryOrigin && (mutation || request.headers.origin !== undefined))
        || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) return send(403, { error: 'ORIGIN_REJECTED' });
      if (request.headers['content-encoding'] || (mutation && request.headers['content-type'] !== 'application/json')
        || (!mutation && (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')))) return send(400, { error: 'BODY_INVALID' });
      const authorization = request.headers.authorization;
      if (mutation && !(enrolling ? /^Bearer [a-f0-9]{64}$/.test(authorization ?? '')
        : /^Bearer ([A-Za-z0-9_-]{43})$/.test(authorization ?? '') && locator(authorization.slice(7)))) return send(403, { error: 'ENROLLMENT_DENIED' });
      timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const bytes = mutation ? await boundedBody(request, enrolling ? 2 : MAX_BODY, controller.signal, 'BODY_INVALID') : undefined;
      if (enrolling && bytes.toString('utf8') !== '{}') return send(400, { error: 'BODY_INVALID' });
      if (controller.signal.aborted) throw fail('REPLICA_UNAVAILABLE');
      const forwardHeaders = { host: trusted.expectedHost, connection: 'close',
        ...(request.headers.origin === undefined ? {} : { origin: trusted.recoveryOrigin }),
        ...(mutation ? { 'content-type': 'application/json', 'content-length': bytes.length, authorization } : {}) };
      const result = await upstream({ port: trusted.replicas.get(route[1]), path: '/api/' + route[2], method: request.method,
        forwardHeaders, body: bytes, signal: controller.signal });
      send(result.status, result.bytes);
    } catch (error) {
      const status = error?.code === 'BODY_INVALID' ? 400 : error?.code === 'REPLICA_RESPONSE_INVALID' ? 502 : 503;
      send(status, { error: status === 400 ? 'BODY_INVALID' : 'REPLICA_UNAVAILABLE' });
    } finally {
      clearTimeout(timer); controller.abort(); request.removeListener('aborted', disconnect); response.removeListener('close', disconnect);
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 64;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  if ([...trusted.replicas.values()].includes(server.address().port)) { await new Promise(resolve => server.close(resolve)); throw fail('GATEWAY_CONFIGURATION_INVALID'); }
  return Object.freeze({ port: server.address().port,
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index], value = process.argv[index + 1];
      if (!['--configuration', '--port'].includes(flag) || !value || Object.hasOwn(args, flag)) throw fail('ARGUMENTS_INVALID');
      args[flag] = value;
    }
    if (!args['--configuration']) throw fail('ARGUMENTS_INVALID');
    const running = await startReplicaGateway({ configuration: JSON.parse(readFileSync(args['--configuration'], 'utf8')), port: Number(args['--port'] ?? 8790) });
    process.stdout.write(JSON.stringify({ ready: true, role: 'replica-gateway', bind: '127.0.0.1', port: running.port }) + '\n');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void running.close().then(() => process.exit(0)); });
  } catch (error) { process.stderr.write((/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'GATEWAY_START_FAILED') + '\n'); process.exitCode = 1; }
}
