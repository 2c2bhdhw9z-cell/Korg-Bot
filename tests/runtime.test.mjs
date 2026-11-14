import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modules = ["core", "metro", "patcher", "storage", "compat"];
async function runtime(host = {}, selected = modules) {
    const context = vm.createContext({ console, ...host });
    for (const name of selected) {
        const source = await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8");
        vm.runInContext(source, context, { filename: `${name}.js` });
    }
    return { context, K: context.__KORG_INTERNAL__ };
}

test("Metro hooks preserve host functions and indexes initialized modules only", async () => {
    const initialized = { publicModule: { exports: { answer: 42 } }, isInitialized: true };
    const pending = { publicModule: { exports: { hidden: true } }, isInitialized: false };
    const modules = new Map([[1, initialized], [2, pending]]);
    function hostRequire() { return undefined; }
    hostRequire.getModules = () => modules;
    function define(factory) {
        const module = { exports: {} };
        factory(context, hostRequire, value => value, value => value, module, module.exports, []);
        modules.set(3, { publicModule: { exports: module.exports }, isInitialized: true });
    }
    const { K, context } = await runtime({ __r: hostRequire, __d: define });
    assert.equal(K.metro.findByProps("answer").answer, 42);
    assert.equal(K.metro.findByProps("hidden"), undefined);
    assert.equal(context.__r(), undefined);
    context.__d((global, require, importDefault, importAll, module, exports) => { exports.created = true; module.exports = exports; }, 3);
    assert.equal(K.metro.findByProps("created").created, true);
    assert.equal(K.metro.findByName("Named"), undefined);
});

test("Metro wrappers are stable and completed factory exports notify without reentrant loops", async () => {
    const modules = new Map();
    function hostRequire() { return undefined; }
    hostRequire.getModules = () => modules;
    function define(factory) {
        const module = { exports: {} };
        factory(context, hostRequire, value => value, value => value, module, module.exports, []);
        modules.set(modules.size, { publicModule: { exports: module.exports }, isInitialized: true });
    }
    const { K, context } = await runtime({ __r: hostRequire, __d: define });
    const requireWrapper = context.__r;
    const defineWrapper = context.__d;
    assert.equal(context.__r, requireWrapper);
    assert.equal(context.__d, defineWrapper);
    const seen = [];
    let unsub;
    unsub = K.metro.subscribe(value => {
        seen.push(value);
        K.metro.getAll();
    });
    context.__d((global, require, importDefault, importAll, module) => { module.exports = { ready: true }; }, 1);
    unsub();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ready, true);
    assert.equal(K.metro.findByProps("ready").ready, true);
});

test("Metro safely indexes exports with throwing getters without changing host behavior", async () => {
    const exports = { visible: true };
    Object.defineProperty(exports, "default", { enumerable: true, get() { throw new Error("default getter ran"); } });
    Object.defineProperty(exports, "danger", { enumerable: true, get() { throw new Error("property getter ran"); } });
    const modules = new Map([[1, { publicModule: { exports }, isInitialized: true }]]);
    function hostRequire() { return undefined; }
    hostRequire.getModules = () => modules;
    const { K, context } = await runtime({ __r: hostRequire });
    assert.equal(K.metro.findByProps("visible"), exports);
    assert.throws(() => context.__r.getModules().get(1).publicModule.exports.default, /default getter ran/);
    assert.equal(K.metro.lastError, undefined);
    const output = { unchanged: true };
    function define(factory) { factory(null, null, null, null, { exports: output }, output, []); }
    const { K: failingK, context: failingContext } = await runtime({ __d: define });
    const unsubscribe = failingK.metro.subscribe(() => { throw new Error("listener failure"); });
    assert.doesNotThrow(() => failingContext.__d(() => {}));
    unsubscribe();
    assert.throws(() => failingContext.__d(() => { throw new Error("factory failure"); }), /factory failure/);
});

