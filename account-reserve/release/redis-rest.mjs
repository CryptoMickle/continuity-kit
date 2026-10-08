import { httpsOrigin, fail } from './profile.mjs';
const MAX_BYTES = 131072;

// Generic Redis REST JSON command transport. It does not discover endpoints,
// follow redirects, retry writes, forward provider errors, or log credentials.
export function createRedisRestCommand({ url, token, allowedOrigins = [] }, { fetcher = fetch, timeoutMs = 10000, now = Date.now } = {}) {
  const origin = httpsOrigin(url);
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length !== 1 || httpsOrigin(allowedOrigins[0]) !== origin || typeof token !== 'string' || !/^[A-Za-z0-9._~+\/-]{16,4096}={0,2}$/.test(token) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('REDIS_CONFIG_INVALID');
  let retryAfter = 0;
  return async args => {
    if (!Array.isArray(args) || args.some(v => typeof v !== 'string') || now() < retryAfter) throw fail('REDIS_UNAVAILABLE');
    const body = JSON.stringify(args);
    if (new TextEncoder().encode(body).length > MAX_BYTES) throw fail('REDIS_UNAVAILABLE');
    const controller = new AbortController();
    let reader, timer;
    const unavailable = () => fail('REDIS_UNAVAILABLE');
    try {
      const work = async () => {
        const response = await fetcher(origin, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'cache-control': 'no-store' }, body, redirect: 'manual', signal: controller.signal });
        if (response.status !== 200 || response.redirected || !response.body) throw unavailable();
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw unavailable();
        reader = response.body.getReader();
        const chunks = []; let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw unavailable();
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!json || typeof json !== 'object' || Array.isArray(json) || Object.keys(json).join(',') !== 'result') throw unavailable();
        return json.result;
      };
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(unavailable()); }, timeoutMs); });
      return await Promise.race([work(), timeout]);
    } catch {
      retryAfter = now() + 2000;
      throw unavailable();
    } finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
  };
}
