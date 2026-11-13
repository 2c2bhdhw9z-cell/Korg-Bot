import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { patchPluginManager } from "../scripts/feature-patches.mjs";

const revision = "4b091e1698aa983c5f4e694ae243c9a6fd8b52fb";
const work = new URL(`../.build/rain-${revision}/`, import.meta.url);
const archive = new URL("../.build/rain-source.tar.gz", import.meta.url);
const available = existsSync(archive) && existsSync(new URL("node_modules/esbuild", work));
const require = available ? createRequire(new URL("package.json", work)) : null;
const esbuild = require?.("esbuild");
const { createStore } = require?.("zustand/vanilla") ?? {};
const load = (source, mocks, loader = "ts") => {
    const module = { exports: {} };
    const code = esbuild.transformSync(source, { loader, format: "cjs", target: "es2022" }).code;
    new Function("module", "exports", "require", code)(module, module.exports, name => {
        if (!(name in mocks)) throw Error(`Unexpected dependency: ${name}`);
        return mocks[name];
    });
    return module.exports;
};
const create = () => initializer => createStore(initializer);
const pinned = (name, fn) => test(name, { skip: available ? false : "Build once to cache pinned Rain and esbuild" }, fn);

pinned("plugin patch accepts pinned upstream, guards both startup methods, rejects drift", () => {
    const original = execFileSync("tar", ["-xOzf", archive.pathname, `rain-${revision}/src/plugins/index.ts`], { encoding: "utf8" });
    const patched = patchPluginManager(original);
    esbuild.transformSync(patched, { loader: "ts" });
    assert.match(patched, /featureAvailability\(instance, Platform.OS\)/);
    assert.match(patched, /pluginPersistence/);
    assert.match(patched, /trackPluginHydration/);
    assert.throws(() => patchPluginManager(patched), /Upstream changed/);
    esbuild.transformSync(readFileSync(new URL("../overlays/FeaturesPage.tsx", import.meta.url), "utf8"), { loader: "tsx" });
});

pinned("catalog derives manifests, filters core/placeholder/dev and fails compatibility closed", () => {
    const storage = { fileExists: async () => false, readFile: async () => "", writeFile: async () => {} };
    const runtime = load(readFileSync(new URL("../overlays/runtime.ts", import.meta.url), "utf8"), { "@api/native/fs": storage, zustand: { create } });
    const features = load(readFileSync(new URL("../overlays/features.ts", import.meta.url), "utf8"), {
        "./runtime": runtime, "react-native": { Platform: { OS: "ios" } }, zustand: { create },
    });
    const instances = new Map([
        ["corefoo", { name: "Core", description: "core" }],
        ["customeffects", { name: "Placeholder", description: "placeholder" }],
        ["jumptotop", { name: "Jump", description: "jump" }],
        ["quoter", { name: "Quote", description: "quote", platforms: ["android"] }],
        ["chatbubbles", { name: "Bubbles", description: "bubbles", predicates: [() => { throw Error("unsupported"); }] }],
        ["actionsheetfinder", { name: "Developer", devOnly: true }],
    ]);
    const catalog = features.featureCatalog(instances);
    assert.deepEqual(catalog.map(item => item.id), ["chatbubbles", "jumptotop", "quoter"]);
    assert.match(catalog[0].availability, /Could not check/);
    assert.match(catalog[2].availability, /Unavailable/);
    assert.deepEqual(features.packChanges(features.packs.Essentials, instances, "ios"), { jumptotop: true });
    assert.deepEqual(features.packChanges(["quoter", "chatbubbles"], instances, "ios"), {});
    assert.equal(features.featureCatalog(instances, true).length, 4);
    assert.equal(features.featureAvailability({ predicates: [() => 1] }, "ios") !== null, true);
});

pinned("saved preferences await writes, preserve unrelated values, rollback on failure and retry", async () => {
    const files = new Map();
    let fail = false;
    const io = {
        fileExists: async path => files.has(path), readFile: async path => files.get(path),
        writeFile: async (path, value) => { if (fail) { fail = false; throw Error("disk full"); } files.set(path, value); },
    };
    const runtime = load(readFileSync(new URL("../overlays/runtime.ts", import.meta.url), "utf8"), { "@api/native/fs": io, zustand: { create } });
    const features = load(readFileSync(new URL("../overlays/features.ts", import.meta.url), "utf8"), {
        "./runtime": runtime, "react-native": { Platform: { OS: "ios" } }, zustand: { create },
    });
    // Keep the same store API as Zustand persist; write scheduling is the real tracked adapter.
    const store = {
        persist: { hasHydrated: () => true },
        state: { settings: { custom: { enabled: false } } },
        getState() { return this.state; },
        setState(next) { this.state = { ...this.state, ...next }; features.pluginPersistence.setItem("plugin-settings", JSON.stringify(this.state)); },
    };
    runtime.useKorgRuntime.setState({ settings: "ready" });
    await assert.rejects(features.saveFeatures(store, { jumptotop: true }), /retry loading/);
    features.trackPluginHydration()({}, undefined);
    await features.saveFeatures(store, { jumptotop: true });
    assert.deepEqual(JSON.parse(files.get("plugins/settings.json")).settings, { custom: { enabled: false }, jumptotop: { enabled: true } });
    assert.equal(features.useFeatureStatus.getState().pendingReload, true);
    fail = true;
    await assert.rejects(features.saveFeatures(store, { jumptotop: false }), /Previous preferences were restored/);
    assert.equal(store.getState().settings.jumptotop.enabled, true);
    assert.equal(JSON.parse(files.get("plugins/settings.json")).settings.jumptotop.enabled, true);
    await features.saveFeatures(store, { jumptotop: false });
    assert.equal(JSON.parse(files.get("plugins/settings.json")).settings.jumptotop.enabled, false);
});

