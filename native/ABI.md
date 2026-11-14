# Korg original native loader, ABI contract v1

This implementation was independently authored for Korg. No Discord modification's source, headers, hook library, implementation, theme, or native dependency is incorporated. This is a source provenance statement, not a formal clean-room certification or a guarantee of rights in the host application. Public React Native declarations were inspected to establish the binary interface; no React Native file is distributed or compiled into this loader.

## Version and verification boundary

Target: supplied Discord iOS 353.0 build 122208, bridgeless React Native, Apple arm64, libc++, iOS 16 minimum. Static Objective-C metadata inspection confirmed `RCTHost` implements `instance:didInitializeRuntime:` with encoding `v32@0:8@16^{Runtime=^^?}24` at image address `0x100610b54`. The interface baseline is **React Native v0.80.0**. The exact React Native/Hermes build shipped in Discord 352 has not been established from host headers or measured on a physical device. iOS 27 and actual Discord execution are unverified. This loader is an implementation targeting that interface, not a claim of demonstrated device compatibility.

Official declarations inspected:

- [JSI public declaration](https://github.com/facebook/react-native/blob/v0.80.0/packages/react-native/ReactCommon/jsi/jsi/jsi.h): `Buffer`, `Runtime`, `Value`, and the pointer invalidation contract.
- [RCTHost callback](https://github.com/facebook/react-native/blob/v0.80.0/packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTHost.mm): `instance:didInitializeRuntime:`.
- [RCTInstance lifecycle](https://github.com/facebook/react-native/blob/v0.80.0/packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm): initialization callback runs on the runtime thread before subsequent application work.

These references describe ABI facts, not code incorporated into Korg.

## Native call contract

The Objective-C IMP takes four machine arguments: receiver, selector, instance object, runtime pointer. The final pointer is the machine representation of a C++ runtime reference. A three-argument hook would shift the instance into the runtime position and is invalid. The hook checks argument count and basic Objective-C type encodings; these checks cannot validate a C++ vtable layout.

With Apple's arm64 Itanium-style C++ ABI, the runtime vptr addresses the first function entry. Slots 0 and 1 are the complete and deleting virtual destructors. **Slot 2 is `evaluateJavaScript`**, followed by `prepareJavaScript` and `evaluatePreparedJavaScript` in RN 0.80. The caller passes the runtime pointer, a reference to a `std::shared_ptr<const Buffer>`, and a reference to a libc++ `std::string`. Korg uses an independently named buffer interface with that binary layout: virtual destructor pair, const byte count method, then const byte pointer method. Its immutable string lives for as long as the shared owner, including any engine-retained copies. No host C++ symbols are linked or resolved by name.

The returned JSI value has a 32-bit kind at offset 0 and eight-byte payload at offset 8, total 16 bytes/alignment 8. Kinds are undefined 0, null 1, boolean 2, number 3, and owned symbol/bigint/string/object 4 through 7. **Size alone does not establish return convention**: the nontrivial destructor makes Apple arm64 use caller-allocated result storage addressed in **x8**, rather than a trivial aggregate returned in x0/x1. Korg's result carrier has its own nontrivial destructor to preserve that convention. Pointer payloads, if ever returned, are released through virtual invalidation entry slot 0. In the public RN 0.80 declaration, `invalidate()` is declared before the virtual destructor, so it occupies the first slot. Korg does not call a host Value destructor or depend on its exported symbol.

The script is wrapped in `void function(){ ... }();`, so successful evaluation yields undefined and cannot retain an object-valued bootstrap result. Unexpected owned return values are still released. C++ and Objective-C bootstrap exceptions are logged, then the original callback proceeds. Invalid native pointers, mismatched vtables, arm64e pointer authentication, or an engine with a different ABI cannot be made safe by catching exceptions. This is an arm64 build, not an arm64e build.

## Startup and JavaScript API

The constructor looks up `RCTHost` and installs an IMP using Apple's Objective-C runtime. An inherited method is overridden on the host class. Later image loads schedule another installation attempt; bounded main-queue retries also handle classes registered after the constructor. A late-loaded loader cannot retroactively intercept an already completed initialization callback. Inject it as an executable load dependency before application startup.

Korg evaluates **before calling the original delegate**, on the callback's runtime thread. This gives the packaged bootstrap a chance to observe Metro's `__d`/`__r` assignments before the host starts its main application. Metro may not exist at that point. The JavaScript bootstrap must support early installation and delay module/UI operations until registration. No native UI or asynchronous JSI access is introduced.

The only native-created global is immutable `globalThis.__KORG_NATIVE__`:

- `name`: `KorgOriginalLoader`
- `version`: `0.2.0-native-original`
- `abi`: `rn-0.80-apple-arm64-v1`
- `storage`: `host` (a capability choice, not an AsyncStorage implementation)
- `log(...args)`: forwards to an available host JavaScript console

The JS runtime supplies persistence using host AsyncStorage when available, plugin handling, Metro interception, and a React Native AppRegistry root wrapper/floating launch entry. There is no native storage module, networking, bundle downloader, settings controller, or private decryption code. The only script input is UTF-8 `KorgResources.bundle/korg.js` under the application's bundle directory (up to 32 MiB). The global also guards repeat bootstrap evaluation within one runtime.

## Build and evidence

`bash scripts/build-native.sh` uses Xcode's iPhoneOS SDK directly, C++17, ARC, arm64, libc++, Foundation and UIKit. It refuses undefined symbols and ad-hoc signs the component. The IPA packager must remove the component's old code-signature command before a final IPA signer signs all nested code. The build does not sign or obtain a Discord IPA.

`python3 scripts/collect-native.py` verifies architecture, install name and every load dependency against a fixed Apple-system allowlist, checks the JS SHA-256 against its build manifest, and publishes only a newly assembled component directory. It also records toolchain information, symbol imports, exact file hashes, build provenance, ABI status, and a source archive. Inputs are the built loader in `.build/native/KorgLoader.dylib`, `dist/korg.js`, `dist/manifest.json`, the original runtime sources in `runtime/`, and this repository's own metadata/licenses. Old native artifacts are never carried forward. A manifest claiming an upstream-derived runtime is rejected.

Output: `artifacts/native/KorgLoader.dylib`, `KorgResources.bundle/` (JS and build manifest), `manifest.json`, `korg-source.tar.gz`, and this API/ABI document. The collector packages the source and license metadata separately; it does not embed third-party plugin code.

Tests exercise the independently authored call carrier against a synthetic runtime. The Mac build compiles the real arm64 Mach-O and checks system dependencies and artifact checksums. These checks are not proof of the host ABI. Static callback metadata is verified in the supplied Discord 353 binary; physical-device startup, reload, missing-resource, syntax-error and persistence checks remain necessary.

## Permission for these original files

The following permission applies to `native/KorgLoader.mm`, this document, `scripts/build-native.sh`, `scripts/collect-native.py`, `.github/workflows/build-native.yml`, and `tests/native.test.mjs`. It does not replace any license on other files or remove obligations for previously distributed material.

MIT No Attribution (MIT-0)

Copyright (c) Korg contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.