// SPDX-License-Identifier: MPL-2.0
// Exact anchors deliberately fail when the pinned upstream source changes.
export function replaceOnce(source, before, after, label) {
    const first = source.indexOf(before);
    if (first < 0 || source.indexOf(before, first + before.length) !== -1) {
        throw new Error(`Upstream changed: expected exactly one ${label}`);
    }
    return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchSettings(source) {
    source = replaceOnce(source, '        name: "Rain",', '        name: "Korg",', "settings section");
    source = replaceOnce(source, '        items: [\n', `        items: [
            {
                key: "KORG_HOME",
                title: () => "Korg",
                icon: findAssetId("PaintPaletteIcon"),
                render: () => import("@rain/pages/Korg"),
                useTrailing: () => "0.1.0",
            },
`, "settings items");
    return replaceOnce(source, "title: () => Strings.RAIN,", 'title: () => "Rain · advanced",', "upstream settings label");
}

// Only these three stores opt into tracked persistence. Other Rain stores keep
// their existing behavior; the helper does not import the stores (no cycles).
export function patchSettingsStore(source) {
    source = 'import { settingsPersistence, trackHydration } from "@rain/pages/Korg/runtime";\n' + source;
    return replaceOnce(source,
        '            storage: createJSONStorage(() => createFileStorage("rain/RAIN_SETTINGS")),',
        '            storage: createJSONStorage(() => settingsPersistence),\n            onRehydrateStorage: () => trackHydration("settings"),', "settings persistence");
}

function patchAppearanceStorage(source, path, persistence, name) {
    source = replaceOnce(source, `createFileStorage("${path}")`, persistence, `${name} persistence`);
    return replaceOnce(source, `            onRehydrateStorage: () => state => {
                state?.setHasHydrated(true);
            }`, `            onRehydrateStorage: () => {
                const finish = trackHydration("${name}");
                return (state, error) => {
                    if (!error) state?.setHasHydrated(true);
                    finish(state, error);
                };
            }`, `${name} hydration`);
}

export function patchColorPreferences(source) {
    source = 'import { colorsPersistence, trackHydration } from "@rain/pages/Korg/runtime";\n' + source;
    return patchAppearanceStorage(source, "themes/colors/preferences.json", "colorsPersistence", "colors");
}

export function patchThemes(source) {
    source = 'import { assertThemeReady, colorsPersistence, runThemeOperation, themesPersistence, trackHydration, useKorgRuntime, waitForSettingsReady } from "@rain/pages/Korg/runtime";\n' + source;
    source = patchAppearanceStorage(source, "RAIN_THEMES", "themesPersistence", "themes");
    const selection = `            selectTheme: async (id: string | null, write = true) => {
                const { themes } = get();
                const theme = id ? themes[id] : null;

                set(state => {
                    const newThemes = { ...state.themes };
                    Object.keys(newThemes).forEach(k => {
                        newThemes[k] = {
                            ...newThemes[k],
                            selected: newThemes[k].id === id
                        };
                    });
                    return { themes: newThemes };
                });

                if (theme == null && write) {
                    updateColor(null, { update: true }, { noCustomIcons: false });
                    return await writeThemeToNative({});
                } else if (theme) {
                    updateColor(theme.data, { update: true }, { noCustomIcons: false });
                    return await writeThemeToNative(theme);
                }
            },`;
    source = replaceOnce(source, selection, `            selectTheme: async (id: string | null, write = true) => {
                return runThemeOperation(() => applyThemeSelection(id, write));
            },`, "serialized theme selection");
    source = replaceOnce(source, `            removeTheme: async (id: string) => {
                const theme = get().themes[id];
                if (theme?.selected) await get().selectTheme(null);

                set(state => {
                    const newThemes = { ...state.themes };
                    delete newThemes[id];
                    return { themes: newThemes };
                });

                return theme?.selected ?? false;
            },`, `            removeTheme: async (id: string) => runThemeOperation(async () => {
                assertThemeReady(useSettings.getState().safeMode);
                const theme = get().themes[id];
                if (theme?.selected) await applyThemeSelection(null);
                themeGenerations.set(id, (themeGenerations.get(id) ?? 0) + 1);
                set(state => {
                    const themes = { ...state.themes };
                    delete themes[id];
                    return { themes };
                });
                await themesPersistence.flush();
                return theme?.selected ?? false;
            }),`, "serialized theme removal");
    for (const method of ["fetchTheme", "hotFetchTheme"]) {
        const hot = method === "hotFetchTheme";
        const before = `            ${method}: async (url: string, selected = false) => {
                let themeJSON: any;

                try {
                    themeJSON = await (await safeFetch(url, { cache: "no-store" })).json();
                } catch {
                    throw new Error(\`Failed to fetch theme at \${url}\`);
                }

                if (!validateTheme(themeJSON)) throw new Error(\`Invalid theme at \${url}\`);

                const themeInfo: ThemeInfo = {
                    id: url,
                    selected: selected,
                    data: processData(themeJSON),
                };

                get().setTheme(url, themeInfo);

                if (selected) {
                    writeThemeToNative(themeInfo);
                    updateColor(themeInfo.data, { update: true }, { noCustomIcons: ${hot} });
                }
            },`;
        source = replaceOnce(source, before, `            ${method}: async (url: string, selected = false) => {
                if (url === "korg:amethyst" || url === "korg:midnight") return;
                assertThemeReady(useSettings.getState().safeMode);
                const existed = Boolean(get().themes[url]);
                const generation = themeGenerations.get(url) ?? 0;
                let themeJSON: any;
                try {
                    themeJSON = await (await safeFetch(url, { cache: "no-store" })).json();
                } catch {
                    throw new Error(\`Failed to fetch theme at \${url}\`);
                }
                if (!validateTheme(themeJSON)) throw new Error(\`Invalid theme at \${url}\`);
                await runThemeOperation(async () => {
                    assertThemeReady(useSettings.getState().safeMode);
                    const current = get().themes[url];
                    if ((themeGenerations.get(url) ?? 0) !== generation || (existed && !current)) return;
                    const themeInfo: ThemeInfo = {
                        id: url,
                        selected: current?.selected ?? false,
                        data: processData(themeJSON),
                    };
                    get().setTheme(url, themeInfo);
                    await themesPersistence.flush();
                    if (themeInfo.selected) {
                        await writeThemeToNative(themeInfo);
                        updateColor(themeInfo.data, { update: true }, { noCustomIcons: ${hot} });
                        await colorsPersistence.flush();
                    }
                });
            },`, `${method} completion selection`);
    }
    source = replaceOnce(source, 'export const useThemes = create<ThemesStore>()(', `const themeGenerations = new Map<string, number>();

// Called only inside runThemeOperation so native writes cannot finish out of order.
async function applyThemeSelection(id: string | null, write = true) {
    assertThemeReady(useSettings.getState().safeMode);
    const { themes } = useThemes.getState();
    const theme = id === null ? null : themes[id];
    if (id !== null && !theme) throw new Error("Theme is no longer installed");
    useThemes.setState({ themes: Object.fromEntries(Object.entries(themes).map(([key, value]) =>
        [key, { ...value, selected: key === id }])) });
    await themesPersistence.flush();
    if (theme || write) {
        await writeThemeToNative(theme ? { ...theme, selected: true } : {});
        updateColor(theme?.data ?? null, { update: true }, { noCustomIcons: false });
        await colorsPersistence.flush();
    }
}

// Registration, selection and rollback are one operation, including Undo.
export async function applyKorgTheme(next: ThemeInfo | null): Promise<ThemeInfo | null> {
    return runThemeOperation(async () => {
        assertThemeReady(useSettings.getState().safeMode);
        const previous = getCurrentTheme();
        try {
            if (next) {
                useThemes.getState().setTheme(next.id, next);
                await themesPersistence.flush();
            }
            await applyThemeSelection(next?.id ?? null);
            return previous;
        } catch {
            try {
                if (previous) useThemes.getState().setTheme(previous.id, previous);
                await applyThemeSelection(previous?.id ?? null);
            } catch {
                throw new Error("Could not save or restore the theme. Retry Discord default before reloading.");
            }
            throw new Error("Could not save the theme. Your previous selection was restored.");
        }
    });
}

export const useThemes = create<ThemesStore>()(`, "theme transactions");
    source = replaceOnce(source, 'export async function initThemes() {', 'export async function initThemes() {\n    await waitForSettingsReady();', "wait for settings before boot");
    source = replaceOnce(source, '        await getCurrentTheme();', `        if (!useSettings.persist.hasHydrated() || useSettings.getState().safeMode) return;
        const readiness = useKorgRuntime.getState();
        if (readiness.settings !== "ready" || readiness.themes !== "ready" || readiness.colors !== "ready") return;`, "initialization readiness");
    return replaceOnce(source, '        updateThemes().catch(e => console.error("Failed to update themes", e));', `        useKorgRuntime.setState({ engineInitialized: true });
        updateThemes().catch(e => console.error("Failed to update themes", e));`, "runtime engine flag");
}

// Rain's options sheet calls updateColor directly. Gate the whole page too,
// including when reached from advanced settings instead of the Korg entry.
export function patchThemesPage(source) {
    source = 'import { themeBlockReason, useKorgRuntime } from "@rain/pages/Korg/runtime";\nimport { Text } from "@metro/common/components";\n' + source;
    return replaceOnce(source, '    const navigation = NavigationNative.useNavigation();\n\n    return (', `    const navigation = NavigationNative.useNavigation();
    useKorgRuntime();
    const blocked = themeBlockReason(safeMode);
    if (blocked) return <Text variant="text-md/normal">{blocked} Open Korg for recovery controls.</Text>;

    return (`, "Themes page readiness");
}

export function patchThemeInfoSheet(source) {
    source = replaceOnce(source, '    const [loading, setLoading] = useState(false);', `    const [loading, setLoading] = useState(false);
    const bundled = themeState.id === "korg:amethyst" || themeState.id === "korg:midnight";`, "bundled theme actions");
    source = replaceOnce(source, `                    <ThemeInfoIconButton
                        label={Strings.REFETCH}`, `                    {!bundled && <ThemeInfoIconButton
                        label={Strings.REFETCH}`, "hide bundled refetch");
    source = replaceOnce(source, `                        disabled={loading}
                    />`, `                        disabled={loading}
                    />}`, "close bundled refetch");
    source = replaceOnce(source, `                    <ThemeInfoIconButton
                        label={Strings.COPY_URL}`, `                    {!bundled && <ThemeInfoIconButton
                        label={Strings.COPY_URL}`, "hide bundled copy URL");
    return replaceOnce(source, `                        onPress={copyThemeUrl}
                    />`, `                        onPress={copyThemeUrl}
                    />}`, "close bundled copy URL");
}
