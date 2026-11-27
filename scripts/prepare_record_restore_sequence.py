"""Package the synthetic sequence runner with unchanged canonical public assets.

This script never reads a user backup. The caller must first assemble the
production sentlog directory. Its exact module and asset hashes are emitted.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULES = ["blob-sha256.js", "backup-format.js", "startup-backup-recovery.js", "record-store.js"]
FIXTURE_FILES = ["index.html", "runner.js", "model.js", "profile.json"]


def package(built_root: Path, destination: Path) -> dict:
    source = built_root.resolve() / "sentlog"
    fixture = ROOT / "tests" / "record_restore_sequence"
    sw = (source / "sw.js").read_text()
    match = re.search(r"const FILES=(.*?);\s*const PDF_ASSETS=", sw, re.S)
    if not match:
        raise RuntimeError("The canonical service worker FILES list was not found")
    expression = match.group(1)
    # Evaluate only this repository's public static literal/Array.from expression.
    names = json.loads(subprocess.check_output(
        ["node", "-e", "const vm=require('vm');process.stdout.write(JSON.stringify(vm.runInNewContext(process.argv[1],{}, {timeout:1000})));", expression], text=True))
    if not isinstance(names, list) or not names or any(not isinstance(x, str) for x in names):
        raise RuntimeError("Invalid canonical static asset list")
    destination = destination.resolve()
    if destination.exists() and any(destination.iterdir()):
        raise RuntimeError("Output must be a new or empty package directory")
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {
        "format": "sentlog-sequence-public-source-manifest-v1",
        "scope": "Unchanged production modules and same-origin static FILES; external PDF_ASSETS omitted",
        "serviceWorkerSHA256": hashlib.sha256((source / "sw.js").read_bytes()).hexdigest(),
        "modules": {}, "fixture": {}, "assets": [],
    }
    for name in FIXTURE_FILES:
        data = (fixture / name).read_bytes()
        (destination / name).write_bytes(data)
        manifest["fixture"][name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    for name in dict.fromkeys([*names, *MODULES]):
        relative = Path(name or "index.html")
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError("Unsafe static asset path")
        path = source / relative
        data = path.read_bytes()
        target = destination / "app" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        descriptor = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        if name in names:
            manifest["assets"].append({"url": "app/" + name, **descriptor})
        if name in MODULES:
            manifest["modules"][name] = descriptor
    # Empty URL and index.html are intentionally distinct cache keys, as in FILES.
    assert len(manifest["assets"]) == len(names), "Unexpected duplicate FILES entry"
    manifest["staticAssetBytes"] = sum(x["bytes"] for x in manifest["assets"])
    (destination / "source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--built-root", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = package(args.built_root, args.out)
    print(json.dumps({"package": str(args.out.resolve()), "assets": len(manifest["assets"]),
                      "staticAssetBytes": manifest["staticAssetBytes"], "modules": manifest["modules"]}))


if __name__ == "__main__":
    main()
