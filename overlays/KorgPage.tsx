/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Adapted from Rain's settings page and theme APIs at
 * ra1ncord/rain@4b091e1698aa983c5f4e694ae243c9a6fd8b52fb.
 */

import { findAssetId } from "@api/assets";
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

export const KORG_VERSION = "0.1.0";
export const RAIN_REVISION = "4b091e1698aa983c5f4e694ae243c9a6fd8b52fb";

// These IDs are local storage keys, never URLs. Integration MUST return early
// for these two IDs in Rain's fetchTheme (and hotFetchTheme) before safeFetch.
// updateThemes runs before this lazily loaded screen can install any guard.
export const KORG_THEME_IDS = ["korg:amethyst", "korg:midnight"] as const;
type KorgThemeId = typeof KORG_THEME_IDS[number];

// Both Discord appearance variants intentionally receive the preset palette.
// Do not change the user's stored light/dark preference to apply a Korg theme.
function palette(primary: string, secondary: string, tertiary: string, floating: string): ThemeManifest["semanticColors"] {
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
        TEXT_PRIMARY: ["#EAE3F5", "#EAE3F5"],
        TEXT_SECONDARY: ["#C9BEDD", "#C9BEDD"],
        ICON_PRIMARY: ["#EAE3F5", "#EAE3F5"],
        ICON_SECONDARY: ["#C9BEDD", "#C9BEDD"],
        HEADER_PRIMARY: ["#F5F0FF", "#F5F0FF"],
        HEADER_SECONDARY: ["#C9BEDD", "#C9BEDD"],
        TEXT_NORMAL: ["#EAE3F5", "#EAE3F5"],
        TEXT_MUTED: ["#B6A9CB", "#B6A9CB"],
        TEXT_LINK: ["#C6A5FF", "#C6A5FF"],
        INTERACTIVE_NORMAL: ["#D4C7E8", "#D4C7E8"],
        INTERACTIVE_HOVER: ["#F5F0FF", "#F5F0FF"],
        INTERACTIVE_ACTIVE: ["#FFFFFF", "#FFFFFF"],
        INTERACTIVE_MUTED: ["#786B8D", "#786B8D"],
        CHANNELS_DEFAULT: ["#B6A9CB", "#B6A9CB"],
        BRAND_500: ["#8250DF", "#8250DF"],
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
                onPress={() => BundleUpdaterManager.reload()}
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

    async function openPage(page: "Plugins" | "Themes") {
        try {
            const { default: Page } = page === "Plugins"
                ? await import("@rain/pages/Plugins")
                : await import("@rain/pages/Themes");
            navigation.push("RAIN_CUSTOM_PAGE", {
                title: page,
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
                        Purple themes and useful controls, built on Rain.
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
                        label="Plugins"
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
