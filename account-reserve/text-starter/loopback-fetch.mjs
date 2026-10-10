import { request } from 'node:http';

// Node test/doctor transport. Only the two local demo hostnames are permitted.
export function loopbackFetch(origin) {
  const base = new URL(origin);
  if (base.origin !== origin || base.protocol !== 'http:' || !['text-starter-primary.localhost','text-starter-reserve.localhost'].includes(base.hostname)
    || !base.port || Number(base.port) < 1024) throw new Error('LOOPBACK_ONLY');
  return (path, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) return reject(new Error('SAME_ORIGIN_ONLY'));
    const headers = Object.fromEntries(new Headers(init.headers));
    const req = request({ hostname: '127.0.0.1', port: Number(base.port), path: url.pathname + url.search, method: init.method ?? 'GET',
      headers: { ...headers, host: base.host, origin }, signal: init.signal ?? AbortSignal.timeout(5000), agent: false }, response => {
      const chunks = []; let length = 0;
      response.on('data', chunk => { length += chunk.length; if (length > 120000) { response.destroy(); reject(new Error('RESPONSE_TOO_LARGE')); } else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
        headers: { 'content-type': response.headers['content-type'] ?? 'application/json' } })));
    });
    req.on('error', reject); req.end(init.body);
  });
}
