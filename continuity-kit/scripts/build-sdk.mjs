/** Build a private, locally installable SDK. Never publishes or contacts a registry. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "delivery/local-export/sdk");
const area = join(root, "delivery/local-export");
mkdirSync(area, { recursive: true });
// A previous pass must not look current after rebuilding, including a failed rebuild.
rmSync(join(output, "consumer-verification.json"), { force: true });
const stage = mkdtempSync(join(area, "sdk-build-"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const source = json(join(root, "package.json"));

try {
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--project",
      join(root, "tsconfig.sdk.json"),
      "--outDir",
      join(stage, "lib"),
    ],
    { cwd: root, stdio: "inherit" },
  );
  const entry = (name) => ({
    types: `./lib/${name}.d.ts`,
    import: `./lib/${name}.js`,
  });
  const pkg = {
    name: source.name,
    version: source.version,
    private: true,
    type: "module",
    description: source.description,
    license: "MIT",
    engines: source.engines,
    main: "./lib/index.js",
    types: "./lib/index.d.ts",
    exports: {
      ".": entry("index"),
      "./testing": entry("demo-fixture"),
    },
    files: ["lib", "LICENSE", "README.md", "third-party-notices.txt"],
    dependencies: source.dependencies,
  };
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  cpSync(join(root, "delivery/SDK_PACKAGE.md"), join(stage, "README.md"));
  cpSync(
    join(root, "public/third-party-notices.txt"),
    join(stage, "third-party-notices.txt"),
  );

  // No lifecycle scripts, registry request, npm publish or installed dependency mutation.
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--offline",
        "--cache",
        join(stage, "npm-cache"),
        "--json",
        "--pack-destination",
        stage,
      ],
      { cwd: stage, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  )[0];
  if (!packed?.filename || packed.filename !== `${pkg.name}-${pkg.version}.tgz`)
    throw new Error("Unexpected SDK archive name");
  const sourceFiles = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.sdk.json",
    "scripts/build-sdk.mjs",
    "delivery/SDK_PACKAGE.md",
    "LICENSE",
    "public/third-party-notices.txt",
    ...readdirSync(join(root, "src/sdk"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/sdk/${name}`),
  ].sort();
  const manifest = {
    format: 1,
    scope: "private-local-sdk-package",
    published: false,
    package: {
      name: pkg.name,
      version: pkg.version,
      filename: packed.filename,
    },
    archiveSha256: sha256(readFileSync(join(stage, packed.filename))),
    files: packed.files.map(({ path, size }) => ({
      path,
      bytes: size,
      sha256: sha256(readFileSync(join(stage, path))),
    })),
    sources: sourceFiles.map((path) => ({
      path,
      sha256: sha256(readFileSync(join(root, path))),
    })),
    dependencies: source.dependencies,
    compilerVersion: json(join(root, "node_modules/typescript/package.json"))
      .version,
  };
  mkdirSync(output, { recursive: true });
  // Replace only this builder's generated outputs; never remove the output directory.
  const archivePath = join(output, packed.filename);
  if (existsSync(archivePath)) rmSync(archivePath);
  renameSync(join(stage, packed.filename), archivePath);
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        archive: relative(root, archivePath),
        sha256: manifest.archiveSha256,
        files: manifest.files.length,
        published: false,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
