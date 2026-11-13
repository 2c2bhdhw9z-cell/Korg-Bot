// SPDX-License-Identifier: MPL-2.0
import { fileExists, readFile, writeFile } from "@api/native/fs";
import { create } from "zustand";

type Readiness = "loading" | "ready" | "error";
type StoreName = "settings" | "themes" | "colors";

export const useKorgRuntime = create<{
    settings: Readiness;
    themes: Readiness;
    colors: Readiness;
    engineInitialized: boolean;
    pendingOperations: number;
}>()(() => ({ settings: "loading", themes: "loading", colors: "loading", engineInitialized: false, pendingOperations: 0 }));

// Rejections reach the caller, but never poison subsequent operations.
export function serialQueue() {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(operation: () => Promise<T>): Promise<T> => {
        const result = tail.then(operation);
        tail = result.catch(() => {});
        return result;
    };
}

// Selection, refresh completion, removal and safe-mode saves share one order.
const enqueueThemeOperation = serialQueue();
export function runThemeOperation<T>(operation: () => Promise<T>): Promise<T> {
    useKorgRuntime.setState(state => ({ pendingOperations: state.pendingOperations + 1 }));
    return enqueueThemeOperation(operation).finally(() => {
        useKorgRuntime.setState(state => ({ pendingOperations: state.pendingOperations - 1 }));
    });
}

export function createTrackedStorage(path: string, io = { fileExists, readFile, writeFile }) {
    const enqueue = serialQueue();
    let latest: Promise<void> = Promise.resolve();
    return {
        async getItem(_name: string) {
            // A prior failed write must settle before reading, but a fresh read
            // must still be able to recover the saved file.
            await latest.catch(() => {});
            return await io.fileExists(path) ? await io.readFile(path) : null;
        },
        setItem(_name: string, value: string) {
            latest = enqueue(() => io.writeFile(path, value));
            // Zustand's void mutators discard this promise. Observe it here;
            // flush retains the rejecting promise for explicit durable saves.
            return latest.catch(() => {});
        },
        async removeItem(_name: string) {
            throw new Error("Clearing tracked Korg storage is not supported");
        },
        async flush() {
            // Include writes enqueued while an earlier write was completing.
            let pending;
            do {
                pending = latest;
                await pending;
            } while (pending !== latest);
        },
    };
}

export const settingsPersistence = createTrackedStorage("rain/RAIN_SETTINGS");
export const themesPersistence = createTrackedStorage("RAIN_THEMES");
export const colorsPersistence = createTrackedStorage("themes/colors/preferences.json");

export function trackHydration(name: StoreName) {
    useKorgRuntime.setState({ [name]: "loading" });
    return (_state?: unknown, error?: unknown) => {
        useKorgRuntime.setState({ [name]: error ? "error" : "ready" });
    };
}

export function themeBlockReason(safeMode: boolean | undefined) {
    const state = useKorgRuntime.getState();
    if ([state.settings, state.themes, state.colors].includes("error")) {
        return "Could not load saved settings or appearance. Retry loading before making changes.";
    }
    if ([state.settings, state.themes, state.colors].some(status => status !== "ready")) {
        return "Loading your saved settings and appearance…";
    }
    if (safeMode || !state.engineInitialized) {
        return "Theme changes are paused. Turn off safe mode and reload to apply a theme.";
    }
    return "";
}

export async function waitForSettingsReady(): Promise<void> {
    if (useKorgRuntime.getState().settings !== "loading") return;
    await new Promise<void>(resolve => {
        const finish = () => { unsubscribe(); clearTimeout(timer); resolve(); };
        const unsubscribe = useKorgRuntime.subscribe(state => {
            if (state.settings !== "loading") finish();
        });
        const timer = setTimeout(finish, 5000);
    });
}

export function assertThemeReady(safeMode: boolean | undefined) {
    const reason = themeBlockReason(safeMode);
    if (reason) throw new Error(reason);
}

// Used by Korg's safe-mode switch; reload is offered only after this resolves.
export async function saveSafeMode(store: {
    persist: { hasHydrated(): boolean };
    getState(): { safeMode?: boolean; updateSettings(value: { safeMode?: boolean }): void };
}, value: boolean) {
    return runThemeOperation(async () => {
        if (!store.persist.hasHydrated() || useKorgRuntime.getState().settings !== "ready") {
            throw new Error("Wait for saved settings to load, or retry loading them.");
        }
        const previous = store.getState().safeMode;
        store.getState().updateSettings({ safeMode: value });
        try {
            await settingsPersistence.flush();
        } catch {
            store.getState().updateSettings({ safeMode: previous });
            try {
                await settingsPersistence.flush();
            } catch {
                throw new Error("Could not save or restore safe mode. Retry saving before reloading.");
            }
            throw new Error("Could not save safe mode. Your previous preference was restored.");
        }
    });
}
