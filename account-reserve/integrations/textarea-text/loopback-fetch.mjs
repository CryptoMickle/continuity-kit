import { request } from 'node:http';

// Node-side tests keep the browser's actual Host and Origin, without DNS/network.
export function loopbackFetch(origin) {
  const base = new URL(origin);
  if (base.protocol !== 'http:' || !['textarea-text-primary.localhost', 'textarea-text-reserve.localhost'].includes(base.hostname) || !base.port) throw new Error('LOOPBACK_ONLY');
  return (path, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) return reject(new Error('SAME_ORIGIN_ONLY'));
    const headers = Object.fromEntries(new Headers(init.headers));
    const req = request({ hostname: '127.0.0.1', port: Number(base.port), path: url.pathname + url.search,
      method: init.method ?? 'GET', headers: { ...headers, host: base.host, origin }, signal: init.signal }, response => {
      const chunks = []; let length = 0;
      response.on('data', chunk => { length += chunk.length; if (length > 120000) { response.destroy(); reject(new Error('RESPONSE_TOO_LARGE')); } else chunks.push(chunk); });
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(init.body);
  });
}