test("Metro supports function and store name lookup with guarded store failures", async () => {
    function Component() {}
    Component.displayName = "Visible";
    const store = { getName: () => "Messages" };
    const broken = { getName() { throw new Error("not ready"); } };
    const exports = [{ default: Component }, broken, store];
    const records = new Map(exports.map((value, id) => [id, { publicModule: { exports: value }, isInitialized: true }]));
    function require() {}
    require.getModules = () => records;
    const { K } = await runtime({ __r: require });
    assert.equal(K.metro.findByName("Visible"), Component);
    assert.equal(K.metro.findByStoreName("Messages"), store);
    assert.equal(K.metro.findByStoreName("Missing"), undefined);
    assert.throws(() => K.metro.common.React, /unavailable/);
});

test("patch scopes preserve receiver, callback contracts, nesting and out-of-order removal", async () => {
    const { K } = await runtime();
    const target = { value: 2, run(amount) { return this.value + amount; } };
    const first = K.patcher.createScope("first");
    const second = K.patcher.createScope("second");
    first.before("run", target, args => [args[0] * 2]);
    second.after("run", target, (args, result, receiver) => result + receiver.value);
    assert.equal(target.run(3), 10);
    first.unpatchAll();
    assert.equal(target.run(3), 7);
    second.unpatchAll();
    assert.equal(target.run(3), 5);
    const instead = K.patcher.createScope("replace");
    instead.instead("run", target, (args, original, receiver) => original(args[0] + 4) + receiver.value);
    assert.equal(target.run(1), 9);
    instead.unpatchAll();
    assert.equal(target.run(1), 3);
});

test("storage scopes isolate keys and persist nested updates, array writes and deletions", async () => {
    const data = new Map();
    const backend = {
        async getItem(key) { return data.has(key) ? data.get(key) : null; },
        async setItem(key, value) { data.set(key, value); },
        async removeItem(key) { data.delete(key); },
        async getAllKeys() { return [...data.keys()]; },
    };
    const { K } = await runtime();
    K.storage.setBackend(backend);
    const one = K.storage.createScope("one");
    const two = K.storage.createScope("two");
    const prefs = await one.createStorage("prefs");
    prefs.deep = { count: 1 };
    prefs.list = ["a"];
    await one.flush();
    prefs.deep.count = 2;
    prefs.list.push("b");
    delete prefs.deep.count;
    await one.flush();
    const stored = JSON.parse(data.get("korg:one:prefs"));
    assert.deepEqual(JSON.parse(JSON.stringify(stored)), { deep: {}, list: ["a", "b"] });
    assert.equal(data.has("korg:two:prefs"), false);
    assert.deepEqual(await one.AsyncStorage.getAllKeys(), ["prefs"]);
    await two.AsyncStorage.setItem("prefs", "{}");
    assert.equal(data.has("korg:two:prefs"), true);
});

test("storage exposes backend read/write failures and unavailable status honestly", async () => {
    const { K } = await runtime();
    assert.equal(K.storage.status, "unavailable");
    const offline = K.storage.createScope("offline");
    await assert.rejects(offline.createStorage("prefs"), /storage unavailable/);
    const failed = {
        async getItem() { return null; },
        async setItem() { throw new Error("write failed"); },
        async removeItem() {},
    };
    K.storage.setBackend(failed);
    const readFailure = {
        async getItem() { throw new Error("read failed"); },
        async setItem() {},
        async removeItem() {},
    };
    K.storage.setBackend(readFailure);
    await assert.rejects(K.storage.createScope("bad").createStorage("prefs"), /read failed/);
    K.storage.setBackend(failed);
    const storage = K.storage.createScope("bad-write");
    const value = await storage.createStorage("prefs");
    value.changed = true;
    await assert.rejects(storage.flush(), /write failed/);
});

test("compatibility instances share globals but isolate plugin patcher and storage scopes", async () => {
    const { K, context } = await runtime();
    const a = K.createCompatibility("plugin-a");
    const b = K.createCompatibility("plugin-b");
    assert.equal(context.vendetta, context.bunny);
    assert.equal(context.vendetta, K.createCompatibility("legacy-global"));
    assert.notEqual(a.patcher, b.patcher);
    assert.equal(a.storage.AsyncStorage, a.storage.AsyncStorage);
    assert.equal(a.plugin.id, "plugin-a");
    assert.equal(b.plugin.id, "plugin-b");
    assert.equal(typeof a.metro.findByProps, "function");
    assert.equal(typeof a.logger.error, "function");
    assert.equal(typeof a.logger.log, "function");
    assert.equal(typeof a.metro.filters.byProps("View"), "function");
});

