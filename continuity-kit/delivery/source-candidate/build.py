"""Explicit, byte-preserving source export. No Git mutation or publication."""
from pathlib import Path
import argparse
import datetime
import gzip
import hashlib
import io
import json
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NAME = "continuity-kit-source-candidate"


def digest(data):
    return hashlib.sha256(data).hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True, type=Path)
parser.add_argument("--date", required=True, type=datetime.date.fromisoformat)
args = parser.parse_args()
out = args.out.resolve()
area = ROOT / "delivery/local-export"
if not out.is_relative_to(area) or out == area or out.exists():
    raise ValueError("Use a new directory inside delivery/local-export")
allowlist = json.loads((HERE / "files.json").read_text())
files, sources = {}, {}
for record in allowlist:
    source, target = record["source"], record.get("target", record["source"])
    for value in [source, target]:
        p = Path(value)
        if p.is_absolute() or ".." in p.parts or str(p) != value:
            raise ValueError(f"Invalid relative path: {value}")
    path = ROOT / source
    if path.is_symlink() or any(p.is_symlink() for p in path.parents):
        raise ValueError(f"Symlink refused: {source}")
    if target in files or target == "SOURCE_MANIFEST.json":
        raise ValueError(f"Duplicate or reserved target: {target}")
    files[target] = path.read_bytes()
    sources[target] = source

manifest = {
    "format": 1,
    "scope": "local-source-candidate",
    "date": args.date.isoformat(),
    "source_kind": "explicit allowlisted working-tree snapshot; includes uncommitted changes",
    "base_commit_only": subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip(),
    "published": False,
    "includes_git_history": False,
    "source_transformations": [],
    "builder_sha256": digest(Path(__file__).read_bytes()),
    "allowlist_sha256": digest((HERE / "files.json").read_bytes()),
    "files": [
        {"path": p, "source": sources[p], "sha256": digest(b), "bytes": len(b)}
        for p, b in sorted(files.items())
    ],
}
files["SOURCE_MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
    for path, data in sorted(files.items()):
        entry = tarfile.TarInfo(f"{NAME}/{path}")
        entry.size, entry.mode, entry.mtime = len(data), 0o644, 0
        tar.addfile(entry, io.BytesIO(data))
archive = gzip.compress(buffer.getvalue(), mtime=0)
out.mkdir(parents=True, exist_ok=False)
(out / f"{NAME}.tar.gz").write_bytes(archive)
result = {
    "archive": f"{NAME}.tar.gz",
    "sha256": digest(archive),
    "bytes": len(archive),
    "file_count": len(files),
    "manifest_sha256": digest(files["SOURCE_MANIFEST.json"]),
}
(out / "manifest.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
