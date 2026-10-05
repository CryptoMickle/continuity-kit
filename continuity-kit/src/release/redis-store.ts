import type { DemoObjectStore, ObjectKind } from "./object-store.ts";

export interface RedisObjectStoreConfig {
  url: string;
  token: string;
  namespace: string;
}

const MAX_BLOB_BYTES = 1_048_576;
const MAX_INDEX_BYTES = 100_000;
const MAX_REST_BYTES = 1_450_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const FAILURE_COOLDOWN_MS = 2_000;

export interface RedisStoreOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

// Seven Redis commands including EVAL, independent of the number of objects.
// Reads validate the namespace envelope and requested value, not unrelated
// values. Full namespace/byte quotas remain atomic on every write below.
const READ_SCRIPT = `
local key, wanted = KEYS[1], ARGV[2]
local function unavailable() return redis.error_reply('CK_STORE_UNAVAILABLE') end
local keyType = redis.call('TYPE', key).ok
if keyType ~= 'none' and keyType ~= 'hash' then return unavailable() end
local ttl = redis.call('PTTL', key)
if ttl ~= -1 and ttl ~= -2 then return unavailable() end
if keyType == 'none' then return false end
local fields = redis.call('HLEN', key)
if fields < 2 or fields > 33 or redis.call('HGET', key, '__schema') ~= 'continuity-demo-objects/v1' then return unavailable() end
local size = redis.call('HSTRLEN', key, wanted)
local maxSize = string.sub(wanted, 3, 8) == 'index:' and 133336 or 1398104
if size > maxSize then return unavailable() end
return redis.call('HGET', key, wanted)
`;

// Only one HSET mutates the namespace. Quotas are derived from bounded objects,
// so failed commands cannot leave separate counters or indexes out of sync.
// HGET is deliberately per object: HGETALL could exceed Upstash's response cap.
const WRITE_SCRIPT = `
local key = KEYS[1]
local operation, wanted, incoming = ARGV[1], ARGV[2], ARGV[3]
local schema = 'continuity-demo-objects/v1'
local function unavailable() return redis.error_reply('CK_STORE_UNAVAILABLE') end
local function fieldInfo(field)
  local slot, kind, id = string.match(field, '^([01]):(%a+):(.+)$')
  if not slot then return nil end
  if kind == 'index' then
    if #id ~= 43 or string.find(id, '[^A-Za-z0-9_-]') then return nil end
  elseif kind == 'blob' then
    if #id ~= 66 or string.sub(id, 1, 2) ~= '0x' or string.find(string.sub(id, 3), '[^0-9a-f]') then return nil end
  else return nil end
  return tonumber(slot) + 1, kind
end
local function byteLength(value, kind)
  local size = #value
  if size == 0 or size % 4 ~= 0 or size > 1398104 then return nil end
  local padding = 0
  if string.sub(value, -2) == '==' then padding = 2
  elseif string.sub(value, -1) == '=' then padding = 1 end
  local body = string.sub(value, 1, size - padding)
  if string.find(body, '[^A-Za-z0-9+/]') then return nil end
  -- Canonical base64 requires unused low bits in the final sextet to be zero.
  if padding > 0 then
    local alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    local sextet = string.find(alphabet, string.sub(body, -1), 1, true)
    if not sextet or (sextet - 1) % (padding == 2 and 16 or 4) ~= 0 then return nil end
  end
  local bytes = size / 4 * 3 - padding
  if bytes < 1 or bytes > (kind == 'index' and 100000 or 1048576) then return nil end
  return bytes
end
local wantedSlot, wantedKind = fieldInfo(wanted)
if not wantedSlot or operation ~= 'put' then return unavailable() end
local incomingBytes = byteLength(incoming, wantedKind)
if not incomingBytes then return unavailable() end
local keyType = redis.call('TYPE', key).ok
if keyType ~= 'none' and keyType ~= 'hash' then return unavailable() end
local ttl = redis.call('PTTL', key)
if ttl ~= -1 and ttl ~= -2 then return unavailable() end
local counts, indexes, total, existing = {0, 0}, {0, 0}, 0, nil
if keyType == 'hash' then
  local fields = redis.call('HLEN', key)
  if fields < 2 or fields > 33 or redis.call('HGET', key, '__schema') ~= schema then return unavailable() end
  for _, field in ipairs(redis.call('HKEYS', key)) do
    if field ~= '__schema' then
      local slot, kind = fieldInfo(field)
      if not slot then return unavailable() end
      local encodedLength = redis.call('HSTRLEN', key, field)
      if encodedLength < 4 or encodedLength > (kind == 'index' and 133336 or 1398104) then return unavailable() end
      local value = redis.call('HGET', key, field)
      local bytes = byteLength(value, kind)
      if not bytes then return unavailable() end
      counts[slot] = counts[slot] + 1
      if kind == 'index' then indexes[slot] = indexes[slot] + 1 end
      total = total + bytes
      if counts[slot] > 16 or indexes[slot] > 2 or total > 16777216 then return unavailable() end
      if field == wanted then existing = value end
    end
  end
end
if existing then
  if existing == incoming then return 'stored' else return 'conflict' end
end
if counts[wantedSlot] >= 16 or (wantedKind == 'index' and indexes[wantedSlot] >= 2) or total + incomingBytes > 16777216 then return 'unavailable' end
redis.call('HSET', key, '__schema', schema, wanted, incoming)
return 'stored'
`;

