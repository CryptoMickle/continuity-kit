import './style.css';
import { recoverReserve } from '@continuitykit/account-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { createPaymentActions } from './actions.mjs';
import { parsePaymentStarterProfile, checkPaymentStarterEnvironment } from './profile.mjs';
import { mountPaymentStarter, showPaymentStarterError } from './page.mjs';

const root = document.getElementById('app');
const controller = new AbortController();
let dead = false, mounted;
const stop = () => { dead = true; controller.abort(); mounted?.dispose(); };
const show = event => { if (event.persisted) location.reload(); };
window.addEventListener('pagehide', stop);
window.addEventListener('pageshow', show);
const timeout = setTimeout(() => controller.abort(), 10000);

try {
  const url = new URL('./payment-config.json', location.href);
  if (url.origin !== location.origin) throw new Error('PAYMENT_CONFIG_ORIGIN_INVALID');
  const response = await fetch(url, { method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
  if (response.status !== 200 || response.redirected || !response.body) throw new Error('PAYMENT_CONFIG_UNAVAILABLE');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 16384)) throw new Error('PAYMENT_CONFIG_TOO_LARGE');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (dead || controller.signal.aborted) throw new Error('PAYMENT_PAGE_CLOSED');
      if (done) break;
      if (!(value instanceof Uint8Array) || (size += value.byteLength) > 16384) throw new Error('PAYMENT_CONFIG_TOO_LARGE');
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const profile = parsePaymentStarterProfile(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  const environment = checkPaymentStarterEnvironment(profile);
  if (!environment.ok) throw new Error('PAYMENT_ENVIRONMENT_UNAVAILABLE');
  if (dead || controller.signal.aborted) throw new Error('PAYMENT_PAGE_CLOSED');
  const transport = createReserveHttpStore({ basePath: profile.storeBasePath });
  // Expose only a reader. This entry has no enrollment capability or write path.
  const store = Object.freeze({ get: locator => transport.get(locator) });
  const actions = createPaymentActions({ profile: profile.payment, lifetimeTarget: window,
    openExistingAccount: ({ signal }) => recoverReserve({ config: profile.reserve, store, signal }),
  });
  try { mounted = mountPaymentStarter(root, { profile, actions, window }); }
  catch (error) { actions.dispose(); throw error; }
} catch {
  if (!dead) showPaymentStarterError(root);
} finally {
  controller.abort();
  clearTimeout(timeout);
}
