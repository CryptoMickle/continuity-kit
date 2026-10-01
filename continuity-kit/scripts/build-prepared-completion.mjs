// Builds a fresh standalone local bundle, avoiding the running dev server's
// cached module graph. Does not restart, navigate, authenticate or broadcast.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "vite";
import { validateTestnetRuntimeConfig } from "../src/runtime.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
const config = validateTestnetRuntimeConfig(
  JSON.parse(
    await readFile(
      resolve(root, "testnet/runtime-candidate-foundation.json"),
      "utf8",
    ),
  ),
);
await build({
  root,
  configFile: false,
  base: "/delivery/local-export/prepared-completion-2026-09-28/",
  define: { __CONTINUITY_TESTNET_CONFIG__: JSON.stringify(config) },
  build: {
    outDir: resolve(
      root,
      "delivery/local-export/prepared-completion-2026-09-28",
    ),
    emptyOutDir: false,
    rolldownOptions: { input: resolve(root, "prepared-completion.html") },
  },
});
