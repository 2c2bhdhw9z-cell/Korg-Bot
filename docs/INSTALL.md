# Trying Korg on iPhone

Korg adds its own settings and built-in themes to Rain. Chats, calls, accounts, and the rest of Discord continue to use Discord's existing app. This first build is experimental and has not been tested inside Discord on a physical iPhone.

## What you have

- `korg.js`: Korg's JavaScript bundle, loaded by a compatible RainTweak installation.
- `korg.98.hbc` (or the version recorded in `manifest.json`): the same bundle compiled for a particular Hermes engine. Prefer plain `korg.js` for the loader's custom-URL feature unless you have verified the engine version matches.
- `korg-source.tar.gz`: the exact modified source, with the upstream lockfile and build scripts.
- `manifest.json`: build identity and SHA-256 checksums.

These files are **not an IPA**, the app package iOS installs. Renaming the bundle or zip to `.ipa` will not install Korg.

## If Rain already works on your iPhone

1. Host the built `korg.js` on an HTTPS address accessible to your phone. Use a trusted host you control; the address must return the JavaScript file, not a sign-in page or a GitHub file-view page. This project does not publish a bundle automatically.
2. Open RainTweak's recovery menu and choose **Load Custom Bundle**. Enter that HTTPS address. Rain also exposes custom bundle controls in its advanced settings; availability depends on the loader version.
3. Close and reopen Discord after the loader has downloaded the file. The inspected loader may download the bundle for the next launch, so a second launch can be necessary.
4. Open Discord settings → **Korg** → **Korg**. Choose **Amethyst** or **Midnight**, or keep Discord default. Plugins and Themes open Rain's existing managers.
5. If the app stops loading, use the native loader recovery menu to clear/disable the custom bundle and return to Rain. A page inside Discord cannot repair a failure that happens before Discord opens.

Korg uses Rain's existing local settings and theme storage. Trying it in an existing Rain installation shares those settings; it is not an isolated app. Korg presets do not download themes from the network. Existing upstream Rain features can still use their own network services.

## If you do not have Rain installed

A compatible loader and a Discord installation that you are permitted to modify must be prepared and signed for your device. iPhone signing is separate from building this bundle. The Linux development computer cannot run Xcode or validate an iPhone install.

The inspected [RainTweak source](https://codeberg.org/raincord/RainTweak) requires Discord v332 or newer for its runtime hooks. The pinned Rain bundle declares iOS build `110861`; that number is an upstream compatibility target, not a guarantee that other builds work. RainTweak's README also says iOS 27 is unsupported. Check your actual iOS, Discord, and loader versions before installation.

This repository does not fetch or redistribute Discord's proprietary IPA, defeat its app encryption, or collect your Discord password or account token. Signing material belongs outside the repository. Device testing and installation remain necessary before this can be called a working iPhone client.

## Account and installation limits

Discord's [terms](https://discord.com/terms) restrict unauthorized client modifications. Using them can put your account at risk. Sideloaded apps can also have notification, sharing, passkey, and signing limitations. There is no claim of App Store approval or official Discord support.

## Recovery

Within Korg, **Use Discord default** clears the selected custom palette without removing themes. **Undo last theme change** is available while the page remains open. **Safe mode** pauses custom themes and non-essential plugins after a reload. It does not remove every upstream core patch. **Reload Discord** can interrupt calls or unsent messages, so finish those first.