test("compatibility UI primitives resolve lazily from host React Native exports", async () => {
    function hostRequire() { return undefined; }
    hostRequire.getModules = () => new Map();
    function define(factory) {
        const module = { exports: {} };
        factory(context, hostRequire, value => value, value => value, module, module.exports, []);
    }
    const { K, context } = await runtime({ __r: hostRequire, __d: define });
    const api = K.createCompatibility("ui-plugin");
    assert.equal(api.ui.components.View, undefined);
    const native = { View() {}, Text() {}, Switch() {}, Pressable() {}, TextInput() {}, ScrollView() {}, AppRegistry: {} };
    K.metro.subscribe(() => {});
    // Capture a module through the host loader and verify the original exports remain usable.
    context.__d((global, require, importDefault, importAll, module) => { module.exports = native; }, 1);
    assert.equal(api.ReactNative.View, native.View);
    assert.equal(api.ui.components.TextInput, native.TextInput);
});

function memoryBackend(data = new Map()) {
    return { data, async getItem(key) { return data.get(key) ?? null; }, async setItem(key, value) { data.set(key, value); }, async removeItem(key) { data.delete(key); }, async getAllKeys() { return [...data.keys()]; } };
}
const plain = value => JSON.parse(JSON.stringify(value));
const diskKey = (id, name) => `korg:${encodeURIComponent(id)}:${encodeURIComponent(name)}`;

test("canonical hydration shares promises, retries reads, clones defaults, and restores from disk", async () => {
    const { K } = await runtime();
    const backend = memoryBackend();
    let reads = 0;
    let fail = true;
    backend.getItem = async key => { reads++; if (fail) throw Error("read failed"); return backend.data.get(key) ?? null; };
    K.storage.setBackend(backend);
    const scope = K.storage.createScope("stable");
    assert.equal(scope, K.storage.createScope("stable"));
    const defaults = { nested: { count: 1 }, list: [] };
    const first = scope.createStorage("prefs", { defaults });
    assert.equal(first, scope.createStorage("prefs"));
    await assert.rejects(first, /read failed/);
    fail = false;
    const retried = scope.createStorage("prefs", { defaults });
    assert.notEqual(first, retried);
    const value = await retried;
    assert.equal(scope.createStorage("prefs"), retried);
    assert.equal(reads, 2);
    assert.equal(value.then, undefined);
    assert.equal(Object.getOwnPropertyDescriptor(value, "flush").enumerable, false);
    defaults.nested.count = 100;
    assert.equal(value.nested.count, 1);
    Object.defineProperty(value.nested, "count", { value: 2, configurable: true, writable: true, enumerable: true });
    Object.defineProperty(value, "defined", { value: { deep: 1 }, enumerable: true, configurable: true });
    value.defined.deep = 3;
    value.list.push({ count: 1 });
    value.list[0].count = 2;
    value.list.splice(0, 0, "first");
    delete value.nested.count;
    await value.flush();
    const expected = { nested: {}, list: ["first", { count: 2 }], defined: { deep: 3 } };
    assert.deepEqual(JSON.parse(backend.data.get(diskKey("stable", "prefs"))), expected);
    assert.deepEqual(plain(defaults), { nested: { count: 100 }, list: [] });
    const secondRuntime = await runtime();
    secondRuntime.K.storage.setBackend(backend);
    assert.deepEqual(plain(await secondRuntime.K.storage.createScope("stable").createStorage("prefs")), expected);
    const globalValue = await K.storage.createStorage("global", { defaults: { ok: true } });
    globalValue.ok = false;
    await K.storage.flushAll();
    assert.equal(JSON.parse(backend.data.get(diskKey("runtime", "global"))).ok, false);
});

