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

See [installation and recovery notes](docs/INSTALL.md). An existing compatible RainTweak installation can load Korg from a custom HTTPS bundle address. The build does not automatically host the bundle, sign an iPhone application, or bypass Discord app encryption. Installing from scratch still requires the loader, a permitted Discord app copy, and device signing.

The native page is integrated with Rain's APIs; its runtime behavior cannot be proven by the browser preview or a successful bundle build. Rain's current compatibility target and the inspected loader revision are recorded in `upstream.json`.

## Credits and license

Built on Rain and its contributors. Adapted source and Korg additions are MPL-2.0; the upstream license and exact modified source accompany the generated distribution. See [NOTICE.md](NOTICE.md) for attribution and the upstream package metadata discrepancy. RainTweak remains a separate OSL-3.0 project; its code is not included here.

Korg is unofficial and unaffiliated with Discord, Rain, or KORG Inc. Discord's terms restrict client modifications, which carry account risk. No App Store availability or official support is implied.