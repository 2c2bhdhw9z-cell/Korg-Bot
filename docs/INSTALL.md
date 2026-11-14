# Building and trying the original Korg runtime

The independently authored loader and runtime source now exist in the staged tree. A physical iPhone run of the rewrite has not been verified. The browser preview is not an app, and a JavaScript bundle or native component ZIP cannot be installed by renaming it to `.ipa`.

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

Python packaging requires Python 3.11+. These are commands to run, not a claim of successful final verification. The main implementation pass must resolve integration issues and report real results.

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

After main-agent integration checks and a successful actual native build, the intended CLI is:

```sh
python3 scripts/package-ipa.py \
  --ipa /path/to/Discord-353.ipa \
  --loader-zip /path/to/native-components.zip \
  --expected-loader-sha256 TRUSTED_ZIP_SHA256 \
  --output /path/to/Korg-353-unsigned.ipa
```

Use an archive whose root contains the collected component files, and obtain its trusted SHA-256 from the actual build. The runtime builder, collector, and packager must agree on their manifest contract before this path is considered ready. The main agent owns that integration and testing; no complete package is claimed by this documentation pass.

The original packager is designed to preserve the supplied input, validate Mach-O/ZIP structure and dependencies, add `KorgLoader.dylib` and `KorgResources.bundle`, remove old signatures and recognized legacy tweak resources if encountered, and produce a separate unsigned IPA with an inspection report. The clean supplied 353 input does not require an old tweak to be present. The packager does not remove encryption or download Discord.

A signer you control must sign the app, added loader, frameworks, and extensions and configure provisioning and entitlements. The packager preserves Discord's identifier; use your signer's duplicate-app/identifier configuration if you need a separate install alongside regular Discord. Keep credentials and provisioning material outside the repository.

## Native compatibility boundary

Static host inspection confirmed `RCTHost` implements `instance:didInitializeRuntime:` with encoding `v32@0:8@16^{Runtime=^^?}24` at image address `0x100610b54`. The loader targets the public React Native **0.80** JSI ABI. That confirms a callback location and signature, not the embedded engine's exact C++ vtable, return convention, or physical-device behavior. See [the ABI contract](../native/ABI.md).

The loader reads only the embedded UTF-8 JavaScript input and evaluates it on the initialization callback's runtime thread before forwarding to the original callback. Startup timing, host module discovery, UI attachment, persistence, recovery from malformed input, and iOS 27 execution still require actual device checks. Neither Linux synthetic tests nor a macOS compile can establish all of these.

## Controls and recovery

If host attachment succeeds, the runtime wraps the React Native root registration and provides a floating **K** control opening Korg's own settings. The six palettes—Graphite, Ember, Glacier, Orchard, Plum, Paper—color those controls only. No full Discord theme engine, font importer, old plugin packs, native safe-mode menu, or global restore/undo behavior is promised.

The actual runtime starts with no plugins. Its URL controls accept a direct HTTPS bundle or JSON manifest, store downloaded source disabled initially, and expose enable, disable, update, remove, and supported exported settings. Enabled plugins run with host JavaScript privileges through a partial Vendetta/Bunny adapter; unsupported APIs or host changes can break them. The browser URL demo does none of this execution.

If the host opens, disable or remove a failing plugin in Korg settings. If it cannot open, an in-app control cannot repair startup: keep a known-good supplied IPA and signing setup available so you can reinstall a working copy. Do not assume a native recovery menu exists in this loader.

## Licenses and installation limits

New original Korg files are MIT-0 with no attribution condition; the [license](../LICENSE) is retained. Historical Rain/MPL-2.0, RainTweak/OSL-3.0, and ElleKit/BSD-3-Clause artifacts keep their obligations. Host software and subsequently downloaded plugins keep their own rights and notices. Read [NOTICE.md](../NOTICE.md) before redistributing an artifact.

This is independently authored replacement work after prior source review, not a formal clean-room certification or provable “100% unique” implementation. Discord's [terms](https://discord.com/terms) restrict unauthorized modifications. Signing, notifications, extensions, and other host services can impose additional installation limits; no official support or App Store approval is implied.
