// Fixed private child entrypoint. It accepts a bound state, never executable code.
import { readNativeOperatorState } from './operator-state.mjs';
import { runtimeProfile } from './operator.mjs';
import { startOperatorHost } from './operator-runtime/host.mjs';

if (!process.send || !process.connected || process.argv.length !== 2) process.exit(1);
let host, started = false, stopping = false, closePromise;
function stop(code = 0) {
  if (!closePromise) {
    stopping = true;
    closePromise = (async () => { try { await host?.close(); } finally { process.exit(code); } })();
  }
  return closePromise;
}
for (const name of ['SIGTERM', 'SIGINT', 'disconnect']) process.once(name, () => { void stop(); });
process.on('message', async message => {
  if (stopping) return;
  if (started) {
    if (message && Object.keys(message).length === 1 && message.type === 'stop') return void stop();
    return void stop(1);
  }
  started = true;
  try {
    if (!message || JSON.stringify(message).length > 16384
      || JSON.stringify(Object.keys(message).sort()) !== JSON.stringify(['id', 'nonce', 'profile', 'state', 'type'])
      || message.type !== 'start' || !/^[a-z][a-z0-9-]{0,31}$/.test(message.id)
      || typeof message.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(message.nonce)
      || typeof message.state !== 'string' || message.state.length > 4096) throw new Error();
    const state = readNativeOperatorState({ profile: message.profile, state: message.state });
    const paths = state.databasePaths.find(item => item.id === message.id);
    const port = state.ports.replicas.find(item => item.id === message.id)?.port;
    if (!paths || !port || state.directory !== message.state || stopping || !process.connected) throw new Error();
    host = await startOperatorHost({ configuration: runtimeProfile(state.profile), database: paths.database,
      invitationFile: paths.invitationFile, port });
    if (stopping || !process.connected) { await host.close(); return void stop(); }
    process.send({ type: 'ready', nonce: message.nonce, id: message.id, port: host.port,
      database: paths.database, invitationFile: paths.invitationFile });
  } catch {
    if (process.connected) process.send({ type: 'failed', code: 'NATIVE_WORKER_START_FAILED' });
    void stop(1);
  }
});
// An orphaned worker that never receives its one startup command cannot linger.
setTimeout(() => { if (!started) void stop(1); }, 8000).unref();
