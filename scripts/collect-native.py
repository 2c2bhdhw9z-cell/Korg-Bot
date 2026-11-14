#!/usr/bin/env python3
"""Assemble and verify original Korg native-loader components."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "artifacts/native"
LIBRARY = ROOT / ".build/native/KorgLoader.dylib"
DIST = ROOT / "dist"
ALLOW = {"/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", "/System/Library/Frameworks/Foundation.framework/Foundation", "/System/Library/Frameworks/UIKit.framework/UIKit", "/usr/lib/libc++.1.dylib", "/usr/lib/libobjc.A.dylib", "/usr/lib/libSystem.B.dylib"}
RUNTIME = ["core.js", "metro.js", "patcher.js", "storage.js", "compat.js", "themes.js", "plugins.js", "ui.js", "start.js"]
SOURCES = ["native/KorgLoader.mm", "native/ABI.md", "scripts/build.mjs", "scripts/verify.mjs", "scripts/build-native.sh", "scripts/collect-native.py", ".github/workflows/build-native.yml", "tests/native.test.mjs", "package.json", "LICENSE", "NOTICE.md", "docs/API.md", "docs/AUDIT.md", "scripts/package-ipa.py", "tests/runtime.test.mjs", "tests/plugins.test.mjs", "tests/test_package_ipa.py"] + [f"runtime/{name}" for name in RUNTIME]

def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

if not LIBRARY.is_file():
    raise SystemExit(f"Missing compiled loader: {LIBRARY}")
if not (DIST / "korg.js").is_file() or not (DIST / "manifest.json").is_file():
    raise SystemExit("Build dist/korg.js and dist/manifest.json first")
arch = run("lipo", "-archs", str(LIBRARY))
if arch != "arm64":
    raise SystemExit(f"Expected arm64 loader, got {arch}")
deps = run("otool", "-L", str(LIBRARY)).splitlines()[1:]
for line in deps:
    dependency = line.strip().split(" (compatibility", 1)[0]
    if dependency == "@rpath/KorgLoader.dylib":
        continue
    if dependency not in ALLOW:
        raise SystemExit(f"Non-system or unexpected dependency: {dependency}")
manifest_js = json.loads((DIST / "manifest.json").read_text())
if manifest_js.get("name") != "KorgOriginalRuntime" or manifest_js.get("plugins") != [] or manifest_js.get("dependencies") != []:
    raise SystemExit("Unexpected runtime manifest contract")
with tempfile.TemporaryDirectory(prefix="korg-artifacts-") as temp:
    stage = Path(temp)
    shutil.copy2(LIBRARY, stage / "KorgLoader.dylib")
    resources = stage / "KorgResources.bundle"
    resources.mkdir()
    shutil.copy2(DIST / "korg.js", resources / "korg.js")
    shutil.copy2(DIST / "manifest.json", resources / "manifest.json")
    (stage / "SOURCE-NOTICE.md").write_text("Korg original loader and runtime sources are MIT-0; see LICENSE. No host application, host headers, downloaded source, plugins, or non-system native dependencies are included.\n")
    (stage / "manifest.json").write_text(json.dumps({
        "name": "KorgOriginalLoader", "version": "0.2.0-native-original", "architecture": "arm64",
        "dependencyPolicy": "system-only", "dynamicDependencies": deps,
        "runtime": {"name": manifest_js["name"], "version": manifest_js["version"], "plugins": [], "dependencies": []},
        "sources": {name: digest(ROOT / name) for name in SOURCES}, "files": {}
    }, indent=2) + "\n")
    with tarfile.open(stage / "korg-source.tar.gz", "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for name in sorted(SOURCES):
            archive.add(ROOT / name, arcname=f"KorgOriginal/{name}")
    package = stage / "manifest.json"
    manifest = json.loads(package.read_text())
    for file in sorted(stage.rglob("*")):
        if file.is_file() and file != package:
            manifest["files"][str(file.relative_to(stage))] = {"bytes": file.stat().st_size, "sha256": digest(file)}
    package.write_text(json.dumps(manifest, indent=2) + "\n")
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(stage, OUT)
print(f"Collected arm64 original Korg components at {OUT}")
