import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";

// Offline only. Produces review material; deliberately has no RPC, signer or broadcast path.
const root = new URL("../", import.meta.url);
const artifactPath = new URL(
  "contracts/out/ContinuityRegistry.sol/ContinuityRegistry.json",
  root,
);
const artifactBytes = readFileSync(artifactPath);
const artifact = JSON.parse(artifactBytes.toString());
const initcode = artifact.bytecode.object as Hex,
  runtime = artifact.deployedBytecode.object as Hex;
if (![initcode, runtime].every((v) => /^0x(?:[0-9a-f]{2})+$/.test(v)))
  throw new Error(
    "Missing or unlinked bytecode; build the pinned contract locally first",
  );
const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const output = {
  status: "offline-review-only-no-deployment",
  chainId: 10143,
  value: "0x0",
  contract: "ContinuityRegistry",
  constructorArguments: [],
  creationData: initcode,
  expectedRuntimeCodeHash: keccak256(runtime),
  initcodeBytes: (initcode.length - 2) / 2,
  runtimeBytes: (runtime.length - 2) / 2,
  artifactSha256: sha256(artifactBytes),
  sourceSha256: sha256(
    readFileSync(new URL("contracts/src/ContinuityRegistry.sol", root)),
  ),
  compilerSettingsSha256: sha256(
    readFileSync(new URL("contracts/foundry.toml", root)),
  ),
  unresolved: [
    "approved deployer and funds",
    "gas estimate on Monad-native compatible tooling",
    "nonce and fees",
    "explicit deployment approval",
    "actual address and successful finalized receipt",
    "two independently operated approved RPC endpoints",
    "runtime-code verification at accepted block",
  ],
};
const destination = new URL("testnet/deployment-review.json", root);
writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `Offline deployment review written to ${fileURLToPath(destination)}; no network request or signing performed.`,
);
