# Korg provenance and rewrite audit

## Scope and conclusion

A read-through of the pre-rewrite repository established explicit Rain derivation: `scripts/build.mjs` fetched and built Rain; `native/patches.mjs` and `scripts/prepare-native.mjs` transformed RainTweak; the overlays identified themselves as adapted. This implementation has been replaced in the current tree. Its new build accepts only the nine files listed in `scripts/build.mjs` and emits a manifest that hashes each input. It fetches no build/runtime code and bundles no plugin implementations. `scripts/package-ipa.py` rejects non-Korg native component identities and any payload other than the two declared runtime files plus their generated source notices.

This is a documented source review and dependency inspection—not a legal opinion or mathematically provable claim that no implementation resembles prior work. The earlier implementers had read the mod-derived version before authoring the replacement; this was not a formally isolated clean-room process. Standard API names are reimplemented from the behavior specified in `docs/API.md`. Public host ABI declarations informed the loader contract.

## Current implementation map

- `native/KorgLoader.mm`: original Apple Objective-C runtime interception and embedded-source evaluation; ABI facts and explicit limits in `native/ABI.md`.
- `runtime/core.js`: Korg state and logging.
- `runtime/metro.js`: observation, module exports index, finders, and lazy common exports.
- `runtime/patcher.js`: plugin-scoped wrappers and out-of-order removal.
- `runtime/storage.js`: namespaced host storage, deep settings proxies, and tracked writes.
- `runtime/compat.js`: independently implemented `window.vendetta`/`window.bunny` compatibility objects.
- `runtime/themes.js`: six palettes applied to Korg controls, not assumed to theme Discord globally.
- `runtime/plugins.js`: empty-by-default, explicit HTTPS bundle/manifest loader; no packaged third-party plugin source.
- `runtime/ui.js`: host-native settings UI and module registration interception.
- `runtime/start.js`: synchronous early setup.
- `scripts/build.mjs`: hashes, concatenates, and syntax-checks exactly nine local runtime inputs.
- `scripts/package-ipa.py`: original Mach-O/ZIP validations and the current resource allowlist.
- `preview/`: local-only settings design preview; it makes no network requests and evaluates no URLs.

## Historical artifacts and licenses

The previous implementation and 0.2 distributions incorporated Rain (MPL-2.0), RainTweak (OSL-3.0), and ElleKit (BSD-3-Clause). Those prior artifacts and Git history retain their associated obligations. This source rewrite does not erase history or retroactively change previously delivered files. The current source carries `LICENSE` (MIT-0) and does not include those upstream dependencies. The user-provided IPA still contains Discord, React Native/Hermes and related host files, which remain third-party property.

The native loader's declared React Native v0.80 ABI contract has not been confirmed against a physical Discord runtime. The new IPA must be checked again when the user provides their newer Discord version. Compilation, bundle hashes, synthetic ABI tests, and static dependency checks do not prove that the injector or plugins work on iOS 27.

## Verification for each build

`npm run verify` proves that the shipped bundle is exactly the manifest-hashed local source list, and that plugin/dependency lists are empty. Node tests cover API ownership, storage, plugin lifecycle, URL handling, and themes. Python tests exercise Mach-O parsing and packaging. A Mac workflow builds the native code and rejects non-system dependencies. Device startup remains a separate validation stage.