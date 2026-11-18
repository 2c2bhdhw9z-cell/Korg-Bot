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
| Build/development scripts | 8 | Local build, verify, compile, collect, package, synthetic packaging smoke, preview, Hermes loop-capture check |
| Browser preview | 4 | Original local settings design |
| Tests | 10 | Runtime/plugin/native/preview/Hermes, real-engine harness and scenario, and packaging checks |
| CI | 2 | macOS build workflow and IPA packaging workflow |
| **Total** | **43** | **No listed file omitted** |

### Root metadata — 5

- `.gitignore`: build output, signing material, IPA and Python-cache exclusions. Ignore rules are not an audit exclusion.
- `LICENSE`: retained MIT-0 permission/disclaimer and host/history boundary.
- `NOTICE.md`: original authorship, historical obligations, and host-software notices.
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
- `runtime/ui.js`: original host-native controls and root-registration wrapper, URL operations, plugin settings and palette selection, and a Korg row and section in Discord's data-driven settings (`SETTING_RENDERER_CONFIG` plus `createList`, inserted after the Account section).
- `runtime/start.js`: synchronous early setup and explicit boot state; readiness flags alone do not prove the host UI works.

### Scripts — 8

- `scripts/build.mjs`: fixed nine-file local concatenation and syntax check; emits source hashes with `plugins: []`, `dependencies: []`. No upstream fetch or package installation.
- `scripts/verify.mjs`: verifies exact local input set, source hashes, deterministic bundle bytes, empty plugin/dependency arrays and syntax. Hashes establish contents, not authorship or device compatibility.
- `scripts/build-native.sh`: direct Xcode arm64 compilation with Apple frameworks/libc++; no RainTweak, Theos or external hook-runtime setup.
- `scripts/collect-native.py`: system-dependency allowlist, component/source hash manifest and source archive collection.
- `scripts/package-ipa.py`: original ZIP/Mach-O validation and unsigned Discord 353 packaging path. The native and runtime manifest versions/fields are now aligned. Synthetic tests pass; the exact compiled artifact and supplied IPA must also pass the final packaging checks.
- `scripts/smoke-package-ipa.py`: builds a synthetic Discord-353-shaped app, runs `package-ipa.py` as CI does, and re-opens the packaged output to check the loader load command, loader bytes, runtime resources and signature removal. Also verifies an already packaged IPA (`--verify`). A synthetic host proves the packaging path, not Discord or device behavior.
- `scripts/hermes-scope-check.mjs`: finds closures that capture `let`/`const` variables declared inside a loop, by analyzing the ESTree that `hermesc -dump-ast` prints. Hermes shares one binding across iterations, so such closures all see the last value.
- `scripts/preview.mjs`: replaced with an independent local HTTP asset server using only Node built-ins. The previous implementation and its MPL header were removed rather than relicensed; history retains the old notice.

### Preview — 4

- `preview/index.html`: original accessible phone-oriented settings design, local assets only, no fake Discord connection or sample-chat client.
- `preview/app.js`: six palette controls and metadata-only URL list. No fetch, URL navigation, dynamic code evaluation or actual plugin installation; text is rendered as text nodes.
- `preview/style.css`: original responsive layout, local system font and small purple visual accent; palette colors represent the runtime's own controls.
- `preview/icon.svg`: original geometric Korg mark, no external asset reference.

The preview is deliberately separate from the actual URL downloader/evaluator in `runtime/plugins.js`. A demo list entry means no manifest or source was retrieved. New preview assets are MIT-0 and use no external library, font, script or stylesheet.

### Tests — 10

