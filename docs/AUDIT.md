# Korg provenance and current-tree audit

## Scope and evidence

The initial provenance audit is recorded in the prior working context as a complete **32-file, 4,161-line** read split across agents. It established that the old builder fetched Rain, native preparation transformed RainTweak, and overlays identified their derivation. That is historical audit evidence, not a fresh count of the replacement tree.

This pass enumerated the entire current repository-plus-staged snapshot with `list_files` and read **all 34 listed files completely**, including all docs, preview assets, runtime bodies, scripts, tests, workflow, license, notices, and `.gitignore`. No listed file was excluded because of its name, size, category, or ignore rule. The starting snapshot contained **4,132 text lines**; edits and concurrent integration change that total. The empty `overlays/` folder contained no file to review. This is a repository-source inventory, not a claim that ignored computer build output, historical binaries, or the proprietary IPA were re-read in this pass.

The replacement runtime and loader **exist in the current staged tree**. Statements that they are lost, missing, or that the current JavaScript builder still downloads Rain are obsolete. No copied mod implementation bodies were identified in the reviewed current tree. This source review and the recorded authorship history support an independently authored replacement; they do not prove every expression is unique.

The authors had already read mod-derived material. This was **not a formally isolated clean-room process**, and a provable “100% unique” claim is not possible. Familiar API names and public React Native declarations describe interface contracts, not incorporated mod bodies. This audit is not a legal opinion.

## Complete current file inventory

Counts are files, not runtime dependencies. Every path in the enumerated snapshot is listed below.

| Category | Count | Role |
| --- | ---: | --- |
| Root metadata | 5 | Project identity, license, notices, ignores |
| Documentation | 3 | API, installation, audit |
| Native | 2 | Original loader and ABI contract |
| Runtime | 9 | Fixed local bundle inputs |
| Build/development scripts | 6 | Local build, verify, compile, collect, package, preview |
| Browser preview | 4 | Original local settings design |
| Tests | 4 | Runtime/plugin/native and packaging checks |
| CI | 1 | macOS build workflow |
| **Total** | **34** | **No listed file omitted** |

### Root metadata — 5

- `.gitignore`: build output, signing material, IPA and Python-cache exclusions. Ignore rules are not an audit exclusion.
- `LICENSE`: retained MIT-0 permission/disclaimer and host/history boundary.
- `NOTICE.md`: original authorship, historical obligations, and retained file-level notice exception.
- `package.json`: local scripts and MIT-0 package metadata; no dependency list. Package-manager metadata is not a bundled runtime dependency.
- `README.md`: implementation status, local preview/build, native and license limits.

### Documentation — 3

- `docs/API.md`: partial Vendetta/Bunny API behavior and actual runtime URL-plugin lifecycle.
- `docs/INSTALL.md`: supplied 353 input, build/packaging/signing stages and recovery limits.
- `docs/AUDIT.md`: this provenance record, full inventory, and verification boundary.

### Native — 2

- `native/KorgLoader.mm`: original Objective-C runtime method interception and embedded-source evaluation; independently named C++ ABI carrier, no imported mod headers or hook library.
- `native/ABI.md`: public RN 0.80 contract, evidence and limitations; its individual claims must stay aligned with actual build/test results. The target now includes static method evidence from the supplied Discord 353; its public RN ABI baseline remains conditional until device execution.

### Runtime — 9

- `runtime/core.js`: runtime state and scoped logging.
- `runtime/metro.js`: early registration observation, guarded exports index and finders; does not initialize every host module to discover it.
- `runtime/patcher.js`: original owner-scoped wrappers, callback contracts and out-of-order cleanup.
- `runtime/storage.js`: namespaced host storage, deep observed settings, queued snapshots and surfaced failures.
- `runtime/compat.js`: original partial `window.vendetta` / `window.bunny` adapters with scoped patch/storage ownership; no universal compatibility claim.
- `runtime/themes.js`: six own palettes, Graphite/Ember/Glacier/Orchard/Plum/Paper, applied to Korg controls only.
- `runtime/plugins.js`: empty-by-default plugin registry, user-entered HTTPS bundle/manifest retrieval, cache, explicit enable and lifecycle cleanup. This is original loader code, not bundled plugin implementations; enabled remote code runs with host privileges.
- `runtime/ui.js`: original host-native controls and root-registration wrapper, URL operations, plugin settings and palette selection.
- `runtime/start.js`: synchronous early setup and explicit boot state; readiness flags alone do not prove the host UI works.

### Scripts — 6

