import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { recoverMessageAddress } from "viem";
import { LOCAL_POLICY } from "../src/sdk/policy.ts";
import {
  registryDomain,
  registrySigningMessage,
} from "../src/sdk/registry-signing.ts";

const origins = new Set([
  "http://primary.localhost:4173",
  "http://recovery.localhost:4174",
]);
const scenarios = new Set([
  "healthy",
  "stale-one",
  "stale-both",
  "missing-current",
  "freshness-offline",
  "corrupt-index",
]);
const zero = `0x${"00".repeat(32)}`;
const hex32 = /^0x[0-9a-f]{64}$/;
const ownerPattern = /^0x[0-9a-f]{40}$/;
const canonical = (value) =>
  JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, JSON.parse(canonical(value[key]))]),
        )
      : value,
  );
const digest = (bytes) =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;
const problem = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });

/** Local-only fixture server. Its registry is a signed model, never Monad evidence. */
export async function createLocalService({ stateDir, port = 4175 } = {}) {
  const statePath = stateDir ? resolve(stateDir, "encrypted-store.json") : null;
  let stored = {
    mirrors: [
      { indexes: {}, blobs: {} },
      { indexes: {}, blobs: {} },
    ],
    records: {},
    block: "0",
  };
  if (statePath) {
    try {
      stored = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  let persistQueue = Promise.resolve();
  const persist = () => {
    if (!statePath) return Promise.resolve();
    const bytes = JSON.stringify(stored);
    persistQueue = persistQueue.then(async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(`${statePath}.tmp`, bytes, { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    });
    return persistQueue;
  };
  const control = { primaryOnline: true, scenario: "healthy" };
  const evidence = () => ({
    trustMode: "local-model",
    blockNumber: stored.block,
    blockHash: digest(Buffer.from(`local-model:${stored.block}`)),
    observedAt: new Date().toISOString(),
  });
  const head = (owner, streamId) => ({
    ...(stored.records[`${owner}:${streamId}`] ?? {
      exists: false,
      manifestDigest: zero,
      version: "0",
      capsuleDigest: zero,
    }),
    evidence: evidence(),
  });

  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const host = req.headers.host ?? "";
    if (!/^localhost:\d+$/.test(host) && !/^127\.0\.0\.1:\d+$/.test(host)) {
      res.writeHead(403).end("Invalid local host");
      return;
    }
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) {
      res.writeHead(403).end("Origin denied");
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const send = (data, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const body = async (max = 1500000) => {
      if (Number(req.headers["content-length"] ?? 0) > max)
        throw problem("TOO_LARGE", "Request is too large.", 413);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > max)
          throw problem("TOO_LARGE", "Request is too large.", 413);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && path === "/v1/status") {
        send({
          ...control,
          records: Object.entries(stored.records).map(([key, record]) => {
            const [owner, streamId] = key.split(":");
            return { owner, streamId, ...record };
          }),
          mirrorCounts: stored.mirrors.map((m) => ({
            indexes: Object.keys(m.indexes).length,
            blobs: Object.keys(m.blobs).length,
          })),
        });
        return;
      }
      if (req.method === "POST" && path === "/v1/control") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw problem("INVALID_REQUEST", "JSON required.");
        const input = JSON.parse((await body(2048)).toString());
        if (
          Object.keys(input).some(
            (k) => !["primaryOnline", "scenario"].includes(k),
          )
        )
          throw problem("INVALID_REQUEST", "Unknown control.");
        if ("primaryOnline" in input) {
          if (typeof input.primaryOnline !== "boolean")
            throw problem("INVALID_REQUEST", "Boolean required.");
          control.primaryOnline = input.primaryOnline;
        }
        if ("scenario" in input) {
          if (!scenarios.has(input.scenario))
            throw problem("INVALID_REQUEST", "Unknown scenario.");
          control.scenario = input.scenario;
        }
        send(control);
        return;
      }
      const mirrorMatch = path.match(
        /^\/v1\/mirrors\/([01])\/(index|blob)\/([a-zA-Z0-9_-]+)$/,
      );
      if (mirrorMatch) {
        const [, slot, kind, key] = mirrorMatch;
        if (key.length > 90 || (kind === "blob" && !hex32.test(key)))
          throw problem("INVALID_REQUEST", "Invalid object key.");
        const collection =
          stored.mirrors[Number(slot)][kind === "index" ? "indexes" : "blobs"];
        if (req.method === "PUT") {
          if (
            !req.headers["content-type"]?.startsWith("application/octet-stream")
          )
            throw problem("INVALID_REQUEST", "Opaque bytes required.");
          const bytes = await body(kind === "index" ? 100000 : 1048576);
          if (kind === "blob" && digest(bytes) !== key)
            throw problem(
              "DIGEST_MISMATCH",
              "Blob digest differs from requested key.",
            );
          const encoded = bytes.toString("base64");
          if (collection[key] && collection[key] !== encoded)
            throw problem(
              "ENROLLMENT_CONFLICT",
              "Immutable object already exists.",
              409,
            );
          collection[key] = encoded;
          await persist();
          send({ stored: true });
          return;
        }
        if (req.method === "GET") {
          let encoded = collection[key];
          if (kind === "blob" && control.scenario === "missing-current")
            encoded = undefined;
          if (
            kind === "blob" &&
            (control.scenario === "stale-both" ||
              (control.scenario === "stale-one" && slot === "0"))
          ) {
            // Preserve stream identity: find its v1, never another user's fixture.
            const wanted = encoded
              ? JSON.parse(Buffer.from(encoded, "base64").toString())
              : null;
            encoded =
              Object.values(collection).find((value) => {
                try {
                  const item = JSON.parse(
                    Buffer.from(value, "base64").toString(),
                  );
                  return (
                    item.header?.version === "1" &&
                    item.header?.streamId === wanted?.header?.streamId
                  );
                } catch {
                  return false;
                }
              }) ?? encoded;
          }
          if (!encoded) throw problem("NOT_FOUND", "Object unavailable.", 404);
          const bytes = Buffer.from(encoded, "base64");
          if (
            kind === "index" &&
            control.scenario === "corrupt-index" &&
            bytes.length
          )
            bytes[Math.floor(bytes.length / 2)] ^= 1;
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": bytes.length,
          });
          res.end(bytes);
          return;
        }
      }
      const registryMatch = path.match(
        /^\/v1\/registry\/(0x[0-9a-f]{40})\/(0x[0-9a-f]{64})$/,
      );
      if (registryMatch && req.method === "GET") {
        if (control.scenario === "freshness-offline")
          throw problem(
            "FRESHNESS_UNAVAILABLE",
            "Local registry is intentionally unavailable.",
            503,
          );
        send(head(registryMatch[1], registryMatch[2]));
        return;
      }
      if (path === "/v1/registry" && req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw problem("INVALID_REQUEST", "JSON required.");
        const input = JSON.parse((await body(10000)).toString());
        const { signature, domain, ...message } = input;
        if (canonical(domain) !== canonical(registryDomain(LOCAL_POLICY)))
          throw problem(
            "CONTEXT_MISMATCH",
            "Signature domain does not identify this local deployment.",
            403,
          );
        const fields =
          message.operation === "create"
            ? [
                "operation",
                "owner",
                "streamId",
                "manifestDigest",
                "initialCapsuleDigest",
              ]
            : message.operation === "commit"
              ? [
                  "operation",
                  "owner",
                  "streamId",
                  "expectedVersion",
                  "expectedDigest",
                  "nextDigest",
                ]
              : [];
        if (
          !fields.length ||
          Object.keys(message).length !== fields.length ||
          fields.some((k) => !(k in message))
        )
          throw problem("INVALID_REQUEST", "Invalid registry operation.");
        if (
          !ownerPattern.test(message.owner) ||
          !hex32.test(message.streamId) ||
          message.streamId === zero
        )
          throw problem("INVALID_REQUEST", "Invalid owner or stream.");
        for (const field of fields.filter((k) => /Digest$/.test(k))) {
          if (!hex32.test(message[field]) || message[field] === zero)
            throw problem("INVALID_REQUEST", "Invalid digest.");
        }
        let recovered;
        try {
          recovered = await recoverMessageAddress({
            message: registrySigningMessage(LOCAL_POLICY, message),
            signature,
          });
        } catch {
          throw problem("UNAUTHORIZED", "Invalid local-model signature.", 403);
        }
        if (recovered.toLowerCase() !== message.owner)
          throw problem(
            "UNAUTHORIZED",
            "Signature does not authorize this owner.",
            403,
          );
        const key = `${message.owner}:${message.streamId}`;
        const current = stored.records[key];
        if (message.operation === "create") {
          if (current)
            throw problem("ALREADY_EXISTS", "Stream already exists.", 409);
          stored.records[key] = {
            exists: true,
            manifestDigest: message.manifestDigest,
            version: "1",
            capsuleDigest: message.initialCapsuleDigest,
          };
        } else {
          if (!current)
            throw problem(
              "UNREGISTERED_ENROLLMENT",
              "Stream does not exist.",
              404,
            );
          if (
            current.version !== message.expectedVersion ||
            current.capsuleDigest !== message.expectedDigest
          )
            throw problem(
              "WRITE_CONFLICT",
              "Another checkpoint has advanced this stream.",
              409,
            );
          if (current.capsuleDigest === message.nextDigest)
            throw problem("NO_CHANGE", "Digest must change.");
          if (BigInt(current.version) >= 18446744073709551615n)
            throw problem("VERSION_OVERFLOW", "Version limit reached.");
          stored.records[key] = {
            ...current,
            version: String(BigInt(current.version) + 1n),
            capsuleDigest: message.nextDigest,
          };
        }
        stored.block = String(BigInt(stored.block) + 1n);
        await persist();
        send(head(message.owner, message.streamId));
        return;
      }
      throw problem("NOT_FOUND", "Unknown endpoint.", 404);
    } catch (error) {
      if (!res.headersSent)
        send(
          {
            code: error.code ?? "INVALID_REQUEST",
            message: error.code ? error.message : "Malformed local request.",
          },
          error.status ?? 400,
        );
      else res.end();
    }
  });
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveReady);
  });
  return {
    server,
    control,
    port: server.address().port,
    close: () => new Promise((resolveClosed) => server.close(resolveClosed)),
  };
}