- `tests/runtime.test.mjs`: Metro capture, patch ownership, storage semantics, compatibility and synthetic host UI/plugin integration, plus regressions for stale patches, once-only module announcements, backend caching and early logging.
- `tests/plugins.test.mjs`: URL/manifest handling (including React Native's `URL` polyfill and encoded path traversal), cache/lifecycle failures, partial dependency mappings, palettes and startup/UI fixtures.
- `tests/native.test.mjs`: synthetic C++ ABI call (slot 1, not slot 2), the layout check against intact and damaged tables, and conditional collected-artifact hash checks. Missing native output can produce a skip; a skip is not native verification.
- `tests/native-hermes.test.mjs`, `tests/native/hermes-harness.cpp`, `tests/native/scenario.js`: build the loader core against a real Hermes 1.0.0 engine (the version in Discord 353), check every virtual-table slot and ownership rule, boot the real runtime and run a simulated Discord with Metro's real `require`. Skipped without `HERMES_SRC` and `HERMES_BUILD`; the `engine` CI job supplies them.
- `tests/hermes-semantics.test.mjs`: fails when `runtime/*.js` creates a closure over a loop-scoped variable, and checks the checker itself against known-bad and known-good patterns.
- `tests/preview.test.mjs`: the preview server survives a malformed request line and serves the expected status codes.
- `tests/hermes.test.mjs`: compiles `dist/korg.js` with a Hermes compiler when one is available (`HERMESC` or the `hermes-compiler` npm package); skipped otherwise.
- `tests/test_package_ipa.py`: synthetic Mach-O/ZIP fixtures, package preservation, legacy-resource removal, artifact hashes and rejection cases. Fixtures do not establish real supplied-IPA packaging success.

### CI — 2 files, 3 jobs

- `.github/workflows/build-native.yml`: macOS checkout, local build/test, native collection and artifact upload. Pinned runner actions are infrastructure, not incorporated runtime dependencies. A workflow file is not evidence that it has passed.
- `.github/workflows/package-ipa.yml`: macOS packaging. Every push packages a synthetic Discord-353-shaped app with the loader that commit built and uploads `Korg-unsigned-ipa-smoke`; a manual run given the user's own Discord 353 IPA (an asset of a release in this repository, a URL they host, or an artifact of a run in this repository) packages that file, verifies the output and uploads `Korg-unsigned-ipa`; a published release that carries a `.ipa` starts that run on its own from the default branch. The workflow never fetches Discord by itself and holds no signing material.

## License and historical boundary

New independently authored Korg files are **MIT No Attribution (MIT-0)** with the original `LICENSE` retained; there is no attribution condition. Earlier file-level notices and artifact licenses remain effective for those historical revisions. All current implementation bodies have been replaced or reviewed as original Korg code; changing package metadata alone would not erase an inherited obligation.

The old Rain/MPL-2.0, RainTweak/OSL-3.0 and ElleKit/BSD-3-Clause revisions and delivered artifacts retain all applicable notices, source and redistribution obligations. They must not be relabelled MIT-0. The prior Rain package.json BSD metadata discrepancy did not replace its actual MPL license. Deleting old build paths does not erase Git history or obligations attached to prior distributions.

The current local runtime bundles no third-party plugin bodies or external runtime dependencies. That does not remove the supplied Discord/React Native/Hermes host's rights and licenses or Apple's platform dependencies. Later user-downloaded plugins retain their own licenses. No audit claim extends Korg's license to these materials.

## Host evidence and unverified stages

Prior inspection of the available supplied IPA established **Discord 353.0, build 122208, arm64, `cryptid=0`, no injected tweak**. Static Objective-C metadata confirmed `RCTHost` → `instance:didInitializeRuntime:`, encoding `v32@0:8@16^{Runtime=^^?}24`, image address `0x100610b54`. These facts are carried forward from the host inspection, not a new physical run in this documentation pass.

The native JSI adapter is conditional on the public **React Native 0.80** binary interface. The callback encoding does not verify the exact embedded engine's vtable or C++ return convention. Physical startup, runtime-thread behavior, UI registration timing, persistence, error recovery and iOS 27 compatibility remain unverified. The older Discord 352 Rain-derived IPA cannot validate this rewrite.

Subsequent integration passed the original Mac build at `04e4037`, run `43574190974`, including all 29 Node runtime/native checks with zero skips and the Python packaging suite. The artifact archive SHA-256 `63b173fd78055e654bc84eb561063e0765508f11ab1130c937b901b9d3f4fac2` matched GitHub metadata. Packaging the supplied Discord 353 produced a 106,520,310-byte unsigned IPA; ZIP integrity, ten Mach-O dependency graphs, exact embedded JS/source hashes, absence of old injected mod payloads, and empty plugin/dependency lists were checked. The input SHA-256 remained `0acdf2b1f1443c1840f9e3cd903d641719ad0ed7850a74df450ae9ff9b513422`. Output SHA-256: `b1da84032cef82062b872b894c9b0f0349d0b90c895c71ece3667eab30937c74`. A final sidecar regression test brings the Python suite to nine tests. These are build/static checks, not signing or physical-device validation.


## Review pass after `2a16be9`

Every file was read again and the suites were run (Node, Python, and a macOS CI build that was already green). Defects that could be reproduced were fixed with a regression test that fails on the previous code:

- `runtime/metro.js`: every lookup re-announced every module to every listener, so one `findByProps` cost O(modules²) once a listener did its own lookups (3,000 synthetic modules: about 7 s in Node). Modules are now announced once; a new subscriber is replayed earlier modules.
- `runtime/storage.js`, `runtime/ui.js`: the AsyncStorage backend was rediscovered by a full scan on every operation and the UI re-resolved host modules on every capture. Both are now cached or skipped once resolved.
- `runtime/patcher.js`: a function captured before `unpatch()` kept running the callback; unpatching an inherited method left a shadowing own property; patched components lost `displayName` and statics; a failed redefine left a ghost patch.
- `runtime/plugins.js`: React Native's `URL` polyfill turned `…/plugin.js` into `…/plugin.js/` and resolved a manifest's `main` by concatenation; a percent-encoded `..` in `main` escaped the manifest directory; `install(url, null)` threw.
- `runtime/core.js`: logging threw before the host defined `console`.
- `scripts/preview.mjs`: a malformed request line (`GET //`) crashed the server.
- `scripts/package-ipa.py`: a loader ZIP containing folder entries was rejected.
- `tests/native.test.mjs`: a missing C++ compiler registered a separate skipped test instead of skipping.
- `preview/style.css`: the `select` rule overrode the 16 px size that stops iOS Safari from zooming on focus; several labels were 7–10 px.

That pass could not tell which Hermes Discord 353 embeds; the next pass measured it. Findings that could not be reproduced without a device (native button placement, burst of `install()` retries before the first successful hook, plugin settings screens that throw) were left unchanged.

## Review pass after the first device report

A device run of the previous build showed the loader hooking React Native, loading the script and reporting that evaluation returned, but no K control appeared. The Discord IPA was then inspected directly and the real engine was built from source.

**Measured, not assumed.** `hermesvm.framework` is Hermes 1.0.0 (build `250829098.0.15`); the app's bundle is bytecode version 98. The engine compiles `async` functions (its compiler is present, and the earlier "evaluation returned" step could only complete if compilation succeeded).

**Root cause.** The loader called slot 2 of `jsi::Runtime`'s virtual table. In the React Native 0.86 interface slot 0 is `ICast::castInterface`, so slot 1 is `evaluateJavaScript` and slot 2 is `prepareJavaScript`, which compiles and discards. Korg's JavaScript never ran. All 39 named entries in the real binary's table, over slots 0 to 108, match the layout derived from the header, and the loader now refuses to run unless 20 anchor functions sit where expected.

**Problems that fixing the slot would have exposed**, found by running the runtime in a real Hermes 1.0.0 engine:

- Hermes shares one `let`/`const` binding across loop iterations. In `runtime/patcher.js` every `before`/`after` patch therefore ran as `instead`; the wrapper Korg installs on `AppRegistry.registerComponent` would have swallowed the app's own root registration and left Discord blank. Chained patches also composed wrongly. In `runtime/core.js` every logger level was the last one; in `runtime/metro.js` and `runtime/compat.js` lazy getters resolved the wrong module. All were restructured, and `tests/hermes-semantics.test.mjs` now guards the pattern.
- `K.metro.getAll()` returned a function after the UI patched it, which stopped storage discovery and left themes and plugins without persistence.

**Diagnostics added** (native `Korg` button): the layout check result, reporter state, the full text and stack of any JavaScript exception, and a stream of errors and status snapshots from Korg's own JavaScript through a native function the loader installs. Errors are persisted at once; a crash leaves a summary under **Previous launch**, and a launch that follows a crash inside the engine skips Korg once.

Still not established: behavior on a physical iPhone, Discord's real module graph (the scenario uses a simulated one plus Metro's real `require`), and iOS 27.

