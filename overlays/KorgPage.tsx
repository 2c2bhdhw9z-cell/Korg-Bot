/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Adapted from Rain's settings page and theme APIs at
 * ra1ncord/rain@4b091e1698aa983c5f4e694ae243c9a6fd8b52fb.
 */

import { findAssetId } from "@api/assets";
import { flushBeforeReload } from "./features";
import { getDebugInfo } from "@api/debug";
import { BundleUpdaterManager } from "@api/native/modules";
import { useSettings } from "@api/settings";
import { openAlert } from "@api/ui/alerts";
import { NavigationNative } from "@metro/common";
import {
    AlertActionButton,
    AlertActions,
    AlertModal,
    Stack,
    TableRow,
    TableRowGroup,
    TableSwitchRow,
    Text,
} from "@metro/common/components";
import { applyKorgTheme, useThemes } from "@plugins/_core/painter/themes";
import type { ThemeInfo } from "@plugins/_core/painter/themes";
import { useColorsPref } from "@plugins/_core/painter/themes/preferences";
import type { ThemeManifest } from "@plugins/_core/painter/themes/types";
import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { colorsPersistence, saveSafeMode, settingsPersistence, themeBlockReason, themesPersistence, useKorgRuntime } from "./runtime";

export const KORG_VERSION = "0.2.0";
export const RAIN_REVISION = "4b091e1698aa983c5f4e694ae243c9a6fd8b52fb";

// These IDs are local storage keys, never URLs. Integration MUST return early
// for every korg: ID in Rain's fetchTheme (and hotFetchTheme) before safeFetch.
// updateThemes runs before this lazily loaded screen can install any guard.
export const KORG_THEME_IDS = ["korg:amethyst", "korg:midnight", "korg:rose", "korg:ocean", "korg:forest", "korg:ember"] as const;
type KorgThemeId = typeof KORG_THEME_IDS[number];

// Both Discord appearance variants intentionally receive the preset palette.
// Do not change the user's stored light/dark preference to apply a Korg theme.
function palette(
    primary: string, secondary: string, tertiary: string, floating: string,
    accent = "#8250DF", link = "#C6A5FF",
    text = "#EAE3F5", subdued = "#C9BEDD", muted = "#B6A9CB",
): ThemeManifest["semanticColors"] {
    return {
        BACKGROUND_PRIMARY: [primary, primary],
        BACKGROUND_SECONDARY: [secondary, secondary],
        BACKGROUND_SECONDARY_ALT: [tertiary, tertiary],
        BACKGROUND_TERTIARY: [tertiary, tertiary],
        BACKGROUND_FLOATING: [floating, floating],
        BACKGROUND_MOBILE_PRIMARY: [primary, primary],
        BACKGROUND_MOBILE_SECONDARY: [secondary, secondary],
        CHANNELTEXTAREA_BACKGROUND: [secondary, secondary],
        BG_BASE_PRIMARY: [primary, primary],
        BG_BASE_SECONDARY: [secondary, secondary],
        BG_BASE_TERTIARY: [tertiary, tertiary],
        BG_SURFACE_RAISED: [secondary, secondary],
        BG_SURFACE_OVERLAY: [floating, floating],
        CHAT_BACKGROUND: [primary, primary],
        CHAT_INPUT_CONTAINER_BACKGROUND: [primary, primary],
        REDESIGN_CHAT_INPUT_BACKGROUND: [secondary, secondary],
        REDESIGN_ONLY_BACKGROUND_DEFAULT: [primary, primary],
        REDESIGN_ONLY_BACKGROUND_RAISED: [secondary, secondary],
        REDESIGN_ONLY_BACKGROUND_SUNKEN: [tertiary, tertiary],
        REDESIGN_ONLY_BACKGROUND_OVERLAY: [floating, floating],
        CARD_PRIMARY_BG: [secondary, secondary],
        CARD_SECONDARY_BG: [tertiary, tertiary],
        INPUT_BACKGROUND: [tertiary, tertiary],
        MODAL_BACKGROUND: [primary, primary],
        MODAL_FOOTER_BACKGROUND: [secondary, secondary],
        TEXT_PRIMARY: [text, text],
        TEXT_SECONDARY: [subdued, subdued],
        ICON_PRIMARY: [text, text],
        ICON_SECONDARY: [subdued, subdued],
        HEADER_PRIMARY: [text, text],
        HEADER_SECONDARY: [subdued, subdued],
        TEXT_NORMAL: [text, text],
        TEXT_MUTED: [muted, muted],
        TEXT_LINK: [link, link],
        INTERACTIVE_NORMAL: [subdued, subdued],
        INTERACTIVE_HOVER: [text, text],
        INTERACTIVE_ACTIVE: ["#FFFFFF", "#FFFFFF"],
        INTERACTIVE_MUTED: [muted, muted],
        CHANNELS_DEFAULT: [muted, muted],
        BRAND_500: [accent, accent],
    };
}

