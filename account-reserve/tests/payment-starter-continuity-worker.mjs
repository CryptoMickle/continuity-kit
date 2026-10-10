// TEST ONLY. Copied beside a clean generated consumer after its production build.
// Browser globals emulate one existing credential; no physical authenticator,
// public network, production module edits or SDK factory substitutions occur.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { keccak256 } from 'viem';

const directory = dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 45000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('GENERATED_PAGE_WAIT_FAILED: ' + label); await delay(10); }
}

export async function runGeneratedPaymentProof(input) {
  assert.deepEqual(Object.keys(input).sort(), ['phase', 'profile', 'primaryUrl', 'recoveryUrl', 'rpcUrl', 'jsdomPackage', ...(input.phase === 'claim' ? ['credential'] : ['journal'])].sort());
  assert.ok(['claim', 'reconcile'].includes(input.phase));
  assert.equal(input.profile.payment.chainId, 10143);
  for (const name of ['primaryUrl', 'recoveryUrl', 'rpcUrl']) { const url = new URL(input[name]); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); }
  const require = createRequire(input.jsdomPackage), { JSDOM } = require('jsdom');
  const dom = new JSDOM(await readFile(join(directory, 'index.html'), 'utf8'), { url: input.profile.recoveryOrigin + '/', pretendToBeVisual: true });
  const $ = id => dom.window.document.getElementById(id);
  const counts = { config: 0, reserveGets: 0, reserveWrites: 0, primary: 0, nativeGet: 0, nativeCreate: 0, rpc: 0, sends: 0, acceptedSends: 0, journalReads: 0, journalWrites: 0, locks: 0 };
  const values = new Map(input.journal ?? []), journalHistory = [];
  const storage = { getItem(key) { counts.journalReads++; return values.get(key) ?? null; }, setItem(key, value) {
    assert.equal(key, 'continuitykit:payment-journal:v1:10143:' + input.profile.payment.owner.toLowerCase());
    assert.doesNotMatch(value, /privateKey|serializedTransaction|prfOutput|credentialId|ciphertext/);
    counts.journalWrites++; values.set(key, value); journalHistory.push(JSON.parse(value));
  } };
  const journal = () => { assert.equal(values.size, 1); return JSON.parse([...values.values()][0]); };
  let queue = Promise.resolve();
  const locks = { request(name, options, callback) {
    assert.equal(name, 'continuitykit:payment-journal:v1:10143:' + input.profile.payment.owner.toLowerCase() + ':lock');
    assert.deepEqual(options, { mode: 'exclusive' }); counts.locks++;
    const next = queue.then(() => callback({ name, mode: 'exclusive' })); queue = next.catch(() => {}); return next;
  } };
  const credentialId = input.credential && Buffer.from(input.credential.id, 'base64url');
  const credentialSecret = input.credential && Buffer.from(input.credential.secret, 'base64url');
  const prfOutputs = [];
  const credentials = {
    create() { counts.nativeCreate++; throw new Error('NEW_CREDENTIAL_FORBIDDEN'); },
    async get({ publicKey, signal }) {
      counts.nativeGet++;
      assert.equal(input.phase, 'claim', 'fresh receipt page has no credential material');
      assert.equal(publicKey.rpId, input.profile.reserve.recoveryRpId); assert.equal(signal.aborted, false);
      assert.equal(publicKey.userVerification, 'required');
      if (publicKey.allowCredentials) { assert.equal(publicKey.allowCredentials.length, 1); assert.deepEqual(Buffer.from(publicKey.allowCredentials[0].id), credentialId); }
      const salt = publicKey.extensions.prf.eval.first; assert.ok(salt instanceof Uint8Array);
      const output = new Uint8Array(createHmac('sha256', credentialSecret).update(salt).digest()); prfOutputs.push(output);
      return { type: 'public-key', rawId: Uint8Array.from(credentialId).buffer,
        getClientExtensionResults: () => ({ prf: { results: { first: output.buffer } } }) };
    },
  };
  const originalFetch = globalThis.fetch;
  const allowedRpc = new Set(['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_getBalance', 'eth_sendRawTransaction', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory']);
  const rpcOrigins = new Set(['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com']);
  let acceptedHash;
  globalThis.fetch = async (resource, init = {}) => {
    const supplied = typeof resource === 'string' || resource instanceof URL ? String(resource) : resource.url;
    const url = new URL(supplied, input.profile.recoveryOrigin);
    if (url.origin === input.profile.originalOrigin) { counts.primary++; throw new Error('ORIGINAL_APP_REQUEST_FORBIDDEN'); }
    if (url.origin === input.profile.recoveryOrigin) {
      assert.equal(init.method, 'GET'); assert.equal(init.mode, 'same-origin'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
      if (url.pathname === '/payment-config.json') counts.config++;
      else { assert.match(url.pathname, /^\/api\/reserve\/[A-Za-z0-9_-]{43}$/); counts.reserveGets++; }
      const local = new URL(url.pathname, input.recoveryUrl);
      return originalFetch(local, { ...init, headers: { ...init.headers, Host: url.host } });
    }
    assert.ok(rpcOrigins.has(url.origin) && url.pathname === '/' && !url.search && !url.hash, 'network outside fixed SDK endpoints is forbidden');
    assert.equal(init.method, 'POST'); const request = JSON.parse(init.body);
    assert.ok(!Array.isArray(request) && allowedRpc.has(request.method), 'page cannot invoke administrative RPC'); counts.rpc++;
    if (request.method === 'eth_sendRawTransaction') {
      assert.equal(input.phase, 'claim'); counts.sends++; assert.equal(counts.sends, 1, 'never replay an uncertain broadcast');
      const hash = keccak256(request.params[0]), saved = journal();
      assert.equal(saved.entries.length, 1); assert.equal(saved.active, 0); assert.equal(saved.entries[0].phase, 'signed'); assert.equal(saved.entries[0].hash, hash);
      assert.deepEqual(journalHistory.map(value => value.entries.at(-1).phase), ['reserved', 'signed']);
      // Forward the original JSON-RPC bytes unchanged. Lose the reply only after
      // the owned EVM confirms acceptance of this exact signed transaction.
      const response = await originalFetch(input.rpcUrl, init), payload = await response.json();
      assert.equal(payload.error, undefined); assert.equal(payload.result, hash); acceptedHash = hash; counts.acceptedSends++;
      throw new Error('TEST_ONLY_ACCEPTED_REPLY_LOST');
    }
    return originalFetch(input.rpcUrl, init);
  };
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location,
    navigator: { credentials, locks }, localStorage: storage, PublicKeyCredential: class {}, isSecureContext: true })) Object.defineProperty(globalThis, name, { configurable: true, value });
  globalThis.__paymentProofObservation = { sessions: [], actions: [] };
  const mainUrl = pathToFileURL(join(directory, 'main.mjs')).href, observerUrl = pathToFileURL(join(directory, 'proof-observer.mjs')).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === './actions.mjs' && context.parentURL === mainUrl) return { url: observerUrl, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === pathToFileURL(join(directory, 'style.css')).href) return { format: 'module', source: 'export default undefined;', shortCircuit: true };
      return next(url, context);
    },
  });
  try {
    await import(mainUrl);
    assert.ok($('payment-right'), $('app').textContent);
    assert.equal($('payment-right').value, '1'); assert.equal($('payment-status').dataset.state, 'idle');
    assert.equal(counts.config, 1); assert.equal(counts.rpc, 0); assert.equal(counts.nativeGet, 0); assert.equal(counts.reserveGets, 0);
    assert.equal(counts.journalReads, 0); assert.equal(counts.journalWrites, 0); assert.equal(counts.locks, 0);
    assert.equal(globalThis.__paymentProofObservation.actions.length, 1);
    if (input.phase === 'claim') {
      $('availability').click(); await until(() => !$('open').disabled, 'funded before opening');
      assert.equal($('payment-status').dataset.state, 'funded'); assert.equal(counts.nativeGet, 0); assert.equal(values.size, 0);
      assert.equal(counts.journalReads, 0); assert.equal(counts.journalWrites, 0); assert.equal(counts.locks, 0);
      const assertionsBeforeClick = counts.nativeGet;
      $('open').click(); assert.equal(counts.nativeGet, assertionsBeforeClick + 1, 'first existing-key assertion begins in the deliberate click stack');
      await until(() => !$('collect').disabled, 'default SDK existing reserve recovery');
      assert.ok(counts.nativeGet >= 1); assert.equal(counts.nativeCreate, 0); assert.equal(counts.reserveGets, 1); assert.equal(counts.sends, 0);
      const session = globalThis.__paymentProofObservation.sessions[0]; assert.equal(session.owner.toLowerCase(), input.profile.payment.owner.toLowerCase());
      assert.equal(session.account.address.toLowerCase(), input.profile.payment.owner.toLowerCase());
      $('collect').click(); $('collect').click();
      await until(() => counts.acceptedSends === 1 && !$('check').disabled, 'accepted send with lost reply');
      assert.equal($('payment-title').textContent, 'An earlier attempt needs attention.');
      assert.equal($('payment-hash').textContent, acceptedHash); assert.equal($('payment-receipt').hidden, false);
      assert.equal($('open').disabled, true); assert.equal($('collect').disabled, true);
      assert.equal(journal().entries[0].phase, 'signed'); assert.equal(journal().entries[0].hash, acceptedHash);
      await assert.rejects(session.account.signMessage({ message: 'ended after the uncertain claim' }), error => error.code === 'SESSION_ENDED');
      const requestsBefore = { rpc: counts.rpc, native: counts.nativeGet };
      $('payment-right').value = '2'; $('payment-right').dispatchEvent(new dom.window.Event('change'));
      assert.equal($('payment-right').value, '2'); assert.equal($('open').disabled, true); assert.equal($('collect').disabled, true);
      assert.match($('unresolved').textContent, /Unresolved payment: 1/); $('open').click(); $('collect').click();
      assert.equal(counts.nativeGet, requestsBefore.native); assert.equal(counts.rpc, requestsBefore.rpc); assert.equal(counts.sends, 1);
      $('payment-right').value = '1'; $('payment-right').dispatchEvent(new dom.window.Event('change'));
      assert.equal($('payment-hash').textContent, acceptedHash);
      assert.equal(globalThis.__paymentProofObservation.actions[0].isOpen, false);
    } else {
      assert.equal(input.credential, undefined); assert.equal(journal().entries[0].phase, 'signed');
      $('check').click(); await until(() => $('payment-status').dataset.state === 'confirmed' && !$('check').disabled, 'fresh-page finalized reconciliation');
      assert.equal($('payment-title').textContent, 'Payment received.'); assert.equal($('payment-hash').textContent, journal().entries[0].hash);
      assert.equal(journal().entries[0].phase, 'confirmed'); assert.equal(journal().active, null);
      assert.equal(counts.nativeGet, 0); assert.equal(counts.reserveGets, 0); assert.equal(counts.sends, 0);
      assert.equal(globalThis.__paymentProofObservation.sessions.length, 0); assert.equal($('open').disabled, true); assert.equal($('collect').disabled, true);
      // Repeated explicit reconciliation remains read-only at the transaction layer.
      $('check').click(); await until(() => !$('check').disabled, 'repeat existing receipt read');
      assert.equal(journal().entries[0].phase, 'confirmed'); assert.equal(counts.journalWrites, 1); assert.equal(counts.sends, 0);
    }
    assert.equal(counts.primary, 0); assert.equal(counts.reserveWrites, 0); assert.equal(counts.nativeCreate, 0);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    assert.equal($('payment-status').dataset.state, 'closed');
    for (const session of globalThis.__paymentProofObservation.sessions) await assert.rejects(session.account.signMessage({ message: 'closed after page exit' }), error => error.code === 'SESSION_ENDED');
    return { phase: input.phase, counts, journal: [...values], hash: acceptedHash ?? journal().entries[0].hash,
      originalRequests: 0, signerEnded: input.phase === 'claim', sourceBodiesUnchanged: true, cssLoaderAndTransparentSessionObserver: true, nativePasskey: false, publicNetwork: false };
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    for (const actions of globalThis.__paymentProofObservation.actions) actions.dispose();
    for (const session of globalThis.__paymentProofObservation.sessions) session.close();
    credentialSecret?.fill(0); credentialId?.fill(0); for (const output of prfOutputs) output.fill(0);
    hooks.deregister(); dom.window.close();
    // Keep the allowlisted loopback forwarding active until this disposable
    // process exits, including any late SDK reads after a failing assertion.
    delete globalThis.__paymentProofObservation;
  }
}

if (process.send) process.once('message', async input => {
  try { process.send({ ok: true, result: await runGeneratedPaymentProof(input) }); }
  catch (error) { process.send({ ok: false, error: String(error?.stack ?? error) }); }
  finally { process.disconnect(); }
});
