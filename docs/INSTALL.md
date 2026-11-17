# Building and trying the original Korg runtime

The independently authored loader and runtime source are in this repository. A physical iPhone run of the rewrite has not been verified. The browser preview is not an app, and a JavaScript bundle or native component ZIP cannot be installed by renaming it to `.ipa`.

The user-supplied input is **Discord 353.0, build 122208**, arm64, with an unencrypted main executable (`cryptid=0`) and no injected tweak found in prior static inspection. It was packaged with the verified original loader into `Korg-0.2-original-Discord-353-unsigned.ipa`. The source file is unchanged; the output is unsigned and needs your own signer. The earlier Discord 352 Korg 0.2 package contains the historical Rain-derived stack and is not this rewrite.

## Explore locally

With Node.js 22+:

```sh
npm run dev
```

The preview server prints its local address. Its settings design has six own palettes and a metadata-only URL demo. It neither connects to Discord nor downloads or executes plugin code. The URL list is temporary; the palette is stored in the browser when possible. No package install or external preview dependency is needed.

## Build the JavaScript input

```sh
npm run build
npm run verify
npm test
python3 -m unittest discover -s tests -p 'test_package_ipa.py'
```

Python packaging requires Python 3.11+. These are the verification commands; the **Build Korg loader** workflow runs them on every push, so check the workflow run for current results.

The local build produces:

- `dist/korg.js`: the nine original runtime modules in a fixed order, syntax-checked as JavaScript.
- `dist/manifest.json`: `KorgOriginalRuntime` identity, per-source SHA-256 hashes, `plugins: []`, and `dependencies: []`.

No Rain source, upstream lockfile, plugin implementation, runtime library, or Hermes compiler is downloaded. The verifier checks that the output exactly matches the hashed local inputs. These checks establish build contents, not iPhone behavior.

## Compile on macOS

Use full Xcode with the iPhoneOS SDK, Node.js 22+, and Python 3.11+:

```sh
npm run build:native
```

The original build uses Xcode's compiler directly for an arm64 Objective-C++ dylib targeting iOS 16+. There is no Theos/RainTweak preparation or third-party hook runtime to supply. The collector checks the loader against an Apple-system dependency allowlist and assembles:

- `KorgLoader.dylib`
- `KorgResources.bundle/korg.js` and its runtime manifest
- A native manifest containing source and component hashes
- `korg-source.tar.gz` and the source notice

The **Build Korg loader** workflow is the macOS build route. Its later actual output must be checked; configuration alone is not a successful build. Loader components do not contain Discord and are not a signed IPA.

## Package a separate app copy

### In GitHub Actions (recommended)

The **Package Korg IPA** workflow (`.github/workflows/package-ipa.yml`) builds the loader on macOS and runs the packager. It needs only one thing the repository cannot provide: your Discord IPA.

What it must be: **Discord 353.0, build 122208**, `arm64`, the app executable **unencrypted** (`cryptid=0`), as a normal `.ipa` whose `Payload/` holds exactly one app bundle with `CFBundleIdentifier com.hammerandchisel.discord`. The packager refuses any other version, identifier, encrypted image, extra app, or already-signed-output name. It does not decrypt or download Discord for you.

How to run it: **Actions → Package Korg IPA → Run workflow**, then either

- `ipa_url`: an HTTPS link to that file that the runner can download (your storage, signed URL, or a release you control). Add `ipa_sha256` to have a different file refused; or
- `ipa_run_id` + `ipa_artifact_name`: upload the IPA as an artifact in a run of this repository (for example `gh workflow run` a small upload workflow, or attach it to any existing run) and point at that run. The default artifact name is `discord-353-ipa`.

The run always smoke-packages a synthetic Discord-353-shaped app first, then packages your file, verifies the result, and uploads **`Korg-unsigned-ipa`** with `Korg-353-unsigned.inspection.json` and the packager log. Output is unsigned.

### Locally

```sh
npm run build && npm run build:native          # macOS, full Xcode
(cd artifacts/native && zip -r -X -D ../native-components.zip .)
sha256sum artifacts/native-components.zip      # shasum -a 256 on macOS
python3 scripts/package-ipa.py \
  --ipa /path/to/Discord-353.ipa \
  --loader-zip artifacts/native-components.zip \
  --expected-loader-sha256 TRUSTED_ZIP_SHA256 \
  --output /path/to/Korg-353-unsigned.ipa
python3 scripts/smoke-package-ipa.py --verify /path/to/Korg-353-unsigned.ipa
```

Use an archive whose root contains the collected component files, and obtain its trusted SHA-256 from the actual build. Folder entries are tolerated, but the file list must match the manifest exactly. The runtime builder, collector, and packager agree on one manifest contract, and the packager refuses an archive that does not match it.

### Smoke-package without the proprietary file