- `scripts/build.mjs`: fixed nine-file local concatenation and syntax check; emits source hashes with `plugins: []`, `dependencies: []`. No upstream fetch or package installation.
- `scripts/verify.mjs`: verifies exact local input set, source hashes, deterministic bundle bytes, empty plugin/dependency arrays and syntax. Hashes establish contents, not authorship or device compatibility.
- `scripts/build-native.sh`: direct Xcode arm64 compilation with Apple frameworks/libc++; no RainTweak, Theos or external hook-runtime setup.
- `scripts/collect-native.py`: system-dependency allowlist, component/source hash manifest and source archive collection.
- `scripts/package-ipa.py`: original ZIP/Mach-O validation and unsigned Discord 353 packaging path. The native and runtime manifest versions/fields are now aligned. Synthetic tests passed; the exact compiled artifact and supplied IPA must also pass the final packaging checks.
- `scripts/preview.mjs`: replaced with an independent local HTTP asset server using only Node built-ins. The previous implementation and its MPL header were removed rather than relicensed; history retains the old notice.

### Preview — 4

- `preview/index.html`: original accessible phone-oriented settings design, local assets only, no fake Discord connection or sample-chat client.
- `preview/app.js`: six palette controls and metadata-only URL list. No fetch, URL navigation, dynamic code evaluation or actual plugin installation; text is rendered as text nodes.
- `preview/style.css`: original responsive layout, local system font and small purple visual accent; palette colors represent the runtime's own controls.
- `preview/icon.svg`: original geometric Korg mark, no external asset reference.

The preview is deliberately separate from the actual URL downloader/evaluator in `runtime/plugins.js`. A demo list entry means no manifest or source was retrieved. New preview assets are MIT-0 and use no external library, font, script or stylesheet.

### Tests — 4

- `tests/runtime.test.mjs`: Metro capture, patch ownership, storage semantics, compatibility and synthetic host UI/plugin integration.
- `tests/plugins.test.mjs`: URL/manifest handling, cache/lifecycle failures, partial dependency mappings, palettes and startup/UI fixtures.
- `tests/native.test.mjs`: synthetic C++ ABI call and conditional collected-artifact hash checks. Missing native output can produce a skip; a skip is not native verification.
- `tests/test_package_ipa.py`: synthetic Mach-O/ZIP fixtures, package preservation, legacy-resource removal, artifact hashes and rejection cases. Fixtures do not establish real supplied-IPA packaging success.

### CI — 1

- `.github/workflows/build-native.yml`: macOS checkout, local build/test, native collection and artifact upload. Pinned runner actions are infrastructure, not incorporated runtime dependencies. A workflow file is not evidence that it has passed.

## License and historical boundary

New independently authored Korg files are **MIT No Attribution (MIT-0)** with the original `LICENSE` retained; there is no attribution condition. Earlier file-level notices and artifact licenses remain effective for those historical revisions. All current implementation bodies have been replaced or reviewed as original Korg code; changing package metadata alone would not erase an inherited obligation.

The old Rain/MPL-2.0, RainTweak/OSL-3.0 and ElleKit/BSD-3-Clause revisions and delivered artifacts retain all applicable notices, source and redistribution obligations. They must not be relabelled MIT-0. The prior Rain package.json BSD metadata discrepancy did not replace its actual MPL license. Deleting old build paths does not erase Git history or obligations attached to prior distributions.

The current local runtime bundles no third-party plugin bodies or external runtime dependencies. That does not remove the supplied Discord/React Native/Hermes host's rights and licenses or Apple's platform dependencies. Later user-downloaded plugins retain their own licenses. No audit claim extends Korg's license to these materials.

## Host evidence and unverified stages

Prior inspection of the available supplied IPA established **Discord 353.0, build 122208, arm64, `cryptid=0`, no injected tweak**. Static Objective-C metadata confirmed `RCTHost` → `instance:didInitializeRuntime:`, encoding `v32@0:8@16^{Runtime=^^?}24`, image address `0x100610b54`. These facts are carried forward from the host inspection, not a new physical run in this documentation pass.

The native JSI adapter is conditional on the public **React Native 0.80** binary interface. The callback encoding does not verify the exact embedded engine's vtable or C++ return convention. Physical startup, runtime-thread behavior, UI registration timing, persistence, error recovery and iOS 27 compatibility remain unverified. The older Discord 352 Rain-derived IPA cannot validate this rewrite.

Subsequent integration passed the original Mac build at `04e4037`, run `43574190974`, including all 29 Node runtime/native checks with zero skips and the Python packaging suite. The artifact archive SHA-256 `63b173fd78055e654bc84eb561063e0765508f11ab1130c937b901b9d3f4fac2` matched GitHub metadata. Packaging the supplied Discord 353 produced a 106,520,310-byte unsigned IPA; ZIP integrity, ten Mach-O dependency graphs, exact embedded JS/source hashes, absence of old injected mod payloads, and empty plugin/dependency lists were checked. The input SHA-256 remained `0acdf2b1f1443c1840f9e3cd903d641719ad0ed7850a74df450ae9ff9b513422`. Output SHA-256: `b1da84032cef82062b872b894c9b0f0349d0b90c895c71ece3667eab30937c74`. A final sidecar regression test brings the Python suite to nine tests. These are build/static checks, not signing or physical-device validation.