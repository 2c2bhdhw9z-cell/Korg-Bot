# Trying Korg on iPhone

Korg adds its own settings and built-in themes to Rain. Chats, calls, accounts, and the rest of Discord continue to use Discord's existing app. This first build is experimental and has not been tested inside Discord on a physical iPhone.

## Packaged IPA for the supplied Discord 352 app

`Korg-0.2.0-Discord-352-unsigned.ipa` is an assembled app package, ready to import into an iPhone sideload signer. Its original VoiceMenu tweak and startup reference have been removed. Korg's loader, complete resource bundle, and ElleKit 1.1.3 hook runtime are included; their source/license notices are inside `BunnyResources.bundle/KorgDistribution`. No hosting or extra tweak injection is required.

The package is **unsigned**. Your signer must sign the main app, extensions, frameworks, and added libraries and manage provisioning/entitlements. No signing credentials are needed in chat. It preserves Discord's original bundle identifier for the signer to configure. To keep regular Discord installed alongside Korg, use the signer's duplicate-app/custom-identifier option and a matching provisioning profile; do not replace your installed Discord unintentionally.

Static checks passed for ZIP integrity, all 11 Mach-O dependency graphs, removal of VoiceMenu, and the embedded Korg files. This does not establish iOS 27.0.1 runtime compatibility; first launch on the phone remains untested.

## Standalone build components

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

## If you currently have regular Discord

The intended installation is a separate app named **Korg**, using app identifier `app.korg.discord`, alongside regular Discord. Korg's customization is bundled inside that app: no hosting account or prior Rain installation is needed. The App Store's installed Discord cannot load this bundle directly.

The repository now prepares a pinned, modified RainTweak loader and has a macOS build workflow, **Build Korg loader**. It produces loader components and their source, not a signed Discord IPA. The packaged loader reads `BunnyResources.bundle/korg.js` on launch and does not download Rain as a default. Its recovery menu's **Reset to Bundled Korg** returns to that packaged version. A custom HTTPS bundle remains an explicit advanced option.

To finish the app, the loader package must be injected into a compatible Discord IPA that you are entitled to supply and modify. The native loader currently retains RainTweak's substrate hook dependency, so the app-packaging step must supply a compatible hook runtime and its license/source notices. No such runtime or proprietary IPA is fetched by this workflow. The resulting app must then be signed for your device through an installation tool you control. Neither this chat nor the repository needs your Discord password or Apple password.

Having regular Discord installed does not provide a reusable IPA or signing approval to the development computer. Those are the remaining external inputs. The Linux development computer cannot run Xcode or validate an iPhone install.

The inspected [RainTweak source](https://codeberg.org/raincord/RainTweak) requires Discord v332 or newer for its runtime hooks. The pinned Rain bundle declares iOS build `110861`; that number is an upstream compatibility target, not a guarantee that other builds work. RainTweak's README also says iOS 27 is unsupported. Check your actual iOS, Discord, and loader versions before installation.

This repository does not fetch or redistribute Discord's proprietary IPA, defeat its app encryption, or collect your Discord password or account token. Signing material belongs outside the repository. Device testing and installation remain necessary before this can be called a working iPhone client.

## Account and installation limits

Discord's [terms](https://discord.com/terms) restrict unauthorized client modifications. Using them can put your account at risk. Sideloaded apps can also have notification, sharing, passkey, and signing limitations. There is no claim of App Store approval or official Discord support.

## Recovery

Within Korg, **Use Discord default** clears the selected custom palette without removing themes. **Undo last theme change** is available while the page remains open. **Safe mode** pauses custom themes and non-essential plugins after a reload. It does not remove every upstream core patch. **Reload Discord** can interrupt calls or unsent messages, so finish those first.
