import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPasskeyPrfOutput } from '@category-labs/mera';
import { createTextReserveCredential, prepareTextReserve, recoverTextReserve, validateText, TEXT_PROTOCOL, MAX_TEXT_BYTES } from '../sdk/text-reserve.mjs';
import { createReserveHttpStore } from '../sdk/http-store.mjs';

const BASELINE = 'continuity-text-encrypted-file/v1';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = code => Object.assign(new Error(code), { code });
const check = (value, code) => { if (!value) throw fail(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const encode = value => encoder.encode(JSON.stringify(sorted(value)));
function unb64(text, max, length) {
  check(typeof text === 'string' && text.length > 0 && text.length <= Math.ceil(max * 4 / 3), 'BASELINE_FILE_INVALID');
  const bytes = new Uint8Array(Buffer.from(text, 'base64url'));
  check(bytes.length <= max && (length === undefined || bytes.length === length) && b64(bytes) === text, 'BASELINE_FILE_INVALID');
  return bytes;
}
function exact(value, fields) { check(value && Object.keys(value).sort().join(',') === [...fields].sort().join(','), 'BASELINE_FILE_INVALID'); }
function sameConfig(a, b) { return Buffer.from(encode(a)).equals(Buffer.from(encode(b))); }

// Synthetic HMAC credential used only by this local drill. Never an actual
// device, signup, identity, wallet, or evidence of native prompt counts.
export function textDrillAuthenticator({ id, secret }) {
  const outputs = [], counts = { creates: 0, assertions: 0 };
  const makeOutput = salt => {
    if (!secret) throw fail('SYNTHETIC_CREDENTIAL_UNAVAILABLE');
    const result = { credentialId: unb64(id, 1024), prfOutput: new Uint8Array(createHmac('sha256', Buffer.from(secret, 'base64url')).update(salt).digest()) };
    outputs.push(result); return result;
  };
  return {
    counts,
    client: {
      async createCredential(request) { counts.creates++; return { ...makeOutput(request.prfSalt), prfEnabled: true, transports: ['internal'] }; },
      async getCredential(request) {
        counts.assertions++;
        if (request.allowCredential) check(b64(request.allowCredential.credentialId) === id, 'SYNTHETIC_CREDENTIAL_MISMATCH');
        return makeOutput(request.prfSalt);
      },
    },
    close() { for (const value of outputs) value.prfOutput.fill(0); outputs.length = 0; },
  };
}
async function baselineKey({ config, credential, prfSalt, webAuthnClient }) {
  let result;
  try {
    result = await getPasskeyPrfOutput({ rpId: config.recoveryRpId, credential, prfSalt, webAuthnClient });
    check(result.credentialId === credential.credentialId, 'BASELINE_KEY_UNAVAILABLE');
    const input = await crypto.subtle.importKey('raw', result.prfOutput, 'HKDF', false, ['deriveKey']);
    const salt = createHash('sha256').update(encode({ format: BASELINE, config, credentialId: credential.credentialId })).digest();
    return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`${BASELINE}/text-aes-gcm`) }, input, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } catch { throw fail('BASELINE_KEY_UNAVAILABLE'); }
  finally { result?.prfOutput.fill(0); }
}

/** Competent baseline: a real AES-256-GCM encrypted file, protected by the same
 * available passkey, with a separate random PRF salt and authenticated policy.
 * This is a local comparison fixture, not a new supported SDK file format. */
