"""Private allowlisted working-tree trial; never export service state or .env."""
from pathlib import Path
import gzip
import hashlib
import io
import json
import subprocess
import argparse
import tarfile
from datetime import date

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "delivery/browser-evaluation"
OUT = ROOT / "delivery/local-export/browser-evaluation-2026-09-29"
parser = argparse.ArgumentParser()
parser.add_argument("--out", type=Path, default=OUT)
parser.add_argument("--date", type=date.fromisoformat, default=date.today())
args = parser.parse_args()
OUT = args.out.resolve()
if not OUT.is_relative_to((ROOT / "delivery/local-export").resolve()):
    raise ValueError("Output must stay inside delivery/local-export")
NAME = "continuity-kit-browser-trial"
if (OUT / f"{NAME}.tar.gz").exists():
    raise FileExistsError("Preserve pinned archives; choose a new --out directory")
REMAP = {
    "primary.localhost": "trial-primary.localhost",
    "recovery.localhost": "trial-recovery.localhost",
    "4173": "4373", "4174": "4374", "4175": "4375",
}

def digest(data):
    return hashlib.sha256(data).hexdigest()

files = {}
sources = {}

def add(path, target=None, remap=False):
    source = ROOT / path
    if source.is_symlink() or any(p.is_symlink() for p in source.parents if p != ROOT.parent):
        raise ValueError(f"Symlink refused: {path}")
    data = source.read_bytes()
    packaged = data
    if remap:
        text = data.decode("utf-8")
        for before, after in REMAP.items():
            text = text.replace(before, after)
        packaged = text.encode("utf-8")
    target = target or path
    if target in files:
        raise ValueError(f"Duplicate: {target}")
    files[target] = packaged
    sources[target] = {"path": path, "sha256": digest(data), "local_addresses_remapped": remap}

release = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "src/release").glob("*.ts"))
sdk = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "src/sdk").glob("*.ts"))
for path in sdk + release + [
    "src/main.ts", "src/style.css", "src/runtime.ts", "src/handoff.ts", "src/vite-env.d.ts",
    "scripts/service.mjs", "scripts/seed-demo.ts", "index.html",
    "tests/sdk-protocol.test.ts", "tests/service.test.mjs",
    "tests/main-reconciliation.test.mjs", "tests/handoff.test.ts",
]:
    add(path, remap=True)
for path in ["package-lock.json", "LICENSE", "public/logo.svg", "public/third-party-notices.txt"]:
    add(path)
for source, target in {
    "start.mjs": "scripts/start.mjs", "build.mjs": "scripts/build.mjs",
    "README.md": "README.md", "EVALUATION_NOTES.md": "EVALUATION_NOTES.md",
    "try.html": "public/try.html",
}.items():
    add(f"delivery/browser-evaluation/{source}", target)

package = json.loads((ROOT / "package.json").read_text())
package["description"] = "Private, synthetic local browser evaluation of ContinuityKit."
package["scripts"] = {
    "start": "node scripts/start.mjs",
    "test": "node --test tests/*.test.ts tests/*.test.mjs",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit && node scripts/build.mjs",
    "check": "npm run typecheck && npm test && npm run build",
}
tsconfig = json.loads((ROOT / "tsconfig.json").read_text())
tsconfig["include"] = ["src", "tests"]
for path, value in [("package.json", package), ("tsconfig.json", tsconfig)]:
    files[path] = (json.dumps(value, indent=2) + "\n").encode()
    sources[path] = {"path": path, "sha256": digest((ROOT / path).read_bytes()),
                     "configuration_wrapper": True}
files[".gitignore"] = b"node_modules/\ndist/\n*.log\n"

try:
    base_commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
except (subprocess.CalledProcessError, FileNotFoundError):
    base_commit = None  # Extracted source archives need no Git installation/history.

manifest = {
    "format": 1, "date": args.date.isoformat(), "scope": "private-synthetic-browser-trial",
    "source_kind": "allowlisted working-tree snapshot, including uncommitted changes",
    "base_commit_only": base_commit,
    "transformation": REMAP,
    "builder_sha256": digest(Path(__file__).read_bytes()),
    "files": [{"path": p, "sha256": digest(b), "bytes": len(b), "source": sources.get(p)}
              for p, b in sorted(files.items())],
    "limitations": ["public synthetic credentials", "one RAM service holds both copies",
                    "no physical, chain, external-evaluator or hosting proof"],
}
files["PACKAGE_MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
    for path, data in sorted(files.items()):
        info = tarfile.TarInfo(f"{NAME}/{path}")
        info.size = len(data)
        info.mode = 0o644
        info.mtime = 0
        tar.addfile(info, io.BytesIO(data))
archive = gzip.compress(buffer.getvalue(), mtime=0)
OUT.mkdir(parents=True, exist_ok=True)
archive_path = OUT / f"{NAME}.tar.gz"
archive_path.write_bytes(archive)
result = {"archive": str(archive_path), "sha256": digest(archive), "file_count": len(files),
          "manifest_sha256": digest(files["PACKAGE_MANIFEST.json"])}
(OUT / "manifest.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
