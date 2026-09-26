import { ContinuityError } from "./types.ts";
import type { Hex } from "./types.ts";
export const wellFormed = (s: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    s,
  );
export const utf8 = (s: string) => new TextEncoder().encode(s);
export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
export function b64(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function unb64(
  value: unknown,
  length?: number,
): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !value.length ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new ContinuityError("SCHEMA_INVALID", "Invalid base64url");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    throw new ContinuityError("SCHEMA_INVALID");
  }
  if (b64(bytes) !== value || (length !== undefined && bytes.length !== length))
    throw new ContinuityError("SCHEMA_INVALID", "Noncanonical bytes");
  return bytes;
}
export function hex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
export function fromHex(value: Hex): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.slice(2).match(/../g) ?? [], (x) =>
    parseInt(x, 16),
  );
}
export const sha = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
export const digest = async (bytes: Uint8Array): Promise<Hex> =>
  hex(await sha(bytes));
// RFC 8785 on the restricted protocol domain: JSON strings, booleans, null,
// arrays, objects and the single fixed integer tag 1. Reject lone surrogates.
export function canonical(value: unknown, depth = 0): string {
  if (depth > 32)
    throw new ContinuityError("SCHEMA_INVALID", "Object nesting limit");
  if (value === null) return "null";
  if (typeof value === "string") {
    if (!wellFormed(value))
      throw new ContinuityError("SCHEMA_INVALID", "Invalid Unicode");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || value === 1) return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map((v) => canonical(v, depth + 1)).join(",") + "]";
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            canonical(k, depth + 1) +
            ":" +
            canonical((value as Record<string, unknown>)[k], depth + 1),
        )
        .join(",") +
      "}"
    );
  throw new ContinuityError("SCHEMA_INVALID", "Unsupported JSON value");
}
export const bytesOf = (value: unknown) => utf8(canonical(value));
export function parseCanonical(bytes: Uint8Array, max: number): unknown {
  if (bytes.length > max)
    throw new ContinuityError("SCHEMA_INVALID", "Size limit");
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    if (!equal(bytesOf(value), bytes)) throw Error();
  } catch {
    throw new ContinuityError(
      "SCHEMA_INVALID",
      "Invalid or noncanonical wire object",
    );
  }
  return value;
}
export async function hkdf(
  prf: Uint8Array,
  info: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(prf),
    "HKDF",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: await sha(utf8("continuity-kit/v1/hkdf")),
        info: utf8(info),
      },
      material,
      256,
    ),
  );
}
export async function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: unknown,
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = random(12);
  const k = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: bytesOf(aad),
      tagLength: 128,
    },
    k,
    new Uint8Array(plaintext),
  );
  return { nonce: b64(nonce), ciphertext: b64(new Uint8Array(ciphertext)) };
}
export async function open(
  key: Uint8Array,
  box: { nonce: string; ciphertext: string },
  aad: unknown,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const k = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(key),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unb64(box.nonce, 12),
          additionalData: bytesOf(aad),
          tagLength: 128,
        },
        k,
        unb64(box.ciphertext),
      ),
    );
  } catch {
    throw new ContinuityError(
      "DECRYPT_FAILED",
      "Authenticated decryption failed",
    );
  }
}
export async function lookupKeys(prf: Uint8Array, primary = false) {
  const lookup = await hkdf(prf, primary ? "primary-locator" : "locator");
  const key = await hkdf(
    prf,
    primary ? "primary-record-aes-gcm" : "manifest-aes-gcm",
  );
  const prefix = utf8(
    primary
      ? "continuity-kit/v1/primary-locator\0"
      : "continuity-kit/v1/locator\0",
  );
  const joined = new Uint8Array(prefix.length + lookup.length);
  joined.set(prefix);
  joined.set(lookup, prefix.length);
  const locator = b64(await sha(joined));
  lookup.fill(0);
  return { locator, key };
}