export async function createTextEncryptedFile({ text, config, credential, webAuthnClient }) {
  const plain = encoder.encode(validateText(text)), prfSalt = randomBytes(32), nonce = randomBytes(12);
  const header = { format: BASELINE, config, credentialId: credential.credentialId, prfSalt: b64(prfSalt), nonce: b64(nonce) };
  try {
    const key = await baselineKey({ config, credential, prfSalt, webAuthnClient });
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encode(header), tagLength: 128 }, key, plain);
    return encode({ ...header, ciphertext: b64(ciphertext) });
  } finally { plain.fill(0); prfSalt.fill(0); }
}
export async function importTextEncryptedFile({ bytes, config, webAuthnClient }) {
  if (bytes === undefined || bytes === null) throw fail('BASELINE_FILE_MISSING');
  let record, plain;
  try {
    check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 65536, 'BASELINE_FILE_INVALID');
    record = JSON.parse(decoder.decode(bytes));
    check(Buffer.from(encode(record)).equals(Buffer.from(bytes)), 'BASELINE_FILE_INVALID');
    exact(record, ['format', 'config', 'credentialId', 'prfSalt', 'nonce', 'ciphertext']);
    check(record.format === BASELINE, 'BASELINE_FILE_INVALID');
    check(sameConfig(record.config, config), 'BASELINE_POLICY_MISMATCH');
    unb64(record.credentialId, 1024);
  } catch (error) { throw error?.code ? error : fail('BASELINE_FILE_INVALID'); }
  const { ciphertext, ...header } = record;
  const salt = unb64(record.prfSalt, 32, 32), nonce = unb64(record.nonce, 12, 12), encrypted = unb64(ciphertext, MAX_TEXT_BYTES + 16);
  try {
    const key = await baselineKey({ config, credential: { credentialId: record.credentialId }, prfSalt: salt, webAuthnClient });
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: encode(header), tagLength: 128 }, key, encrypted)); }
    catch { throw fail('BASELINE_AUTH_FAILED'); }
    const text = validateText(decoder.decode(plain));
    return Object.freeze({ text, textDigest: hash(plain) });
  } finally { salt.fill(0); plain?.fill(0); }
}
export function tamperTextCiphertext(bytes) {
  const record = JSON.parse(decoder.decode(bytes)), ciphertext = Buffer.from(record.ciphertext, 'base64url');
  ciphertext[Math.floor(ciphertext.length / 2)] ^= 1;
  return encode({ ...record, ciphertext: b64(ciphertext) });
}

