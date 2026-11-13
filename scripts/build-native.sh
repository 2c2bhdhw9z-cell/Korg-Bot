#!/usr/bin/env bash
# Build the open-source loader only. Does not obtain, modify, or sign a Discord IPA.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
    echo "Native compilation requires macOS with Xcode. On Linux, run npm run prepare:native to verify and prepare the source." >&2
    exit 1
fi
command -v gmake >/dev/null
command -v ldid >/dev/null
xcrun --sdk iphoneos --show-sdk-path
node scripts/verify.mjs
node scripts/prepare-native.mjs

korg_theos_revision=8167f59de02fd32cf45b16bfcb1330dfa5c9974c
export THEOS="$PWD/.build/native/theos"
if [[ ! -d "$THEOS/.git" ]]; then
    mkdir -p "$THEOS"
    git -C "$THEOS" init -q
    git -C "$THEOS" remote add origin https://github.com/theos/theos.git
fi
git -C "$THEOS" fetch --depth 1 origin "$korg_theos_revision"
git -C "$THEOS" checkout --detach "$korg_theos_revision"
git -C "$THEOS" submodule update --init --recursive --depth 1
korg_sdk_version="$(xcrun --sdk iphoneos --show-sdk-version)"
korg_sdk_path="$(xcrun --sdk iphoneos --show-sdk-path)"
gmake -C .build/native/rain-tweak package \
    SDKVERSION="$korg_sdk_version" SYSROOT="$korg_sdk_path" \
    THEOS_PLATFORM_DEB_COMPRESSION_TYPE=gzip \
    -j"$(sysctl -n hw.ncpu)"
python3 scripts/collect-native.py
