import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createLocalService } from "./service.mjs";
import { validateTestnetRuntimeConfig } from "../src/runtime.ts";

/** Local hosting only; callers separately authorize physical credentials/chain use. */
export async function startDemo({ physical = false, testnetConfig } = {}) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config =
    testnetConfig === undefined
      ? undefined
      : validateTestnetRuntimeConfig(testnetConfig);
  physical = physical || config !== undefined;
  const service = await createLocalService({
    stateDir: resolve(root, ".local-state"),
  });
  const servers = [];
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await Promise.allSettled([
      ...servers.map((server) => server.close()),
      service.close(),
    ]);
  }
  try {
    for (const [host, port] of [
      ["primary.localhost", 4173],
      ["recovery.localhost", 4174],
    ]) {
      const server = await createServer({
        root,
        configFile: false,
        define: {
          "import.meta.env.VITE_ENABLE_PHYSICAL_PASSKEYS": JSON.stringify(
            physical ? "true" : "false",
          ),
          __CONTINUITY_TESTNET_CONFIG__:
            config === undefined ? "undefined" : JSON.stringify(config),
        },
        server: {
          host: "127.0.0.1",
          port,
          strictPort: true,
          watch: physical ? null : undefined,
          hmr: !physical,
          allowedHosts: [host],
        },
        plugins:
          host === "primary.localhost"
            ? [
                {
                  name: "primary-outage-demo",
                  configureServer(vite) {
                    vite.middlewares.use((_req, res, next) => {
                      if (service.control.primaryOnline) return next();
                      res.statusCode = 503;
                      res.setHeader("Content-Type", "text/html; charset=utf-8");
                      res.end(
                        '<!doctype html><title>Primary is offline · ContinuityKit</title><body style="background:#101412;color:#f2f3ee;font:20px system-ui;padding:12vw"><p>CONTINUITYKIT / OUTAGE TEST</p><h1>The primary app is offline.</h1><p>Its pages and backend are intentionally unavailable.</p><a style="color:#c5f17f" href="http://recovery.localhost:4174">Open the independent recovery client →</a></body>',
                      );
                    });
                  },
                },
              ]
            : [],
      });
      servers.push(server);
      await server.listen();
    }
  } catch (error) {
    await close();
    throw error;
  }
  const query = physical ? "/?mode=physical" : "";
  process.stdout.write(
    `ContinuityKit ${config ? "Monad testnet · LOCAL storage" : "local demonstration"}\nPrimary: http://primary.localhost:4173${query}\nRecovery: http://recovery.localhost:4174${query}\nEncrypted stores + LOCAL model/control service: http://localhost:4175\nNo authentication or chain call starts on launch. ${config ? "Explicit client actions can send approved testnet transactions. New chain-bound passkeys are required." : "No chain is contacted."}\n`,
  );
  const stop = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { close };
}
