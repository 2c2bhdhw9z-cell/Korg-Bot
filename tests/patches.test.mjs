import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { patchSettings, patchSettingsStore, patchColorPreferences, patchThemes, patchThemesPage, patchThemeInfoSheet, replaceOnce } from "../scripts/patches.mjs";

const revision = "4b091e1698aa983c5f4e694ae243c9a6fd8b52fb";
const work = new URL(`../.build/rain-${revision}/`, import.meta.url);
const archive = new URL("../.build/rain-source.tar.gz", import.meta.url);
const available = existsSync(archive) && existsSync(new URL("node_modules/esbuild", work));
const require = available ? createRequire(new URL("package.json", work)) : null;
const esbuild = require?.("esbuild");
const { createStore } = require?.("zustand/vanilla") ?? {};
const middleware = require?.("zustand/middleware") ?? {};
const upstream = path => execFileSync("tar", ["-xOzf", archive.pathname, `rain-${revision}/${path}`], { encoding: "utf8" });

function load(source, mocks, loader = "ts") {
    const code = esbuild.transformSync(source, { loader, format: "cjs", target: "es2022" }).code;
    const module = { exports: {} };
    // Same realm as Zustand: its middleware uses instanceof Promise.
    new Function("module", "exports", "require", code)(module, module.exports, name => {
        if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
        return mocks[name];
    });
    return module.exports;
}
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const create = () => initializer => createStore(initializer);

async function harness({ readError = false, initialSafeMode = false } = {}) {
    const writes = [], files = new Map();
    let writeImpl = async (path, value) => { writes.push({ path, value: JSON.parse(value) }); files.set(path, value); };
    const fs = {
        fileExists: async path => { if (readError) throw Error("read failed"); return files.has(path); },
        readFile: async path => files.get(path),
        writeFile: (path, value) => writeImpl(path, value),
    };
    const runtime = load(readFileSync(new URL("../overlays/runtime.ts", import.meta.url), "utf8"), {
        "@api/native/fs": fs, zustand: { create },
    });
    const settings = load(patchSettingsStore(upstream("src/api/settings.ts")), {
        "@rain/pages/Korg/runtime": runtime, zustand: { create }, "zustand/middleware": middleware,
        "./native/loader": { getLoaderConfigPath: () => "loader.json" },
        "./storage": { createFlattenedFileStorage: () => ({ getItem: async () => null, setItem: async () => {} }) },
    });
    const prefs = load(patchColorPreferences(upstream("src/plugins/_core/painter/themes/preferences.ts")), {
        "@rain/pages/Korg/runtime": runtime, "@api/storage": {}, zustand: { create }, "zustand/middleware": middleware,
    });
    let fetchImpl = async () => ({ json: async () => ({ spec: 2, name: "Remote" }) });
    const updates = [];
    const themes = load(patchThemes(upstream("src/plugins/_core/painter/themes/index.ts")), {
        "@rain/pages/Korg/runtime": runtime, "@api/native/fs": fs,
        "@api/native/loader": { getThemeFilePath: () => "theme.json", getStoredTheme: () => null, isPyonLoader: () => false },
        "@api/settings": settings, "@api/storage": {}, "@lib/utils": { safeFetch: (...args) => fetchImpl(...args) },
        "@metro/common": { FluxDispatcher: { dispatch() {} } }, "react-native": { Platform: { OS: "ios" } },
        zustand: { create }, "zustand/middleware": middleware, "./colors": { __esModule: true, default() {} },
        "./parser": { normalizeToHex: value => value, applyAndroidAlphaKeys() {} },
        "./preferences": prefs, "./updater": { updateColor: data => updates.push(data?.name ?? null) },
    });
    await tick();
    if (!readError) {
        settings.useSettings.getState().updateSettings({ safeMode: initialSafeMode });
        await runtime.settingsPersistence.flush();
        await themes.initThemes();
        await tick();
    }
    return {
        runtime, themes, settings, prefs, writes, updates, files,
        setWrite(fn) { writeImpl = fn; }, setFetch(fn) { fetchImpl = fn; },
        recoverReads() { readError = false; },
    };
}
const theme = (id, selected = false) => ({ id, selected, data: { spec: 2, name: id } });
const pinnedTest = (name, fn) => test(name, { skip: available ? false : "Run build once to cache pinned Rain source and dependencies" }, fn);

test("patches reject missing or ambiguous upstream anchors", () => {
    assert.throws(() => replaceOnce("abc", "x", "y", "anchor"), /exactly one/);
    assert.throws(() => replaceOnce("xx", "x", "y", "anchor"), /exactly one/);
    assert.equal(replaceOnce("abc", "b", "B", "anchor"), "aBc");
});

