import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real disposable Redis evaluates production Lua. No TCP listener, credentials,
// external account, existing database or persistent application data is involved.
export async function redisFixture(binary: string) {
  const directory = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ck-redis-"),
  );
  const socketPath = join(directory, "redis.sock");
  const server = spawn(
    binary,
    [
      "--port",
      "0",
      "--unixsocket",
      socketPath,
      "--unixsocketperm",
      "700",
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      directory,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const stopped = new Promise<void>((resolve) =>
    server.once("close", () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error(`Fixture Redis not ready: ${output}`)),
        5_000,
      );
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Fixture Redis exited: ${code}: ${output}`));
      });
      const chunk = (data: Buffer) => {
        output += data.toString();
        if (output.toLowerCase().includes("ready to accept connections")) {
          clearTimeout(timer);
          resolve();
        }
      };
      server.stdout.on("data", chunk);
      server.stderr.on("data", chunk);
    });
  } catch (error) {
    server.kill("SIGTERM");
    await stopped;
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const command = (args: Array<string | number>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const socket = connect({ path: socketPath });
      const parts = [Buffer.from(`*${args.length}\r\n`)];
      for (const arg of args) {
        const bytes = Buffer.from(String(arg));
        parts.push(
          Buffer.from(`$${bytes.length}\r\n`),
          bytes,
          Buffer.from("\r\n"),
        );
      }
      let response = Buffer.alloc(0);
      socket.setTimeout(10_000, () =>
        socket.destroy(new Error("Fixture Redis command timeout")),
      );
      socket.on("error", reject);
      socket.on("connect", () => socket.write(Buffer.concat(parts)));
      socket.on("data", (chunk) => {
        response = Buffer.concat([response, chunk]);
        const lineEnd = response.indexOf("\r\n");
        if (lineEnd === -1) return;
        const prefix = String.fromCharCode(response[0]);
        const text = response.subarray(1, lineEnd).toString();
        if (
          prefix === "$" &&
          Number(text) >= 0 &&
          response.length < lineEnd + 2 + Number(text) + 2
        )
          return;
        socket.destroy();
        if (prefix === "-") reject(new Error(text));
        else if (prefix === "+") resolve(text);
        else if (prefix === ":") resolve(Number(text));
        else if (prefix === "$" && text === "-1") resolve(null);
        else if (prefix === "$")
          resolve(
            response
              .subarray(lineEnd + 2, lineEnd + 2 + Number(text))
              .toString(),
          );
        else reject(new Error(`Unsupported fixture RESP type: ${prefix}`));
      });
    });

  let requests = 0;
  let requestBytes = 0;
  let responseBytes = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    requests++;
    requestBytes += Buffer.byteLength(String(init?.body));
    let payload: string;
    let status = 200;
    try {
      payload = JSON.stringify({
        result: await command(JSON.parse(String(init?.body)) as string[]),
      });
    } catch (error) {
      payload = JSON.stringify({ error: String(error) });
      status = 400;
    }
    responseBytes += Buffer.byteLength(payload);
    return new Response(payload, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const commandCounts = async () => {
    const info = String(await command(["INFO", "commandstats"]));
    return Object.fromEntries(
      [...info.matchAll(/^cmdstat_([^:]+):calls=(\d+),/gm)]
        .filter((m) => m[1] !== "info")
        .map((m) => [m[1]!, Number(m[2])]),
    );
  };
  return {
    command,
    fetcher,
    // Run measurements sequentially. Redis counts the executed Lua subcommands
    // too; INFO sampling itself is excluded. This is not a provider invoice.
    async measure<T>(run: () => Promise<T>) {
      const before = await commandCounts();
      const r = requests,
        sent = requestBytes,
        received = responseBytes;
      const start = performance.now();
      const value = await run();
      const elapsedMs = performance.now() - start;
      const after = await commandCounts();
      const byCommand = Object.fromEntries(
        Object.entries(after)
          .map(([name, count]) => [name, count - (before[name] ?? 0)] as const)
          .filter(([, count]) => count > 0),
      );
      return {
        value,
        metrics: {
          commands: Object.values(byCommand).reduce((a, b) => a + b, 0),
          byCommand,
          providerRequests: requests - r,
          requestBodyBytes: requestBytes - sent,
          responseBodyBytes: responseBytes - received,
          elapsedMs: Math.round(elapsedMs * 100) / 100,
        },
      };
    },
    async close() {
      server.kill("SIGTERM");
      await stopped;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
