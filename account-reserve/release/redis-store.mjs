import { SCHEMA, MAX_RECORD_BYTES, MAX_RECORDS, base64url, decode64, fail, validLocator } from './profile.mjs';

// One hash is the entire release namespace. Quota and ticket consumption happen
// in the same Lua invocation as the create-only ciphertext write.
const COMMON = `
local key = KEYS[1]
local expiry = tonumber(ARGV[1])
local schema = '${SCHEMA}'
local now = redis.call('TIME')
if not expiry or tonumber(now[1]) * 1000 + tonumber(now[2]) / 1000 >= expiry then return {'expired'} end
local kind = redis.call('TYPE', key).ok
if kind ~= 'none' and kind ~= 'hash' then return redis.error_reply('RESERVE_STORE_INVALID') end
if kind == 'hash' then
  local fields = redis.call('HLEN', key)
  if fields < 4 or fields > 34 or redis.call('HGET', key, '__schema') ~= schema or redis.call('HGET', key, '__expires') ~= ARGV[1] then return redis.error_reply('RESERVE_STORE_INVALID') end
end
`;
export const READ_SCRIPT = COMMON + `
if kind == 'none' then return {'missing'} end
local value = redis.call('HGET', key, 'data:' .. ARGV[2])
if not value then return {'missing'} end
if #value < 2 or #value > 87382 then return redis.error_reply('RESERVE_STORE_INVALID') end
return {'found', value}
`;
export const WRITE_SCRIPT = COMMON + `
local locator, ticket, incoming = ARGV[2], ARGV[3], ARGV[4]
if #locator ~= 43 or string.find(locator, '[^A-Za-z0-9_-]') or #ticket ~= 64 or string.find(ticket, '[^0-9a-f]') or #incoming < 2 or #incoming > 87382 or string.find(incoming, '[^A-Za-z0-9_-]') then return redis.error_reply('RESERVE_STORE_INVALID') end
local count, used = 0, 0
if kind == 'hash' then
  for _, field in ipairs(redis.call('HKEYS', key)) do
    if field ~= '__schema' and field ~= '__expires' then
      if string.sub(field, 1, 5) == 'data:' and #field == 48 and not string.find(string.sub(field, 6), '[^A-Za-z0-9_-]') then
        count = count + 1
        local size = redis.call('HSTRLEN', key, field)
        if size < 2 or size > 87382 then return redis.error_reply('RESERVE_STORE_INVALID') end
      elseif string.sub(field, 1, 7) == 'ticket:' and #field == 71 and not string.find(string.sub(field, 8), '[^0-9a-f]') then
        used = used + 1
        local bound = redis.call('HGET', key, field)
        if #bound ~= 43 or string.find(bound, '[^A-Za-z0-9_-]') or redis.call('HEXISTS', key, 'data:' .. bound) ~= 1 then return redis.error_reply('RESERVE_STORE_INVALID') end
      else return redis.error_reply('RESERVE_STORE_INVALID') end
    end
  end
end
if count ~= used or count > 16 then return redis.error_reply('RESERVE_STORE_INVALID') end
local previous = redis.call('HGET', key, 'ticket:' .. ticket)
if previous then
  if previous == locator then return {'conflict'} else return {'consumed'} end
end
if redis.call('HEXISTS', key, 'data:' .. locator) == 1 then return {'conflict'} end
if count >= 16 then return {'limit'} end
redis.call('HSET', key, '__schema', schema, '__expires', ARGV[1], 'data:' .. locator, incoming, 'ticket:' .. ticket, locator)
redis.call('PEXPIREAT', key, ARGV[1])
return {'created'}
`;

export function createReleaseStore({ profile, command }) {
  if (!profile?.namespace || profile.namespace !== `accountreserve:v1:${profile.releaseId}` || !/^accountreserve:v1:[a-f0-9]{32}$/.test(profile.namespace) || !Number.isSafeInteger(profile.expires) || typeof command !== 'function') throw fail('RELEASE_CONFIG_INVALID');
  const invoke = (script, ...args) => command(['EVAL', script, '1', profile.namespace, String(profile.expires), ...args]);
  return Object.freeze({
    async get(locator) {
      if (!validLocator(locator)) throw fail('LOCATOR_INVALID');
      const result = await invoke(READ_SCRIPT, locator);
      if (Array.isArray(result) && result.length === 1 && result[0] === 'missing') return undefined;
      if (Array.isArray(result) && result.length === 1 && result[0] === 'expired') throw fail('RELEASE_EXPIRED');
      if (!Array.isArray(result) || result.length !== 2 || result[0] !== 'found') throw fail('STORE_UNAVAILABLE');
      return decode64(result[1], MAX_RECORD_BYTES);
    },
    async putIfAbsent(locator, bytes, ticketHash) {
      if (!validLocator(locator) || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_RECORD_BYTES || !/^[a-f0-9]{64}$/.test(ticketHash)) throw fail('RECORD_INVALID');
      const result = await invoke(WRITE_SCRIPT, locator, ticketHash, base64url(bytes));
      if (!Array.isArray(result) || result.length !== 1 || !['created', 'conflict', 'consumed', 'limit', 'expired'].includes(result[0])) throw fail('STORE_WRITE_UNKNOWN');
      return result[0];
    },
    limits: Object.freeze({ maxRecords: MAX_RECORDS, maxRecordBytes: MAX_RECORD_BYTES }),
  });
}