export async function startTextDrillHosts() {
  const servers = [], records = new Map(), token = randomBytes(32).toString('base64url');
  const counts = { primary: 0, storeReads: 0, storeWrites: 0 };
  let primaryOnline = true, storeMode = 'healthy', used = false;
  const send = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
  const listen = async handler => {
    const server = createServer(handler); servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}`;
  };
  const close = async () => {
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    for (const bytes of records.values()) bytes.fill(0); records.clear();
  };
  try {
    const primaryOrigin = await listen((request, response) => { counts.primary++; send(response, primaryOnline ? 200 : 503, { synthetic: true }); });
    const reserveOrigin = await listen(async (request, response) => {
      try {
        const match = /^\/api\/reserve\/([A-Za-z0-9_-]{43})$/.exec(request.url);
        if (!match) return send(response, 404, { error: 'MISSING' });
        const locator = match[1];
        if (request.method === 'GET') {
          counts.storeReads++;
          if (storeMode === 'unavailable') return send(response, 503, { error: 'UNAVAILABLE' });
          const bytes = records.get(locator);
          if (!bytes || storeMode === 'missing') return send(response, 404, { error: 'MISSING' });
          return send(response, 200, { bytes: b64(storeMode === 'tampered' ? tamperTextCiphertext(bytes) : bytes) });
        }
        if (request.method !== 'PUT') return send(response, 405, { error: 'METHOD' });
        if (used || request.headers.authorization !== `Bearer ${token}`) return send(response, 403, { error: 'DENIED' });
        let body = ''; for await (const part of request) { body += part; if (body.length > 88000) throw fail('BODY_TOO_LARGE'); }
        const value = JSON.parse(body), bytes = unb64(value.bytes, 65536);
        if (records.has(locator)) return send(response, 409, { error: 'EXISTS' });
        used = true; records.set(locator, bytes); counts.storeWrites++; return send(response, 201, { created: true });
      } catch { send(response, 400, { error: 'INVALID' }); }
    });
    return {
      reserveOrigin,
      primaryStatus: async () => { const response = await fetch(primaryOrigin, { redirect: 'error' }); await response.body?.cancel(); return response.status; },
      setPrimaryOnline(value) { primaryOnline = Boolean(value); },
      setStoreMode(value) { check(['healthy', 'missing', 'tampered', 'unavailable'].includes(value), 'FAULT_MODE_INVALID'); storeMode = value; },
      newStore: () => loopbackStore(reserveOrigin, { enrollmentToken: token }),
      counts: () => ({ ...counts }),
      close,
    };
  } catch (error) { await close(); throw error; }
}
function loopbackStore(origin, { enrollmentToken, onFetch = () => {} } = {}) {
  const allowed = new URL(origin);
  check(allowed.protocol === 'http:' && allowed.hostname === '127.0.0.1' && allowed.origin === origin, 'NON_LOOPBACK_TARGET_REJECTED');
  return createReserveHttpStore({ ...(enrollmentToken ? { enrollmentToken } : {}), fetcher: (path, init) => {
    const target = new URL(path, origin);
    check(target.origin === origin && /^\/api\/reserve\/[A-Za-z0-9_-]{43}$/.test(target.pathname), 'NON_LOOPBACK_TARGET_REJECTED');
    if (!enrollmentToken) check(init?.method === 'GET', 'READ_ONLY_RECOVERY');
    onFetch(); return fetch(target, { ...init, redirect: 'error' });
  } });
}

// Every comparison attempt runs in a new Node process. Inputs contain only
// config, synthetic credential material and an encrypted file path; never plaintext,
// original-window state, a locator, a content key or a writable admission token.
export async function runTextDrillChild(input) {
  const auth = textDrillAuthenticator(input.credential);
  let httpRequests = 0;
  try {
    let file;
    if (input.kind === 'file') {
      try { file = new Uint8Array(await readFile(input.filePath)); }
      catch (error) { if (error.code !== 'ENOENT') throw fail('BASELINE_FILE_INVALID'); }
    }
    const opened = input.kind === 'reserve'
      ? await recoverTextReserve({ config: input.config, webAuthnClient: auth.client, store: loopbackStore(input.config.recoveryOrigin, { onFetch: () => httpRequests++ }) })
      : await importTextEncryptedFile({ bytes: file, config: input.config, webAuthnClient: auth.client });
    check(Object.keys(opened).sort().join(',') === (input.kind === 'reserve' ? 'locator,protocol,text,textDigest' : 'text,textDigest'), 'UNEXPECTED_RECOVERY_SURFACE');
    return { status: 'recovered', text: opened.text, textDigest: opened.textDigest, credentialApiCalls: { ...auth.counts }, httpRequests, noSigningSurface: true };
  } catch (error) {
    return { status: error?.code ?? 'RECOVERY_FAILED', credentialApiCalls: { ...auth.counts }, httpRequests };
  } finally { auth.close(); }
}
function inFreshProcess(input) {
  const code = `import {runTextDrillChild} from ${JSON.stringify(import.meta.url)}; let data=''; for await (const chunk of process.stdin) data+=chunk; console.log(JSON.stringify(await runTextDrillChild(JSON.parse(data))));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(fail('CHILD_TIMEOUT')); }, 15000);
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 100000) child.kill(); });
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 10000) child.kill(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(fail('CHILD_FAILED'));
      try { resolve(JSON.parse(output)); } catch { reject(fail('CHILD_RESULT_INVALID')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]));

