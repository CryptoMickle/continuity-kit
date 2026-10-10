// Local drill control only. This fixture is copied beside the packaged public
// operator host; production entrypoints never import it or expose its IPC.
import { initializeDatabase } from './store.mjs';
import { startOperatorHost } from './host.mjs';
import { startReplicaGateway } from './replica-gateway.mjs';

if (!process.send) throw new Error('IPC_TEST_ONLY');
let running;
process.once('message', async request => {
  try {
    if (request.synthetic !== true) throw new Error('SYNTHETIC_DRILL_ONLY');
    if (request.kind === 'store') {
      if (request.initialize) initializeDatabase(request.database, request.configuration);
      running = await startOperatorHost({ configuration: request.configuration, database: request.database,
        invitationFile: request.invitationFile, role: 'recovery', port: request.port ?? 0 });
    } else if (request.kind === 'gateway') {
      running = await startReplicaGateway({ configuration: request.configuration, port: request.port ?? 0 });
    } else throw new Error('TEST_KIND_INVALID');
    process.send({ ready: true, port: running.port });
  } catch (error) { process.send({ ready: false, error: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'DRILL_HOST_START_FAILED' }); process.exitCode = 1; process.disconnect(); }
});
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  if (stopping) return; stopping = true;
  try { await running?.close(); } finally { process.exit(0); }
});