pinnedTest("all transforms accept only the pinned originals and produce valid TS/TSX", () => {
    for (const [path, patch] of [
        ["src/plugins/_core/settings/index.tsx", patchSettings],
        ["src/api/settings.ts", patchSettingsStore],
        ["src/plugins/_core/painter/themes/preferences.ts", patchColorPreferences],
        ["src/plugins/_core/painter/themes/index.ts", patchThemes],
        ["src/rain/pages/Themes/index.tsx", patchThemesPage],
        ["src/rain/pages/Themes/sheets/ThemeInfoActionSheet.tsx", patchThemeInfoSheet],
    ]) {
        const patched = patch(upstream(path));
        esbuild.transformSync(patched, { loader: path.endsWith("tsx") ? "tsx" : "ts" });
        assert.throws(() => patch(patched), /Upstream changed/);
    }
    esbuild.transformSync(readFileSync(new URL("../overlays/KorgPage.tsx", import.meta.url), "utf8"), { loader: "tsx" });
});

pinnedTest("tracked writes serialize, expose failure, and recover without poisoning the queue", async () => {
    const { runtime } = await harness();
    const first = deferred(), calls = [];
    const storage = runtime.createTrackedStorage("test", {
        fileExists: async () => false, readFile: async () => "",
        writeFile: async (_path, value) => { calls.push(value); if (value === "one") await first.promise; },
    });
    storage.setItem("", "one");
    storage.setItem("", "two");
    await tick();
    assert.deepEqual(calls, ["one"]);
    first.resolve();
    await storage.flush();
    assert.deepEqual(calls, ["one", "two"]);
    const broken = runtime.createTrackedStorage("bad", {
        fileExists: async () => false, readFile: async () => "",
        writeFile: async (_path, value) => { if (value === "bad") throw Error("disk full"); },
    });
    broken.setItem("", "bad");
    await assert.rejects(broken.flush(), /disk full/);
    broken.setItem("", "good");
    await broken.flush();
});

for (const method of ["fetchTheme", "hotFetchTheme"]) {
    pinnedTest(`${method}: late refresh cannot override Amethyst or resurrect removed themes`, async () => {
        const h = await harness();
        const store = h.themes.useThemes.getState();
        store.setTheme("remote", theme("remote", true));
        const download = deferred();
        h.setFetch(async () => { await download.promise; return { json: async () => ({ spec: 2, name: "Refreshed" }) }; });
        const refresh = store[method]("remote", true);
        await h.themes.applyKorgTheme(theme("korg:amethyst"));
        download.resolve();
        await refresh;
        assert.equal(h.themes.getCurrentTheme().id, "korg:amethyst");
        assert.equal(h.updates.at(-1), "korg:amethyst");
        assert.equal(JSON.parse(h.files.get("theme.json")).id, "korg:amethyst");
        const removed = deferred();
        h.setFetch(async () => { await removed.promise; return { json: async () => ({ spec: 2, name: "Deleted" }) }; });
        const stale = store[method]("remote");
        await store.removeTheme("remote");
        removed.resolve();
        await stale;
        assert.equal(h.themes.useThemes.getState().themes.remote, undefined);
        h.setFetch(() => { throw Error("local ID reached network"); });
        await store[method]("korg:amethyst", true);
        await store[method]("korg:midnight", true);
    });

    pinnedTest(`${method}: selection at completion wins and native writes block later selections`, async () => {
        const h = await harness();
        h.themes.useThemes.getState().setTheme("remote", theme("remote"));
        const download = deferred();
        h.setFetch(async () => { await download.promise; return { json: async () => ({ spec: 2, name: "Updated" }) }; });
        const refresh = h.themes.useThemes.getState()[method]("remote", false);
        await h.themes.selectTheme(theme("remote"));
        const native = deferred(), writes = [];
        h.setWrite(async (path, value) => { writes.push(path); if (path === "theme.json") await native.promise; });
        download.resolve();
        await tick();
        assert.ok(writes.includes("theme.json"));
        let completed = false;
        const select = h.themes.applyKorgTheme(theme("korg:amethyst")).then(() => { completed = true; });
        await tick();
        assert.equal(completed, false);
        native.resolve();
        await Promise.all([refresh, select]);
        assert.equal(h.themes.getCurrentTheme().id, "korg:amethyst");
        assert.equal(h.updates.at(-1), "korg:amethyst");
    });
}

pinnedTest("Korg apply and Undo wait for durable save; failures restore selection and never report success", async () => {
    const h = await harness();
    const previous = await h.themes.applyKorgTheme(theme("korg:amethyst"));
    assert.equal(previous, null);
    const undo = await h.themes.applyKorgTheme(theme("korg:midnight"));
    assert.equal(undo.id, "korg:amethyst");
    await h.themes.applyKorgTheme(undo);
    assert.equal(JSON.parse(h.files.get("RAIN_THEMES")).state.themes[undo.id].selected, true);
    let fail = true;
    h.setWrite(async path => { if (path === "RAIN_THEMES" && fail) { fail = false; throw Error("disk full"); } });
    await assert.rejects(h.themes.applyKorgTheme(theme("korg:midnight")), /previous selection was restored/);
    assert.equal(h.themes.getCurrentTheme().id, "korg:amethyst");
    h.setWrite(async () => { throw Error("persistent failure"); });
    await assert.rejects(h.themes.applyKorgTheme(null), /Could not save or restore/);
});