pinned("hydration failure blocks writes and retry restores editable state", async () => {
    const io = { fileExists: async () => false, readFile: async () => "", writeFile: async () => {} };
    const runtime = load(readFileSync(new URL("../overlays/runtime.ts", import.meta.url), "utf8"), { "@api/native/fs": io, zustand: { create } });
    const features = load(readFileSync(new URL("../overlays/features.ts", import.meta.url), "utf8"), {
        "./runtime": runtime, "react-native": { Platform: { OS: "ios" } }, zustand: { create },
    });
    const store = {
        persist: { hasHydrated: () => true },
        state: { settings: {} },
        getState() { return this.state; },
        setState(next) { this.state = next; features.pluginPersistence.setItem("plugin-settings", JSON.stringify(next)); },
    };
    runtime.useKorgRuntime.setState({ settings: "ready" });
    features.trackPluginHydration()({}, Error("read failed"));
    await assert.rejects(features.saveFeatures(store, { jumptotop: true }), /retry loading/);
    assert.deepEqual(store.getState().settings, {});
    features.trackPluginHydration()({}, undefined);
    await features.saveFeatures(store, { jumptotop: true });
    assert.equal(store.getState().settings.jumptotop.enabled, true);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function managerFixture(io, safeMode = false) {
    const zustand = require("zustand");
    const runtime = load(readFileSync(new URL("../overlays/runtime.ts", import.meta.url), "utf8"), {
        "@api/native/fs": io, zustand,
    });
    const features = load(readFileSync(new URL("../overlays/features.ts", import.meta.url), "utf8"), {
        "./runtime": runtime, "react-native": { Platform: { OS: "ios" } }, zustand,
    });
    const original = execFileSync("tar", ["-xOzf", archive.pathname, `rain-${revision}/src/plugins/index.ts`], { encoding: "utf8" });
    // Keep the pinned lifecycle intact; substitute only its generated plugin import.
    const patched = patchPluginManager(original).replace('import("#rain-plugins")', 'Promise.resolve({ default: {} })');
    const manager = load(patched, {
        "@api/settings": { useSettings: { getState: () => ({ safeMode }) } },
        "@api/storage": { waitForHydration: async () => {} },
        "@api/ui/toasts": { showToast: () => {} },
        "@lib/utils/logger": { logger: { log: () => {} } },
        react: {}, zustand, "zustand/middleware": require("zustand/middleware"),
        "@rain/pages/Korg/features": features, "@rain/pages/Korg/runtime": runtime,
        "react-native": { Platform: { OS: "ios" } },
    });
    return { manager, features, runtime };
}

pinned("delayed startup never overwrites a queued disable; advanced toggles persist", async () => {
    const files = new Map();
    const gate = deferred();
    const started = deferred();
    const io = {
        fileExists: async path => files.has(path), readFile: async path => files.get(path),
        writeFile: async (path, value) => { files.set(path, value); },
    };
    const { manager, features, runtime } = managerFixture(io);
    await manager.usePluginSettings.persist.rehydrate();
    runtime.useKorgRuntime.setState({ settings: "ready" });
    manager.pluginInstances.set("optional", { start: () => { started.resolve(); return gate.promise; }, stop: async () => {} });
    await features.saveFeatures(manager.usePluginSettings, { optional: true });
    const startup = manager.initPlugins();
    await started.promise;
    const disable = features.saveFeatures(manager.usePluginSettings, { optional: false });
    await disable;
    gate.resolve();
    await startup;
    assert.equal(manager.usePluginSettings.getState().settings.optional.enabled, false);
    assert.equal(JSON.parse(files.get("plugins/settings.json")).state.settings.optional.enabled, false);
    await manager.startPlugin("optional");
    assert.equal(JSON.parse(files.get("plugins/settings.json")).state.settings.optional.enabled, true);
    await manager.stopPlugin("optional");
    assert.equal(JSON.parse(files.get("plugins/settings.json")).state.settings.optional.enabled, false);
});

pinned("failed reads still start core, but loading/safe mode block optional startup", async () => {
    let failed = true;
    let core = 0;
    let optional = 0;
    const io = {
        fileExists: async () => { if (failed) throw Error("unreadable"); return false; },
        readFile: async () => "", writeFile: async () => {},
    };
    const { manager, features, runtime } = managerFixture(io, true);
    await manager.usePluginSettings.persist.rehydrate();
    assert.equal(features.useFeatureStatus.getState().hydration, "error");
    manager.pluginInstances.set("coreRecovery", { start: async () => { core++; }, eagerStart: async () => { core++; } });
    manager.pluginInstances.set("optional", { start: async () => { optional++; }, eagerStart: async () => { optional++; } });
    runtime.useKorgRuntime.setState({ settings: "error" });
    await manager.initPlugins();
    await manager.initEagerPlugins();
    assert.equal(core, 2);
    assert.equal(optional, 0);
    await manager.startPlugin("coreRecovery");
    await manager.stopPlugin("coreRecovery");
    assert.equal(manager.usePluginSettings.getState().settings.coreRecovery, undefined);
    failed = false;
    await manager.usePluginSettings.persist.rehydrate();
    runtime.useKorgRuntime.setState({ settings: "ready" });
    await assert.rejects(manager.startPlugin("optional"), /cannot start/);
    assert.equal(optional, 0);
    assert.equal(features.useFeatureStatus.getState().pendingReload, false);
});

pinned("failed write and rollback can rehydrate and save again", async () => {
    const files = new Map();
    let failures = 0;
    const io = {
        fileExists: async path => files.has(path), readFile: async path => files.get(path),
        writeFile: async (path, value) => { if (failures-- > 0) throw Error("disk full"); files.set(path, value); },
    };
    const { manager, features, runtime } = managerFixture(io);
    await manager.usePluginSettings.persist.rehydrate();
    await features.pluginPersistence.flush();
    runtime.useKorgRuntime.setState({ settings: "ready" });
    failures = 2;
    await assert.rejects(features.saveFeatures(manager.usePluginSettings, { optional: true }), /Could not save or restore/);
    assert.equal(features.useFeatureStatus.getState().hydration, "error");
    await assert.rejects(features.pluginPersistence.flush(), /disk full/);
    await manager.usePluginSettings.persist.rehydrate();
    assert.equal(features.useFeatureStatus.getState().hydration, "ready");
    await features.saveFeatures(manager.usePluginSettings, { optional: true });
    assert.equal(JSON.parse(files.get("plugins/settings.json")).state.settings.optional.enabled, true);
    await features.flushBeforeReload();
});

pinned("reload checks queued saves and tracked persistence before finishing", async () => {
    const gate = deferred();
    const io = { fileExists: async () => false, readFile: async () => "", writeFile: async () => gate.promise };
    const { features, runtime } = managerFixture(io);
    features.pluginPersistence.setItem("plugin-settings", "value");
    const flush = features.flushBeforeReload();
    await tick();
    features.useFeatureStatus.setState({ saving: true });
    gate.resolve();
    await assert.rejects(flush, /still saving/);
    features.useFeatureStatus.setState({ saving: false });
    runtime.useKorgRuntime.setState({ pendingOperations: 1 });
    await assert.rejects(features.flushBeforeReload(), /finish saving/);
    runtime.useKorgRuntime.setState({ pendingOperations: 0 });
    await features.flushBeforeReload();
});

pinned("optional startup requires both persisted stores ready; retry waits for reload", async () => {
    let starts = 0;
    let eager = 0;
    const io = { fileExists: async () => false, readFile: async () => "", writeFile: async () => {} };
    const { manager, features, runtime } = managerFixture(io);
    await manager.usePluginSettings.persist.rehydrate();
    manager.pluginInstances.set("optional", {
        start: async () => { starts++; }, eagerStart: async () => { eager++; },
    });
    manager.usePluginSettings.getState().updatePluginSetting("optional", true);
    await features.pluginPersistence.flush();
    runtime.useKorgRuntime.setState({ settings: "ready" });
    features.useFeatureStatus.setState({ hydration: "loading" });
    await manager.initPlugins();
    assert.equal(starts, 0);
    features.useFeatureStatus.setState({ hydration: "ready" });
    runtime.useKorgRuntime.setState({ settings: "loading" });
    await manager.initEagerPlugins();
    assert.equal(eager, 0);
    runtime.useKorgRuntime.setState({ settings: "ready" });
    // Nothing resumes on hydration; a new boot is needed to apply saved choices.
    assert.equal(starts, 0);
    assert.equal(eager, 0);
});

pinned("queued feature save blocks reload until its write settles", async () => {
    const gate = deferred();
    let block = false;
    const io = {
        fileExists: async () => false, readFile: async () => "",
        writeFile: async () => { if (block) await gate.promise; },
    };
    const { manager, features, runtime } = managerFixture(io);
    await manager.usePluginSettings.persist.rehydrate();
    runtime.useKorgRuntime.setState({ settings: "ready" });
    block = true;
    const save = features.saveFeatures(manager.usePluginSettings, { optional: true });
    assert.equal(features.useFeatureStatus.getState().saving, true);
    await assert.rejects(features.flushBeforeReload(), /finish saving/);
    gate.resolve();
    await save;
    assert.equal(features.useFeatureStatus.getState().saving, false);
    await features.flushBeforeReload();
});
