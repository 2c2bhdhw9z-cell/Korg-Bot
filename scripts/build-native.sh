#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
    echo "Native compilation requires macOS and Xcode; local runtime build and synthetic ABI tests work on Linux." >&2
    exit 1
fi
command -v xcrun >/dev/null
node scripts/build.mjs
node scripts/verify.mjs
sdk="$(xcrun --sdk iphoneos --show-sdk-path)"
mkdir -p .build/native
xcrun --sdk iphoneos clang++ -std=c++17 -fobjc-arc -arch arm64 -mios-version-min=16.0 \
    -isysroot "$sdk" -stdlib=libc++ -dynamiclib native/KorgLoader.mm \
    -framework Foundation -framework UIKit -Wl,-undefined,error \
    -install_name @rpath/KorgLoader.dylib -o .build/native/KorgLoader.dylib
python3 scripts/collect-native.py
