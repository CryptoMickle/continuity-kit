import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createLocalService } from "./service.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const physicalRun = process.argv.includes("--physical");
if (physicalRun) process.env.VITE_ENABLE_PHYSICAL_PASSKEYS = "true";
const service = await createLocalService({
  stateDir: resolve(root, ".local-state"),
});
const primary = await createServer({
  root,
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    watch: physicalRun ? null : undefined,
    hmr: !physicalRun,
    allowedHosts: ["primary.localhost"],
  },
  plugins: [
    {
      name: "primary-outage-demo",
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          if (service.control.primaryOnline) {
            next();
            return;
          }
          res.statusCode = 503;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            '<!doctype html><title>Primary is offline · ContinuityKit</title><body style="background:#101412;color:#f2f3ee;font:20px system-ui;padding:12vw"><p>CONTINUITYKIT / OUTAGE TEST</p><h1>The primary app is offline.</h1><p>Its pages and backend are intentionally unavailable.</p><a style="color:#c5f17f" href="http://recovery.localhost:4174">Open the independent recovery client →</a></body>',
          );
        });
      },
    },
  ],
});
const recovery = await createServer({
  root,
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    watch: physicalRun ? null : undefined,
    hmr: !physicalRun,
    allowedHosts: ["recovery.localhost"],
  },
});
await primary.listen();
await recovery.listen();
process.stdout.write(
  `ContinuityKit local demonstration\nPrimary: http://primary.localhost:4173${process.argv.includes("--physical") ? "/?mode=physical" : ""}\nRecovery: http://recovery.localhost:4174${process.argv.includes("--physical") ? "/?mode=physical" : ""}\nEncrypted stores + signed local registry: http://localhost:4175\nNo passkeys are created automatically. No chain is contacted.\n`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all([primary.close(), recovery.close(), service.close()]);
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
