#!/usr/bin/env python3
"""Package and verify a Korg IPA end to end, without the supplied Discord app.

Two uses:

  smoke-package-ipa.py --output OUT.ipa [--native-dir artifacts/native | --loader-zip ZIP]
      Build a synthetic, Discord-353-shaped IPA (one Payload/Discord.app with the real bundle
      identifier, version 353.0, an arm64 unencrypted main executable, a framework, a nested
      extension and stale signatures), run scripts/package-ipa.py on it exactly as CI does, and
      then open the packaged output and check that it really contains the Korg loader and
      resources. With --native-dir the loader is the collected macOS build; without it a
      synthetic arm64 dylib is used, so the path also runs on Linux.

  smoke-package-ipa.py --verify OUT.ipa
      Check an already packaged IPA for the same shape and loader injection. Used on the IPA
      packaged from a user-supplied Discord file.

The synthetic host proves packaging and verification; it is not a Discord build and says
nothing about device behavior. Stdlib only.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("package_ipa", ROOT / "scripts" / "package-ipa.py")
pkg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pkg)

DISCORD_IDENTIFIER = "com.hammerandchisel.discord"
DISCORD_VERSION = "353.0"
DISCORD_BUILD = "122208"
RESOURCE_FILES = ("KorgResources.bundle/korg.js", "KorgResources.bundle/manifest.json",
                  "KorgResources.bundle/Source/korg-source.tar.gz",
                  "KorgResources.bundle/Source/SOURCE-NOTICE.md")
NATIVE_FILES = ("KorgLoader.dylib", "KorgResources.bundle/korg.js",
                "KorgResources.bundle/manifest.json", "korg-source.tar.gz", "SOURCE-NOTICE.md")


def fail(message):
    raise SystemExit(f"smoke packaging failed: {message}")


def library(name, cmd=0xC):
    raw = bytearray(pkg.dylib_command(name))
    struct.pack_into("<I", raw, 0, cmd)
    return bytes(raw)


def rpath(path):
    """LC_RPATH, which package-ipa reads as an @loader_path/@rpath search entry."""
    encoded = path.encode("utf-8") + b"\0"
    size = (12 + len(encoded) + 7) & ~7
    return struct.pack("<III", 0x8000001C, size, 12) + encoded + bytes(size - 12 - len(encoded))


def macho(commands=(), padding=1024, cryptid=0, filetype=6, signature=True):
    """A thin arm64 Mach-O with one __TEXT/__text section, as tests/test_package_ipa.py builds."""
    segment = bytearray(152)
    struct.pack_into("<II16sQQQQIIII", segment, 0, 0x19, 152, b"__TEXT", 0, 4096, 0, 0, 7, 5, 1, 0)
    struct.pack_into("<16s16sQQIIIIIIII", segment, 72, b"__text", b"__TEXT", 0, 32, 0, 2, 0, 0, 0, 0, 0, 0)
    encryption = struct.pack("<IIIIII", 0x2C, 24, 0, 0, cryptid, 0)
    signature_command = struct.pack("<IIII", 0x1D, 16, 0, 0)
    commands = [bytes(segment), encryption, signature_command, *commands]
    end = 32 + sum(map(len, commands))
    section = end + padding
    payload = b"SYNTHETIC HOST INSTRUCTIONS MUST STAY UNCHANGED!!"
    segment = bytearray(commands[0])
    struct.pack_into("<Q", segment, 48, section + len(payload))
    struct.pack_into("<I", segment, 120, section)
    commands[0] = bytes(segment)
    trailer = b"UNREFERENCED_SIGNATURE"
    commands[2] = struct.pack("<IIII", 0x1D if signature else 0x7777, 16, section + len(payload), len(trailer))
    header = struct.pack("<IIIIIIII", 0xFEEDFACF, pkg.ARM64, 0, filetype, len(commands), end - 32, 0, 0)
    return header + b"".join(commands) + bytes(padding) + payload + trailer


def write_zip(path, files, directories=()):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in directories:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFDIR | 0o755) << 16
            archive.writestr(info, b"")
        for name, data in files.items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if name.endswith((".dylib", "Discord", "Some", "Share")) else 0o644)) << 16
            archive.writestr(info, data)


def synthetic_host():
    """One app bundle carrying what package-ipa inspects: identity, version, images, stale signatures."""
    app = "Payload/Discord.app/"
    files = {
        app + "Info.plist": plistlib.dumps({
            "CFBundleExecutable": "Discord",
            "CFBundleName": "Discord",
            "CFBundleDisplayName": "Discord",
            "CFBundleIdentifier": DISCORD_IDENTIFIER,
            "CFBundleShortVersionString": DISCORD_VERSION,
            "CFBundleVersion": DISCORD_BUILD,
            "MinimumOSVersion": "16.0",
        }, fmt=plistlib.FMT_BINARY),
        app + "Discord": macho([library("/usr/lib/libobjc.A.dylib"),
                                library("@rpath/Some.framework/Some"),
                                rpath("@executable_path/Frameworks")], filetype=2),
        app + "Frameworks/Some.framework/Info.plist": plistlib.dumps({"CFBundleExecutable": "Some"}),
        app + "Frameworks/Some.framework/Some": macho([library("/usr/lib/libobjc.A.dylib")]),
        app + "PlugIns/Share.appex/Info.plist": plistlib.dumps({"CFBundleExecutable": "Share"}),
        app + "PlugIns/Share.appex/Share": macho([library("/usr/lib/libSystem.B.dylib")], filetype=2),
        app + "PlugIns/Share.appex/_CodeSignature/CodeResources": b"nested signature",
        app + "assets/bundle.bin": b"SYNTHETIC HOST ASSET",
        app + "_CodeSignature/CodeResources": b"signature",
        app + "embedded.mobileprovision": b"profile",
    }
    directories = ("Payload/", app, app + "Frameworks/", app + "assets/")
    return files, directories


def synthetic_native():
    """The native component archive contract collect-native.py produces, with a synthetic loader."""
    runtime_manifest = {"name": "KorgOriginalRuntime", "version": "0.2.0",
                        "thirdPartyPluginsBundled": False, "runtimeDependenciesBundled": [],
                        "pluginRegistry": []}
    files = {
        "KorgLoader.dylib": macho([library("/usr/lib/libobjc.A.dylib")], filetype=6),
        "KorgResources.bundle/korg.js": b"// synthetic Korg runtime for the packaging smoke test\n",
        "KorgResources.bundle/manifest.json": json.dumps(runtime_manifest).encode(),
        "korg-source.tar.gz": b"synthetic source archive fixture",
        "SOURCE-NOTICE.md": b"Synthetic smoke-test notice\n",
    }
    manifest = {"name": "KorgOriginalLoader", "version": "0.2.0-native-original", "architecture": "arm64",
                "files": {name: {"bytes": len(data), "sha256": pkg.sha(data)} for name, data in files.items()}}
    files["manifest.json"] = json.dumps(manifest).encode()
    return files


def native_input(temp, native_dir):
    """Return the loader archive CI would package, and the loader/korg.js bytes it must inject."""
    loader_zip = temp / "native-components.zip"
    if native_dir is not None:
        directory = Path(native_dir)
        if not (directory / "KorgLoader.dylib").is_file():
            fail(f"{directory} has no KorgLoader.dylib; build the native loader first")
        files = {str(path.relative_to(directory)): path.read_bytes()
                 for path in directory.rglob("*") if path.is_file()}
        write_zip(loader_zip, files, directories=(f"{str(path.relative_to(directory))}/"
                                                  for path in directory.iterdir() if path.is_dir()))
    else:
        files = synthetic_native()
        write_zip(loader_zip, files, directories=("KorgResources.bundle/",))
    loader = files["KorgLoader.dylib"]
    korg_js = files["KorgResources.bundle/korg.js"]
    return loader_zip, loader, korg_js


def parse_commands(data, description):
    if not isinstance(data, bytes) or data[:4] not in pkg.MAGICS:
        fail(f"{description}: not a thin Mach-O")
    header = pkg.parse(data)
    if header["cpu"] != pkg.ARM64:
        fail(f"{description}: not arm64")
    return header


def verify_ipa(path, *, loader_bytes=None, korg_js=None, report=None):
    """Open a packaged IPA and prove the loader and resources are really inside Payload/*.app."""
    entries = pkg.read_zip(path)
    files = {name: data for name, (_, data) in entries.items() if data is not None}
    roots = {name.split("/")[1] for name in files
             if name.startswith("Payload/") and len(name.split("/")) > 2 and name.split("/")[1].endswith(".app")}
    if len(roots) != 1:
        fail(f"expected one Payload app, found {sorted(roots)}")
    app = "Payload/" + next(iter(roots))
    info_name = app + "/Info.plist"
    if info_name not in files:
        fail("packaged app has no Info.plist")
    info = plistlib.loads(files[info_name])
    if info.get("CFBundleIdentifier") != DISCORD_IDENTIFIER:
        fail(f"bundle identifier changed: {info.get('CFBundleIdentifier')!r}")
    if str(info.get("CFBundleShortVersionString", "")).split(".")[0] != "353":
        fail(f"unexpected version: {info.get('CFBundleShortVersionString')!r}")
    if info.get("CFBundleDisplayName") != "Korg" or info.get("CFBundleName") != "Korg":
        fail("the packaged app is not named Korg")
    executable = app + "/" + str(info.get("CFBundleExecutable"))
    if executable not in files:
        fail(f"missing main executable {executable}")
    header = parse_commands(files[executable], executable)
    if header["filetype"] != 2:
        fail("the main executable is not MH_EXECUTE")
    libraries = [command["name"] for command in header["commands"] if command["cmd"] in pkg.DYLIBS]
    if pkg.LOADER_PATH not in libraries:
        fail(f"the Korg loader is not loaded by the app ({libraries})")
    if any(command["cmd"] == 0x1D for command in header["commands"]):
        fail("the main executable still carries an LC_CODE_SIGNATURE command")
    loader_name = app + "/Frameworks/KorgLoader.dylib"
    if loader_name not in files:
        fail("Payload app has no Frameworks/KorgLoader.dylib")
    loader_header = parse_commands(files[loader_name], loader_name)
    if loader_header["filetype"] != 6:
        fail("KorgLoader.dylib is not MH_DYLIB")
    for command in loader_header["commands"]:
        if command["cmd"] in pkg.DYLIBS and not command["name"].startswith(("/System/Library/", "/usr/lib/")):
            fail(f"KorgLoader.dylib links a non-system library: {command['name']}")
    for name in RESOURCE_FILES:
        if app + "/" + name not in files:
            fail(f"missing {app}/{name}")
    # The packager removes LC_CODE_SIGNATURE from every image it writes, the injected loader included, because the
    # signer must sign the whole app again. Everything else in the loader has to be the built one.
    if loader_bytes is not None and files[loader_name] != pkg.rewrite(loader_bytes):
        fail("the packaged KorgLoader.dylib differs from the built loader")
    if korg_js is not None and files[app + "/KorgResources.bundle/korg.js"] != korg_js:
        fail("the packaged korg.js differs from the built runtime")
    leftovers = [name for name in files
                 if "_CodeSignature" in name.split("/") or name.endswith("/embedded.mobileprovision")]
    if leftovers:
        fail(f"stale signature material survived: {leftovers[:3]}")
    if report is not None:
        for key, expected in (("preservedBundleIdentifier", DISCORD_IDENTIFIER),
                              ("preservedDiscordVersion", DISCORD_VERSION),
                              ("thirdPartyPluginsBundled", False), ("runtimeDependenciesBundled", [])):
            if report.get(key) != expected:
                fail(f"inspection report {key} is {report.get(key)!r}, expected {expected!r}")
    return {
        "ipa": str(path),
        "bytes": path.stat().st_size,
        "sha256": pkg.sha(path.read_bytes()),
        "app": app,
        "bundleIdentifier": info.get("CFBundleIdentifier"),
        "version": info.get("CFBundleShortVersionString"),
        "build": info.get("CFBundleVersion"),
        "loadCommand": pkg.LOADER_PATH,
        "loaderSignatureCommandRemoved": True,
        "loaderSha256": pkg.sha(files[loader_name]),
        "korgJsSha256": pkg.sha(files[app + "/KorgResources.bundle/korg.js"]),
        "resourceFiles": list(RESOURCE_FILES),
        "mainExecutableLibraries": libraries,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, help="Where to write the packaged smoke IPA")
    parser.add_argument("--native-dir", type=Path, help="Collected native components to inject (macOS build)")
    parser.add_argument("--loader-zip", type=Path, help="Alternatively, a prepared native artifact ZIP")
    parser.add_argument("--verify", type=Path, help="Only verify an already packaged IPA")
    parser.add_argument("--expected-loader-sha256", help="Trusted SHA-256 of the native archive")
    args = parser.parse_args()
    if args.verify is not None:
        print(json.dumps(verify_ipa(args.verify), indent=2))
        return
    if args.output is None:
        parser.error("give --output to package, or --verify to check an existing IPA")
    output = args.output.resolve()
    if output.exists():
        fail(f"{output} already exists; remove it first")
    with tempfile.TemporaryDirectory(prefix="korg-smoke-") as temp_name:
        temp = Path(temp_name)
        host, directories = synthetic_host()
        host_ipa = temp / "Discord-353-synthetic.ipa"
        write_zip(host_ipa, host, directories=directories)
        if args.loader_zip is not None:
            loader_zip = Path(args.loader_zip)
            if not loader_zip.is_file():
                fail(f"{loader_zip} does not exist")
            loader_files = pkg.read_zip(loader_zip)
            loader = loader_files["KorgLoader.dylib"][1]
            korg_js = loader_files["KorgResources.bundle/korg.js"][1]
        else:
            loader_zip, loader, korg_js = native_input(temp, args.native_dir)
        expected = args.expected_loader_sha256 or pkg.sha(loader_zip.read_bytes())
        command = [sys.executable, str(ROOT / "scripts" / "package-ipa.py"),
                   "--ipa", str(host_ipa), "--loader-zip", str(loader_zip),
                   "--expected-loader-sha256", expected, "--output", str(output)]
        completed = subprocess.run(command, capture_output=True, text=True)
        if completed.returncode != 0:
            fail(f"package-ipa.py refused the input:\n{completed.stdout}{completed.stderr}")
        try:
            report = json.loads(completed.stdout)
        except json.JSONDecodeError:
            fail(f"package-ipa.py did not print an inspection report:\n{completed.stdout}")
        summary = verify_ipa(output, loader_bytes=loader, korg_js=korg_js, report=report)
        inspection = output.with_suffix(".inspection.json")
        if not inspection.is_file():
            fail("package-ipa.py did not write the inspection sidecar")
        on_disk = json.loads(inspection.read_text())
        if on_disk.get("outputSha256") != pkg.sha(output.read_bytes()):
            fail("the inspection sidecar does not match the packaged IPA")
        if on_disk.get("inputSha256") != pkg.sha(host_ipa.read_bytes()):
            fail("the inspection sidecar does not record the input digest")
        summary["nativeInput"] = "collected macOS build" if args.native_dir else (
            "prepared archive" if args.loader_zip else "synthetic arm64 dylib")
        summary["inspection"] = str(inspection)
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
