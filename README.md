# Korg for iOS

Korg is an independently authored, experimental runtime and native loader for a supplied Discord iOS app. The current staged tree contains the replacement source and build scripts. It is no longer a Rain build or a collection of bundled Rain plugins. **A working Discord 353 installation has not yet been demonstrated on a physical iPhone.**

The supplied IPA is Discord **353.0, build 122208**, arm64, with `cryptid=0` and no injected tweak found during prior static inspection. That input is available for later packaging; this README does not announce a newly built or signed Korg IPA. The older Discord 352 Korg 0.2 artifact is the historical Rain-derived build, not this rewrite.

## What is here

- Nine original core modules: state/logging, Metro discovery, scoped patching, persistent storage, compatibility adapters, palettes, URL plugins, host-native controls, and startup.
- Six own palettes: **Graphite, Ember, Glacier, Orchard, Plum, Paper**. They color Korg's controls and settings; they do not implement full Discord themes.
- An empty plugin registry. No plugin implementations or external runtime dependencies are bundled.
- Partial, independently implemented `window.vendetta` / `window.bunny` adapters. Familiar API names do not mean universal legacy-plugin support. See [the API contract](docs/API.md).
- An original Objective-C++ loader using Apple's Objective-C runtime and system libraries, with an embedded local JavaScript bundle. No RainTweak, Theos, Substrate, or ElleKit build path is required by the new loader.

The actual runtime can download a user-entered HTTPS bundle or manifest, store its source, and enable it explicitly. Downloaded plugins execute in the host JavaScript runtime, not a security sandbox. New installs start disabled; saved enabled plugins can resume from their cached source. This is separate from the browser demo below.

## Local design preview

Requires Node.js 22 or newer; no package installation is needed:

```sh
npm run dev
```

Open the local address printed by the server. The small, phone-oriented preview shows Korg settings, the six palettes, and an initially empty URL list. **The URL form adds metadata only:** it never downloads a manifest or bundle, evaluates code, installs a plugin, or connects to Discord. Entries last for the current page visit; palette selection is saved locally when browser storage is available. No fonts, libraries, or code are fetched from a CDN.

This is an original design study for the implemented controls, not a native screenshot or proof of host integration.

## Local JavaScript build

```sh
npm run build
npm run verify
npm test
python3 -m unittest discover -s tests -p 'test_package_ipa.py'
```

These are verification commands, not a report that all checks have passed. Final runtime and packager integration checks belong to the main implementation pass.

`scripts/build.mjs` syntax-checks and concatenates exactly nine local files in a fixed order. It emits `dist/korg.js` and `dist/manifest.json`; the manifest records every source's SHA-256 with `plugins: []` and `dependencies: []`. The verifier reconstructs the bundle from those inputs and checks exact equality and hashes. The build fetches no source, plugin catalog, package, or Hermes compiler. No Hermes bytecode is promised.

## Native build and installation

The native source build requires **macOS and full Xcode**, plus Node.js 22+ and Python 3.11+. Later macOS CI must compile and validate the actual component:

```sh
npm run build:native
```

The system-only build compiles `native/KorgLoader.mm` directly with Xcode's iPhoneOS SDK. The collector prepares `artifacts/native/` with the loader, `KorgResources.bundle`, manifests, and a source archive. These components are not an IPA. Workflow runner actions are build infrastructure, not libraries bundled into Korg.

The target callback was confirmed statically in Discord 353: `RCTHost` → `instance:didInitializeRuntime:`, encoding `v32@0:8@16^{Runtime=^^?}24`, image address `0x100610b54`. The JSI call contract is conditional on the public **React Native 0.80** ABI; static callback metadata does not establish the embedded engine's exact C++ layout. Compilation, synthetic tests, and hash checks cannot replace physical-device validation. See [installation](docs/INSTALL.md) and [ABI details](native/ABI.md).

The original packager is intended to combine a verified native artifact and the supplied unencrypted Discord 353 IPA into a separate unsigned output. Manifest agreement, actual macOS output, packaging checks, signing of all nested code, and device startup remain release gates. The project does not fetch Discord, remove encryption, or collect signing credentials.

## Authorship, licenses, and history

The replacement Korg implementation was independently authored after earlier mod-derived material had been read. This was **not a formally isolated clean-room process**; a claim of provable “100% unique” code is not possible. The [audit](docs/AUDIT.md) distinguishes prior provenance review, current source inventory, build verification, and unverified device behavior.

New original Korg files use **MIT No Attribution (MIT-0)**; [LICENSE](LICENSE) is retained. MIT-0 imposes no attribution condition. This does not relicense older files or artifacts. Historical Rain (MPL-2.0), RainTweak (OSL-3.0), and ElleKit (BSD-3-Clause) material retains its notices and obligations, as do the supplied host app and its dependencies. See [NOTICE.md](NOTICE.md), including the pre-existing preview server's license header.

Korg is unofficial and unaffiliated with Discord, Rain, Vendetta, Bunny, or KORG Inc. No rights to the host app or trademarks are granted by Korg's license. Discord's [terms](https://discord.com/terms) restrict unauthorized client modifications; no official support or App Store availability is implied.
