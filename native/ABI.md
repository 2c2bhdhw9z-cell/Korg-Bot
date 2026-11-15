# Korg original native loader, ABI contract v2

This implementation was independently authored for Korg. No Discord modification's source, headers, hook library, implementation, theme, or native dependency is incorporated. This is a source provenance statement, not a formal clean-room certification or a guarantee of rights in the host application. Public React Native and Hermes declarations were inspected to establish the binary interface; no React Native or Hermes file is distributed or compiled into this loader.

## Version and verification boundary

Target: supplied Discord iOS 353.0 build 122208, bridgeless React Native, Apple arm64, libc++, iOS 16 minimum. Static Objective-C metadata inspection confirmed `RCTHost` implements `instance:didInitializeRuntime:` with encoding `v32@0:8@16^{Runtime=^^?}24` at image address `0x100610b54`.

**The engine was measured from the supplied IPA, not assumed:**

- `Frameworks/hermesvm.framework` is **Hermes 1.0.0, build `250829098.0.15`**, a full build with the compiler included (it contains the parser and bytecode-lowering code, so it compiles source text at run time).
- `main.jsbundle` is Hermes bytecode **version 98** (magic `0x1F1903C103BC1FC6`, version field `0x62`).
- The interface is React Native **0.86**'s: `facebook::jsi::Runtime` derives from `IRuntime`, which derives from `ICast`. The framework exports `Runtime`'s virtual table and the base-class implementations of many virtual functions. All 39 entries that resolve to a named exported function, spread over slots 0 to 108, appear in the order of `jsi.h` from the Hermes tag `hermes-v250829098.0.15` (md5 `5c81e771…`, byte-identical to React Native 0.86's header), and the two destructors sit at 109 and 110.

This is a static and emulated verification. **The loader has not been observed running on a physical iPhone.** iOS 27 and actual Discord execution remain unverified.

### History: why v1 never ran the script

ABI v1 assumed the React Native 0.80 layout, where slots 0 and 1 are the destructors and slot 2 is `evaluateJavaScript`. In the 0.86 layout slot 0 is `ICast::castInterface`, `evaluateJavaScript` is **slot 1**, and slot 2 is `prepareJavaScript`. v1 therefore called `prepareJavaScript`, which compiles the script and discards the result. Nothing threw, the diagnostics said "evaluation returned", and Korg's JavaScript never executed. `tests/native/hermes-harness.cpp` keeps a negative control that calls slot 2 and shows the script does not run.

## Native call contract

The Objective-C IMP takes four machine arguments: receiver, selector, instance object, runtime pointer. The final pointer is the machine representation of a C++ runtime reference. A three-argument hook would shift the instance into the runtime position and is invalid.

The runtime vptr addresses the first function entry (Itanium C++ ABI). Slots used, in the order `jsi.h` declares them (`ICast` first, then `IRuntime`'s virtual functions, destructors last):

| Slot | Function |
| ---: | --- |
| 0 | `castInterface(const UUID &)` |
| **1** | **`evaluateJavaScript(const std::shared_ptr<const Buffer> &, const std::string &)`** |
| 2, 3 | `prepareJavaScript`, `evaluatePreparedJavaScript` (never called) |
| 6 | `global()` |
| 19 | `createPropNameIDFromAscii(const char *, size_t)` |
| 36 | `utf8(const String &)` |
| 54 | `setPropertyValue(const Object &, const PropNameID &, const Value &)` |
| 79 | `createFunctionFromHostFunction(const PropNameID &, unsigned, HostFunctionType)` |
| 109, 110 | complete and deleting destructors |

Korg uses independently named stand-ins with the same binary shapes: a buffer interface (virtual destructor pair, `size`, `data`), a 16-byte `Value` (32-bit kind, padding, eight-byte payload; undefined 0, null 1, boolean 2, number 3, owned symbol/bigint/string/object 4 to 7), and an 8-byte `Handle` for `Object`, `Function`, `String` and `PropNameID`. **Size alone does not establish the return convention**: each has a nontrivial destructor, so Apple arm64 returns it through caller-allocated storage addressed in **x8**, as the host's classes do. Owned pointers are released through virtual invalidation entry slot 0 (`PointerValue::invalidate()`).

### The layout is checked before any call

`korg::checkLayout` compares the host's *exported* `facebook::jsi::Runtime` virtual table with 20 anchor functions: base-class implementations at slots 0, 9, 12, 13, 21, 35, 37, 42, 47, 50, 53, 56, 59, 75, 78, 83, 92, 98, 105 and 108, read from `hermesvm.framework`. An inserted or removed virtual function anywhere shifts every anchor after it. It also requires slots 1 to 8 to be one shared pure-virtual stub and the destructors to be either at 109 and 110 or both null (GCC leaves an abstract class's destructor entries null; Apple's compiler fills them in). If anything disagrees, the loader does not touch the runtime. It records `layout: Not recognized: <reason>` and skips Korg, so a Discord update that changes the interface degrades to stock Discord instead of crashing.

### Errors and the safe-mode breadcrumb

A JavaScript exception thrown out of `evaluateJavaScript` is a `facebook::jsi::JSError`, a `std::exception` whose `what()` is the message plus the JavaScript stack. The loader catches it and records the full text. Before each call into the runtime it writes `KorgOriginalInFlight` to `NSUserDefaults` and clears it afterwards. If the app dies in between, the next launch skips Korg once, says why under **Previous launch**, and clears the flag so the launch after that tries again.

## JavaScript-to-native reporting

Before the bootstrap runs, the loader installs one native function, `globalThis.__korgNativeReport(string)`, created with `createFunctionFromHostFunction`. The bootstrap moves it into the frozen `__KORG_NATIVE__.report` and deletes the global. It runs on the JavaScript thread, accepts only string arguments, never throws into the engine, and hands text to the diagnostics store. Korg's runtime uses it for:

- `boot` lines (core loaded, runtime started),
- `error` reports: every `warn` or `error` the runtime logs, plugin load failures, and uncaught errors seen through a wrapper around `ErrorUtils.setGlobalHandler` (the host's own handler still runs),
- `status` snapshots: Metro hook state, module count, UI phase and the reason the UI is not attached yet.

The runtime caps this at 200 messages per launch. Errors are written to disk immediately because the host may crash right after reporting one.

## Startup and JavaScript API

The constructor looks up `RCTHost` and installs an IMP using Apple's Objective-C runtime. An inherited method is overridden on the host class. Later image loads schedule another installation attempt; bounded main-queue retries also handle classes registered after the constructor. A late-loaded loader cannot retroactively intercept an already completed initialization callback. Inject it as an executable load dependency before application startup.

Korg evaluates **before calling the original delegate**, on the callback's runtime thread. This gives the packaged bootstrap a chance to observe Metro's `__d`/`__r` assignments before the host starts its main application. Metro does not exist at that point, so the JavaScript bootstrap installs early and delays module and UI operations until registration. The loader adds one native UI element, a small floating **Korg** button that opens a diagnostics alert with a Copy button. The alert shows the loader, hook, layout, reporter, resource and evaluation status, the runtime's latest status, the JavaScript errors, and a summary of the previous launch. The snapshot is kept in `NSUserDefaults` under `KorgOriginalDiagnostics` and `KorgOriginalJSErrors`. Beyond the reporter above, no asynchronous JSI access is introduced.

The script is passed to the engine as plain source text, which Discord's full Hermes 1.0 build compiles. `async` functions, optional chaining and spread all work (verified in a real Hermes 1.0 engine, and `tests/hermes.test.mjs` compiles the bundle whenever a Hermes compiler is available).

**Hermes does not give each loop iteration its own `let`/`const` binding.** A closure created inside a loop sees the last iteration's value. React Native apps avoid this because their build rewrites such code; Korg's source reaches the engine unchanged, so `runtime/*.js` must create closures in a helper function instead. `tests/hermes-semantics.test.mjs` fails the build when it finds the pattern.

The only native-created global is immutable `globalThis.__KORG_NATIVE__`:

- `name`: `KorgOriginalLoader`
- `version`: `0.2.0-native-original`
- `abi`: `jsi-0.86-apple-arm64-v2`
- `storage`: `host` (a capability choice, not an AsyncStorage implementation)
- `report(string)`: the native reporting function described above (absent if it could not be installed)
- `log(...args)`: forwards to an available host JavaScript console

The JS runtime supplies persistence using host AsyncStorage when available, plugin handling, Metro interception, and a React Native AppRegistry root wrapper/floating launch entry. There is no native storage module, networking, bundle downloader, settings controller, or private decryption code. The only script input is UTF-8 `KorgResources.bundle/korg.js` under the application's bundle directory (up to 32 MiB). The global also guards repeat bootstrap evaluation within one runtime.

## Build and evidence

`bash scripts/build-native.sh` uses Xcode's iPhoneOS SDK directly, C++17, ARC, arm64, libc++, Foundation and UIKit. It refuses undefined symbols and ad-hoc signs the component. The IPA packager must remove the component's old code-signature command before a final IPA signer signs all nested code. The build does not sign or obtain a Discord IPA.

`python3 scripts/collect-native.py` verifies that the loader is arm64 and that every load dependency is on a fixed Apple-system allowlist, checks the runtime manifest's name, `plugins` and `dependencies`, and publishes only a newly assembled component directory with exact file hashes and a source archive. It does not re-check `dist/korg.js` against its manifest; `scripts/build-native.sh` runs `node scripts/verify.mjs` first. Inputs are the built loader in `.build/native/KorgLoader.dylib`, `dist/korg.js`, `dist/manifest.json`, the original runtime sources in `runtime/`, and this repository's own metadata/licenses. Old native artifacts are never carried forward.

Output: `artifacts/native/KorgLoader.dylib`, `KorgResources.bundle/` (JS and build manifest), `manifest.json`, `SOURCE-NOTICE.md`, and `korg-source.tar.gz` (which contains the sources and licenses, including this document). The collector does not embed third-party plugin code.

Evidence, from weakest to strongest:

- `tests/native.test.mjs` compiles the loader's engine-facing core against a synthetic runtime with the 0.86 table shape and exercises the layout check, including damaged tables.
- `tests/native-hermes.test.mjs` builds `tests/native/hermes-harness.cpp` and drives a **real Hermes 1.0.0 engine** through the loader core, then boots the real `dist/korg.js` and runs `tests/native/scenario.js`, a simulated Discord with Metro's real `require` polyfill, React Native style lazy exports, AppRegistry, AsyncStorage and ErrorUtils. It checks slot 1 executes, slot 2 does not, exceptions arrive with their stack, the native function receives text, the K button renders and opens, a palette persists, a plugin patches and unpatches, and errors reach the native side. It needs the engine's source and build (`HERMES_SRC`, `HERMES_BUILD`); the `engine` CI job builds Hermes 250829098.0.15 on macOS arm64 and runs it, matching the device's architecture and standard library.
- The `loader` CI job compiles the real arm64 Mach-O and checks system dependencies and artifact checksums.

None of this replaces physical-device startup, reload, missing-resource, syntax-error and persistence checks.

## Permission for these original files

The following permission applies to `native/KorgLoader.mm`, this document, `scripts/build-native.sh`, `scripts/collect-native.py`, `scripts/hermes-scope-check.mjs`, `.github/workflows/build-native.yml`, `tests/native.test.mjs`, `tests/native-hermes.test.mjs`, `tests/hermes-semantics.test.mjs`, and the files in `tests/native/`. The test harness includes Hermes' public headers when compiled but contains none of them. It does not replace any license on other files or remove obligations for previously distributed material.

MIT No Attribution (MIT-0)

Copyright (c) Korg contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.