test("storage captures ordered snapshots, rejects circular changes, and retries writes after errors", async () => {
    const { K } = await runtime();
    const backend = memoryBackend();
    const writes = [];
    let release;
    let fail = false;
    backend.setItem = async (key, value) => {
        writes.push(JSON.parse(value));
        if (writes.length === 1) await new Promise(resolve => { release = resolve; });
        if (fail) throw Error("write failed");
        backend.data.set(key, value);
    };
    K.storage.setBackend(backend);
    const scope = K.storage.createScope("ordered");
    const value = await scope.createStorage("prefs", { defaults: { nested: { count: 0 }, list: [] } });
    value.nested.count = 1;
    value.nested.count = 2;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(writes.length, 1);
    const reading = scope.AsyncStorage.getItem("prefs");
    release();
    assert.equal(JSON.parse(await reading).nested.count, 2);
    assert.deepEqual(writes.map(item => item.nested.count), [1, 2]);
    assert.throws(() => { value.self = value; }, /Circular/);
    assert.equal("self" in value, false);
    assert.throws(() => value.nested.self = value, /Circular/);
    assert.equal("self" in value.nested, false);
    assert.throws(() => value.list.push(value), /Circular/);
    assert.equal(value.list.length, 0);
    const circular = {}; circular.self = circular;
    assert.throws(() => { value.external = circular; }, /Circular/);
    assert.throws(() => Object.defineProperty(value, "getter", { enumerable: true, configurable: true, get: () => 1 }), /data properties/);
    fail = true;
    value.nested.count = 3;
    await assert.rejects(scope.flush(), /write failed/);
    assert.equal(JSON.parse(await scope.AsyncStorage.getItem("prefs")).nested.count, 2);
    await assert.rejects(scope.flush(), /write failed/);
    fail = false;
    value.nested.count = 4;
    await scope.flush();
    assert.equal(JSON.parse(await scope.AsyncStorage.getItem("prefs")).nested.count, 4);
});

test("backend adapters keep snapshots isolated and never replace or escape host namespaces", async () => {
    const { K } = await runtime();
    const host = memoryBackend();
    const supplied = memoryBackend();
    K.storage.setBackend(host);
    const a = K.storage.createScope("a:/% ");
    const b = K.storage.createScope("b");
    const keyed = await a.createStorage(supplied, { key: "../b:%2F", defaults: { nested: { count: 0 } } });
    keyed.nested.count = 1;
    await a.flush();
    assert.deepEqual([...supplied.data.keys()], [diskKey("a:/% ", "../b:%2F")]);
    await b.AsyncStorage.setItem("settings", "host only");
    assert.equal(host.data.get(diskKey("b", "settings")), "host only");
    assert.equal(supplied.data.has(diskKey("b", "settings")), false);
    for (const names of [["get", "set"], ["read", "write"]]) {
        const original = { nested: { count: 0 } };
        const snapshots = [];
        const backend = {
            [names[0]]: async (...args) => { assert.equal(args.length, 0); return original; },
            [names[1]]: async snapshot => { snapshots.push(snapshot); snapshot.fromBackend = true; },
        };
        const pending = a.createStorage(backend);
        assert.equal(a.createStorage(backend), pending);
        const value = await pending;
        value.nested.count = 1;
        value.nested.count = 2;
        await a.flush();
        assert.deepEqual(snapshots.map(item => item.nested.count), [1, 2]);
        assert.equal(original.nested.count, 0);
        assert.equal(value.fromBackend, undefined);
        const other = await b.createStorage(backend);
        assert.notEqual(other, value);
    }
    const unavailable = (await runtime()).K;
    await unavailable.storage.createScope("custom").createStorage({ read: async () => ({}), write: async () => {} });
    assert.equal(unavailable.storage.status, "unavailable");
    await assert.rejects(unavailable.storage.createStorage("no-host"), /storage unavailable/);
    await assert.rejects(a.createStorage({}), /must implement/);
});

