import { http } from 'viem';
import { APPROVED_TESTNET_RPCS } from './client-profile.mjs';

const INTERVAL_MS = 250;
const fail = code => Object.assign(new Error(code), { code });

// One FIFO per approved endpoint, shared by all clients constructed from this
// factory. A rejected request advances the queue; it is never retried. Keeping
// wallet preparation, reads and broadcast in the same queue prevents separate
// viem clients from creating an accidental burst within this page.
export function createPacedRpcTransportFactory({ httpTransport = http, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const queues = new Map();
  function transportFor(url) {
    if (!APPROVED_TESTNET_RPCS.includes(url)) throw fail('PUBLIC_RPC_NOT_APPROVED');
    if (!queues.has(url)) queues.set(url, { tail: Promise.resolve(), nextStart: 0 });
    const queue = queues.get(url);
    const direct = httpTransport(url, { retryCount: 0, timeout: 10000, fetchOptions: { redirect: 'error' } });
    return config => {
      const adapter = direct(config);
      return {
        ...adapter,
        request(args, options) {
          const attempt = queue.tail.then(async () => {
            while (now() < queue.nextStart) await wait(queue.nextStart - now());
            queue.nextStart = now() + INTERVAL_MS;
            return adapter.request(args, options);
          });
          queue.tail = attempt.then(() => undefined, () => undefined);
          return attempt;
        },
      };
    };
  }
  // Draining performs no requests. It lets controlled fixtures finish pending
  // reads before restoring a mocked transport; it cannot release a queued send.
  transportFor.idle = () => Promise.all([...queues.values()].map(queue => queue.tail));
  return Object.freeze(transportFor);
}

// Browser module singleton: app readiness and claim clients share these queues.
export const publicTestnetTransport = createPacedRpcTransportFactory();