export const KORG_THEMES: Record<KorgThemeId, ThemeManifest> = {
    "korg:amethyst": {
        spec: 2,
        name: "Korg Amethyst",
        description: "Soft purple surfaces with a bright lavender accent. Bundled with Korg; works offline.",
        authors: [{ name: "Korg" }],
        semanticColors: palette("#211A30", "#1B1528", "#140F20", "#2B213C"),
        rawColors: {
            BRAND_360: "#B08AFF",
            BRAND_500: "#8250DF",
            BRAND_560: "#7545CA",
            BRAND_600: "#673BB5",
        },
    },
    "korg:midnight": {
        spec: 2,
        name: "Korg Midnight",
        description: "Near-black surfaces with the same lavender accent. Bundled with Korg; works offline.",
        authors: [{ name: "Korg" }],
        semanticColors: palette("#100D17", "#0B0911", "#07060B", "#1B1528"),
        rawColors: {
            BRAND_360: "#B08AFF",
            BRAND_500: "#8250DF",
            BRAND_560: "#7545CA",
            BRAND_600: "#673BB5",
        },
    },
    "korg:rose": {
        spec: 2,
        name: "Korg Rose",
        description: "Deep plum surfaces with a soft rose accent. Bundled with Korg; works offline.",
        authors: [{ name: "Korg" }],
        semanticColors: palette("#251B24", "#1E171E", "#171118", "#322431", "#A84F75", "#F4A9CB", "#F8EDF3", "#DEC9D5", "#BBA5B1"),
        rawColors: {
            BRAND_360: "#E998B8",
            BRAND_500: "#A84F75",
            BRAND_560: "#944262",
            BRAND_600: "#813653",
        },
    },
    "korg:ocean": {
        spec: 2,
        name: "Korg Ocean",
        description: "Deep teal surfaces with a clear blue accent. Bundled with Korg; works offline.",
        authors: [{ name: "Korg" }],
        semanticColors: palette("#14252A", "#112025", "#0C191E", "#20343A", "#288BA4", "#8ED9E9", "#ECF6F7", "#C0D9DD", "#A0BCC1"),
        rawColors: {
            BRAND_360: "#74C8DA",
            BRAND_500: "#288BA4",
            BRAND_560: "#227A92",
            BRAND_600: "#1C697E",
        },
    },
    "korg:forest": {
        spec: 2,
        name: "Korg Forest",
        description: "Evergreen surfaces with a fresh leaf accent. Bundled with Korg; works offline.",
        authors: [{ name: "Korg" }],
        semanticColors: palette("#1A2722", "#16211C", "#101A16", "#29382F", "#548F68", "#A9DFBA", "#EFF6EF", "#C9DACA", "#A7BDAA"),
        rawColors: {
            BRAND_360: "#91CFA5",
            BRAND_500: "#548F68",
            BRAND_560: "#477E5B",
            BRAND_600: "#3B6D4E",
        },
    },
    "korg:ember": {
        spec: 2,
        name: "Korg Ember",
        description: "Charcoal surfaces with a warm copper accent. Bundled with Korg; works offline.",
        authors: [{ name: "Korg" }],
        semanticColors: palette("#27211F", "#201A19", "#191413", "#362C28", "#B66F46", "#F3BA91", "#F8F0EA", "#DFCABE", "#BEA99D"),
        rawColors: {
            BRAND_360: "#E5A075",
            BRAND_500: "#B66F46",
            BRAND_560: "#A05E38",
            BRAND_600: "#8B4F2F",
        },
    },
};