test("AsyncStorage encodes names exactly once and batches remain scoped and ordered", async () => {
    const { K } = await runtime();
    const backend = memoryBackend();
    K.storage.setBackend(backend);
    const a = K.storage.createScope("owner:%2F");
    const b = K.storage.createScope("owner:/");
    const names = ["100%", "%2F", "a/b:c", "雪", ""];
    const pending = a.AsyncStorage.multiSet(names.map(name => [name, `value:${name}`]));
    const values = await a.AsyncStorage.multiGet(names);
    await pending;
    assert.deepEqual(plain(values), names.map(name => [name, `value:${name}`]));
    assert.deepEqual(plain(await a.AsyncStorage.getAllKeys()), names);
    assert.deepEqual([...backend.data.keys()], names.map(name => diskKey("owner:%2F", name)));
    await b.AsyncStorage.setItem("100%", "other");
    await a.AsyncStorage.multiRemove(names.slice(0, 2));
    await a.AsyncStorage.clear();
    assert.deepEqual(plain(await a.AsyncStorage.getAllKeys()), []);
    assert.equal(await b.AsyncStorage.getItem("100%"), "other");
    await a.AsyncStorage.removeItem("absent");
    await a.flush();
});

const fullModules = [...modules, "themes", "plugins", "ui", "start"];
function hostFixture() {
    const records = new Map();
    const registrations = new Map();
    const effects = [];
    let renders = 0;
    const React = {
        createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
        useState: () => [0, () => { renders++; }],
        useEffect(callback) { const cleanup = callback(); if (cleanup) effects.push(cleanup); },
    };
    const Native = Object.fromEntries(["View", "Text", "Switch", "Modal", "SafeAreaView", "ScrollView", "TextInput", "Pressable"].map(name => [name, ({ native: name })]));
    const appProviders = new Map();
    Native.AppRegistry = {
        registerComponent(name, provider) { registrations.set(name, provider); appProviders.set(name, provider); return name; },
        runApplication(name, props) { const Root = appProviders.get(name)(); return React.createElement(Root, props); },
    };
    function require(id) { return records.get(id)?.publicModule.exports; }
    require.getModules = () => records;
    function define(factory, id) {
        const module = { exports: {} };
        factory(null, require, value => value, value => value, module, module.exports, []);
        records.set(id, { publicModule: module, isInitialized: true });
    }
    function publish(context, id, exports) { context.__d((_global, _require, _default, _all, module) => { module.exports = exports; }, id); }
    return { React, Native, records, registrations, effects, get renders() { return renders; }, require, define, publish };
}

