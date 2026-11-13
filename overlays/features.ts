// SPDX-License-Identifier: MPL-2.0
import type { rainPlugin } from "@plugins/types";
import { Platform } from "react-native";
import { create } from "zustand";
import { colorsPersistence, createTrackedStorage, serialQueue, settingsPersistence, themesPersistence, useKorgRuntime } from "./runtime";

export type Category = "Everyday" | "Appearance" | "Media" | "Messages" | "Privacy" | "Services" | "Other";
const categories: Partial<Record<string, Category>> = {
    jumptotop: "Everyday", picturelinks: "Media", showimagelinks: "Media", unlimitedzoom: "Media",
    permissionviewer: "Everyday", pastelize: "Appearance", betteryoubar: "Appearance",
    chatboxavatar: "Appearance", platformindicators: "Appearance", expressionutils: "Media",
    favouriteanything: "Media", filesizeonpicker: "Media", animatedprofiles: "Appearance",
    animatedkeyboard: "Appearance", chatbubbles: "Appearance", decor: "Appearance",
    serverdrawer: "Appearance", declutter: "Appearance", dashless: "Appearance",
    hidecallbuttons: "Appearance", betterchatbuttons: "Appearance", taptap: "Everyday",
    bringbacktenor: "Media", clipboardgifsend: "Media", petpet: "Media",
    fakenitro: "Media", multiscrobbler: "Services", richpresence: "Services",
    reviewdb: "Services", translator: "Services", bypassuploadlimit: "Services",
    messagelogger: "Privacy", alwaystrust: "Privacy", quickdelete: "Privacy",
    silenttyping: "Privacy", cleanurls: "Privacy", anonymizefilenames: "Privacy",
    hideblockedandignoredmessages: "Privacy", accountswitcher: "Everyday",
    textreplace: "Messages", moreconfirm: "Messages", viewraw: "Messages",
    quoter: "Messages", bettersilentleave: "Messages", stafftags: "Appearance",
    globalbadges: "Appearance", animalfacts: "Messages", randomfact: "Messages",
    animalcommands: "Messages", moyai: "Messages", experiments: "Other",
};
export const categoryOrder: Category[] = ["Everyday", "Appearance", "Media", "Messages", "Privacy", "Services", "Other"];
export const packs = {
    "Essentials": ["jumptotop", "picturelinks", "showimagelinks", "unlimitedzoom", "permissionviewer"],
    "Personal touches": ["pastelize", "betteryoubar", "chatboxavatar", "platformindicators"],
    "Media tools": ["expressionutils", "favouriteanything", "filesizeonpicker"],
} as const;
export const riskNotes: Record<string, string> = {
    messagelogger: "Keeps copies of edited and deleted messages on this device.",
    bypassuploadlimit: "May upload files to an external service instead of directly to Discord.",
    alwaystrust: "Removes Discord's untrusted-link check. Check links yourself.",
    quickdelete: "Removes the delete confirmation for messages.",
    reviewdb: "Connects to ReviewDB; review data is shared with that service.",
    decor: "Connects to a third-party decoration service.",
    customeffects: "Connects to a third-party effects service.",
    multiscrobbler: "Connects listening activity to external services.",
    richpresence: "Shares activity with connected services.",
    translator: "Translation may send message text to a translation service.",
};

// A placeholder source module is not a working bundled feature.
export function featureCatalog(instances: Map<string, rainPlugin>, developerSettings = false) {
    return [...instances.entries()]
        .filter(([id, plugin]) => !id.startsWith("core") && id !== "customeffects" && Boolean(plugin) && (!plugin.devOnly || developerSettings))
        .map(([id, plugin]) => ({ id, plugin, category: categories[id] ?? "Other", availability: featureAvailability(plugin, Platform.OS) }))
        .sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));
}

export function featureAvailability(plugin: Pick<rainPlugin, "platforms" | "predicates">, platform: string): string | null {
    try {
        if (plugin.platforms && (!Array.isArray(plugin.platforms) || !plugin.platforms.includes(platform as "ios" | "android"))) return `Unavailable on ${platform}`;
        if (plugin.predicates && (!Array.isArray(plugin.predicates) || !plugin.predicates.every(predicate => typeof predicate === "function" && predicate() === true))) return "Requirements not met on this device";
    } catch { return "Could not check device requirements"; }
    return null;
}

export const pluginPersistence = createTrackedStorage("plugins/settings.json");
export const useFeatureStatus = create<{ hydration: "loading" | "ready" | "error"; pendingReload: boolean; saving: boolean }>()
    (() => ({ hydration: "loading", pendingReload: false, saving: false }));
export function trackPluginHydration() {
    useFeatureStatus.setState({ hydration: "loading" });
    return (_state?: unknown, error?: unknown) => {
        useFeatureStatus.setState({ hydration: error ? "error" : "ready" });
    };
}
const enqueue = serialQueue();
type SettingsStore = {
    persist: { hasHydrated(): boolean };
    getState(): { settings: Record<string, { enabled: boolean }> };
    setState(next: { settings: Record<string, { enabled: boolean }> }): void;
};

// A batch changes only named IDs. Unmentioned saved preferences are left alone.
let pendingSaves = 0;
export function saveFeatures(store: SettingsStore, changes: Record<string, boolean>) {
    pendingSaves++;
    useFeatureStatus.setState({ saving: true });
    return enqueue(async () => {
        if (!store.persist.hasHydrated() || useFeatureStatus.getState().hydration !== "ready" || useKorgRuntime.getState().settings !== "ready") {
            throw new Error("Wait for saved settings to load, or retry loading them.");
        }
        const previous = store.getState().settings;
        if (!Object.keys(changes).length || Object.entries(changes).every(([id, value]) => previous[id]?.enabled === value)) return;
        store.setState({ settings: { ...previous, ...Object.fromEntries(Object.entries(changes).map(([id, enabled]) => [id, { enabled }])) } });
        try {
            await pluginPersistence.flush();
            useFeatureStatus.setState({ pendingReload: true });
        } catch {
            store.setState({ settings: previous });
            try { await pluginPersistence.flush(); }
            catch {
                useFeatureStatus.setState({ hydration: "error" });
                throw new Error("Could not save or restore feature preferences. Retry loading before making changes.");
            }
            throw new Error("Could not save features. Previous preferences were restored.");
        }
    }).finally(() => {
        pendingSaves--;
        useFeatureStatus.setState({ saving: pendingSaves > 0 });
    });
}

export function packChanges(ids: readonly string[], instances: Map<string, rainPlugin>, platform: string): Record<string, boolean> {
    return Object.fromEntries(ids.filter(id => {
        const plugin = instances.get(id);
        return plugin && !plugin.devOnly && !featureAvailability(plugin, platform);
    }).map(id => [id, true]));
}

// Check twice: a save can enter the queue while storage is being flushed.
export async function flushBeforeReload() {
    const idle = () => !useFeatureStatus.getState().saving && useKorgRuntime.getState().pendingOperations === 0;
    if (!idle()) throw new Error("Wait for preferences to finish saving before reloading.");
    await Promise.all([
        settingsPersistence.flush(), colorsPersistence.flush(), themesPersistence.flush(), pluginPersistence.flush(),
    ]);
    if (!idle()) throw new Error("Preferences are still saving. Try reloading again.");
}
