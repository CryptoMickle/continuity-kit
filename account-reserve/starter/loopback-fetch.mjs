import { request } from 'node:http';
// Node-only helper for the starter's synthetic test and diagnostic command.
// The Host/Origin remain the real local origins; no external destination allowed.
export function loopbackFetch(origin) {
  const base = new URL(origin);
  if (base.protocol !== 'http:' || !base.hostname.endsWith('.localhost')) throw new Error('LOOPBACK_ONLY');
  return (path, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, origin); if (url.origin !== origin) return reject(new Error('SAME_ORIGIN_ONLY'));
    const headers = Object.fromEntries(new Headers(init.headers));
    const req = request({ hostname: '127.0.0.1', port: base.port, path: url.pathname + url.search, method: init.method ?? 'GET', headers: { ...headers, host: base.host, origin }, signal: init.signal }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 100000) { res.destroy(); reject(new Error('RESPONSE_TOO_LARGE')); } else chunks.push(chunk); });
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(init.body);
  });
}
