/** Check the exact packaged source bytes. No app execution or network. */
import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
  await readFile(resolve(root, "SOURCE_MANIFEST.json"), "utf8"),
);
if (
  manifest.scope !== "local-source-candidate" ||
  !Array.isArray(manifest.files)
)
  throw new Error("Unexpected source manifest");
const seen = new Set();
for (const file of manifest.files) {
  const path = resolve(root, file.path);
  if (
    !path.startsWith(root + sep) ||
    relative(root, path).split(sep).join("/") !== file.path ||
    seen.has(file.path)
  )
    throw new Error("Invalid or duplicate source path");
  seen.add(file.path);
  for (let current = path; current !== root; current = dirname(current))
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Symlink is not a packaged file");
  const bytes = await readFile(path);
  if (
    bytes.length !== file.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw new Error(`Packaged source changed: ${file.path}`);
}
console.log(JSON.stringify({ filesVerified: seen.size, networkRequests: 0 }));
