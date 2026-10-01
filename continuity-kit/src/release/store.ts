import { validateReleaseProfile } from "./profile.ts";
import type { ReleaseProfile } from "./profile.ts";

// Minimal compatible D1 surface. Tests run the same SQL against local SQLite.
export interface DemoDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}
export interface DemoStoreEnv {
  DB: DemoDatabase;
  CONTINUITY_UPLOAD_TOKEN?: string;
}
const fixedHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};
const keyPattern = { index: /^[A-Za-z0-9_-]{43}$/, blob: /^0x[a-f0-9]{64}$/ };
const objectQuery =
  "SELECT bytes FROM ck_demo_objects WHERE slot=? AND kind=? AND object_key=?";
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
async function boundedBody(req: Request, max: number) {
  if (
    req.headers.has("content-length") &&
    (!/^\d+$/.test(req.headers.get("content-length")!) ||
      Number(req.headers.get("content-length")) > max)
  )
    throw new Error("TOO_LARGE");
  if (!req.body) throw new Error("EMPTY");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + 10000;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("TIMEOUT")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (part.done) break;
      size += part.value.length;
      if (size > max) throw new Error("TOO_LARGE");
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (size === 0) throw new Error("EMPTY");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}
async function authorized(header: string | null, expected: string | undefined) {
  if (
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    !header ||
    !/^Bearer [a-f0-9]{64}$/.test(header)
  )
    return false;
  const digest = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([digest(header.slice(7)), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}
export function createDemoStore(input: ReleaseProfile) {
  const profile = validateReleaseProfile(input);
  return async (req: Request, env: DemoStoreEnv): Promise<Response> => {
    const u = new URL(req.url);
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = { ...fixedHeaders, vary: "Origin" };
    const answer = (status: number, body?: string | Uint8Array) =>
      new Response(
        body ? (typeof body === "string" ? body : new Uint8Array(body)) : null,
        { status, headers },
      );
    if (u.origin !== profile.storeOrigin || u.search) return answer(403);
    if (origin && origin !== profile.aOrigin && origin !== profile.bOrigin)
      return answer(403);
    if (origin) headers["access-control-allow-origin"] = origin;
    if (Date.now() >= Date.parse(profile.expiresAt)) return answer(410);
    // Read-only presenter access check, before any native credential creation.
    if (u.pathname === "/v1/presenter-access") {
      if (origin && origin !== profile.aOrigin) return answer(403);
      if (req.method === "OPTIONS") {
        if (
          origin !== profile.aOrigin ||
          req.headers.get("access-control-request-method") !== "GET" ||
          (
            req.headers.get("access-control-request-headers") ?? ""
          ).toLowerCase() !== "authorization"
        )
          return answer(403);
        headers["access-control-allow-methods"] = "GET, OPTIONS";
        headers["access-control-allow-headers"] = "Authorization";
        return answer(204);
      }
      if (req.method !== "GET") return answer(405);
      return answer(
        (await authorized(
          req.headers.get("authorization"),
          env.CONTINUITY_UPLOAD_TOKEN,
        ))
          ? 204
          : 401,
      );
    }
    const path = u.pathname.match(
      /^\/v1\/mirrors\/([01])\/(index|blob)\/([^/]+)$/,
    );
    if (!path) return answer(404);
    const [, slotText, kindText, key] = path;
    const kind = kindText as "index" | "blob";
    const slot = Number(slotText);
    if (!keyPattern[kind].test(key!)) return answer(400);
    if (req.method === "OPTIONS") {
      const method = req.headers.get("access-control-request-method");
      const requested = (
        req.headers.get("access-control-request-headers") ?? ""
      )
        .toLowerCase()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        !origin ||
        !["GET", "PUT"].includes(method ?? "") ||
        (method === "PUT" && origin !== profile.aOrigin) ||
        requested.some((h) => !["authorization", "content-type"].includes(h))
      )
        return answer(403);
      headers["access-control-allow-methods"] =
        origin === profile.aOrigin ? "GET, PUT, OPTIONS" : "GET, OPTIONS";
      headers["access-control-allow-headers"] = "Authorization, Content-Type";
      return answer(204);
    }
    if (!["GET", "PUT"].includes(req.method)) return answer(405);
    // CORS is not authorization: even clients omitting Origin need the capability.
    if (
      req.method === "PUT" &&
      ((origin && origin !== profile.aOrigin) ||
        !(await authorized(
          req.headers.get("authorization"),
          env.CONTINUITY_UPLOAD_TOKEN,
        )))
    )
      return answer(401);
    const load = () =>
      env.DB.prepare(objectQuery)
        .bind(slot, kind, key)
        .first<{ bytes: ArrayBuffer | number[] }>();
    try {
      if (req.method === "GET") {
        const stored = await load();
        if (!stored) return answer(404);
        headers["content-type"] = "application/octet-stream";
        return answer(200, new Uint8Array(stored.bytes));
      }
      if (req.headers.get("content-type") !== "application/octet-stream")
        return answer(415);
      const bytes = await boundedBody(req, kind === "index" ? 100000 : 1048576);
      if (Date.now() >= Date.parse(profile.expiresAt)) return answer(410);
      if (kind === "blob") {
        const hash =
          "0x" +
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (v) => v.toString(16).padStart(2, "0"),
          ).join("");
        if (hash !== key) return answer(422);
      }
      const previous = await load();
      if (previous)
        return answer(same(new Uint8Array(previous.bytes), bytes) ? 204 : 409);
      try {
        await env.DB.prepare(
          "INSERT INTO ck_demo_objects(slot,kind,object_key,bytes) VALUES(?,?,?,?) ON CONFLICT(slot,kind,object_key) DO NOTHING",
        )
          .bind(slot, kind, key, bytes.buffer)
          .run();
      } catch {
        // A concurrent identical request can win at the quota boundary.
        const winner = await load();
        if (winner)
          return answer(same(new Uint8Array(winner.bytes), bytes) ? 204 : 409);
        // Backend failure vs quota intentionally indistinguishable; never claim stored.
        return answer(503);
      }
      const stored = await load();
      return answer(
        stored && same(new Uint8Array(stored.bytes), bytes) ? 204 : 409,
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      return answer(
        code === "TOO_LARGE"
          ? 413
          : code === "TIMEOUT"
            ? 408
            : code === "EMPTY"
              ? 400
              : 503,
      );
    }
  };
}
