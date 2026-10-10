import { getAddress } from 'viem';

export const MAX_PAYMENT_HISTORY = 64;
const MAX_JOURNAL_LENGTH = 131072, UINT256 = 2n ** 256n;
const fail = code => Object.assign(new Error(code), { code });
const fields = ['chainId','address','owner','rightId','amount','nonce','gas','maxFeePerGas','maxPriorityFeePerGas'];
const entryFields = ['address','rightId','amount','nonce','gas','maxFeePerGas','maxPriorityFeePerGas','selectedGas','phase','hash'];
function exact(input, names, code) {
  try {
    if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== names.length) throw 0;
    const result = {};
    for (const name of names) { const d = Object.getOwnPropertyDescriptor(input, name); if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw 0; result[name] = d.value; }
    return result;
  } catch { throw fail(code); }
}
function address(value, code) {
  try { const normalized = getAddress(value).toLowerCase(); if (/^0x0{40}$/.test(normalized)) throw 0; return normalized; }
  catch { throw fail(code); }
}
function scope(input) {
  if (!input || ![31337,10143].includes(input.chainId)) throw fail('PAYMENT_POLICY_INVALID');
  return Object.freeze({ chainId: input.chainId, owner: address(input.owner, 'PAYMENT_POLICY_INVALID') });
}
export function validatePaymentPolicy(input) {
  const p = exact(input, fields, 'PAYMENT_POLICY_INVALID');
  if (![31337,10143].includes(p.chainId) || !Number.isSafeInteger(p.nonce) || p.nonce < 0) throw fail('PAYMENT_POLICY_INVALID');
  p.address = address(p.address, 'PAYMENT_POLICY_INVALID'); p.owner = address(p.owner, 'PAYMENT_POLICY_INVALID');
  if (p.address === p.owner) throw fail('PAYMENT_POLICY_INVALID');
  for (const name of ['rightId','amount','gas','maxFeePerGas','maxPriorityFeePerGas']) if (typeof p[name] !== 'bigint' || p[name] < (name === 'maxPriorityFeePerGas' ? 0n : 1n) || p[name] >= UINT256) throw fail('PAYMENT_POLICY_INVALID');
  if (p.maxPriorityFeePerGas > p.maxFeePerGas) throw fail('PAYMENT_POLICY_INVALID');
  return Object.freeze(p);
}
function decimal(value, allowZero = false) {
  if (typeof value !== 'string' || value.length > 78 || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw fail('PAYMENT_JOURNAL_INVALID');
  const number = BigInt(value); if (number < (allowZero ? 0n : 1n) || number >= UINT256) throw fail('PAYMENT_JOURNAL_INVALID'); return number;
}
export function paymentEntryPolicy(entry, suppliedScope) {
  return validatePaymentPolicy({ chainId: suppliedScope.chainId, owner: suppliedScope.owner, address: entry.address,
    rightId: BigInt(entry.rightId), amount: BigInt(entry.amount), nonce: entry.nonce, gas: BigInt(entry.gas), maxFeePerGas: BigInt(entry.maxFeePerGas), maxPriorityFeePerGas: BigInt(entry.maxPriorityFeePerGas) });
}
export function paymentEntry(policy, selectedGas) {
  const p = validatePaymentPolicy(policy);
  if (typeof selectedGas !== 'bigint' || selectedGas <= 0n || selectedGas > p.gas) throw fail('PAYMENT_GAS_INVALID');
  return Object.freeze({ address: p.address, rightId: String(p.rightId), amount: String(p.amount), nonce: p.nonce, gas: String(p.gas), maxFeePerGas: String(p.maxFeePerGas), maxPriorityFeePerGas: String(p.maxPriorityFeePerGas), selectedGas: String(selectedGas), phase: 'reserved', hash: null });
}
export function validatePaymentJournal(input, suppliedScope) {
  try {
    const s = scope(suppliedScope), j = exact(input, ['version','chainId','owner','active','entries'], 'PAYMENT_JOURNAL_INVALID');
    if (j.version !== 1 || j.chainId !== s.chainId || j.owner !== s.owner || !Array.isArray(j.entries) || j.entries.length < 1 || j.entries.length > MAX_PAYMENT_HISTORY || Reflect.ownKeys(j.entries).length !== j.entries.length + 1) throw 0;
    const ids = new Set(), hashes = new Set(); let previousNonce = -1;
    const entries = Array.from({ length: j.entries.length }, (_, index) => {
      const d = Object.getOwnPropertyDescriptor(j.entries, String(index)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw 0;
      const e = exact(d.value, entryFields, 'PAYMENT_JOURNAL_INVALID');
      if (e.address !== address(e.address, 'PAYMENT_JOURNAL_INVALID') || e.address === s.owner || !Number.isSafeInteger(e.nonce) || e.nonce <= previousNonce) throw 0;
      previousNonce = e.nonce;
      const id = e.address + ':' + e.rightId; if (ids.has(id)) throw 0; ids.add(id);
      for (const name of ['rightId','amount','gas','maxFeePerGas','selectedGas']) decimal(e[name]); decimal(e.maxPriorityFeePerGas, true);
      if (BigInt(e.selectedGas) > BigInt(e.gas) || BigInt(e.maxPriorityFeePerGas) > BigInt(e.maxFeePerGas)) throw 0;
      if (!['reserved','signed','confirmed'].includes(e.phase) || index < j.entries.length - 1 && e.phase !== 'confirmed') throw 0;
      if (e.phase === 'reserved') { if (e.hash !== null) throw 0; }
      else { if (typeof e.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(e.hash) || hashes.has(e.hash)) throw 0; hashes.add(e.hash); }
      return Object.freeze(e);
    });
    if (j.active !== (entries.at(-1).phase === 'confirmed' ? null : entries.length - 1)) throw 0;
    return Object.freeze({ version: 1, chainId: s.chainId, owner: s.owner, active: j.active, entries: Object.freeze(entries) });
  } catch { throw fail('PAYMENT_JOURNAL_INVALID'); }
}
function method(object, name, code) {
  try {
    let cursor = object;
    for (let i = 0; cursor && i < 8; i++, cursor = Object.getPrototypeOf(cursor)) { const d = Object.getOwnPropertyDescriptor(cursor, name); if (d) { if (!Object.hasOwn(d, 'value') || typeof d.value !== 'function') throw 0; return d.value.bind(object); } }
  } catch { /* fixed error below */ }
  throw fail(code);
}
function transition(previous, next) {
  if (!previous) return next.entries.length === 1 && next.active === 0 && next.entries[0].phase === 'reserved';
  const a = previous.entries, b = next.entries;
  if (previous.active === null) return a.length < MAX_PAYMENT_HISTORY && b.length === a.length + 1 && next.active === a.length && b.at(-1).phase === 'reserved' && a.every((e, i) => JSON.stringify(e) === JSON.stringify(b[i]));
  if (a.length !== b.length || !a.slice(0, -1).every((e, i) => JSON.stringify(e) === JSON.stringify(b[i]))) return false;
  const before = a.at(-1), after = b.at(-1);
  if (entryFields.filter(name => !['phase','hash'].includes(name)).some(name => before[name] !== after[name])) return false;
  return before.phase === 'reserved' && after.phase === 'signed' && next.active === previous.active
    || before.phase === 'signed' && after.phase === 'confirmed' && before.hash === after.hash && next.active === null;
}

/** Durable at-most-once coordination for cooperating tabs on this origin only.
 * This is not cross-device coordination or protection against storage deletion
 * or hostile same-origin code. No signed bytes, keys or receipts are persisted. */
export function createBrowserPaymentPendingStore(options) {
  let captured;
  try {
    const names = Reflect.ownKeys(options ?? {});
    if (names.some(n => !['chainId','owner','storage','locks'].includes(n)) || !names.includes('chainId') || !names.includes('owner')) throw 0;
    captured = exact(options, names, 'PAYMENT_STORE_INVALID');
  } catch { throw fail('PAYMENT_STORE_INVALID'); }
  const s = scope(captured), key = `continuitykit:payment-journal:v1:${s.chainId}:${s.owner}`, lockKey = key + ':lock';
  let storage, locks;
  try { storage = Object.hasOwn(captured, 'storage') ? captured.storage : globalThis.localStorage; locks = Object.hasOwn(captured, 'locks') ? captured.locks : globalThis.navigator?.locks; }
  catch { throw fail('PAYMENT_STORE_UNAVAILABLE'); }
  const get = method(storage, 'getItem', 'PAYMENT_STORE_UNAVAILABLE'), set = method(storage, 'setItem', 'PAYMENT_STORE_UNAVAILABLE'), request = method(locks, 'request', 'PAYMENT_LOCK_UNAVAILABLE');
  let locked = false;
  function read() {
    let raw; try { raw = get(key); } catch { throw fail('PAYMENT_STORE_UNAVAILABLE'); }
    if (raw === null) return undefined;
    if (typeof raw !== 'string' || !raw.length || raw.length > MAX_JOURNAL_LENGTH) throw fail('PAYMENT_JOURNAL_INVALID');
    let value; try { value = validatePaymentJournal(JSON.parse(raw), s); } catch { throw fail('PAYMENT_JOURNAL_INVALID'); }
    if (JSON.stringify(value) !== raw) throw fail('PAYMENT_JOURNAL_INVALID'); return value;
  }
  return Object.freeze({
    read,
    put(input) {
      if (!locked) throw fail('PAYMENT_LOCK_REQUIRED');
      const next = validatePaymentJournal(input, s), previous = read();
      if (!transition(previous, next)) throw fail('PAYMENT_JOURNAL_CONFLICT');
      const raw = JSON.stringify(next); if (raw.length > MAX_JOURNAL_LENGTH) throw fail('PAYMENT_JOURNAL_INVALID');
      try { set(key, raw); } catch { throw fail('PAYMENT_STORE_UNAVAILABLE'); }
      if (JSON.stringify(read()) !== raw) throw fail('PAYMENT_STORE_READBACK_FAILED');
    },
    async withLock(callback) {
      if (typeof callback !== 'function') throw fail('PAYMENT_LOCK_UNAVAILABLE');
      let entered = false;
      try { const result = await request(lockKey, { mode: 'exclusive' }, async lock => {
        if (entered || locked || !lock || lock.name !== lockKey || lock.mode !== 'exclusive') throw fail('PAYMENT_LOCK_UNAVAILABLE');
        entered = true; locked = true;
        try { return await callback(); } finally { locked = false; }
      }); if (!entered || locked) throw fail('PAYMENT_LOCK_UNAVAILABLE'); return result; } catch (error) { if (entered) throw error; throw fail('PAYMENT_LOCK_UNAVAILABLE'); }
    },
  });
}