## Review pass after the second device report

The second device build ran Korg's JavaScript for the first time and reported what it saw. Two things in that report were wrong in Korg, and one was misleading.

**Storage.** The report showed `JSON Parse error: Unexpected character: o` and `host AsyncStorage module has not been found`. Reading the real bundle's bytecode (disassembled with the engine's own `hbcdump`) shows Discord 353 has no AsyncStorage. The only objects in its modules with `getItem`/`setItem`/`removeItem` are a Zustand persist adapter (`getItem` returns objects, so `JSON.parse` saw `[object Object]`). Korg's search for storage had picked that adapter. The loader now provides storage itself (`native/ABI.md`, "Native storage function"), the runtime uses it before anything else, and a host object that returns non-strings is refused with a clear error. Running the build that was sent through the new scenario reproduces the same error text.

**Misleading diagnostics.** The status line was sampled (every 256th report), so "UI waiting, attached=no" could be stale; it said nothing about what happened afterwards. Status is now sent whenever it changes, with its own message budget, and says what was found, how, and how far the overlay got.

**Attaching.** The previous design searched every module for React, react-native and the AppRegistry on every module load, which is quadratic over a start-up of thousands of modules, and depended on `registerComponent` being patched before the app registered its root. The bytecode shows how Discord's entry module registers (`registerComponent("Discord")`, then `registerRunnable` with a wrapper) and that AppRegistry reads its wrapper provider each time an app runs. Korg now (1) checks only the module that just finished loading, (2) recognises react-native by the presence of its lazy getters without calling them, (3) also watches `global.RN$AppRegistry` (which `AppRegistry.js` assigns), (4) installs its wrapper with `setWrapperComponentProvider`, which works whether the app registered before or after, (5) runs a slow heartbeat that finds anything missed and stops once the overlay has mounted, and (6) keeps the app outside an error boundary so a failure in Korg's controls cannot blank Discord.

**Verification.** `tests/native/scenario.js` was rebuilt to follow the real module graph: a react-native index of lazy getters, the AppRegistry module assigning `RN$AppRegistry` while `AppRegistryImpl` is still loading 60 other modules, Discord's entry registering and re-registering its runnable, 3,000 filler modules, and a decoy persist adapter. It runs in the real Hermes 1.0.0 engine with Metro's own `require` polyfill. The runtime from the previous device build fails it in 16 places, including the exact JSON error; the new runtime passes. Not verified: an iPhone run, and the Objective-C file storage (the harness exercises the same four operations over a map; the compile and the file code are covered by the macOS build and review only).

