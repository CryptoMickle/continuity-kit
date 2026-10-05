/** Build only. Never registers a site, uploads files or calls a chain. */
import { readFile, mkdir, writeFile, cp, readdir } from "node:fs/promises";
import { resolve, relative, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "vite";
import { validateReleaseProfile } from "../src/release/profile.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
if (
  ![6, 8].includes(process.argv.length) ||
  process.argv[2] !== "--profile" ||
  process.argv[4] !== "--out" ||
  (process.argv.length === 8 &&
    (process.argv[6] !== "--storage" ||
      !["d1", "upstash"].includes(process.argv[7])))
)
  throw new Error(
    "Use --profile <reviewed JSON> --out <new directory inside delivery/local-export> [--storage d1|upstash]",
  );
const storage = process.argv[7] ?? "d1";
const profilePath = resolve(process.argv[3]);
const out = resolve(process.argv[5]);
const area = join(root, "delivery/local-export");
if (!out.startsWith(area + "/"))
  throw new Error("Local export directory required");
const input = await readFile(profilePath);
if (input.length > 8192) throw new Error("Profile too large");
const profile = validateReleaseProfile(JSON.parse(input));
await mkdir(out); // Refuse to overwrite a previous candidate/evidence snapshot.
const define = {
  __CONTINUITY_RELEASE_PROFILE__: JSON.stringify(profile),
  __CONTINUITY_TESTNET_CONFIG__: "undefined",
  "import.meta.env.VITE_ENABLE_PHYSICAL_PASSKEYS": '"true"',
};
await build({
  root,
  configFile: false,
  envDir: false,
  define,
  build: { outDir: join(out, "primary"), emptyOutDir: false, sourcemap: false },
});
await cp(join(out, "primary"), join(out, "recovery"), { recursive: true });
await build({
  root,
  configFile: false,
  envDir: false,
  publicDir: false,
  define,
  build: {
    outDir: join(out, "store"),
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: join(
        root,
        storage === "d1"
          ? "src/release/worker.ts"
          : "src/release/redis-worker.ts",
      ),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
});
if (storage === "d1") {
  await mkdir(join(out, "store/migrations"));
  await cp(
    join(root, "migrations/0001_demo_objects.sql"),
    join(out, "store/migrations/0001_demo_objects.sql"),
  );
}
// Embed the reviewed static output in small Worker entrypoints so security
// headers do not depend on whether the host supports a static _headers file.
const assets = {};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};
let assetBytes = 0;
async function embed(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await embed(path);
    else {
      if (!entry.isFile()) throw new Error("Non-file asset forbidden");
      const contentType = mime[extname(entry.name)];
      if (!contentType) throw new Error("Unexpected asset type");
      const bytes = await readFile(path);
      assetBytes += bytes.length;
      if (assetBytes > 2 * 1024 * 1024)
        throw new Error("Client bundle too large");
      assets["/" + relative(join(out, "primary"), path)] = {
        contentType,
        base64: bytes.toString("base64"),
      };
    }
  }
}
await embed(join(out, "primary"));
for (const role of ["primary", "recovery"]) {
  await build({
    root,
    configFile: false,
    envDir: false,
    publicDir: false,
    define: {
      ...define,
      __CONTINUITY_CLIENT_ROLE__: JSON.stringify(role),
      __CONTINUITY_CLIENT_ASSETS__: JSON.stringify(assets),
    },
    build: {
      outDir: join(out, "hosts", role, "dist/server"),
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: join(root, "src/release/client-worker.ts"),
        formats: ["es"],
        fileName: () => "index.js",
      },
    },
  });
}
await mkdir(join(out, "hosts/store/dist/server"), { recursive: true });
await cp(
  join(out, "store/index.js"),
  join(out, "hosts/store/dist/server/index.js"),
);
// Exact source/migration allowlist; never copy installed tooling or secrets.
for (const file of storage === "d1"
  ? [
      "package.json",
      "package-lock.json",
      "drizzle.config.ts",
      "db/schema.ts",
      "drizzle/0000_demo_objects.sql",
      "drizzle/0001_demo_quota.sql",
      "drizzle/meta/_journal.json",
      "drizzle/meta/0000_snapshot.json",
      "drizzle/meta/0001_snapshot.json",
      "README.md",
    ]
  : []) {
  const destination = join(out, "hosts/store", file);
  await mkdir(join(destination, ".."), { recursive: true });
  await cp(join(root, "release/database", file), destination);
}
await writeFile(
  join(out, "profile.json"),
  JSON.stringify(profile, null, 2) + "\n",
);
const files = [];
async function visit(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlink forbidden");
    if (entry.isDirectory()) await visit(p);
    else {
      const bytes = await readFile(p);
      files.push({
        path: relative(out, p),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
await visit(out);
const manifest = {
  format: 1,
  scope: "local-public-demo-candidate",
  storage,
  createdAt: new Date().toISOString(),
  profile,
  placeholderOrigins: [
    profile.aOrigin,
    profile.bOrigin,
    profile.storeOrigin,
  ].some((u) => new URL(u).hostname.endsWith(".invalid")),
  published: false,
  files,
  remaining: [
    "actual provider origins and access mode",
    ...(storage === "d1"
      ? [
          "store capability secret and runtime DB binding",
          "Sites project identities, source preparation and platform validation of generated D1 migrations",
        ]
      : [
          "separate approved Upstash database, verified plan/capacity and eviction disabled",
          "server-only CONTINUITY_UPLOAD_TOKEN, CONTINUITY_REDIS_REST_URL and CONTINUITY_REDIS_REST_TOKEN",
          "reviewed hosting destination; do not replace failed Sites D1 history with this independent candidate",
        ]),
    "verification of actual hosted headers, CORS, opener and cost limits",
    "physical/native interoperability",
    "actual judge links and supervised demonstration; method accepted by organizer 30 September",
    "explicit publication and new physical/write approval",
  ],
};
await writeFile(
  join(out, "MANIFEST.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    out,
    files: files.length,
    placeholderOrigins: manifest.placeholderOrigins,
    published: false,
  }),
);
