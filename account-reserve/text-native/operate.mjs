import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { open, lstat, realpath, unlink, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { argumentsFrom, readProfile } from './build.mjs';
import { runNativeDoctor } from './doctor.mjs';
import { readNativeOperatorState } from './operator-state.mjs';
import { checkNativeOperator } from './operator-readiness.mjs';
import { startReplicaGateway } from './operator-runtime/replica-gateway.mjs';
import { startNativeHost } from './native-host.mjs';

const fail = code => Object.assign(new Error(code), { code });
const workerPath = fileURLToPath(new URL('./operator-worker.mjs', import.meta.url));
async function exitedWithin(worker, milliseconds) {
  let timer;
  try { return await Promise.race([worker.exit.then(() => true), new Promise(done => { timer = setTimeout(() => done(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const safeCodes = new Set(['NATIVE_OPERATOR_LOCKED', 'NATIVE_OPERATOR_PORT_IN_USE', 'NATIVE_OPERATOR_BUILD_INVALID',
  'NATIVE_OPERATOR_STATE_INVALID', 'NATIVE_OPERATOR_ABORTED', 'NATIVE_OPERATOR_EXPIRED', 'NATIVE_OPERATOR_CHILD_FAILED',
  'NATIVE_OPERATOR_START_FAILED', 'NATIVE_OPERATOR_READINESS_FAILED', 'NATIVE_OPERATOR_SHUTDOWN_FAILED']);
const safeError = error => fail(safeCodes.has(error?.code) ? error.code : 'NATIVE_OPERATOR_START_FAILED');

async function reservePort(port) {
  const server = createServer(socket => socket.destroy());
  try { await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); }); }
  catch { throw fail('NATIVE_OPERATOR_PORT_IN_USE'); }
  let promise;
  return { port, close() { return promise ??= new Promise(done => server.close(done)); } };
}

/** Starts only existing, bound state. No grant, authenticator, database reset,
 * repair or automatic restart is performed. All child handles belong to this run. */
export async function startNativeOperator({ profile, state, out = fileURLToPath(new URL('./dist', import.meta.url)), signal, onState } = {}) {
  let bound;
  try { bound = readNativeOperatorState({ profile, state }); }
  catch { throw fail('NATIVE_OPERATOR_STATE_INVALID'); }
  if (signal?.aborted) throw fail('NATIVE_OPERATOR_ABORTED');
  let checked;
  try { checked = await runNativeDoctor({ profile: bound.profile, out }); }
  catch { throw fail('NATIVE_OPERATOR_BUILD_INVALID'); }
  if (!checked.ok) throw fail('NATIVE_OPERATOR_BUILD_INVALID');
  out = await realpath(out);

  const lockPath = join(bound.directory, 'runtime.lock'), nonce = randomBytes(32).toString('hex');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { throw fail(error?.code === 'EEXIST' ? 'NATIVE_OPERATOR_LOCKED' : 'NATIVE_OPERATOR_STATE_INVALID'); }
  const lockStat = await lock.stat();
  async function removeOwnedLock(checkContents = true) {
    const current = await lstat(lockPath);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === lockStat.dev && current.ino === lockStat.ino
      && (!checkContents || await readFile(lockPath, 'utf8') === JSON.stringify({ version: 1, nonce }) + '\n')) await unlink(lockPath);
  }
  try { await lock.writeFile(JSON.stringify({ version: 1, nonce }) + '\n'); await lock.sync(); }
  catch { try { await removeOwnedLock(false); } catch {} await lock.close(); throw fail('NATIVE_OPERATOR_START_FAILED'); }

  const reservations = new Map(), workers = [], listeners = [], life = new AbortController();
  let stopping = false, ready = false, closed, failureReason, expiryTimer, finishInitialization, settleFailure;
  const unavailable = new Set();
  const status = () => Object.freeze({ state: stopping ? 'closed' : unavailable.size === bound.ports.replicas.length ? 'unavailable' : unavailable.size ? 'degraded' : 'ready',
    unavailableReplicas: Object.freeze(bound.ports.replicas.filter(item => unavailable.has(item.id)).map(item => item.id)) });
  function announce() {
    try { if (typeof onState === 'function') Promise.resolve(onState(status())).catch(() => {}); } catch { /* callback cannot alter managed ownership */ }
  }
  const initialized = new Promise(done => { finishInitialization = done; });
  const failure = new Promise(done => { settleFailure = done; });
  const abort = () => { void close(fail('NATIVE_OPERATOR_ABORTED')); };
  async function stopWorker(worker) {
    if (worker.exited) return true;
    try { if (worker.child.connected) worker.child.send({ type: 'stop' }, () => {}); } catch {}
    if (await exitedWithin(worker, 1500)) return true;
    worker.child.kill('SIGTERM');
    if (await exitedWithin(worker, 1500)) return true;
    worker.child.kill('SIGKILL');
    return exitedWithin(worker, 2000);
  }
  function close(problem) {
    if (problem && !failureReason) failureReason = safeError(problem);
    if (!closed) {
      stopping = true; life.abort(); clearTimeout(expiryTimer); signal?.removeEventListener('abort', abort);
      closed = (async () => {
        await initialized;
        const results = await Promise.allSettled([...listeners.reverse().map(item => item.close()),
          ...[...reservations.values()].map(item => item.close())]);
        const stopped = await Promise.all(workers.map(stopWorker));
        if (results.some(item => item.status === 'rejected') || stopped.some(value => !value)) failureReason ??= fail('NATIVE_OPERATOR_SHUTDOWN_FAILED');
        // Keep the lock when owned children did not exit. Never consult/kill a PID from disk.
        if (stopped.every(Boolean) && results.every(item => item.status === 'fulfilled')) {
          try { await removeOwnedLock(); }
          catch (error) { if (error?.code !== 'ENOENT') failureReason ??= fail('NATIVE_OPERATOR_SHUTDOWN_FAILED'); }
        }
        try { await lock.close(); } catch { failureReason ??= fail('NATIVE_OPERATOR_SHUTDOWN_FAILED'); }
        settleFailure(failureReason); announce();
      })();
    }
    return closed;
  }
  const active = () => {
    if (stopping || life.signal.aborted) throw failureReason ?? fail('NATIVE_OPERATOR_ABORTED');
    if (Date.now() >= Date.parse(bound.profile.expiresAt)) throw fail('NATIVE_OPERATOR_EXPIRED');
  };
  function watchExpiry() {
    const remaining = Date.parse(bound.profile.expiresAt) - Date.now();
    if (remaining <= 0) { void close(fail('NATIVE_OPERATOR_EXPIRED')); return; }
    expiryTimer = setTimeout(watchExpiry, Math.min(remaining, 60000)); expiryTimer.unref();
  }
  function workerLost(worker) {
    if (stopping) return;
    if (!ready) { void close(fail('NATIVE_OPERATOR_CHILD_FAILED')); return; }
    if (!unavailable.has(worker.id)) { unavailable.add(worker.id); announce(); }
    // A lost store is not restarted. Surviving copies remain readable through B.
    if (!worker.stopping) {
      worker.stopping = true;
      void stopWorker(worker).then(stopped => { if (!stopped && !stopping) void close(fail('NATIVE_OPERATOR_SHUTDOWN_FAILED')); });
    }
  }
  async function releasePort(port) { await reservations.get(port)?.close(); reservations.delete(port); active(); }
  async function startWorker(paths) {
    const port = bound.ports.replicas.find(item => item.id === paths.id).port;
    await releasePort(port);
    const child = fork(workerPath, [], { execPath: process.execPath, execArgv: [], serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH ?? '', LANG: 'C', TZ: 'UTC', NODE_NO_WARNINGS: '1' } });
    let onExit;
    const worker = { id: paths.id, child, exited: false, exit: new Promise(done => { onExit = done; }) }; workers.push(worker);
    const exited = () => { worker.exited = true; onExit(); workerLost(worker); };
    // Spawn errors may have close without exit; an explicitly disconnected IPC
    // channel may have exit without close. Either confirms no live owned process.
    child.once('close', exited); child.once('exit', exited);
    child.once('disconnect', () => workerLost(worker));
    child.once('error', () => workerLost(worker));
    await new Promise((done, reject) => {
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); child.removeListener('message', message);
        child.removeListener('exit', exited); child.removeListener('error', errored); life.signal.removeEventListener('abort', cancelled); error ? reject(error) : done(); };
      const message = value => {
        if (JSON.stringify(value) !== JSON.stringify({ type: 'ready', nonce, id: paths.id, port, database: paths.database, invitationFile: paths.invitationFile })) return finish(fail('NATIVE_OPERATOR_CHILD_FAILED'));
        finish();
      };
      const exited = () => finish(fail('NATIVE_OPERATOR_CHILD_FAILED')), errored = exited;
      const cancelled = () => finish(failureReason ?? fail('NATIVE_OPERATOR_ABORTED'));
      const timer = setTimeout(() => finish(fail('NATIVE_OPERATOR_CHILD_FAILED')), 10000);
      child.on('message', message); child.once('exit', exited); child.once('error', errored); life.signal.addEventListener('abort', cancelled, { once: true });
      try { child.send({ type: 'start', nonce, id: paths.id, profile: bound.profile, state: bound.directory }, error => { if (error) errored(); }); }
      catch { errored(); }
      if (life.signal.aborted) cancelled();
    });
    active();
  }
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort(); active(); watchExpiry();
    const ports = [bound.ports.primary, bound.ports.recovery, bound.ports.gateway, ...bound.ports.replicas.map(item => item.port)];
    for (const port of ports) { active(); const reservation = await reservePort(port); reservations.set(port, reservation); }
    for (const paths of bound.databasePaths) { active(); await startWorker(paths); }
    await releasePort(bound.ports.gateway);
    listeners.push(await startReplicaGateway({ configuration: bound.gatewayConfiguration, port: bound.ports.gateway })); active();
    await releasePort(bound.ports.primary);
    listeners.push(await startNativeHost({ profile: bound.profile, role: 'primary', assets: join(out, 'primary'), port: bound.ports.primary })); active();
    await releasePort(bound.ports.recovery);
    listeners.push(await startNativeHost({ profile: bound.profile, role: 'recovery', assets: join(out, 'recovery'), port: bound.ports.recovery, gatewayPort: bound.ports.gateway })); active();
    const checkedRuntime = await checkNativeOperator({ profile: bound.profile, state: bound.directory, out, signal: life.signal });
    if (!checkedRuntime.ok) throw fail('NATIVE_OPERATOR_READINESS_FAILED'); active();
    ready = true; finishInitialization(); announce();
    return Object.freeze({ ports: bound.ports, close: () => close(), failure, status });
  } catch (error) {
    finishInitialization(); await close(safeError(error)); throw failureReason ?? safeError(error);
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  // npm may forward a terminal signal already delivered to the whole process
  // group. Repeated signals must not restore the default exit before cleanup.
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, stop);
  try {
    const args = argumentsFrom(process.argv.slice(2), ['profile', 'state', 'out']);
    if (!args.state || !args.out) throw fail('NATIVE_OPERATOR_START_FAILED');
    const running = await startNativeOperator({ profile: await readProfile(args.profile), state: resolve(args.state), out: resolve(args.out), signal: controller.signal,
      onState(value) { if (value.state === 'degraded' || value.state === 'unavailable') console.log(JSON.stringify({ operatorState: value.state, unavailableReplicas: value.unavailableReplicas })); } });
    console.log(JSON.stringify({ ready: running.status().state === 'ready', bind: '127.0.0.1', ports: running.ports, status: running.status(), physicalPasskeyVerified: false, cryptographicRecoveryVerified: false }));
    const problem = await running.failure;
    if (problem && problem.code !== 'NATIVE_OPERATOR_ABORTED') {
      await new Promise(done => process.stderr.write(problem.code + '\n', done)); process.exit(1);
    }
    // All owned listeners, children and lock cleanup have completed. Exit here
    // rather than enter Node's natural teardown with terminal signals arriving.
    process.exit(0);
  } catch (error) {
    if (!(controller.signal.aborted && error?.code === 'NATIVE_OPERATOR_ABORTED')) {
      await new Promise(done => process.stderr.write(safeError(error).code + '\n', done)); process.exit(1);
    }
    process.exit(0);
  }
  // CLI-only handlers stay installed through explicit exit; npm may forward
  // another signal after resources and the lock have been closed.
}
