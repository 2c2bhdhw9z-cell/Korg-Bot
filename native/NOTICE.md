# Korg native loader modifications

RainTweak revision c2fa89a6c23eacad923cf46fcb70d45957aa37e0 is
licensed under OSL-3.0. Its complete original LICENSE is retained in the
prepared native source and copied into the bundle as LICENSE.RainTweak.
Modified native source is produced from the pinned upstream source archive by
`scripts/prepare-native.mjs` and the exact transformations in
`native/patches.mjs`; no upstream source is silently replaced. The Korg JavaScript
bundle and its source/license notices are separately packaged as `korg.js`,
`korg-source.tar.gz`, `LICENSE.rain`, `NOTICE.md`, and
`THIRD_PARTY_NOTICES.md` inside BunnyResources.bundle.

Changes to RainTweak: Theos copies KorgPayload into the bundle on every
package invocation, independently of Resources cleanup; the runtime evaluates packaged korg.js by default rather
than downloading Rain; explicitly enabled HTTPS custom bundles retain the
existing rain/bundle.js cache behavior; reset restores the packaged default;
recovery UI no longer offers remote Rain versions; the package is KorgLoader
0.2.0 (`app.korg.loader`). The RainTweak tweak/module name and Rain bridge
protocol remain unchanged for compatibility. `korgEmbedded` metadata signals
to the JS layer that Korg is local. The original Discord filter is retained,
with `app.korg.discord` added for a separately identified app.

This is a loader modification, not a Discord binary or an official Discord
client. Packaging and iPhone runtime behavior need macOS/Theos and device
verification. No Discord app, account data, tokens, or credentials are included.
