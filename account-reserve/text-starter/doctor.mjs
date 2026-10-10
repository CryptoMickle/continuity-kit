import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration, validateConfiguration, validateEnvironment, portsFromArgs } from './config.mjs';
import { loopbackFetch } from './loopback-fetch.mjs';

async function freePort(port) {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  await new Promise(done => server.close(done));
}
export async function runDoctor({ settings = configuration(), live = false, checkPorts = true } = {}) {
  const checks = [];
  async function check(name, action, advice) {
    try { await action(); checks.push({ name, ok: true }); }
    catch { checks.push({ name, ok: false, advice }); }
  }
  await check('Node.js 24+', () => { if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(); }, 'Install Node.js 24 or newer, then reinstall this starter.');
  await check('Two distinct local origins and exact B RP ID', () => validateConfiguration(settings), 'Keep the two fixed .localhost hostnames, different ports, and recoveryRpId equal to B’s hostname.');
  await check('Installed public SDK entrypoints', async () => {
    for (const [entry, exports] of [['text-reserve',['createTextReserveCredential','prepareTextReserve','recoverTextReserve']], ['text-browser',['startTextReserveSetup','createTextReserveReceiver']], ['http-store',['createReserveHttpStore']]]) {
      const value = await import('@continuitykit/account-reserve/' + entry);
      if (exports.some(name => typeof value[name] !== 'function')) throw new Error();
    }
    const source = JSON.parse(await readFile(new URL('./package.json', import.meta.url)));
    if (!source.dependencies['@continuitykit/account-reserve']?.startsWith('file:./')) throw new Error();
  }, 'Run npm ci --ignore-scripts in the generated folder. Keep its SDK tarball and package-lock.json together.');
  await check('Built local frontend', () => access(new URL('./dist/index.html', import.meta.url)), 'Run npm run build in this folder before starting the server.');
  if (checks.find(item => item.name.startsWith('Two '))?.ok) {
    if (live) {
      for (const [role, origin] of [['primary', settings.originalOrigin], ['recovery', settings.recoveryOrigin]]) await check(role + ' configuration is reachable', async () => {
        const response = await loopbackFetch(origin)('/api/config'); if (!response.ok) throw new Error();
        const value = await response.json(); validateEnvironment(value, origin);
        if (value.role !== role || JSON.stringify(validateConfiguration({ originalOrigin: value.originalOrigin, recoveryOrigin: value.recoveryOrigin, config: value.config })) !== JSON.stringify(validateConfiguration(settings))) throw new Error();
      }, 'Run npm run dev with these same ports. If you deliberately disabled A, restore it from B before the live doctor.');
    } else if (checkPorts) for (const origin of [settings.originalOrigin, settings.recoveryOrigin]) await check('Local port ' + new URL(origin).port + ' is free', () => freePort(Number(new URL(origin).port)), 'Stop the other local server or choose two unused ports with --primary-port=5975 --recovery-port=5976. If this starter is already running, use --live.');
  }
  return { ok: checks.every(item => item.ok), checks, mode: 'Local simulation only; no physical passkey proof', requirements: 'No wallet, funds or provider account. Only Node.js and local ports.', storage: 'Encrypted snapshot and simulated credential in disposable server RAM. Never deploy this server.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = process.argv.slice(2), live = args.includes('--live');
    if (args.filter(value => value === '--live').length > 1) throw new Error();
    const ports = portsFromArgs(args.filter(value => value !== '--live'));
    const report = await runDoctor({ settings: configuration(ports.primaryPort, ports.recoveryPort), live });
    console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
  } catch { console.error('Doctor configuration is invalid. Use different local ports: npm run doctor -- --primary-port=5973 --recovery-port=5974 [--live].'); process.exitCode = 1; }
}
