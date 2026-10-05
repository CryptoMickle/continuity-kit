/** Verify the actual archive from outside the source checkout, without publishing. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert.ok(
  args.every((arg) => arg === "--allow-downloads"),
  "Unknown argument",
);
const allowDownloads = args.includes("--allow-downloads");
const output = join(root, "delivery/local-export/sdk");
rmSync(join(output, "consumer-verification.json"), { force: true });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = readJson(join(output, "manifest.json"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(manifest.scope, "private-local-sdk-package");
assert.equal(manifest.published, false);
const archive = join(output, manifest.package.filename);
assert.equal(sha256(readFileSync(archive)), manifest.archiveSha256);
for (const source of manifest.sources)
  assert.equal(
    sha256(readFileSync(join(root, source.path))),
    source.sha256,
    `SDK build is stale: ${source.path}. Run npm run build:sdk first.`,
  );

const dir = mkdtempSync(join(tmpdir(), "continuity-sdk-consumer-"));
try {
  cpSync(join(root, "examples/standalone-consumer"), dir, {
    recursive: true,
    filter: (path) =>
      !path.includes("node_modules") && !path.endsWith("package-lock.json"),
  });
  const pkg = readJson(join(dir, "package.json"));
  pkg.dependencies = { [manifest.package.name]: `file:${archive}` };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  try {
    execFileSync(
      "npm",
      [
        "install",
        allowDownloads ? "--prefer-offline" : "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    if (String(error.stderr).includes("ENOTCACHED"))
      throw new Error(
        "A dependency is absent from npm's offline cache. To permit public dependency downloads during installation, run npm run verify:sdk -- --allow-downloads. Runtime fetch remains disabled.",
      );
    throw new Error(
      `Isolated package installation failed: ${String(error.stderr)}`,
    );
  }

  const installed = join(dir, "node_modules", manifest.package.name);
  assert.equal(lstatSync(installed).isSymbolicLink(), false);
  assert.ok(realpathSync(installed).startsWith(realpathSync(dir) + "/"));
  const installedPackage = readJson(join(installed, "package.json"));
  assert.equal(installedPackage.private, true);
  assert.deepEqual(Object.keys(installedPackage.exports).sort(), [
    ".",
    "./testing",
  ]);
  assert.equal(installedPackage.scripts, undefined);
  for (const file of manifest.files)
    assert.equal(
      sha256(readFileSync(join(installed, file.path))),
      file.sha256,
      file.path,
    );
  assert.equal(existsSync(join(installed, "src")), false);
  for (const file of readdirSync(join(installed, "lib")))
    assert.ok(file.endsWith(".js") || file.endsWith(".d.ts"), file);

  const ts = createRequire(import.meta.url)(
    join(dir, "node_modules/typescript"),
  );
  for (const file of ["index.ts", "typecheck.ts"]) {
    const imports = ts.preProcessFile(
      readFileSync(join(dir, file), "utf8"),
      true,
    ).importedFiles;
    assert.ok(imports.length > 0);
    assert.ok(
      imports.every(
        ({ fileName }) =>
          fileName === "continuity-kit" ||
          fileName === "continuity-kit/testing",
      ),
      `${file} must consume only the installed public package exports`,
    );
  }

  // Resolve consumer types from its own installation in both Node and bundler modes.
  const typecheck = (module, moduleResolution) =>
    execFileSync(
      process.execPath,
      [
        join(dir, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2023",
        "--module",
        module,
        "--moduleResolution",
        moduleResolution,
        "--lib",
        "ES2023,DOM,ESNext.Disposable",
        "--types",
        "node",
        "--allowImportingTsExtensions",
        "index.ts",
        "typecheck.ts",
      ],
      { cwd: dir, stdio: "inherit" },
    );
  typecheck("NodeNext", "NodeNext");
  typecheck("ESNext", "Bundler");

  // The synthetic consumer must not turn a package check into HTTP/RPC activity.
  writeFileSync(
    join(dir, "deny-fetch.mjs"),
    'globalThis.fetch = async () => { throw new Error("Network fetch forbidden in SDK consumer test"); };\n',
  );
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "./deny-fetch.mjs", "index.ts"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  assert.equal(result.evidence, "synthetic-public-fixture");
  assert.equal(result.trustMode, "local-model");
  assert.equal(result.blockchainTransactions, 0);
  assert.equal(result.externalAdoption, false);
  const evidence = {
    scope: "internal-isolated-package-consumer",
    archiveSha256: manifest.archiveSha256,
    packageFilesVerified: manifest.files.length,
    node: process.version,
    installedFromTarball: true,
    sourceTreeImports: false,
    typeChecks: ["NodeNext", "Bundler"],
    runtimeFetchDisabled: true,
    dependencyInstallation: allowDownloads
      ? "public-downloads-allowed"
      : "offline-cache-only",
    verifierSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    consumerSources: ["package.json", "index.ts", "typecheck.ts"].map(
      (path) => ({
        path,
        sha256: sha256(
          readFileSync(join(root, "examples/standalone-consumer", path)),
        ),
      }),
    ),
    result,
  };
  writeFileSync(
    join(output, "consumer-verification.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
