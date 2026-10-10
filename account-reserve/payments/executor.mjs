import { decodeEventLog, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';
import { MAX_PAYMENT_HISTORY, paymentEntry, paymentEntryPolicy, validatePaymentJournal, validatePaymentPolicy } from './pending.mjs';

const ABI = parseAbi(['function claim(uint256 id)', 'event RightClaimed(uint256 indexed id, address indexed beneficiary, uint256 amount)']);
const CLAIM_TOPIC = encodeEventTopics({ abi: ABI, eventName: 'RightClaimed' })[0];
const fail = code => Object.assign(new Error(code), { code });
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function value(object, name) { try { const d = Object.getOwnPropertyDescriptor(object, name); if (d && Object.hasOwn(d, 'value')) return d.value; } catch {} throw fail('PAYMENT_OPTIONS_INVALID'); }
function method(object, name) {
  try { for (let cursor = object, n = 0; cursor && n < 8; cursor = Object.getPrototypeOf(cursor), n++) { const d = Object.getOwnPropertyDescriptor(cursor, name); if (d) { if (typeof d.value !== 'function') throw 0; return d.value.bind(object); } } } catch {}
  throw fail('PAYMENT_OPTIONS_INVALID');
}
function arrayValues(input, limit) {
  if (!Array.isArray(input)) throw 0;
  const length = value(input, 'length');
  if (!Number.isSafeInteger(length) || length < 0 || length > limit || Reflect.ownKeys(input).length !== length + 1) throw 0;
  return Array.from({ length }, (_, index) => value(input, String(index)));
}
const errorCode = (error, fallback) => { try { const d = Object.getOwnPropertyDescriptor(error, 'code'); return typeof d?.value === 'string' && /^PAYMENT_[A-Z0-9_]{1,88}$/.test(d.value) ? d.value : fallback; } catch { return fallback; } };
const policyEqual = (a, b) => Object.keys(a).every(name => a[name] === b[name]);

/** One fixed reviewed intent per executor. Every unfinished attempt blocks the
 * same account across contracts until a matching successful receipt is verified.
 * The supplied client must corroborate public-testnet receipts independently. */
export function createPaymentExecutor(options, guards) {
  const wallet = value(options, 'wallet'), publicClient = value(options, 'publicClient'), policy = validatePaymentPolicy(value(options, 'policy')), store = value(options, 'pendingStore');
  const account = value(wallet, 'account'), chain = value(wallet, 'chain');
  const prepare = method(wallet, 'prepareTransactionRequest'), sign = method(wallet, 'signTransaction');
  const chainId = method(publicClient, 'getChainId'), send = method(publicClient, 'sendRawTransaction'), receiptFor = method(publicClient, 'getTransactionReceipt');
  const read = method(store, 'read'), put = method(store, 'put'), lock = method(store, 'withLock');
  const beforePrepare = method(guards, 'beforePrepare'), beforeBroadcast = method(guards, 'beforeBroadcast'), beforeCheck = method(guards, 'beforeCheck');
  const scope = Object.freeze({ chainId: policy.chainId, owner: policy.owner });
  let closed = false, promise, hash, deliveryStatus = 'not-attempted';
  function active() {
    if (closed) throw fail('PAYMENT_SESSION_CLOSED');
    try { if (value(wallet, 'account') !== account || value(wallet, 'chain') !== chain || !equal(value(account, 'address'), policy.owner) || value(chain, 'id') !== policy.chainId) throw 0; } catch { throw fail('PAYMENT_SIGNER_CHANGED'); }
  }
  active();
  async function external(fn, args, fallback) { try { return await fn(...args); } catch (error) { throw fail(errorCode(error, fallback)); } }
  async function hydrate() { const result = await external(read, [], 'PAYMENT_STORE_UNAVAILABLE'); active(); return result === undefined ? undefined : validatePaymentJournal(result, scope); }
  async function save(journal) {
    active(); const next = validatePaymentJournal(journal, scope);
    await external(put, [next], 'PAYMENT_STORE_UNAVAILABLE'); active();
    const actual = await hydrate(); if (JSON.stringify(actual) !== JSON.stringify(next)) throw fail('PAYMENT_STORE_READBACK_FAILED'); return next;
  }
  function withEntry(journal, entry, add = false) {
    const entries = add ? [...(journal?.entries ?? []), entry] : [...journal.entries.slice(0, -1), entry];
    return { version: 1, ...scope, active: entry.phase === 'confirmed' ? null : entries.length - 1, entries };
  }
  function validateTransaction(tx, data, gas, signed = false) {
    try {
    const names = ['chainId','type','to','data','value','gas','maxFeePerGas','maxPriorityFeePerGas','nonce'];
    const t = {}; for (const name of names) { try { t[name] = signed && ['value','maxPriorityFeePerGas'].includes(name) && !Object.hasOwn(tx, name) ? 0n : value(tx, name); } catch { throw fail('PAYMENT_TRANSACTION_MISMATCH'); } }
    if (t.chainId !== policy.chainId || t.type !== 'eip1559' || !equal(t.to, policy.address) || t.data !== data || t.value !== 0n || t.gas !== gas || t.maxFeePerGas !== policy.maxFeePerGas || t.maxPriorityFeePerGas !== policy.maxPriorityFeePerGas || t.nonce !== policy.nonce) throw fail('PAYMENT_TRANSACTION_MISMATCH');
    for (const name of Reflect.ownKeys(tx)) {
      const d = Object.getOwnPropertyDescriptor(tx, name); if (!d || !Object.hasOwn(d, 'value')) throw fail('PAYMENT_TRANSACTION_MISMATCH');
      if (name === 'accessList' && arrayValues(d.value, 0).length !== 0) throw fail('PAYMENT_TRANSACTION_MISMATCH');
      if (name === 'authorizationList' && d.value !== undefined || ['gasPrice','blobs','blobVersionedHashes','maxFeePerBlobGas'].includes(name)) throw fail('PAYMENT_TRANSACTION_MISMATCH');
      if (!names.includes(name) && !['account','chain','from','accessList','authorizationList','r','s','v','yParity'].includes(name)) throw fail('PAYMENT_TRANSACTION_MISMATCH');
      if (name === 'account' && d.value !== account || name === 'chain' && d.value !== chain || name === 'from' && !equal(d.value, policy.owner)) throw fail('PAYMENT_TRANSACTION_MISMATCH');
    }
    } catch { throw fail('PAYMENT_TRANSACTION_MISMATCH'); }
  }
  async function checked(entry) {
    active(); const previousPolicy = paymentEntryPolicy(entry, scope);
    await external(beforeCheck, [], 'PAYMENT_CHECK_FAILED'); active();
    if (await external(chainId, [], 'PAYMENT_CHAIN_UNAVAILABLE') !== policy.chainId) throw fail('PAYMENT_CHAIN_MISMATCH'); active();
    let receipt;
    try { receipt = await receiptFor({ hash: entry.hash, policy: previousPolicy }); }
    catch (error) {
      active(); const d = error && Object.getOwnPropertyDescriptor(error, 'name');
      if (d?.value === 'TransactionReceiptNotFoundError') return undefined;
      throw fail(errorCode(error, 'PAYMENT_RECEIPT_UNAVAILABLE'));
    }
    active();
    let details;
    try { details = Object.fromEntries(['transactionHash','to','from','status','logs'].map(name => [name, value(receipt, name)])); } catch { throw fail('PAYMENT_RECEIPT_MISMATCH'); }
    if (!equal(details.transactionHash, entry.hash) || !equal(details.to, entry.address) || !equal(details.from, policy.owner)) throw fail('PAYMENT_RECEIPT_MISMATCH');
    if (details.status !== 'success') throw fail('PAYMENT_REVERTED');
    let logs;
    try { logs = arrayValues(details.logs, 1024); } catch { throw fail('PAYMENT_EVENT_MISMATCH'); }
    const events = [];
    for (const log of logs) {
      try {
        if (!equal(value(log, 'address'), entry.address)) continue;
        const captured = arrayValues(value(log, 'topics'), 4);
        if (captured[0] !== CLAIM_TOPIC) continue;
        if (Object.hasOwn(log, 'removed') && value(log, 'removed') !== false) throw 0;
        const event = decodeEventLog({ abi: ABI, data: value(log, 'data'), topics: captured, strict: true });
        events.push(event.args);
      } catch { throw fail('PAYMENT_EVENT_MISMATCH'); }
    }
    if (events.length !== 1 || events[0].id !== previousPolicy.rightId || !equal(events[0].beneficiary, policy.owner) || events[0].amount !== previousPolicy.amount) throw fail('PAYMENT_EVENT_MISMATCH');
    return receipt;
  }
  async function reconcile(journal, index) {
    const entry = journal.entries[index]; hash = entry.hash ?? undefined; deliveryStatus = 'unknown';
    if (entry.phase === 'reserved') throw fail('PAYMENT_RECONCILIATION_REQUIRED');
    const receipt = await checked(entry); active();
    if (!receipt) return Object.freeze({ hash: entry.hash });
    if (entry.phase === 'signed') journal = await save(withEntry(journal, { ...entry, phase: 'confirmed' }));
    deliveryStatus = 'confirmed'; return Object.freeze({ hash: entry.hash, receipt });
  }
  function selectedIndex(journal) { return journal?.entries.findIndex(e => e.address === policy.address && e.rightId === String(policy.rightId)) ?? -1; }
  async function claim() {
    let journal = await hydrate();
    const index = selectedIndex(journal);
    if (index >= 0) {
      if (!policyEqual(paymentEntryPolicy(journal.entries[index], scope), policy)) throw fail('PAYMENT_INTENT_MISMATCH');
      return reconcile(journal, index);
    }
    if (journal?.active !== null && journal?.active !== undefined) throw fail('PAYMENT_ACCOUNT_BLOCKED');
    if (journal?.entries.length >= MAX_PAYMENT_HISTORY) throw fail('PAYMENT_HISTORY_FULL');
    if (journal?.entries.length) {
      if (policy.nonce <= journal.entries.at(-1).nonce) throw fail('PAYMENT_NONCE_REUSED');
      if (!await checked(journal.entries.at(-1))) throw fail('PAYMENT_PRIOR_CONFIRMATION_REQUIRED');
      active();
    }
    if (await external(chainId, [], 'PAYMENT_CHAIN_UNAVAILABLE') !== policy.chainId) throw fail('PAYMENT_CHAIN_MISMATCH'); active();
    const gas = await external(beforePrepare, [], 'PAYMENT_PREFLIGHT_FAILED'); active();
    const entry = paymentEntry(policy, gas); journal = await save(withEntry(journal, entry, true));
    const data = encodeFunctionData({ abi: ABI, functionName: 'claim', args: [policy.rightId] });
    const request = await external(prepare, [{ account, chain, chainId: policy.chainId, type: 'eip1559', to: policy.address, data, value: 0n, nonce: policy.nonce, gas, maxFeePerGas: policy.maxFeePerGas, maxPriorityFeePerGas: policy.maxPriorityFeePerGas }], 'PAYMENT_PREPARATION_FAILED');
    active(); validateTransaction(request, data, gas);
    const serializedTransaction = await external(sign, [request], 'PAYMENT_SIGNING_FAILED'); active();
    try {
      if (typeof serializedTransaction !== 'string' || serializedTransaction.length > 4096 || !/^0x02[0-9a-f]+$/i.test(serializedTransaction)) throw 0;
      validateTransaction(parseTransaction(serializedTransaction), data, gas, true);
      if (!equal(await recoverTransactionAddress({ serializedTransaction }), policy.owner)) throw fail('PAYMENT_SIGNED_OWNER_MISMATCH');
    } catch (error) { throw fail(errorCode(error, 'PAYMENT_SIGNED_TRANSACTION_INVALID')); }
    active(); hash = keccak256(serializedTransaction); journal = await save(withEntry(journal, { ...entry, phase: 'signed', hash }));
    await external(beforeBroadcast, [Object.freeze({ gas })], 'PAYMENT_BROADCAST_GUARD_FAILED'); active();
    deliveryStatus = 'attempted';
    const returned = await external(send, [{ serializedTransaction }], 'PAYMENT_BROADCAST_UNKNOWN'); active();
    if (!equal(returned, hash)) throw fail('PAYMENT_BROADCAST_HASH_MISMATCH');
    return reconcile(journal, journal.entries.length - 1);
  }
  async function check() {
    const journal = await hydrate(), index = selectedIndex(journal);
    if (index < 0) throw fail('PAYMENT_TRANSACTION_MISSING');
    if (!policyEqual(paymentEntryPolicy(journal.entries[index], scope), policy)) throw fail('PAYMENT_INTENT_MISMATCH');
    return reconcile(journal, index);
  }
  function run(action) {
    active(); if (promise) return promise;
    promise = Promise.resolve().then(() => lock(async () => { active(); return action(); })).finally(() => { promise = undefined; }); return promise;
  }
  return Object.freeze({ claim: () => run(claim), check: () => run(check), close() { closed = true; }, get hash() { return hash; }, get deliveryStatus() { return deliveryStatus; } });
}