`npm run package:smoke` builds a synthetic Discord-353-shaped app (real bundle identity and version, an arm64 unencrypted executable, a framework, a nested extension, stale signatures), runs the same packager on it, then re-opens the output and checks the injected `KorgLoader.dylib` load command, the loader bytes, the runtime resources and the removal of old signatures. With no native build it injects a synthetic arm64 dylib, so it also runs on Linux; on macOS the workflow uses the loader that build actually compiled. A synthetic host is a packaging check, not Discord and not device behavior.

The original packager is designed to preserve the supplied input, validate Mach-O/ZIP structure and dependencies, add `KorgLoader.dylib` and `KorgResources.bundle`, rename the app to “Korg”, remove old signatures and recognized legacy tweak resources if encountered, and produce a separate unsigned IPA plus `<output>.inspection.json`. It refuses to run if either output file already exists. The clean supplied 353 input does not require an old tweak to be present. The packager does not remove encryption or download Discord.

A signer you control must sign the app, added loader, frameworks, and extensions and configure provisioning and entitlements. The packager preserves Discord's identifier; use your signer's duplicate-app/identifier configuration if you need a separate install alongside regular Discord. Keep credentials and provisioning material outside the repository.

## Native compatibility boundary

Static host inspection confirmed `RCTHost` implements `instance:didInitializeRuntime:` with encoding `v32@0:8@16^{Runtime=^^?}24` at image address `0x100610b54`. The loader targets the public React Native **0.80** JSI ABI. That confirms a callback location and signature, not the embedded engine's exact C++ vtable, return convention, or physical-device behavior. See [the ABI contract](../native/ABI.md).

The loader reads only the bundled UTF-8 JavaScript resource (`KorgResources.bundle/korg.js`) and evaluates it on the initialization callback's runtime thread before forwarding to the original callback. Startup timing, host module discovery, UI attachment, persistence, recovery from malformed input, and iOS 27 execution still require actual device checks. Neither Linux synthetic tests nor a macOS compile can establish all of these.

## Controls and recovery

If host attachment succeeds, the runtime installs a wrapper through React Native's `AppRegistry.setWrapperComponentProvider` (which applies to every app when it starts, whenever it was registered) and adds a **Korg** section to Discord's own settings screen: a pressable row registered in `SETTING_RENDERER_CONFIG` and a section inserted into the root settings list by `createList`, placed after the Account section. Both that row and the floating **K** control open Korg's settings. When Discord's settings modules are not found, only the floating control exists; the native diagnostics say which happened. Saved preferences and plugins load once the app starts. Separately, the native loader shows a small floating **Korg** button that opens a diagnostics alert with a Copy button; it works even when the JavaScript side fails to attach. The alert lists:

- `layout`: whether Discord's JavaScript engine interface is the one this loader was built for (it refuses to run otherwise, leaving stock Discord untouched);
- `reporter`, `storage`, `resource` and `evaluation`: whether the loader installed its reporting and storage functions, found `korg.js`, and ran it without a JavaScript error;
- `runtime status`: Korg's own account of where it got to, refreshed whenever it changes: the Metro hooks and module count; whether React, react-native and the AppRegistry were found (and how); whether the wrapper is installed; which apps registered and which ran; whether the K overlay rendered and mounted (`phase=waiting`, `captured`, `wrapped`, `rendered`); the storage in use; and any note on why something is missing;
- **JavaScript errors**: every error Korg's JavaScript caught, including uncaught errors, plugin load failures and errors thrown while the bootstrap script ran, with their stack traces;
- **Previous launch**: the last messages and errors from the launch before this one, which is where a crash leaves its last words.

If the app ends while Korg is calling into the engine, the next launch skips Korg once (`safe mode` in the alert) so Discord still opens, and the launch after that tries again. The six palettes—Graphite, Ember, Glacier, Orchard, Plum, Paper—color those controls only. No full Discord theme engine, font importer, old plugin packs, native safe-mode menu (beyond the one-launch skip described above), or global restore/undo behavior is promised.

The actual runtime starts with no plugins. Its URL controls accept a direct HTTPS bundle or JSON manifest, store downloaded source disabled initially, and expose enable, disable, update, remove, and supported exported settings. Enabled plugins run with host JavaScript privileges through a partial Vendetta/Bunny adapter; unsupported APIs or host changes can break them. The browser URL demo does none of this execution.

If the host opens, disable or remove a failing plugin in Korg settings. If it cannot open, an in-app control cannot repair startup: keep a known-good supplied IPA and signing setup available so you can reinstall a working copy. Do not assume a native recovery menu exists in this loader.

## Licenses and installation limits

New original Korg files are MIT-0 with no attribution condition; the [license](../LICENSE) is retained. Historical Rain/MPL-2.0, RainTweak/OSL-3.0, and ElleKit/BSD-3-Clause artifacts keep their obligations. Host software and subsequently downloaded plugins keep their own rights and notices. Read [NOTICE.md](../NOTICE.md) before redistributing an artifact.

This is independently authored replacement work after prior source review, not a formal clean-room certification or provable “100% unique” implementation. Discord's [terms](https://discord.com/terms) restrict unauthorized modifications. Signing, notifications, extensions, and other host services can impose additional installation limits; no official support or App Store approval is implied.
