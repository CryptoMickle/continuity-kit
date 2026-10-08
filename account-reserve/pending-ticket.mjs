import { getAddress } from 'viem';

const fail = code => Object.assign(new Error(code), { code });
const keys = ['version', 'chainId', 'address', 'owner', 'rightId', 'phase', 'hash'];

// Public metadata only. A ticket is a fail-closed browser safety record, not
// cryptographic authorization, a cross-device lock, or proof a send occurred.
export function validatePendingTicket(ticket, scope) {
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket) || Object.keys(ticket).length !== keys.length || keys.some(key => !Object.hasOwn(ticket, key))) throw fail('PENDING_TICKET_INVALID');
  if (ticket.version !== 1 || ticket.chainId !== scope.chainId || ticket.address !== scope.address.toLowerCase() || ticket.owner !== scope.owner.toLowerCase() || typeof ticket.rightId !== 'string' || !/^[1-9][0-9]{0,77}$/.test(ticket.rightId) || BigInt(ticket.rightId) >= 2n ** 256n || !['reserved', 'signed'].includes(ticket.phase) || (ticket.phase === 'reserved' ? ticket.hash !== null : typeof ticket.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(ticket.hash))) throw fail('PENDING_TICKET_INVALID');
  return Object.freeze({ ...ticket });
}

export function createBrowserPendingStore(options) {
  if (options.chainId !== 31337) throw fail('LOCAL_CHAIN_REQUIRED');
  return scopedBrowserStore(options);
}

// Internal entry for the reviewed public-client wrapper. Ordinary callers keep
// the 31337-only API; this never signs or broadcasts anything.
export function __createTestnetPendingStore(options) {
  if (options.chainId !== 10143) throw fail('REVIEWED_TESTNET_REQUIRED');
  return scopedBrowserStore(options);
}

function scopedBrowserStore({ chainId, address, owner, storage = globalThis.localStorage, locks = globalThis.navigator?.locks }) {
  address = getAddress(address).toLowerCase(); owner = getAddress(owner).toLowerCase();
  if (typeof locks?.request !== 'function') throw fail('PENDING_LOCK_UNAVAILABLE');
  if (typeof storage?.getItem !== 'function' || typeof storage?.setItem !== 'function') throw fail('PENDING_STORE_UNAVAILABLE');
  const scope = { chainId, address, owner };
  const key = `continuity-reserve:pending-v1:${chainId}:${address}:${owner}`;
  async function read() {
    let raw;
    try { raw = storage.getItem(key); } catch { throw fail('PENDING_STORE_UNAVAILABLE'); }
    if (raw === null) return undefined;
    if (typeof raw !== 'string' || raw.length > 1024) throw fail('PENDING_TICKET_INVALID');
    let value;
    try { value = JSON.parse(raw); } catch { throw fail('PENDING_TICKET_INVALID'); }
    if (JSON.stringify(value) !== raw) throw fail('PENDING_TICKET_INVALID');
    return validatePendingTicket(value, scope);
  }
  return Object.freeze({
    read,
    async put(ticket) {
      ticket = validatePendingTicket(ticket, scope);
      const existing = await read();
      if (existing && (existing.rightId !== ticket.rightId || existing.phase === 'signed' || ticket.phase !== 'signed')) throw fail('PENDING_TICKET_CONFLICT');
      try { storage.setItem(key, JSON.stringify(ticket)); } catch { throw fail('PENDING_STORE_UNAVAILABLE'); }
      const stored = await read();
      if (JSON.stringify(stored) !== JSON.stringify(ticket)) throw fail('PENDING_STORE_READBACK_FAILED');
    },
    withLock(callback) {
      return locks.request(key, { mode: 'exclusive' }, async lock => {
        if (!lock) throw fail('PENDING_LOCK_UNAVAILABLE');
        return callback();
      });
    },
  });
}
