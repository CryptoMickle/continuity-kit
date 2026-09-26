import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateTestnetRuntimeConfig } from "../src/runtime.ts";

export const ACK = "--acknowledge-chat-approved-testnet-run";
export function parseTestnetArgs(args) {
  if (
    args.length !== 3 ||
    args[0] !== "--config" ||
    !args[1] ||
    args[2] !== ACK
  )
    throw new Error("TESTNET_RUN_DORMANT");
  return resolve(args[1]);
}
export async function readTestnetConfig(path) {
  const bytes = await readFile(path);
  if (bytes.length > 16384) throw new Error("TESTNET_CONFIG_TOO_LARGE");
  return validateTestnetRuntimeConfig(JSON.parse(bytes.toString("utf8")));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let configPath;
  try {
    configPath = parseTestnetArgs(process.argv.slice(2));
  } catch {
    process.stdout.write(
      "Testnet run remains dormant. After concrete chat approval and verified deployment, supply --config <reviewed-policy.json> plus the operator acknowledgment. No service started.\n",
    );
  }
  if (configPath) {
    const config = await readTestnetConfig(configPath);
    const { startDemo } = await import("./start-demo.mjs");
    await startDemo({ physical: true, testnetConfig: config });
  }
}