function fail(): never {
  // Provider error text can contain credentials or object data; never forward it.
  throw new Error("REDIS_STORE_UNAVAILABLE");
}

function validateConfig(config: RedisObjectStoreConfig): URL {
  if (
    !config ||
    typeof config.url !== "string" ||
    !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.upstash\.io\/?$/.test(
      config.url,
    ) ||
    typeof config.token !== "string" ||
    !/^[A-Za-z0-9._~+\/-]{16,4096}={0,2}$/.test(config.token) ||
    typeof config.namespace !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(config.namespace)
  )
    throw new Error("REDIS_STORE_CONFIG_INVALID");
  return new URL(config.url);
}

function objectField(slot: number, kind: ObjectKind, key: string): string {
  if (
    (slot !== 0 && slot !== 1) ||
    (kind !== "index" && kind !== "blob") ||
    typeof key !== "string" ||
    !(kind === "index" ? /^[A-Za-z0-9_-]{43}$/ : /^0x[0-9a-f]{64}$/).test(key)
  )
    fail();
  return `${slot}:${kind}:${key}`;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function decode(value: unknown, kind: ObjectKind): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length >
      Math.ceil((kind === "index" ? MAX_INDEX_BYTES : MAX_BLOB_BYTES) / 3) * 4
  )
    fail();
  const binary = atob(value);
  if (btoa(binary) !== value) fail();
  if (binary.length > (kind === "index" ? MAX_INDEX_BYTES : MAX_BLOB_BYTES))
    fail();
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createRedisObjectStore(
  config: RedisObjectStoreConfig,
  options: RedisStoreOptions = {},
): DemoObjectStore {
  const endpoint = validateConfig(config).href;
  const token = config.token;
  const redisKey = `ck:demo:${config.namespace}:objects:v1`;
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let retryNotBefore = 0;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  )
    throw new Error("REDIS_STORE_CONFIG_INVALID");

  const command = async (
    operation: "read" | "put",
    field: string,
    value = "",
  ) => {
    // A warm server backs off after provider overload, transport loss or timeout.
    // No sleeps, background retries or claim of a distributed billing limit.
    if (now() < retryNotBefore) fail();
    let providerUnavailable = false;
    const body = JSON.stringify([
      "EVAL",
      operation === "read" ? READ_SCRIPT : WRITE_SCRIPT,
      "1",
      redisKey,
      operation,
      field,
      value,
    ]);
    if (body.length > MAX_REST_BYTES) fail(); // All command characters are ASCII.
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectTimeout: ((error: Error) => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      providerUnavailable = true;
      controller.abort();
      void reader?.cancel().catch(() => {});
      rejectTimeout?.(new Error("REDIS_STORE_UNAVAILABLE"));
    }, timeoutMs);
    const work = async () => {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "cache-control": "no-store",
          pragma: "no-cache",
        },
        body,
        // Workers rejects redirect:"error". Manual never follows a Location;
        // the strict 200 check below rejects every redirect response.
        redirect: "manual",
        signal: controller.signal,
      }).catch(() => {
        providerUnavailable = true;
        return fail();
      });
      if (response.status === 429 || response.status >= 500)
        providerUnavailable = true;
      if (response.status !== 200 || response.redirected || !response.body)
        fail();
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d+$/.test(length) || Number(length) > MAX_REST_BYTES)
      )
        fail();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value: chunk, done } = await reader.read().catch(() => {
          providerUnavailable = true;
          return fail();
        });
        if (done) break;
        size += chunk.byteLength;
        if (size > MAX_REST_BYTES) fail();
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const json: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (
        !json ||
        typeof json !== "object" ||
        Array.isArray(json) ||
        Object.keys(json).length !== 1 ||
        !("result" in json)
      )
        fail();
      return json.result;
    };
    try {
      return await Promise.race([work(), timeout]);
    } catch {
      if (providerUnavailable) retryNotBefore = now() + FAILURE_COOLDOWN_MS;
      fail();
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  };

  return Object.freeze({
    async read(slot: number, kind: ObjectKind, key: string) {
      try {
        const result = await command("read", objectField(slot, kind, key));
        return result === null ? null : decode(result, kind);
      } catch {
        fail();
      }
    },
    async putImmutable(
      slot: number,
      kind: ObjectKind,
      key: string,
      bytes: Uint8Array,
    ) {
      try {
        const field = objectField(slot, kind, key);
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.length < 1 ||
          bytes.length > (kind === "index" ? MAX_INDEX_BYTES : MAX_BLOB_BYTES)
        )
          fail();
        const result = await command("put", field, encode(bytes));
        return result === "stored" || result === "conflict"
          ? result
          : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  });
}
