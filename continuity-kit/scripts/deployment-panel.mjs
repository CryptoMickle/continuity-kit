import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const ACK = "--acknowledge-chat-approved-deployment-and-resolved-terms";
export const ORIGIN = "http://primary.localhost:4176";

// A local operator guard, not a source of user consent. Never infer approval from JSON.
export function deploymentPanelOptions(root) {
  let reserved = false;
  return {
    root,
    configFile: false,
    define: { __DEPLOYMENT_OPERATOR_ACK__: "true" },
    server: {
      host: "127.0.0.1",
      port: 4176,
      strictPort: true,
      allowedHosts: ["primary.localhost"],
      hmr: false,
      watch: null,
      cors: false,
      open: false,
    },
    plugins: [
      {
        name: "deployment-operator-guard",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Referrer-Policy", "no-referrer");
            res.setHeader("X-Frame-Options", "DENY");
            res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
            if (req.headers.host !== "primary.localhost:4176") {
              res.statusCode = 403;
              res.end("Operator hostname required");
              return;
            }
            if (req.url?.split("?")[0] !== "/__deployment_attempt") {
              next();
              return;
            }
            if (req.method !== "POST" || req.headers.origin !== ORIGIN) {
              res.statusCode = 403;
              res.end("Explicit same-origin operator action required");
              return;
            }
            if (reserved) {
              res.statusCode = 409;
              res.end(
                "Attempt already reserved; reconcile the existing ticket",
              );
              return;
            }
            reserved = true;
            res.statusCode = 204;
            res.end();
          });
        },
      },
    ],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3 || process.argv[2] !== ACK) {
    process.stdout.write(
      "Deployment panel remains dormant: concrete chat approval and resolved provider/faucet terms are required. No service started. The acknowledgment switch is for the authorized operator only; it does not grant consent.\n",
    );
  } else {
    const { createServer } = await import("vite");
    const server = await createServer(
      deploymentPanelOptions(fileURLToPath(new URL("..", import.meta.url))),
    );
    await server.listen();
    process.stdout.write(
      `Operator-only panel: ${ORIGIN}/testnet-deploy.html\nNo RPC or authentication until the manual one-shot action. Do not restart to retry an uncertain transaction.\n`,
    );
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await server.close();
      process.exit(0);
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  }
}
