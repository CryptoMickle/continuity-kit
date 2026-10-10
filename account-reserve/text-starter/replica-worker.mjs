// Private child entrypoint for the disposable loopback replica starter only.
import { writeFile, unlink, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeDatabase } from './operator-runtime/store.mjs';
import { startOperatorHost } from './operator-runtime/host.mjs';

if (!process.send || !process.connected) throw new Error('LOCAL_STARTER_IPC_ONLY');
let host, stopping = false, initializing = false;
async function stop() {
  if (stopping) return; stopping = true;
  try { await host?.close(); } finally { process.exit(0); }
}
for (const signal of ['SIGTERM', 'SIGINT', 'disconnect']) process.once(signal, stop);
process.once('message', async message => {
  if (initializing || stopping) return; initializing = true;
  let invitationFile;
  try {
    if (message?.synthetic !== true || !['alpha', 'beta'].includes(message.id) || !/^[a-f0-9]{64}$/.test(message.invitation)
      || !Number.isInteger(message.port) || message.port < 0 || message.port > 65535 || typeof message.initialize !== 'boolean'
      || typeof message.directory !== 'string' || await realpath(message.directory) !== message.directory
      || !(await lstat(message.directory)).isDirectory()) throw new Error('WORKER_INPUT_INVALID');
    const database = join(message.directory, 'reserve.db');
    invitationFile = join(message.directory, 'invitation.txt');
    await writeFile(invitationFile, message.invitation + '\n', { flag: 'wx', mode: 0o600 });
    if (message.initialize) initializeDatabase(database, message.configuration);
    host = await startOperatorHost({ configuration: message.configuration, database, invitationFile, port: message.port });
    await unlink(invitationFile); invitationFile = undefined; message.invitation = undefined;
    if (stopping || !process.connected) { await host.close(); process.exit(0); }
    process.send({ ready: true, port: host.port });
  } catch {
    try { if (invitationFile) await unlink(invitationFile); } catch {}
    await host?.close();
    if (process.connected) process.send({ ready: false, error: 'REPLICA_START_FAILED' });
    process.exitCode = 1; process.disconnect();
  }
});
