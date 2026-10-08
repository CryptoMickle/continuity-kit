import { configuration } from './config.mjs';
import { loopbackFetch } from './loopback-fetch.mjs';
const config = configuration();
const checks = [];
for (const [role, origin] of [['primary', config.originalOrigin], ['recovery', config.recoveryOrigin]]) {
  try {
    const response = await loopbackFetch(origin)('/api/config', { signal: AbortSignal.timeout(3000) });
    const value = await response.json();
    checks.push({ id: role, status: response.ok && value.role === role && value.config?.recoveryRpId === config.config.recoveryRpId ? 'pass' : 'fail', message: `${role} configuration ${response.status}` });
  } catch { checks.push({ id: role, status: 'fail', message: 'Not reachable. Run npm run dev in another terminal.' }); }
}
checks.push({ id: 'physical-passkey', status: 'unverified', message: 'A real passkey ceremony is required; no credential was requested.' });
checks.push({ id: 'durability', status: 'unverified', message: 'Starter data is in RAM and disappears on server restart.' });
console.log(JSON.stringify({ ok: checks.every(c => c.status !== 'fail'), checks, secretsPrinted: false }, null, 2));
if (checks.some(c => c.status === 'fail')) process.exitCode = 1;
