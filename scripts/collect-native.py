"""Collect a built loader and exact source; never collect a Discord application."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / ".build/native/rain-tweak"
OUT = ROOT / "artifacts/native"
OUT.mkdir(parents=True, exist_ok=True)

packages = list((WORK / "packages").glob("*.deb"))
if len(packages) != 1:
    raise RuntimeError(f"Expected one freshly built loader package, found {len(packages)}")
stage = WORK / ".theos/_"
dylibs = list(stage.rglob("RainTweak.dylib"))
resources = list(stage.rglob("BunnyResources.bundle"))
if len(dylibs) != 1 or len(resources) != 1:
    raise RuntimeError("Missing or ambiguous native library/resource bundle")

sha256 = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
if sha256(resources[0] / "korg.js") != sha256(ROOT / "dist/korg.js"):
    raise RuntimeError("Packaged Korg differs from verified JavaScript build")
architecture = subprocess.check_output(["lipo", "-archs", str(dylibs[0])], text=True).strip()
if architecture != "arm64":
    raise RuntimeError(f"Unexpected native architecture: {architecture}")
dependencies = subprocess.check_output(["otool", "-L", str(dylibs[0])], text=True)

shutil.copy2(packages[0], OUT / "KorgLoader.deb")
shutil.copy2(dylibs[0], OUT / "RainTweak.dylib")
shutil.copytree(resources[0], OUT / "BunnyResources.bundle", dirs_exist_ok=True)
shutil.copy2(WORK / "LICENSE", OUT / "LICENSE.RainTweak")
shutil.copy2(ROOT / "native/NOTICE.md", OUT / "NATIVE-NOTICE.md")
shutil.copy2(ROOT / "docs/INSTALL.md", OUT / "INSTALL.md")
with tarfile.open(OUT / "korg-loader-source.tar.gz", "w:gz") as archive:
    for name in ["Sources", "Headers", "Makefile", "control", "RainTweak.plist", "patch.plist", "LICENSE", "KorgPayload"]:
        archive.add(WORK / name, arcname="KorgLoader/" + name)
    archive.add(ROOT / "native/NOTICE.md", arcname="KorgLoader/KORG-NOTICE.md")
    archive.add(ROOT / "native/loader.lock.json", arcname="KorgLoader/upstream.lock.json")

manifest = {
    "name": "KorgLoader",
    "version": "0.1.0",
    "status": "Compiled loader component; not an IPA; physical iPhone runtime unverified",
    "architecture": architecture,
    "xcode": subprocess.check_output(["xcodebuild", "-version"], text=True).strip(),
    "sdk": subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-version"], text=True).strip(),
    "theosRevision": "8167f59de02fd32cf45b16bfcb1330dfa5c9974c",
    "dynamicDependencies": dependencies,
    "requiresHookRuntime": "substrate" in dependencies.lower(),
    "files": {},
}
for file in sorted(OUT.rglob("*")):
    if file.is_file() and file.name != "manifest.json":
        manifest["files"][str(file.relative_to(OUT))] = {"bytes": file.stat().st_size, "sha256": sha256(file)}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Verified arm64 loader and embedded Korg; artifacts: {OUT}")
