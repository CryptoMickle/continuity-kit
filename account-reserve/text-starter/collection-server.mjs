import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import { readFile, realpath, lstat, access, mkdtemp, mkdir, rm, chmod } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { portsFromArgs } from './config.mjs';
import { collectionConfiguration } from './collection-config.mjs';
import { startReplicaGateway } from './operator-runtime/replica-gateway.mjs';
import { canonical, ciphertext, locator } from './operator-runtime/profile.mjs';
import { fail, readBounded, localJsonRequest } from './replica-transport.mjs';

const PRF_SALT = '20b9d60bc82e9d394a6e32b02bfb225927685add7cc924188fb8b7117e034d12';
const IDS = Object.freeze(['alpha', 'beta']);
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...names].sort().join();

/** Disposable local fault demonstration. Only encrypted snapshots are persisted,
 * in two temporary SQLite databases served by separate child processes. The
 * simulated authenticator remains in this parent process's RAM. Never deploy. */
export async function startCollectionStarter({ primaryPort = 6173, recoveryPort = 6174,
  dist = fileURLToPath(new URL('./dist/', import.meta.url)) } = {}) {
  const settings = collectionConfiguration(primaryPort, recoveryPort), servers = [], requests = new Set();
  const staticRoot = await realpath(dist); await access(join(staticRoot, 'index.html'));
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'continuity-starter-collection-'))); await chmod(directory, 0o700);
  const secret = randomBytes(32), states = IDS.map(id => ({ id, directory: join(directory, id),
    invitation: randomBytes(32).toString('hex'), child: undefined, exited: undefined, port: 0, initialized: false, corruptedApps: new Set(), locators: new Map() }));
  const profile = { version: 1, primaryOrigin: settings.originalOrigin, recoveryOrigin: settings.recoveryOrigin,
    expiresAt: new Date(Date.now() + 86400000).toISOString(), apps: settings.apps.map(({ id, label, config }) => ({ id, label, appId: config.appId })) };
  let gateway, credentialId, primaryOnline = true, enrollmentAttempted = new Set(), controlBusy = false, closing = false, closePromise;
  const grantsByToken = new Map(), activeWork = new Set();
  const appIds = settings.apps.map(app => app.config.appId);
  const running = state => Boolean(state.child && Number.isInteger(state.child.pid) && state.child.exitCode === null && state.child.signalCode === null);
  const status = () => ({ synthetic: true, primaryOnline, replicas: states.map(state => ({ id: state.id, running: running(state), corruptedApps: [...state.corruptedApps] })) });
  const replicas = settings.replicas;

  async function stopStore(state) {
    const child = state.child, exited = state.exited;
    if (!child || !running(state)) { if (exited) await exited; return; }
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  async function startStore(state) {
    if (closing || running(state)) throw fail('CONTROL_CONFLICT');
    const child = fork(new URL('./replica-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], env: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir() } });
    state.child = child;
    // Spawn failures can close without exit; IPC disconnect can exit before close.
    state.exited = new Promise(done => { child.once('exit', done); child.once('close', done); });
    child.on('error', () => {});
    try {
      const result = await new Promise((done, reject) => {
        let settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); child.removeListener('message', message); child.removeListener('error', failed); child.removeListener('exit', failed); error ? reject(error) : done(value); };
        const message = value => finish(undefined, value), failed = () => finish(fail('REPLICA_START_FAILED'));
        const timer = setTimeout(() => finish(fail('REPLICA_START_TIMEOUT')), 10000);
        child.once('message', message); child.once('error', failed); child.once('exit', failed);
        child.send({ synthetic: true, id: state.id, directory: state.directory, invitation: state.invitation,
          configuration: profile, port: state.port, initialize: !state.initialized }, error => { if (error) failed(); });
      });
      if (!result?.ready || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535 || state.port && state.port !== result.port || closing) throw fail('REPLICA_START_FAILED');
      state.port = result.port; state.initialized = true;
    } catch (error) { await stopStore(state); throw error; }
  }
  async function corruptStore(state, appId) {
    if (running(state) || state.corruptedApps.has(appId)) throw fail('CONTROL_CONFLICT');
    if (state.exited) await state.exited;
    const database = join(state.directory, 'reserve.db'), stat = await lstat(database);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 || await realpath(database) !== database) throw fail('LOCAL_DATABASE_INVALID');
    const db = new DatabaseSync(database);
    try {
      const knownLocator = state.locators.get(appId);
      if (!knownLocator) throw fail('NO_SNAPSHOT_TO_CORRUPT');
      const row = db.prepare('SELECT locator,ciphertext FROM operator_records WHERE locator=?').get(knownLocator);
      if (!row) throw fail('NO_SNAPSHOT_TO_CORRUPT');
      const envelope = JSON.parse(ciphertext(row.ciphertext).toString('utf8'));
      const bytes = Buffer.from(envelope.ciphertext, 'base64url'); bytes[0] ^= 1; envelope.ciphertext = bytes.toString('base64url');
      const result = db.prepare('UPDATE operator_records SET ciphertext=? WHERE locator=?').run(Buffer.from(canonical(envelope)), row.locator);
      if (result.changes !== 1) throw fail('LOCAL_DATABASE_INVALID'); state.corruptedApps.add(appId);
    } finally { db.close(); }
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const controller of requests) controller.abort();
      await Promise.all(servers.map(server => new Promise(done => { server.close(done); server.closeAllConnections(); })));
      await Promise.allSettled([...activeWork]);
      await gateway?.close();
      await Promise.all(states.map(stopStore));
      secret.fill(0); credentialId = undefined; grantsByToken.clear(); enrollmentAttempted.clear();
      for (const state of states) { state.invitation = undefined; state.locators.clear(); }
      await rm(directory, { recursive: true, force: true });
    })();
    return closePromise;
  }
  async function listen(role, port, origin) {
    const server = createServer((request, response) => {
      const work = serve(request, response); activeWork.add(work);
      work.finally(() => activeWork.delete(work)).catch(() => {});
    });
    async function serve(request, response) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 9000); requests.add(controller);
      const disconnect = () => controller.abort(); request.once('aborted', disconnect); response.once('close', disconnect);
      const send = (code, value) => { if (!response.destroyed && !response.headersSent) { response.writeHead(code, { 'content-type': 'application/json' }); response.end(Buffer.isBuffer(value) ? value : JSON.stringify(value)); } };
      response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer'); response.setHeader('connection', 'close');
      response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      try {
        if (closing || request.headers.host !== new URL(origin).host) return send(421, { error: 'HOST_REJECTED' });
        if (role === 'primary' && !primaryOnline) return send(503, { error: 'PRIMARY_OFFLINE' });
        if (typeof request.url !== 'string' || request.url.length > 4096 || !request.url.startsWith('/') || request.url.startsWith('//') || /[%\\#]/.test(request.url)) return send(400, { error: 'URL_REJECTED' });
        const url = new URL(request.url, origin);
        const selector = url.pathname === '/' && /^\?app=(textarea|markdown)$/.test(url.search);
        if (url.pathname + url.search !== request.url || url.search && !selector) return send(400, { error: 'URL_REJECTED' });
        if (Date.now() >= Date.parse(profile.expiresAt)) return send(410, { error: 'LOCAL_DEMONSTRATION_EXPIRED' });
        const api = url.pathname.startsWith('/api/'), mutation = request.method !== 'GET';
        if (api && (request.headers.origin !== undefined && request.headers.origin !== origin
          || request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) return send(403, { error: 'ORIGIN_REJECTED' });
        if (request.headers['content-encoding'] || mutation && (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json')) return send(403, { error: 'ORIGIN_REJECTED' });
        if (!mutation && (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0')) return send(400, { error: 'BODY_INVALID' });
        if (url.pathname === '/api/config' && !mutation) return send(200, { ...settings, role, synthetic: true, collectionMode: true, expiresAt: profile.expiresAt });
        if (url.pathname === '/api/status' && role === 'recovery' && !mutation) return send(200, status());
        if (url.pathname === '/api/primary' && role === 'recovery' && request.method === 'POST') {
          const value = JSON.parse((await readBounded(request, 32, controller.signal)).toString('utf8'));
          if (!exact(value, ['online']) || typeof value.online !== 'boolean') throw fail('BODY_INVALID'); primaryOnline = value.online; return send(200, status());
        }
        if (url.pathname === '/api/replica-control' && role === 'recovery' && request.method === 'POST') {
          const value = JSON.parse((await readBounded(request, 192, controller.signal)).toString('utf8'));
          if (!exact(value, value.action === 'corrupt' ? ['id', 'action', 'appId'] : ['id', 'action'])
            || !IDS.includes(value.id) || !['stop', 'start', 'corrupt'].includes(value.action)
            || value.action === 'corrupt' && !appIds.includes(value.appId)) throw fail('BODY_INVALID');
          if (controlBusy) return send(409, { error: 'CONTROL_CONFLICT' }); controlBusy = true;
          try {
            const state = states.find(item => item.id === value.id);
            if (value.action === 'stop') await stopStore(state);
            else if (value.action === 'start') await startStore(state);
            else await corruptStore(state, value.appId);
            return send(200, status());
          } finally { controlBusy = false; }
        }
        if (url.pathname === '/api/replica-enrollment' && role === 'recovery' && request.method === 'POST') {
          const input = JSON.parse((await readBounded(request, 96, controller.signal)).toString('utf8'));
          if (!exact(input, ['appId']) || !appIds.includes(input.appId)) throw fail('BODY_INVALID');
          if (enrollmentAttempted.has(input.appId) || controlBusy) return send(409, { error: 'ENROLLMENT_CLOSED' });
          enrollmentAttempted.add(input.appId); controlBusy = true;
          try {
            const grants = [];
            for (const state of states) {
              const result = await localJsonRequest({ port: gateway.port, origin: settings.recoveryOrigin, path: '/api/replicas/' + state.id + '/enrollment/start',
                method: 'POST', body: Buffer.from('{}'), authorization: 'Bearer ' + state.invitation, signal: controller.signal });
              const value = JSON.parse(result.bytes.toString('utf8'));
              if (result.status !== 201 || !locator(value.enrollmentToken)) throw fail('ENROLLMENT_UNCONFIRMED');
              grants.push({ id: state.id, enrollmentToken: value.enrollmentToken });
            }
            if (grants[0].enrollmentToken === grants[1].enrollmentToken) throw fail('ENROLLMENT_UNCONFIRMED');
            if (controller.signal.aborted || closing) throw fail('ENROLLMENT_UNCONFIRMED');
            for (const grant of grants) grantsByToken.set(grant.enrollmentToken, { id: grant.id, appId: input.appId });
            return send(201, { appId: input.appId, replicas: grants });
          } finally { controlBusy = false; }
        }
        if (url.pathname === '/api/synthetic' && role === 'recovery' && request.method === 'POST') {
          const value = JSON.parse((await readBounded(request, 512, controller.signal)).toString('utf8'));
          if (!exact(value, value.credentialId === undefined ? ['action', 'rpId', 'salt'] : ['action', 'rpId', 'salt', 'credentialId'])
            || value.rpId !== settings.apps[0].config.recoveryRpId || value.salt !== PRF_SALT) throw fail('BODY_INVALID');
          if (value.action === 'create') {
            if (credentialId || value.credentialId !== undefined) return send(409, { error: 'ONE_LOCAL_CREDENTIAL_PER_RUN' }); credentialId = randomBytes(24).toString('base64url');
          } else if (value.action === 'get') {
            if (!credentialId || value.credentialId !== undefined && value.credentialId !== credentialId) return send(404, { error: 'CREDENTIAL_MISSING' });
          } else throw fail('BODY_INVALID');
          return send(200, { credentialId, prfOutput: createHmac('sha256', secret).update(Buffer.from(PRF_SALT, 'hex')).digest('base64url') });
        }
        const route = /^\/api\/replicas\/(alpha|beta)\/reserve\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
        if (role === 'recovery' && route && locator(route[2]) && ['GET', 'PUT'].includes(request.method)) {
          const body = mutation ? await readBounded(request, 87440, controller.signal) : undefined;
          let grant;
          if (mutation) {
            const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
            grant = match && grantsByToken.get(match[1]);
            if (!grant || grant.id !== route[1]) return send(403, { error: 'UPLOAD_PERMISSION_REJECTED' });
            // Consume synchronously before dispatch, including failed or unknown outcomes.
            grantsByToken.delete(match[1]);
          }
          const result = await localJsonRequest({ port: gateway.port, origin: settings.recoveryOrigin, path: url.pathname, method: request.method,
            body, authorization: mutation ? request.headers.authorization : undefined, signal: controller.signal });
          if (mutation && result.status === 201 && !controller.signal.aborted && !closing) {
            states.find(state => state.id === route[1]).locators.set(grant.appId, route[2]);
          }
          return send(result.status, result.bytes);
        }
        if (api) return send(404, { error: 'ROUTE_UNAVAILABLE' });
        if (mutation) return send(405, { error: 'METHOD_REJECTED' });
        const name = resolve(staticRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
        if (!name.startsWith(staticRoot + sep) || !types[extname(name)] || await realpath(name) !== name) return send(404, { error: 'NOT_FOUND' });
        const stat = await lstat(name); if (!stat.isFile() || stat.size > 1024 * 1024) return send(404, { error: 'NOT_FOUND' });
        response.writeHead(200, { 'content-type': types[extname(name)] }); response.end(await readFile(name));
      } catch (error) {
        const code = error?.code;
        const status = ['CONTROL_CONFLICT', 'NO_SNAPSHOT_TO_CORRUPT'].includes(code) ? 409 : code === 'BODY_INVALID' || error instanceof SyntaxError ? 400 : 503;
        send(status, { error: status === 400 ? 'BODY_INVALID' : status === 409 ? code : 'LOCAL_OPERATION_UNCONFIRMED' });
      } finally { clearTimeout(timer); controller.abort(); requests.delete(controller); request.removeListener('aborted', disconnect); response.removeListener('close', disconnect); }
    }
    server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 32;
    servers.push(server); await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  }
  try {
    for (const state of states) { await mkdir(state.directory, { mode: 0o700 }); await startStore(state); }
    gateway = await startReplicaGateway({ configuration: { recoveryOrigin: settings.recoveryOrigin, replicas: states.map(({ id, port }) => ({ id, port })) } });
    await listen('primary', primaryPort, settings.originalOrigin); await listen('recovery', recoveryPort, settings.recoveryOrigin);
  } catch (error) { await close(); throw error; }
  return Object.freeze({ ...settings, close,
    // Trusted local harness only. Never exposed by an HTTP route.
    inspect: () => ({ directory, replicas: states.map(state => ({ id: state.id, pid: state.child?.pid, port: state.port, database: join(state.directory, 'reserve.db'), running: running(state), corruptedApps: [...state.corruptedApps], locators: [...state.locators].map(([appId, locator]) => ({ appId, locator })) })) }) });
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    // The shared parser's legacy defaults are 5973/5974; fill the replica
    // defaults before validation so one-sided overrides use 6173/6174.
    const supplied = portsFromArgs([...args, ...(!args.some(value => value.startsWith('--primary-port=')) ? ['--primary-port=6173'] : []),
      ...(!args.some(value => value.startsWith('--recovery-port=')) ? ['--recovery-port=6174'] : [])]);
    const app = await startCollectionStarter({ primaryPort: 6173, recoveryPort: 6174, ...supplied });
    console.log(JSON.stringify({ primary: app.originalOrigin, reserve: app.recoveryOrigin, mode: 'SYNTHETIC LOCAL COLLECTION DEMONSTRATION', storage: 'Two temporary SQLite child processes. Never deploy.' }));
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (stopping) return; stopping = true;
      try { await app.close(); process.exit(0); } catch { process.exit(1); }
    });
  } catch { console.error('Collection starter could not start. Build the frontend and select two unused local ports.'); process.exitCode = 1; }
}
