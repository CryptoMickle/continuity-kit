import { build } from "vite";
import { fileURLToPath } from "node:url";

await build({
  root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false,
  envDir: false,
  define: {
    "import.meta.env.VITE_ENABLE_PHYSICAL_PASSKEYS": '"false"',
    __CONTINUITY_TESTNET_CONFIG__: "undefined",
  },
});
