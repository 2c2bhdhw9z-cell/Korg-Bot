# Korg for iOS

An experimental Discord customization built on [Rain](https://github.com/ra1ncord/rain), in the same family of mobile modifications as Rain and Kettu. **Korg** is the working name.

The first version adds a Korg settings section, bundled Amethyst and Midnight themes, restore-default and undo controls, shortcuts to Rain's plugin/theme managers, and safe-mode/reload controls. Discord itself continues to handle chats, calls, and sign-in.

**Status:** source and build pipeline for a Rain-compatible bundle, plus an interactive design preview. This is not a standalone iOS app or a ready-to-install IPA. Actual iPhone compatibility must be tested with a compatible Discord/RainTweak installation. The preview uses fictional, local chats and never connects to Discord.

## Open the design preview

With Node.js 22 or newer installed:

```sh
npm run dev
```

Open the local address printed by the command. Sample servers, channels, local message composition, and theme choices work. Themes are saved in the browser when storage is available; demo messages last only until reload. The preview is a design study, not a pixel-for-pixel rendering of the native Discord app.

## Build the client customization

Requires Node.js 22+, Bun (tested version recorded in `package.json`), Git, and tar. No Xcode is needed for the JavaScript/Hermes bundle.

```sh
npm run build
npm test
npm run verify
```

The build downloads the exact Rain revision and archive checksum in `upstream.json`, applies the focused changes in `scripts/patches.mjs`, inserts the files in `overlays/`, and installs upstream's frozen lockfile with package lifecycle scripts disabled. It then uses Rain's own build tools to produce:

- `dist/korg.js` — compatible loader input in plain JavaScript.
- `dist/korg.<version>.hbc` — Hermes bytecode for that engine version.
- `dist/manifest.json` — versions, sizes, and SHA-256 checksums.
- `dist/korg-source.tar.gz` — complete modified source and upstream lockfile.
- Full upstream license, bundled dependency license texts, and installation notes.

Run tests after the first build so they can exercise the pinned Rain source and its real state-storage middleware. Tests before that cache exists explicitly skip integration cases. The tests cover failed saves, rollback, delayed theme refreshes, and safe-mode reload requirements. A successful build is verified before replacing the previous distribution, which is kept under `.build/previous-dist`.

Build output is ignored by Git. No Discord IPA or signing material is downloaded or committed. The original Rain sources are retrieved at build time instead of hiding an untracked vendor tree inside this repository. Changed upstream anchors fail the build rather than silently applying a partial patch.

## iPhone installation

See [installation and recovery notes](docs/INSTALL.md). For a phone with regular Discord, the intended result is a separately installed Korg app with the customization embedded. The added native loader prepares that path without requiring a hosting account or a prior Rain installation. A compatible Discord IPA that you can supply and modify, packaging with the loader's hook runtime, and device signing remain necessary. This project does not fetch a proprietary app, bypass its encryption, or collect signing credentials.

An existing compatible RainTweak installation can also load the JavaScript build from a custom HTTPS address.

The native page is integrated with Rain's APIs; its runtime behavior cannot be proven by the browser preview or a successful bundle build. Rain's current compatibility target and the inspected loader revision are recorded in `upstream.json`.

## Credits and license

Built on Rain and its contributors. Adapted source and Korg additions are MPL-2.0; the upstream license and exact modified source accompany the generated distribution. See [NOTICE.md](NOTICE.md) for attribution and the upstream package metadata discrepancy. RainTweak remains a separate OSL-3.0 project; its code is not included here.

Korg is unofficial and unaffiliated with Discord, Rain, or KORG Inc. Discord's terms restrict client modifications, which carry account risk. No App Store availability or official support is implied.


## Native loader build

After building the JavaScript bundle, `npm run prepare:native` verifies and downloads the pinned RainTweak source, applies the local-bundle changes, and prepares `.build/native/rain-tweak`. This preparation and its patch tests work on Linux. The native code itself requires macOS and full Xcode.

On a Mac with GNU Make (`gmake`), `ldid`, and `xz` installed, run `npm run build:native`. The script checks out a pinned Theos revision and pinned submodules, uses the installed iPhoneOS SDK, compiles the loader, checks the arm64 library and embedded JavaScript checksum, and collects components, corresponding source, and licenses under `artifacts/native/`.

The **Build Korg loader** GitHub Actions workflow runs the same path on `macos-15`. A successful workflow validates compilation and packaging, not iPhone installation or Discord runtime compatibility. Its output is a `.deb`/dylib/resource bundle, **not an installable IPA**. It never downloads Discord, signs a user's app, or publishes a release.

The native loader is adapted from RainTweak under OSL-3.0; see [native notices](native/NOTICE.md). Preserve both the JavaScript and native licenses/source when distributing their components.

## Bundled customization in 0.2

Korg now exposes Rain's bundled plugin manifests in a searchable **Bundled features** library, grouped by purpose. It shows unavailable platform/capability combinations instead of attempting to enable them. This is a library of Rain plugins already compiled into Korg, not an installer for arbitrary Kettu plugins.

Three optional one-tap packs add compatible features without disabling existing choices: **Essentials**, **Personal touches**, and **Media tools**. Individual feature choices are saved and applied after reload. Features involving message retention, external services, or removal of confirmations show an explanation before enabling. No pack is silently applied to an existing installation.

Six offline palettes are included: **Amethyst, Midnight, Rose, Ocean, Forest, and Ember**, plus restoration of Discord's default. Fonts has a shortcut to Rain's importer; no font files are claimed to be bundled. The design preview includes representative feature selections stored only in the browser, explicitly separate from the native app.

Plugin preferences use tracked writes and rollback; optional plugins wait for readable settings, while core recovery stays available. Startup completion cannot overwrite a preference saved for the next reload. Native/iOS 27 runtime compatibility still requires device testing; successful compilation is not proof that every bundled plugin works on that OS.

## Repackage a supplied Discord 352 IPA

`scripts/package-ipa.py` assembles a separate unsigned output from the specific unencrypted Discord 352/VoiceMenu input layout. It does not download Discord or remove encryption. The CLI pins the trusted Korg 0.2 native artifact SHA-256 by default, verifies its manifest, replaces the exact VoiceMenu weak-load command, and validates embedded binary dependencies. Supply a compatible arm64 hook runtime and its license for the current loader. See `--help` for local-file arguments. No IPA, provisioning profile, or credential is committed.

Run the packager checks with `python3 -m unittest discover -s tests -p 'test_package_ipa.py'`. They cover Mach-O bounds/padding, thin and FAT binaries, encryption rejection, symbol exports, artifact tampering, ZIP paths, dependencies, permissions, and preservation of original resources. An inspection JSON beside the output records hashes and changes. Signing and device runtime verification remain separate.
