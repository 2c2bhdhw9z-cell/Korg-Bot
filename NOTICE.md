# Korg notices

Korg is an independent, experimental customization of Rain. Korg is a working name, not a claim of affiliation with Discord, Rain, or KORG Inc.

Rain and its contributors created the underlying client modification, plugin system, theme engine, and integration with Discord. Upstream project: https://github.com/ra1ncord/rain

The build uses Rain revision `4b091e1698aa983c5f4e694ae243c9a6fd8b52fb`. Its repository LICENSE contains the Mozilla Public License 2.0. Its package.json has inconsistent BSD-3-Clause metadata; Korg retains the actual upstream LICENSE and all original notices, and treats the incorporated Rain source and modifications as MPL-2.0 covered source. No upstream copyright or license notice is removed.

Korg's source additions are also offered under MPL-2.0: https://mozilla.org/MPL/2.0/

Each distribution includes `LICENSE.rain` (the full upstream license), `THIRD_PARTY_NOTICES.md` (license and copyright texts for packages incorporated into the bundle), and `korg-source.tar.gz` (the exact modified Rain source, dependency lockfile, and build scripts). Keep them with redistributed builds. Bundled dependencies retain their own licenses; the whole bundle is not exclusively MPL-2.0 covered.

Korg changes the settings section, adds a native settings page with two local themes, guards local themes against network refreshes, and tracks theme/settings persistence and runtime readiness. It also prevents stale refreshes from replacing a newly selected theme. The rest of the Rain runtime is retained, including its existing plugins and optional services; this is not an independent security audit of upstream.

RainTweak is a separate loader with its own OSL-3.0 license. The optional native build adapts its pinned source; native distributions include its license, modification notice, and corresponding source as described in `native/NOTICE.md`. The JavaScript distribution alone does not include a native loader binary. No build in this project fetches or distributes Discord application binaries, account credentials, or signing certificates. No rights to Discord's software or trademarks are granted by Korg's license.
