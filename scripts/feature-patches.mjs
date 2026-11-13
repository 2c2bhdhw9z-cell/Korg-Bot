// SPDX-License-Identifier: MPL-2.0
import { replaceOnce } from "./patches.mjs";

export function patchPluginManager(source) {
    source = 'import { featureAvailability, pluginPersistence, trackPluginHydration, useFeatureStatus } from "@rain/pages/Korg/features";\nimport { useKorgRuntime } from "@rain/pages/Korg/runtime";\nimport { Platform } from "react-native";\n' + source;
    source = replaceOnce(source,
        '            storage: createJSONStorage(() => createFileStorage("plugins/settings.json")),\n            onRehydrateStorage: () => state => {\n                state?.setHasHydrated(true);\n            },',
        '            storage: createJSONStorage(() => pluginPersistence),\n            onRehydrateStorage: () => {\n                const finish = trackPluginHydration();\n                return (state, error) => {\n                    if (!error) state?.setHasHydrated(true);\n                    finish(state, error);\n                };\n            },', "plugin settings storage");
    source = replaceOnce(source,
        'async function runPluginLifecycle(id: string, method: "start" | "eagerStart"): Promise<void> {',
        'async function runPluginLifecycle(id: string, method: "start" | "eagerStart"): Promise<boolean> {', "lifecycle start result");
    source = replaceOnce(source,
        '    const settings = useSettings.getState();\n    if (settings.safeMode && !isPluginCore(id)) {',
        '    const settings = useSettings.getState();\n    if (!isPluginCore(id)) {\n        if (useFeatureStatus.getState().hydration !== "ready" || useKorgRuntime.getState().settings !== "ready") return false;\n        const unavailable = featureAvailability(instance, Platform.OS);\n        if (unavailable) {\n            logger.log(`[${id}] ${unavailable}`);\n            return false;\n        }\n    }\n    if (settings.safeMode && !isPluginCore(id)) {', "both plugin startup paths compatibility guard");
    source = replaceOnce(source,
        '        logger.log(`[${id}] Skipped in safe mode`);\n        return;',
        '        logger.log(`[${id}] Skipped in safe mode`);\n        return false;', "safe mode skipped start result");
    source = replaceOnce(source,
        '        await instance[method]?.();\n        usePluginSettings.getState().updatePluginSetting(id, true);',
        '        await instance[method]?.();\n        return true;', "startup lifecycle must not write preferences");
    source = replaceOnce(source,
        'export const startPlugin = (id: string): Promise<void> => runPluginLifecycle(id, "start");\nexport const startEagerPlugin = (id: string): Promise<void> => runPluginLifecycle(id, "eagerStart");',
        `// Explicit advanced-manager actions retain their preference changes.
export async function startPlugin(id: string): Promise<void> {
    if (!await runPluginLifecycle(id, "start")) throw new Error("Plugin cannot start until saved settings are ready and compatible");
    if (!isPluginCore(id)) {
        usePluginSettings.getState().updatePluginSetting(id, true);
        await pluginPersistence.flush();
    }
}
export async function startEagerPlugin(id: string): Promise<void> {
    if (!await runPluginLifecycle(id, "eagerStart")) throw new Error("Plugin cannot start until saved settings are ready and compatible");
    if (!isPluginCore(id)) {
        usePluginSettings.getState().updatePluginSetting(id, true);
        await pluginPersistence.flush();
    }
}`, "explicit advanced plugin starts");
    source = replaceOnce(source,
        '    try {\n        await instance.stop?.();\n        usePluginSettings.getState().updatePluginSetting(id, false);',
        '    if (isPluginCore(id)) return;\n    if (useFeatureStatus.getState().hydration !== "ready" || useKorgRuntime.getState().settings !== "ready") throw new Error("Wait for saved settings to load before stopping plugins");\n    try {\n        await instance.stop?.();\n        usePluginSettings.getState().updatePluginSetting(id, false);\n        await pluginPersistence.flush();', "explicit advanced plugin stop");
    source = replaceOnce(source,
        'await (method === "start" ? startPlugin(id) : startEagerPlugin(id));',
        'await runPluginLifecycle(id, method);', "batch startup avoids preference writes");
    source = replaceOnce(source,
        'try { await startEagerPlugin(id); }',
        'try { await runPluginLifecycle(id, "eagerStart"); }', "eager startup avoids preference writes");
    for (const [method, anchor] of [
        ["initPlugins", '    const ids = Array.from(pluginInstances.keys()).filter(isPluginEnabled);\n    await startBatched(ids, "start");'],
        ["initEagerPlugins", '    const ids = Array.from(pluginInstances.keys()).filter(isPluginEnabled);\n    await Promise.allSettled('],
    ]) {
        source = replaceOnce(source, anchor, `    const ready = useFeatureStatus.getState().hydration === "ready" && useKorgRuntime.getState().settings === "ready";
    const ids = Array.from(pluginInstances.keys()).filter(id => isPluginCore(id) || ready && isPluginEnabled(id));
` + anchor.slice(anchor.indexOf('    await ')), `${method} failed hydration guard`);
    }
    return source;
}