function showMessage(title: string, content: string) {
    openAlert("korg-message", <AlertModal
        title={title}
        content={content}
        actions={<AlertActions>
            <AlertActionButton text="OK" variant="secondary" />
        </AlertActions>}
    />);
}

function requestReload(content: string) {
    openAlert("korg-reload", <AlertModal
        title="Reload Discord?"
        content={content}
        actions={<AlertActions>
            <AlertActionButton
                text="Reload"
                variant="primary"
                onPress={async () => {
                    try {
                        await flushBeforeReload();
                        BundleUpdaterManager.reload();
                    } catch (error) {
                        showMessage("Reload paused", error instanceof Error ? error.message : "Wait for changes to finish saving.");
                    }
                }}
            />
            <AlertActionButton text="Later" variant="secondary" />
        </AlertActions>}
    />);
}

function Swatch({ color }: { color: string }) {
    return <View style={{
        width: 28,
        height: 28,
        borderRadius: 9,
        backgroundColor: color,
        borderWidth: 1,
        borderColor: "#B08AFF",
    }} />;
}

export default function KorgPage() {
    const navigation = NavigationNative.useNavigation();
    const { safeMode } = useSettings();
    const themeMap = useThemes(state => state.themes);
    const readiness = useKorgRuntime();
    const settingsReady = readiness.settings === "ready";
    const hydrationFailed = [readiness.settings, readiness.themes, readiness.colors].includes("error");
    const [busy, setBusy] = useState(false);
    const working = useRef(false);
    const [notice, setNotice] = useState("");
    const [undoTheme, setUndoTheme] = useState<ThemeInfo | null | undefined>(undefined);
    const activeTheme = Object.values(themeMap).find(theme => theme.selected);
    const blockedReason = themeBlockReason(safeMode);
    const saving = busy || readiness.pendingOperations > 0;
    const themeActionsBlocked = saving || Boolean(blockedReason);
    const debugInfo = getDebugInfo();

    async function changeTheme(target: KorgThemeId | null | "undo") {
        // Ref prevents two taps before React has rendered the disabled rows.
        if (working.current || themeActionsBlocked) return;
        if (!useSettings.persist.hasHydrated() || useSettings.getState().safeMode) return;
        working.current = true;
        setBusy(true);
        setNotice("");
        try {
            let next: ThemeInfo | null;
            if (target === "undo") {
                if (undoTheme === undefined) return;
                next = undoTheme;
            } else if (target === null) {
                next = null;
            } else {
                // Rain's parser can mutate manifests. Keep bundled definitions
                // pristine and never use installTheme/fetchTheme for local IDs.
                next = {
                    id: target,
                    selected: false,
                    data: JSON.parse(JSON.stringify(KORG_THEMES[target])),
                };
            }
            const previous = await applyKorgTheme(next);
            setUndoTheme(target === "undo" ? undefined : previous);
            setNotice(next ? `${next.data.name} applied and saved.` : "Discord default restored and saved.");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "Could not save the theme. Try again before reloading.");
        } finally {
            working.current = false;
            setBusy(false);
        }
    }

    async function changeSafeMode(value: boolean) {
        if (working.current || !settingsReady || useKorgRuntime.getState().pendingOperations) return;
        working.current = true;
        setBusy(true);
        setNotice("");
        try {
            await saveSafeMode(useSettings, value);
            requestReload("Your safe mode preference was saved. Reload Discord to finish applying it.");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "Could not save safe mode. Try again before reloading.");
        } finally {
            working.current = false;
            setBusy(false);
        }
    }

    async function retryLoading() {
        if (working.current || useKorgRuntime.getState().pendingOperations) return;
        working.current = true;
        setBusy(true);
        setNotice("");
        try {
            // Only retry failed stores: never replace successful in-memory state.
            const state = useKorgRuntime.getState();
            await Promise.all([
                state.settings === "error" && useSettings.persist.rehydrate(),
                state.themes === "error" && useThemes.persist.rehydrate(),
                state.colors === "error" && useColorsPref.persist.rehydrate(),
            ]);
            const after = useKorgRuntime.getState();
            if ([after.settings, after.themes, after.colors].includes("error")) {
                setNotice("Saved data still could not be loaded. Check device storage and retry. Existing files have not been reset.");
            } else {
                await Promise.all([settingsPersistence.flush(), themesPersistence.flush(), colorsPersistence.flush()]);
                if (!after.engineInitialized) {
                    requestReload("Saved data loaded. Reload Discord to initialize themes.");
                }
            }
        } catch {
            setNotice("Could not reload saved data. Try again.");
        } finally {
            working.current = false;
            setBusy(false);
        }
    }

    async function openPage(page: "Features" | "Plugins" | "Themes" | "Fonts") {
        try {
            const { default: Page } = page === "Features"
                ? await import("@rain/pages/Korg/FeaturesPage")
                : page === "Plugins"
                    ? await import("@rain/pages/Plugins")
                    : page === "Themes"
                        ? await import("@rain/pages/Themes")
                        : await import("@rain/pages/Fonts");
            navigation.push("RAIN_CUSTOM_PAGE", {
                title: page === "Features" ? "Bundled features" : page,
                render: () => <Page />,
            });
        } catch {
            showMessage("Page unavailable", `Could not open ${page}. Try reloading Discord.`);
        }
    }

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 38 }}>
            <Stack style={{ paddingVertical: 24, paddingHorizontal: 12 }} spacing={24}>
                <View style={{
                    padding: 24,
                    borderRadius: 24,
                    backgroundColor: "#211A30",
                    borderColor: "#69469C",
                    borderWidth: 1,
                    gap: 10,
                }}>
                    <Text variant="heading-xl/bold" accessibilityRole="header" style={{ color: "#F5F0FF" }}>
                        Korg
                    </Text>
                    <Text variant="text-md/medium" style={{ color: "#C6A5FF" }}>
                        Your Discord, a little more you.
                    </Text>
                    <Text variant="text-sm/normal" style={{ color: "#D4C7E8" }}>
                        Bundled themes and useful controls, built on Rain.
                        Your chats, calls and sign-in stay in Discord.
                    </Text>
                </View>

                <TableRowGroup title="Make it yours">
                    <TableRow
                        label="Amethyst"
                        subLabel="Soft purple · bundled on this device"
                        icon={<Swatch color="#8250DF" />}
                        trailing={<TableRow.TrailingText text={activeTheme?.id === "korg:amethyst" ? "Selected" : "Apply"} />}
                        disabled={themeActionsBlocked}
                        onPress={() => void changeTheme("korg:amethyst")}
                    />
                    <TableRow
                        label="Midnight"
                        subLabel="Near-black with lavender accents · bundled"
                        icon={<Swatch color="#100D17" />}
                        trailing={<TableRow.TrailingText text={activeTheme?.id === "korg:midnight" ? "Selected" : "Apply"} />}
                        disabled={themeActionsBlocked}
                        onPress={() => void changeTheme("korg:midnight")}
                    />
                    <TableRow
                        label="Rose"
                        subLabel="Soft rose on deep plum · bundled"
                        icon={<Swatch color="#A84F75" />}
                        trailing={<TableRow.TrailingText text={activeTheme?.id === "korg:rose" ? "Selected" : "Apply"} />}
                        disabled={themeActionsBlocked}
                        onPress={() => void changeTheme("korg:rose")}
                    />
                    <TableRow
                        label="Ocean"
                        subLabel="Clear blue on deep teal · bundled"
                        icon={<Swatch color="#288BA4" />}
                        trailing={<TableRow.TrailingText text={activeTheme?.id === "korg:ocean" ? "Selected" : "Apply"} />}
                        disabled={themeActionsBlocked}
                        onPress={() => void changeTheme("korg:ocean")}
                    />
                    <TableRow
                        label="Forest"
                        subLabel="Fresh green on evergreen · bundled"
                        icon={<Swatch color="#548F68" />}
                        trailing={<TableRow.TrailingText text={activeTheme?.id === "korg:forest" ? "Selected" : "Apply"} />}
                        disabled={themeActionsBlocked}
                        onPress={() => void changeTheme("korg:forest")}
                    />
                    <TableRow
                        label="Ember"
                        subLabel="Warm copper on charcoal · bundled"
                        icon={<Swatch color="#B66F46" />}
                        trailing={<TableRow.TrailingText text={activeTheme?.id === "korg:ember" ? "Selected" : "Apply"} />}
                        disabled={themeActionsBlocked}
                        onPress={() => void changeTheme("korg:ember")}
                    />
                    <TableRow
                        label="Use Discord default"
                        subLabel="Remove the custom palette; keep installed themes"
                        icon={<TableRow.Icon source={findAssetId("Discord")} />}
                        disabled={themeActionsBlocked}
                        onPress={() => void changeTheme(null)}
                    />
                    {undoTheme !== undefined && <TableRow
                        label="Undo last theme change"
                        subLabel={`Restore ${undoTheme?.data.name ?? "Discord default"}. Available until you leave this page.`}
                        disabled={themeActionsBlocked}
                        onPress={() => void changeTheme("undo")}
                    />}
                </TableRowGroup>
                <Text variant="text-sm/normal" color="text-muted" accessibilityLiveRegion="polite">
                    {saving ? "Saving or loading your preferences…" : notice || blockedReason ||
                        `Selected: ${activeTheme?.data.name ?? "Discord default"}. Bundled themes need no download. If a screen keeps its old colors, reload Discord.`}
                </Text>

                <TableRowGroup title="Your setup">
                    <TableRow
                        arrow
                        label="Bundled features"
                        subLabel="Built-in features and one-tap packs. No plugin links needed."
                        icon={<TableRow.Icon source={findAssetId("PuzzlePieceIcon")} />}
                        onPress={() => void openPage("Features")}
                    />
                    <TableRow
                        arrow
                        label="Advanced plugin manager"
                        subLabel="Manage Rain's installed plugins"
                        icon={<TableRow.Icon source={findAssetId("PuzzlePieceIcon")} />}
                        onPress={() => void openPage("Plugins")}
                    />
                    <TableRow
                        arrow
                        label="Themes"
                        subLabel="Manage all themes and appearance options"
                        icon={<TableRow.Icon source={findAssetId("PaintPaletteIcon")} />}
                        onPress={() => void openPage("Themes")}
                    />
                    <TableRow
                        arrow
                        label="Fonts"
                        subLabel="Manage imported fonts; fonts are not bundled"
                        onPress={() => void openPage("Fonts")}
                    />
                </TableRowGroup>

                <TableRowGroup title="Recovery">
                    {hydrationFailed && <TableRow
                        label="Retry loading saved data"
                        subLabel="Try reading settings and appearance again without resetting them"
                        disabled={saving}
                        onPress={() => void retryLoading()}
                    />}
                    <TableSwitchRow
                        label="Safe mode"
                        subLabel="Pause custom themes and non-essential plugins after reload"
                        icon={<TableRow.Icon source={findAssetId("ShieldIcon")} />}
                        value={Boolean(safeMode)}
                        disabled={saving || !settingsReady}
                        onValueChange={(value: boolean) => void changeSafeMode(value)}
                    />
                    <TableRow
                        label="Reload Discord"
                        subLabel="Finish sending messages or leave a call first"
                        icon={<TableRow.Icon source={findAssetId("RetryIcon")} />}
                        disabled={saving}
                        onPress={() => {
                            if (working.current || useKorgRuntime.getState().pendingOperations) return;
                            requestReload("Discord will restart. This can interrupt an active call or an unsent message.");
                        }}
                    />
                </TableRowGroup>

                <TableRowGroup title="About Korg">
                    <TableRow label="Korg" subLabel="Native settings overlay" trailing={<TableRow.TrailingText text={KORG_VERSION} />} />
                    <TableRow label="Rain" subLabel={`Upstream base: ${RAIN_REVISION.slice(0, 7)}`} trailing={<TableRow.TrailingText text={debugInfo.rain.version} />} />
                    <TableRow label="Discord" trailing={<TableRow.TrailingText text={`${debugInfo.discord.version} (${debugInfo.discord.build})`} />} />
                    <TableRow label="Credits" subLabel="Built on the work of Rain and its contributors. Adapted source is licensed under MPL-2.0. Korg is an unofficial Discord modification." />
                </TableRowGroup>
            </Stack>
        </ScrollView>
    );
}