export async function runTextRecoveryDrill({ outputDirectory, hostFactory = startTextDrillHosts } = {}) {
  const hosts = await hostFactory(), credential = { id: b64(randomBytes(24)), secret: b64(randomBytes(32)) };
  const auth = textDrillAuthenticator(credential);
  const text = `\ufeffFictional handoff — Å, 界, 🦊.\r\n\nOriginal draft.\nRun marker: ${randomBytes(12).toString('hex')}\n`;
  const config = { appId: `text-drill-${randomBytes(8).toString('hex')}`, recoveryOrigin: hosts.reserveOrigin, recoveryRpId: '127.0.0.1' };
  let handle, fileDirectory;
  try {
    check(await hosts.primaryStatus() === 200, 'PRIMARY_SETUP_NOT_AVAILABLE');
    const initial = { ...auth.counts };
    handle = await createTextReserveCredential({ config, user: { name: 'Synthetic text drill', displayName: 'Synthetic text drill' }, webAuthnClient: auth.client });
    const afterCreation = { ...auth.counts };
    const ready = await prepareTextReserve({ config, recoveryCredential: handle, text, store: hosts.newStore(), webAuthnClient: auth.client });
    check(ready.text === text && ready.independentlyVerified, 'PREPARATION_NOT_VERIFIED');
    const afterReserve = { ...auth.counts };
    const file = await createTextEncryptedFile({ text, config, credential: { credentialId: handle.credentialId }, webAuthnClient: auth.client });
    const afterFile = { ...auth.counts };
    fileDirectory = await mkdtemp(join(tmpdir(), 'continuity-text-backup-'));
    const filePaths = Object.fromEntries(['available', 'missing', 'tampered'].map(kind => [kind, join(fileDirectory, `${kind}.json`)]));
    await writeFile(filePaths.available, file);
    await writeFile(filePaths.tampered, tamperTextCiphertext(file));
    check(Buffer.from(await readFile(filePaths.available)).equals(Buffer.from(file)), 'ENCRYPTED_FILE_READBACK_FAILED');
    const fileReadiness = await inFreshProcess({ kind: 'file', config, credential, filePath: filePaths.available });
    check(fileReadiness.status === 'recovered' && fileReadiness.text === text && fileReadiness.textDigest === hash(Buffer.from(text)) && fileReadiness.httpRequests === 0, 'ENCRYPTED_FILE_NOT_INDEPENDENTLY_VERIFIED');
    handle.close(); auth.close(); hosts.setPrimaryOnline(false);
    const rows = [
      ['both-retained', 'healthy', 'available', false, 'recovered', 'recovered'],
      ['encrypted-file-missing', 'healthy', 'missing', false, 'recovered', 'BASELINE_FILE_MISSING'],
      ['reserve-record-missing', 'missing', 'available', false, 'RESERVE_MISSING', 'recovered'],
      ['reserve-service-unavailable', 'unavailable', 'available', false, 'STORE_UNAVAILABLE', 'recovered'],
      ['both-ciphertexts-altered', 'tampered', 'tampered', false, 'MANIFEST_AUTH_FAILED', 'BASELINE_AUTH_FAILED'],
      ['credential-unavailable', 'healthy', 'available', true, 'PASSKEY_OPERATION_FAILED', 'BASELINE_KEY_UNAVAILABLE'],
    ];
    const comparison = []; let healthy;
    for (const [id, mode, fileMode, lost, reserveExpected, fileExpected] of rows) {
      hosts.setStoreMode(mode);
      const observations = {};
      for (const kind of ['reserve', 'file']) {
        const primaryBefore = await hosts.primaryStatus(), httpBefore = hosts.counts();
        check(primaryBefore === 503, 'PRIMARY_NOT_OFFLINE');
        const result = await inFreshProcess({ kind, config, credential: { ...credential, ...(lost ? { secret: null } : {}) }, ...(kind === 'file' ? { filePath: filePaths[fileMode] } : {}) });
        const httpDelta = delta(hosts.counts(), httpBefore), primaryAfter = await hosts.primaryStatus();
        check(primaryAfter === 503 && httpDelta.primary === 0, 'PRIMARY_NOT_OFFLINE');
        check(result.status === (kind === 'reserve' ? reserveExpected : fileExpected), 'EXPECTED_OUTCOME_NOT_OBSERVED');
        check(result.credentialApiCalls.creates === 0 && httpDelta.storeWrites === 0, 'RECOVERY_MUTATED_STATE');
        const matches = result.status === 'recovered' ? result.text === text && result.textDigest === hash(Buffer.from(text)) && result.noSigningSurface === true : null;
        check(matches !== false, 'RECOVERED_TEXT_MISMATCH');
        if (kind === 'file') check(result.httpRequests === 0 && httpDelta.storeReads === 0, 'FILE_IMPORT_USED_HTTP');
        const { text: plaintext, ...safe } = result;
        observations[kind] = { ...safe, exactTextAndDigestMatch: matches, primaryBefore, primaryAfter, httpDelta };
        if (id === 'both-retained') { healthy ??= {}; healthy[kind] = plaintext; }
      }
      comparison.push({ id, textReserve: observations.reserve, encryptedFile: observations.file });
    }
    const finishedReserve = healthy.reserve + 'Finished locally: revised the final line.\n';
    const finishedFile = healthy.file + 'Finished locally: revised the final line.\n';
    check(finishedReserve === finishedFile, 'FINISHED_EXPORTS_DIFFER');
    const json = JSON.stringify({ format: 'continuity-text-export/v1', text: finishedReserve }, null, 2) + '\n';
    let writtenAndReadBack = false;
    if (outputDirectory) {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, 'text-reserve.txt'), finishedReserve);
      await writeFile(join(outputDirectory, 'encrypted-file.txt'), finishedFile);
      await writeFile(join(outputDirectory, 'text-reserve.json'), json);
      await writeFile(join(outputDirectory, 'encrypted-file.json'), json);
      await writeFile(join(outputDirectory, 'encrypted-backup.json'), file);
      writtenAndReadBack = (await readFile(join(outputDirectory, 'text-reserve.txt'), 'utf8')) === finishedReserve
        && (await readFile(join(outputDirectory, 'encrypted-file.txt'), 'utf8')) === finishedFile
        && (await readFile(join(outputDirectory, 'text-reserve.json'), 'utf8')) === json
        && (await readFile(join(outputDirectory, 'encrypted-file.json'), 'utf8')) === json;
      check(writtenAndReadBack, 'EXPORT_READBACK_FAILED');
    }
    check(hosts.counts().storeWrites === 1, 'RESERVE_WAS_REWRITTEN');
    const report = {
      format: 'continuity-text-drill/v1', status: 'passed', synthetic: true, protocol: TEXT_PROTOCOL,
      recoveryIsolation: 'A new Node child process for every path and fault case; config and synthetic credential only, plus an encrypted file path for file import. No plaintext, locator or writable token.',
      encryptedFileStorage: 'Written, byte-readback checked and independently imported in a fresh process before the outage; every import child reads the actual file. The missing-file case observes ENOENT.',
      originalServiceOutage: 'Real loopback HTTP 503 before and after every recovery attempt.',
      fixture: { textBytes: Buffer.byteLength(text), textSha256: hash(Buffer.from(text)), sameTextAndCredential: true, dynamicMarker: true },
      operations: { sharedCredentialCreation: delta(afterCreation, initial), reservePreparation: delta(afterReserve, afterCreation), encryptedFilePreparation: { creates: afterFile.creates - afterReserve.creates + fileReadiness.credentialApiCalls.creates, assertions: afterFile.assertions - afterReserve.assertions + fileReadiness.credentialApiCalls.assertions }, totalHttp: hosts.counts(), nativePromptsMeasured: false, humanStepsMeasured: false, signups: 0, signingActions: 0 },
      comparison,
      exports: { equalEditedText: true, equalEditedJson: true, textSha256: hash(Buffer.from(finishedReserve)), jsonSha256: hash(Buffer.from(json)), writtenAndReadBack },
      limits: [
        'Synthetic HMAC WebAuthn adapter; no native browser, physical passkey or prompt-count proof.',
        'Both stores are local test services under one operator; no provider or operator independence claim.',
        'Both methods recover when their encrypted artifact and credential survive; the file also works without reserve HTTP.',
        'Both preparations independently import before the outage. Reserve preparation reuses create-time PRF material; the file uses a separate random PRF salt. API counts are not native prompt counts or a universal efficiency ranking.',
        'The reserve helps when the export file is absent; losing the credential prevents both methods.',
        'No account, signing, chain, signup, developer adoption or human onboarding measurement.',
        'The encrypted-file format is a comparison fixture, not a supported production backup format.',
      ],
    };
    if (outputDirectory) await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally { handle?.close(); auth.close(); credential.secret = undefined; await hosts.close(); if (fileDirectory) await rm(fileDirectory, { recursive: true, force: true }); }
}