test("full runtime loads a real URL plugin, uses its persisted settings, patches, themes, and late UI capture", async () => {
    const host = hostFixture();
    const disk = memoryBackend();
    const pluginSource = `module.exports = {
        onLoad: async function () {
            const api = require('@vendetta/plugin');
            const patcher = require('@vendetta/patcher');
            const metro = require('@vendetta/metro');
            api.storage.deep = { count: 1 };
            api.storage.deep.count = 2;
            this.unpatch = patcher.after('run', metro.findByProps('run'), function (args, result) { return result + 10; });
        },
        onUnload: async function () { this.unpatch(); }
    };`;
    const fetches = [];
    const fetcher = async url => {
        fetches.push(url);
        return { ok: true, status: 200, url, headers: { get: () => String(pluginSource.length) }, text: async () => pluginSource };
    };
    const { K, context } = await runtime({
        __r: host.require, __d: host.define,
        fetch: fetcher, URL, AbortController, TextEncoder, setTimeout, clearTimeout,
        window: {},
    }, modules);
    K.storage.setBackend(disk);
    for (const name of ["themes", "plugins", "ui", "start"]) {
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), context);
    }
    const original = { run(value) { return value * 2; } };
    host.publish(context, 1, original);
    host.publish(context, 2, { createElement: host.React.createElement, useState: host.React.useState, useEffect: host.React.useEffect });
    assert.equal(context.window.vendetta, context.window.bunny);
    assert.equal(typeof context.window.vendetta.storage.createStorage, "function");
    host.publish(context, 3, { ...host.Native, AppRegistry: host.Native.AppRegistry });
    const rootRegistration = host.Native.AppRegistry.registerComponent("Root", () => function Root() {});
    assert.equal(rootRegistration, "Root");
    const overlayElement = host.Native.AppRegistry.runApplication("Root", {});
    assert.equal(overlayElement.type.name, "KorgOverlay");
    const renderedRoot = overlayElement.type(overlayElement.props);
    assert.equal(renderedRoot.type.name, "Overlay");
    assert.equal(K.ui.status().rootWrapped, true);
    assert.equal(renderedRoot.type(renderedRoot.props).type, host.Native.View);
    assert.equal(context.window.vendetta.ui.components.View, host.Native.View);
    assert.equal(host.registrations.size, 1);
    K.ui.openSettings();
    host.Native.AppRegistry.runApplication("Root", {});
    assert.ok(host.renders > 0);
    const installed = await K.plugins.install("https://plugins.test/real.js", { kind: "bundle" });
    assert.equal(installed.enabled, false);
    await K.plugins.setEnabled(installed.id, true);
    assert.equal(original.run(3), 16);
    const api = K.compatibility.get(installed.id);
    const savedSettings = api.plugin.storage;
    assert.deepEqual(plain(savedSettings.deep), { count: 2 });
    assert.deepEqual(JSON.parse(disk.data.get(diskKey(installed.id, "settings"))), { deep: { count: 2 } });
    await K.themes.select("paper");
    assert.equal(K.themes.current(), "paper");
    assert.equal(disk.data.get(diskKey("korg.runtime.appearance", "selected")), "paper");
    assert.ok(host.renders > 0);
    await K.plugins.setEnabled(installed.id, false);
    assert.equal(original.run(3), 6);
    assert.equal(K.plugins.isActive(installed.id), false);
    await K.storage.flushAll();
    assert.deepEqual(fetches, ["https://plugins.test/real.js"]);
    const reload = await runtime({ fetch: async () => { throw Error("must load cached source"); }, URL, AbortController, TextEncoder, setTimeout, clearTimeout }, [...modules, "themes", "plugins"]);
    reload.K.storage.setBackend(disk);
    await reload.K.plugins.initialize();
    assert.equal(reload.K.plugins.list()[0].enabled, false);
});

test("runtime boot captures AppRegistry before registration and UI survives late React Native capture", async () => {
    const host = hostFixture();
    const { K, context } = await runtime({ __r: host.require, __d: host.define }, modules);
    for (const name of ["themes", "plugins", "ui", "start"]) {
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), context);
    }
    K.ui.initialize();
    assert.equal(K.runtime.ready, false);
    host.publish(context, 1, { ...host.Native, AppRegistry: host.Native.AppRegistry });
    host.publish(context, 2, { createElement: host.React.createElement, useState: host.React.useState, useEffect: host.React.useEffect });
    assert.equal(K.ui.initialize().attached, true);
    assert.equal(host.Native.AppRegistry.registerComponent("LateRoot", () => function Root() {}), "LateRoot");
    assert.ok(host.registrations.has("LateRoot"));
    await K.runtime.boot;
    assert.equal(K.runtime.ready, true);
});

test("release require captures returned exports without getModules and repairs replaced hooks", async () => {
    const exports = { releaseOnly: true };
    let getterCalls = 0;
    Object.defineProperty(exports, "danger", { get() { getterCalls++; throw Error("must stay lazy"); } });
    const { K, context } = await runtime({ __r: () => exports });
    const seen = [];
    K.metro.subscribe(value => seen.push(value));
    assert.equal(context.__r(), exports);
    assert.equal(K.metro.findByProps("releaseOnly"), exports);
    assert.equal(seen[0], exports);
    assert.equal(getterCalls, 0);
    vm.runInContext('Object.defineProperty(globalThis, "__r", { configurable: true, writable: true, value: () => ({ replaced: true }) })', context);
    assert.equal(K.metro.status().hooks.__r, false);
    K.metro.install();
    assert.equal(context.__r().replaced, true);
    assert.equal(K.metro.findByProps("replaced").replaced, true);
    assert.equal(K.metro.status().hooks.__r, true);
    assert.ok(K.reportStatus().metro.moduleCount > 0);
    assert.equal(context.__KORG_DIAGNOSTICS__.metro.hooks.__r, true);
});