pinnedTest("safe mode waits for save and cannot bypass skipped initialization after navigation", async () => {
    const h = await harness({ initialSafeMode: true });
    assert.equal(h.runtime.useKorgRuntime.getState().engineInitialized, false);
    const pending = deferred();
    h.setWrite(async () => pending.promise);
    let saved = false;
    const saving = h.runtime.saveSafeMode(h.settings.useSettings, false).then(() => { saved = true; });
    await tick();
    assert.equal(saved, false);
    pending.resolve();
    await saving;
    assert.match(h.runtime.themeBlockReason(false), /reload/);
    await assert.rejects(h.themes.selectTheme(null), /reload/);
    // A new consumer of the shared API gets the same gate; no page-local ref.
    await assert.rejects(h.themes.applyKorgTheme(theme("korg:amethyst")), /reload/);
    h.setWrite(async () => { throw Error("disk full"); });
    await assert.rejects(h.runtime.saveSafeMode(h.settings.useSettings, true), /Could not save or restore/);
    assert.equal(h.settings.useSettings.getState().safeMode, false);
});

pinnedTest("read failure is explicit, prevents writes, and supports rehydration retry", async () => {
    const h = await harness({ readError: true });
    assert.equal(h.runtime.useKorgRuntime.getState().settings, "error");
    assert.equal(h.runtime.useKorgRuntime.getState().themes, "error");
    assert.equal(h.runtime.useKorgRuntime.getState().colors, "error");
    assert.match(h.runtime.themeBlockReason(false), /Retry loading/);
    await assert.rejects(h.runtime.saveSafeMode(h.settings.useSettings, true), /retry loading/);
    await assert.rejects(h.themes.applyKorgTheme(theme("korg:amethyst")), /Retry loading/);
    assert.equal(h.writes.length, 0);
    h.recoverReads();
    await Promise.all([h.settings.useSettings.persist.rehydrate(), h.themes.useThemes.persist.rehydrate(), h.prefs.useColorsPref.persist.rehydrate()]);
    assert.equal(h.runtime.useKorgRuntime.getState().settings, "ready");
    assert.equal(h.runtime.useKorgRuntime.getState().themes, "ready");
    assert.equal(h.runtime.useKorgRuntime.getState().colors, "ready");
    assert.match(h.runtime.themeBlockReason(false), /reload/);
    await h.runtime.saveSafeMode(h.settings.useSettings, true);
});

pinnedTest("native write failure rolls Korg back and propagates refresh failure", async () => {
    const h = await harness();
    await h.themes.applyKorgTheme(theme("korg:amethyst"));
    let failed = false;
    h.setWrite(async path => {
        if (path === "theme.json" && !failed) { failed = true; throw Error("native write failed"); }
    });
    await assert.rejects(h.themes.applyKorgTheme(theme("korg:midnight")), /previous selection was restored/);
    assert.equal(h.themes.getCurrentTheme().id, "korg:amethyst");
    h.themes.useThemes.getState().setTheme("remote", theme("remote"));
    await h.themes.selectTheme(theme("remote"));
    h.setWrite(async path => { if (path === "theme.json") throw Error("native write failed"); });
    for (const method of ["fetchTheme", "hotFetchTheme"]) {
        await assert.rejects(h.themes.useThemes.getState()[method]("remote", true), /native write failed/);
    }
});

pinnedTest("malformed stored JSON reports failure instead of loading forever and can be retried", async () => {
    const h = await harness();
    h.files.set("RAIN_THEMES", "{broken");
    await h.themes.useThemes.persist.rehydrate();
    assert.equal(h.runtime.useKorgRuntime.getState().themes, "error");
    await assert.rejects(h.themes.applyKorgTheme(null), /Retry loading/);
    h.files.set("RAIN_THEMES", JSON.stringify({ state: { themes: {} }, version: 0 }));
    await h.themes.useThemes.persist.rehydrate();
    assert.equal(h.runtime.useKorgRuntime.getState().themes, "ready");
    await h.themes.applyKorgTheme(theme("korg:amethyst"));
});

pinnedTest("pending saves survive new page consumers and clear on rejection", async () => {
    const h = await harness();
    const pending = deferred();
    h.setWrite(async () => pending.promise);
    const saving = h.runtime.saveSafeMode(h.settings.useSettings, true);
    await tick();
    assert.equal(h.runtime.useKorgRuntime.getState().pendingOperations, 1);
    pending.resolve();
    await saving;
    assert.equal(h.runtime.useKorgRuntime.getState().pendingOperations, 0);
    await assert.rejects(h.themes.applyKorgTheme(null), /reload/);
    assert.equal(h.runtime.useKorgRuntime.getState().pendingOperations, 0);
});
