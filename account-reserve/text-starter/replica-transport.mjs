import { request as httpRequest } from 'node:http';

export const fail = code => Object.assign(new Error(code), { code });
export function readBounded(stream, maximum, signal) {
  return new Promise((resolve, reject) => {
    const declared = stream.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) return reject(fail('BODY_INVALID'));
    const chunks = []; let size = 0, settled = false;
    const cleanup = () => {
      for (const [name, fn] of [['data', data], ['end', end], ['error', error], ['aborted', error], ['close', close]]) stream.removeListener(name, fn);
      signal.removeEventListener('abort', abort);
    };
    const finish = (problem, bytes) => { if (settled) return; settled = true; cleanup(); if (problem) { stream.pause(); reject(problem); } else resolve(bytes); };
    const data = bytes => { size += bytes.length; if (size > maximum) finish(fail('BODY_INVALID')); else chunks.push(bytes); };
    const end = () => finish(undefined, Buffer.concat(chunks, size));
    const error = () => finish(fail('BODY_INVALID'));
    const close = () => { if (!stream.complete) error(); };
    const abort = () => finish(fail('REQUEST_ABORTED'));
    for (const [name, fn] of [['data', data], ['end', end], ['error', error], ['aborted', error], ['close', close]]) stream.on(name, fn);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}

// Only trusted server configuration supplies the target port. No DNS, arbitrary
// request headers, redirect following, retries or replica selection occur here.
export async function localJsonRequest({ port, origin, path, method = 'GET', body, authorization, signal }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/api\/replicas\/(alpha|beta)\/(enrollment\/start|reserve\/[A-Za-z0-9_-]{43})$/.test(path)) throw fail('TARGET_INVALID');
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== 'text-starter-reserve.localhost') throw fail('TARGET_INVALID');
  if (!['GET', 'POST', 'PUT'].includes(method) || (body && body.length > 87440)) throw fail('TARGET_INVALID');
  let request, response;
  try {
    response = await new Promise((resolve, reject) => {
      request = httpRequest({ hostname: '127.0.0.1', port, path, method, agent: false, signal,
        headers: { host: url.host, origin, connection: 'close', ...(method === 'GET' ? {} : {
          'content-type': 'application/json', 'content-length': body?.length ?? 0, ...(authorization ? { authorization } : {}),
        }) } }, resolve);
      request.once('error', () => reject(fail('REPLICA_UNAVAILABLE'))); request.end(body);
    });
    if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 600
      || response.statusCode >= 300 && response.statusCode < 400 || response.headers['content-encoding']
      || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '')) throw fail('REPLICA_RESPONSE_INVALID');
    return { status: response.statusCode, bytes: await readBounded(response, 87440, signal) };
  } finally { response?.destroy(); request?.destroy(); }
}
