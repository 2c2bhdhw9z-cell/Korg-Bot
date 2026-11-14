# Korg notices

## Current original implementation

The replacement native loader, nine-module JavaScript runtime, and new local settings preview are independently authored Korg work. No third-party mod implementation, plugin body, hook runtime, theme engine, or external runtime dependency is bundled by the current local-source build. Host-provided React, React Native, Hermes, and platform libraries are not Korg-authored or relicensed.

New original Korg files are offered under **MIT No Attribution (MIT-0)**. The original permission and disclaimer remain in [LICENSE](LICENSE). MIT-0 has no attribution condition. This statement neither overrides a file's existing license notice nor grants rights to the separately supplied host application or to plugins a user later downloads.

The implementers had read prior mod-derived source before writing the replacements. “Independently authored” describes the replacement's provenance; it is not a formal clean-room certification, a legal opinion, or proof that every expression is unique. Public API names and React Native ABI declarations informed compatibility contracts, not incorporated implementation bodies. The Vendetta/Bunny shim is partial and does not imply endorsement or universal plugin support.

## Historical distributions and retained obligations

Previous Korg revisions and the old Discord 352 Korg 0.2 artifacts used [Rain](https://github.com/ra1ncord/rain), including revision `4b091e1698aa983c5f4e694ae243c9a6fd8b52fb`, under the **Mozilla Public License 2.0**. Its package metadata said BSD-3-Clause inconsistently; that did not replace its actual MPL-2.0 LICENSE. Adapted Rain files and their covered modifications retain the applicable source, notice, and redistribution requirements.

Previous native components adapted [RainTweak](https://codeberg.org/raincord/RainTweak) under **OSL-3.0**. The previously assembled IPA also included **ElleKit under BSD-3-Clause**. Those delivered artifacts and historical revisions retain their respective licenses, copyright notices, source obligations, and disclaimers. Removing old build paths or authoring a new loader does not erase or retroactively relicense them. Keep the corresponding historical source and notices with redistribution of those artifacts.

The former MPL-tagged preview server has been replaced with a new implementation using only Node's built-in HTTP and file APIs. The current server and `preview/` assets are independently authored MIT-0 work. Earlier versions retain their historical license.

## Host software and name

The supplied Discord IPA and its React Native/Hermes and other host resources remain third-party software with their own licenses and rights. The new loader links Apple system libraries; “no external runtime dependencies bundled” does not mean no platform or host dependencies. Plugins obtained later retain their own licenses and may introduce their own dependencies.

Korg is a working name for an unofficial project, unaffiliated with Discord, Rain, Vendetta, Bunny, or KORG Inc. Korg's license grants no rights to their software, names, or trademarks. The project does not fetch proprietary app binaries, defeat encryption, or collect account or signing credentials.
