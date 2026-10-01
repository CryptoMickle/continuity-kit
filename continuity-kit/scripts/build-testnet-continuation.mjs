// Fresh local assets for recovery after the verified v1. Does not restart the
// live service, touch loaded tabs, authenticate, or contact the chain.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "vite";
import { validateTestnetRuntimeConfig } from "../src/runtime.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(
  await readFile(
    resolve(root, "testnet/runtime-candidate-foundation.json"),
    "utf8",
  ),
);
// One explicitly approved checkpoint per authentication session. The external
// run ledger still limits the whole run to v1, v2, v3; reload cannot renew it.
config.sessionLimits.maxTransactions = 1;
config.sessionLimits.maxTotalFeeWei = "60000000000000000";
const approved = validateTestnetRuntimeConfig(config);
const base = "/delivery/local-export/testnet-continuation-2026-09-28/";
await build({
  root,
  configFile: false,
  base,
  define: { __CONTINUITY_TESTNET_CONFIG__: JSON.stringify(approved) },
  build: {
    outDir: resolve(root, `.${base}`),
    emptyOutDir: false,
    rolldownOptions: { input: resolve(root, "index.html") },
  },
});
