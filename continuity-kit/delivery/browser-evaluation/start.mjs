/** Public synthetic browser trial only. No physical credentials, config or persistence. */
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createLocalService } from "./service.mjs";
import { LOCAL_POLICY } from "../src/sdk/policy.ts";

if (process.argv.length !== 2)
  throw new Error(
    "This trial accepts no flags. Run npm start without options.",
  );
if (
  LOCAL_POLICY.aOrigin !== "http://trial-primary.localhost:4373" ||
  LOCAL_POLICY.bOrigin !== "http://trial-recovery.localhost:4374" ||
  LOCAL_POLICY.registryUrl !== "http://localhost:4375"
)
  throw new Error(
    "Start this launcher only inside the generated trial package.",
  );

const root = fileURLToPath(new URL("..", import.meta.url));
const servers = [];
const service = await createLocalService({ port: 4375 }); // No stateDir: RAM only.
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
  for (const [origin, primary] of [
    [LOCAL_POLICY.aOrigin, true],
    [LOCAL_POLICY.bOrigin, false],
  ]) {
    const url = new URL(origin);
    const server = await createServer({
      root,
      configFile: false,
      envDir: false,
      define: {
        "import.meta.env.VITE_ENABLE_PHYSICAL_PASSKEYS": '"false"',
        __CONTINUITY_TESTNET_CONFIG__: "undefined",
      },
      server: {
        host: "127.0.0.1",
        port: Number(url.port),
        strictPort: true,
        allowedHosts: [url.hostname],
        hmr: false,
        watch: null,
        fs: { strict: true, allow: [root] },
        headers: {
          "Cache-Control": "no-store",
          "Permissions-Policy":
            "publickey-credentials-create=(), publickey-credentials-get=()",
        },
      },
      plugins: primary
        ? [
            {
              name: "trial-primary-outage",
              configureServer(vite) {
                vite.middlewares.use((_req, res, next) => {
                  if (service.control.primaryOnline) return next();
                  res.statusCode = 503;
                  res.setHeader("Content-Type", "text/html; charset=utf-8");
                  res.end(
                    `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Primary offline · local trial</title><body style="font:16px system-ui;background:#f3f5fa;color:#222631;padding:10vw;line-height:1.7"><p>CONTINUITYKIT · LOCAL SIMULATION</p><h1>The original app is offline.</h1><p>This is the planned outage. Open the separate recovery client to retrieve the latest saved checkpoint.</p><p><a href="${LOCAL_POLICY.bOrigin}/">Open recovery client →</a></p><p><a href="${LOCAL_POLICY.bOrigin}/try.html">Return to the trial guide</a></p></body></html>`,
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
  await import("./seed-demo.ts");
} catch (error) {
  await close();
  throw error;
}
process.stdout.write(
  `\nGuided trial: ${LOCAL_POLICY.bOrigin}/try.html\n` +
    `Primary: ${LOCAL_POLICY.aOrigin}/\nRecovery: ${LOCAL_POLICY.bOrigin}/\n` +
    "Public synthetic v1 prepared. All data resets when this process stops.\n" +
    "No real passkeys, accounts, wallet, RPC or blockchain transactions.\n" +
    "Use invented sample text only. Ctrl+C stops this trial.\n",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await close();
    process.exit(0);
  });
