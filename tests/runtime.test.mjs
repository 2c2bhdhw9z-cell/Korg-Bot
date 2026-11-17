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
    class Component { constructor(props) { this.props = props; } }
    const React = {
        Component,
        // Like React's: children passed in `props` are kept unless children are given as arguments.
        createElement(type, props, ...children) { return { type, props: { ...props, ...(children.length ? { children: children.length > 1 ? children : children[0] } : {}) } }; },
        useState: () => [0, () => { renders++; }],
        useEffect(callback) { const cleanup = callback(); if (cleanup) effects.push(cleanup); },
    };
    const Native = Object.fromEntries(["View", "Text", "Switch", "Modal", "SafeAreaView", "ScrollView", "TextInput", "Pressable"].map(name => [name, ({ native: name })]));
    // AppRegistry as React Native 0.86 ships it: a namespace of functions that read the wrapper provider whenever an
    // app starts, so a wrapper installed after registerComponent still applies.
    let wrapperProvider;
    const appProviders = new Map();
    const AppRegistry = {
        registerComponent(name, provider) { registrations.set(name, provider); appProviders.set(name, provider); return name; },
        getAppKeys() { return [...appProviders.keys()]; },
        setWrapperComponentProvider(provider) { wrapperProvider = provider; },
        runApplication(name, params) {
            const Root = appProviders.get(name)();
            const Wrapper = wrapperProvider && wrapperProvider(params);
            const root = React.createElement(Root, params);
            return Wrapper ? React.createElement(Wrapper, params, root) : root;
        },
    };
    // react-native's index: every export is a lazy getter, and none may be read until it is needed.
    const reactNative = {};
    for (const [name, value] of Object.entries({ ...Native, AppRegistry })) Object.defineProperty(reactNative, name, { enumerable: true, get: () => value });
    function require(id) { return records.get(id)?.publicModule.exports; }
    require.getModules = () => records;
    function define(factory, id) {
        const module = { exports: {} };
        factory(null, require, value => value, value => value, module, module.exports, []);
        records.set(id, { publicModule: module, isInitialized: true });
    }
    function publish(context, id, exports) { context.__d((_global, _require, _default, _all, module) => { module.exports = exports; }, id); }
    // The ids Discord's modules would have: React, react-native's index, and the AppRegistry namespace.
    const publishAll = context => { publish(context, 2, React); publish(context, 3, reactNative); publish(context, 4, AppRegistry); };
    return { React, Native, AppRegistry, reactNative, records, registrations, effects, get renders() { return renders; }, require, define, publish, publishAll };
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
    assert.equal(context.window.vendetta, context.window.bunny);
    assert.equal(typeof context.window.vendetta.storage.createStorage, "function");
    assert.equal(K.ui.status().attached, false);
    host.publishAll(context);
    assert.equal(K.ui.status().attached, true);
    assert.equal(K.ui.status().registry, "module");
    // The app registers and starts after Korg attached; Korg's wrapper is what React renders around it.
    assert.equal(host.AppRegistry.registerComponent("Root", () => function Root() {}), "Root");
    const wrapped = host.AppRegistry.runApplication("Root", {});
    assert.equal(wrapped.type.name, "KorgWrapper");
    assert.equal(wrapped.props.children.type.name, "Root");
    assert.equal(K.ui.status().rootWrapped, true);
    const wrapper = wrapped.type(wrapped.props);
    assert.equal(wrapper.type, host.Native.View);
    assert.equal(wrapper.props.children[0].type.name, "Root", "the Discord root stays outside Korg's protected subtree");
    const boundary = wrapper.props.children[1];
    assert.equal(boundary.type.name, "KorgBoundary", "the whole Korg UI has an error boundary");
    const overlay = boundary.props.children;
    assert.equal(overlay.type.name, "Overlay");
    const rendered = overlay.type(overlay.props);
    assert.equal(rendered.type, host.Native.View);
    assert.equal(K.ui.status().phase, "rendered");
    assert.equal(K.ui.status().mounted, true);
    assert.equal(context.window.vendetta.ui.components.View, host.Native.View);
    assert.equal(host.registrations.size, 1);
    K.ui.openSettings();
    host.AppRegistry.runApplication("Root", {});
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

test("the wrapper works whichever host module loads first, and for an app registered before Korg attached", async () => {
    for (const order of [[2, 3, 4], [4, 3, 2], [3, 4, 2]]) {
        const host = hostFixture();
        const { K, context } = await runtime({ __r: host.require, __d: host.define }, modules);
        for (const name of ["themes", "plugins", "ui", "start"]) {
            vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), context);
        }
        K.ui.initialize();
        assert.equal(K.runtime.ready, false);
        // Discord registers its root early; the registry is captured only afterwards.
        host.AppRegistry.registerComponent("Discord", () => function Discord() {});
        const parts = { 2: host.React, 3: host.reactNative, 4: host.AppRegistry };
        for (const id of order) host.publish(context, id, parts[id]);
        assert.equal(K.ui.status().attached, true, `attached after publishing in order ${order}`);
        assert.deepEqual(plain(K.ui.status().registered), ["Discord"], "an app registered earlier is listed");
        const wrapped = host.AppRegistry.runApplication("Discord", {});
        assert.equal(wrapped.type.name, "KorgWrapper", "the wrapper applies to the app registered before attaching");
        assert.deepEqual(plain(K.ui.status().ran), ["Discord"]);
        await K.runtime.boot;
        assert.equal(K.runtime.ready, true);
    }
});

test("Korg adds a row and a section to Discord's data-driven settings, and its row opens Korg's settings", async () => {
    const host = hostFixture();
    const { K, context } = await runtime({ __r: host.require, __d: host.define }, modules);
    for (const name of ["themes", "plugins", "ui", "start"]) {
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), context);
    }
    // Discord's settings modules initialize after Korg is watching, as they do on a device.
    const accountRow = { type: "pressable", title: () => "Account" };
    const settingsModule = { SETTING_RENDERER_CONFIG: { ACCOUNT: accountRow } };
    const listModule = { createList(config) { return config.sections.length; } };
    host.publish(context, 10, settingsModule);
    host.publish(context, 11, listModule);
    const config = settingsModule.SETTING_RENDERER_CONFIG;
    assert.equal(K.ui.status().settings.row, true, "the Korg row was registered");
    assert.equal(config.ACCOUNT, accountRow, "Discord's own rows are unchanged");
    assert.equal(config.KORG_SETTINGS.type, "pressable");
    assert.equal(config.KORG_SETTINGS.title(), "Korg");
    assert.equal(config.KORG_SETTINGS.withArrow, true);
    // The root settings list is the one that names Discord's ACCOUNT row.
    const sections = [
        { label: "Account", title: "Account", settings: ["ACCOUNT"] },
        { label: "Privacy", title: "Privacy", settings: ["PRIVACY"] },
    ];
    listModule.createList({ sections });
    assert.deepEqual(plain(sections.map(section => section.label)), ["Account", "Korg", "Privacy"], "the Korg section follows Account");
    assert.deepEqual(plain(sections[1].settings), ["KORG_SETTINGS"]);
    assert.equal(K.ui.status().settings.section, true);
    // Rebuilding the list must not add a second Korg section, and lists without ACCOUNT are left alone.
    listModule.createList({ sections });
    assert.equal(sections.filter(section => section.label === "Korg").length, 1);
    const pluginPage = [{ label: "Plugin", title: "Plugin", settings: ["SOMETHING_ELSE"] }];
    listModule.createList({ sections: pluginPage });
    assert.equal(pluginPage.length, 1, "a non-root settings list is not modified");
    // Pressing Discord's Korg row opens Korg's own settings sheet.
    host.publishAll(context);
    host.AppRegistry.registerComponent("Root", () => function Root() {});
    const wrapped = host.AppRegistry.runApplication("Root", {});
    const overlay = wrapped.type(wrapped.props).props.children[1].props.children;
    const rendered = overlay.type(overlay.props);
    const sheet = rendered.props.children[1];
    assert.equal(sheet.type(sheet.props).props.visible, false, "the settings sheet starts closed");
    config.KORG_SETTINGS.onPress();
    assert.equal(sheet.type(sheet.props).props.visible, true, "Discord's Korg row opens Korg settings");
    assert.match(K.ui.status().settings.note, /row/);
});

test("attaching costs nothing per module, and the registry global is captured when it is assigned", async () => {
    const host = hostFixture();
    const { K, context } = await runtime({ __r: host.require, __d: host.define }, modules);
    let enumerations = 0;
    const getAll = K.metro.getAll;
    K.metro.getAll = (...args) => { enumerations += 1; return getAll.apply(K.metro, args); };
    for (const name of ["themes", "plugins", "ui", "start"]) {
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), context);
    }
    const afterStart = enumerations;
    for (let id = 100; id < 3100; id++) host.publish(context, id, { id, helper() {} });
    assert.equal(enumerations, afterStart, "3,000 unrelated modules must not trigger a single module search");
    assert.equal(K.ui.status().attached, false);
    // React Native's AppRegistry module stores itself in a global; the assignment alone is enough to attach.
    context.RN$AppRegistry = host.AppRegistry;
    assert.equal(K.ui.status().attached, true);
    assert.equal(K.ui.status().registry, "RN$AppRegistry");
    const descriptor = Object.getOwnPropertyDescriptor(context, "RN$AppRegistry");
    assert.ok("value" in descriptor && descriptor.value === host.AppRegistry && descriptor.writable, "the global is an ordinary property again, as the native side expects");
    // A registry that already exists when Korg starts is found too.
    const early = hostFixture();
    const second = await runtime({ __r: early.require, __d: early.define, RN$AppRegistry: early.AppRegistry }, modules);
    for (const name of ["themes", "plugins", "ui", "start"]) {
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), second.context);
    }
    assert.equal(second.K.ui.status().registry, "RN$AppRegistry");
});

test("the heartbeat finds what module capture could not, and stops once the overlay is mounted", async () => {
    const host = hostFixture();
    const timers = [];
    const { K, context } = await runtime({ __r: host.require, __d: host.define, setTimeout: callback => { timers.push(callback); return timers.length; } }, modules);
    for (const name of ["themes", "plugins", "ui", "start"]) {
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), context);
    }
    assert.equal(timers.length, 1, "one heartbeat is scheduled at start");
    // React and react-native load, but the registry is only reachable through react-native's lazy AppRegistry export.
    host.publish(context, 2, host.React);
    host.publish(context, 3, host.reactNative);
    assert.equal(K.ui.status().attached, false, "capturing a lazy getter must not read it");
    timers.shift()();
    assert.equal(K.ui.status().attached, true, "the heartbeat read the export from a safe place");
    assert.equal(K.ui.status().registry, "react-native export");
    assert.equal(timers.length, 1, "the heartbeat keeps going until the overlay is mounted");
    host.AppRegistry.registerComponent("Root", () => function Root() {});
    const wrapped = host.AppRegistry.runApplication("Root", {});
    const container = wrapped.type(wrapped.props);
    const guard = container.props.children[1];
    const overlay = guard.props.children;
    overlay.type(overlay.props);
    assert.equal(K.ui.status().mounted, true);
    timers.shift()();
    assert.equal(timers.length, 0, "no further heartbeat once the overlay is mounted");
});

test("a failure inside Korg's controls cannot take the app down, and is reported", async () => {
    const host = hostFixture();
    const { K, context } = await runtime({ __r: host.require, __d: host.define }, modules);
    for (const name of ["themes", "plugins", "ui", "start"]) {
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), context);
    }
    host.publishAll(context);
    host.AppRegistry.registerComponent("Root", () => function Root() {});
    const wrapped = host.AppRegistry.runApplication("Root", {});
    const container = wrapped.type(wrapped.props);
    const guard = container.props.children[1];
    assert.equal(typeof guard.type, "function", "the controls are inside an error boundary");
    assert.notEqual(container.props.children[0], guard, "the app is not inside the boundary");
    assert.deepEqual(plain(guard.type.getDerivedStateFromError(new Error("x"))), { failed: true });
    const instance = new guard.type(guard.props);
    assert.equal(instance.render(), guard.props.children, "healthy controls render");
    instance.state = { failed: true };
    assert.equal(instance.render(), null, "a failed overlay renders nothing");
    instance.componentDidCatch(new RangeError("overlay blew up"));
    assert.match(K.ui.status().overlayError, /overlay blew up/);
    assert.ok(K.errors.some(entry => entry.text.includes("Korg overlay render error") && entry.text.includes("overlay blew up")));
    // Without React the wrapper shows the app untouched instead of a blank screen.
    const bareHost = hostFixture();
    const bare = await runtime({ __r: bareHost.require, __d: bareHost.define }, modules);
    for (const name of ["themes", "plugins", "ui"]) vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), bare.context);
    bare.K.ui.initialize();
    bare.context.RN$AppRegistry = bareHost.AppRegistry;
    assert.equal(bare.K.ui.status().attached, true);
    bareHost.AppRegistry.registerComponent("Root", () => function Root() {});
    const bareWrapped = bareHost.AppRegistry.runApplication("Root", {});
    assert.equal(bare.K.ui.status().react, false);
    assert.equal(bareWrapped.type(bareWrapped.props), bareWrapped.props.children, "the app is returned untouched");
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

test("patches stop running after unpatch, restore inherited methods, and keep component statics", async () => {
    const { K } = await runtime({}, ["core", "patcher"]);
    const scope = K.patcher.createScope("regression");
    // A reference captured before unpatch() must not keep running the callback.
    const target = { greet() { return "original"; } };
    const unpatch = scope.after("greet", target, (_args, result) => `patched ${result}`);
    const captured = target.greet;
    assert.equal(captured(), "patched original");
    unpatch();
    assert.equal(captured(), "original");
    assert.equal(target.greet(), "original");
    // Unpatching an inherited method must not leave a shadowing own property behind.
    class Base { hello() { return "base"; } }
    const child = new Base();
    const undo = scope.after("hello", child, (_args, result) => `${result}!`);
    assert.equal(child.hello(), "base!");
    undo();
    assert.equal(Object.prototype.hasOwnProperty.call(child, "hello"), false);
    Base.prototype.hello = () => "changed";
    assert.equal(child.hello(), "changed");
    // Patched components keep displayName and statics so name lookups still find them.
    function Component() {}
    Component.displayName = "Patched";
    Component.extra = 7;
    const holder = { Component };
    scope.after("Component", holder, () => {});
    assert.equal(holder.Component.displayName, "Patched");
    assert.equal(holder.Component.extra, 7);
    // A property that cannot be redefined fails cleanly and does not break cleanup of other patches.
    const fixed = {};
    Object.defineProperty(fixed, "run", { value() { return 1; }, configurable: false, writable: false });
    const sound = { run() { return 2; } };
    scope.after("run", sound, (_args, result) => result + 1);
    assert.throws(() => scope.before("run", fixed, () => {}), error => error.name === "TypeError");
    assert.doesNotThrow(() => scope.unpatchAll());
    assert.equal(sound.run(), 2);
    assert.equal(fixed.run(), 1);
});

test("logging works before the host installs a console", async () => {
    const context = vm.createContext({});
    // V8 gives every context a built-in console; Hermes has none until the host sets one up.
    vm.runInContext("delete globalThis.console", context);
    assert.equal(typeof context.console, "undefined");
    vm.runInContext(await readFile(path.join(repoRoot, "runtime", "core.js"), "utf8"), context);
    const K = context.__KORG_INTERNAL__;
    assert.doesNotThrow(() => K.log.error("too early", new Error("no console yet")));
    const lines = [];
    context.console = { error: (...values) => lines.push(values), log: (...values) => lines.push(["log", ...values]) };
    K.log.error("later");
    K.makeLogger("scope").warn("falls back to log");
    assert.deepEqual(lines, [["[Korg:runtime]", "later"], ["log", "[Korg:scope]", "falls back to log"]]);
});

test("Metro announces each module once, so lookups do not replay every module to every listener", async () => {
    const modules = new Map();
    const add = id => modules.set(id, { isInitialized: true, publicModule: { exports: { [`prop${id}`]: id } } });
    for (let id = 0; id < 300; id++) add(id);
    function hostRequire() {}
    hostRequire.getModules = () => modules;
    const { K } = await runtime({ __r: hostRequire });
    const seen = [];
    // Like the UI listener, this performs its own lookup for every capture.
    K.metro.subscribe(value => { seen.push(value); K.metro.findByProps("createElement"); });
    assert.equal(seen.length, 300);
    for (let round = 0; round < 5; round++) K.metro.findByProps("missing");
    assert.equal(seen.length, 300);
    // A late subscriber hears about earlier modules exactly once; the first listener is not told again.
    const late = [];
    K.metro.subscribe(value => late.push(value));
    assert.equal(late.length, 300);
    assert.equal(seen.length, 300);
    add(1000);
    K.metro.getAll();
    assert.equal(seen.length, 301);
    assert.equal(late.length, 301);
});

test("the discovered AsyncStorage backend is cached after the first scan", async () => {
    let scans = 0;
    const store = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
    const modules = new Map([[1, { isInitialized: true, publicModule: { exports: store } }]]);
    function hostRequire() {}
    hostRequire.getModules = () => { scans++; return modules; };
    const { K } = await runtime({ __r: hostRequire });
    assert.equal(K.storage.status, "persistent");
    const afterDiscovery = scans;
    for (let round = 0; round < 5; round++) {
        assert.equal(await K.storage.AsyncStorage.getItem("key"), null);
        assert.equal(K.storage.status, "persistent");
    }
    assert.equal(scans, afterDiscovery);
    K.storage.setBackend(null);
    assert.equal(K.storage.status, "persistent");
    assert.ok(scans > afterDiscovery, "Clearing the injected backend must rediscover");
});

test("a module scanned while its factory is still running is announced again when it completes", async () => {
    const modules = new Map();
    function hostRequire() {}
    hostRequire.getModules = () => modules;
    function define(factory) {
        const module = { exports: {} };
        factory(context, hostRequire, value => value, value => value, module, module.exports, []);
    }
    const { K, context } = await runtime({ __r: hostRequire, __d: define });
    const seen = [];
    K.metro.subscribe(value => seen.push(value));
    let shared;
    context.__d((global, require, importDefault, importAll, module) => {
        shared = module.exports;
        // Metro marks a module initialized before its factory runs; a lookup made now sees partial exports.
        modules.set(1, { publicModule: { exports: shared }, isInitialized: true });
        K.metro.getAll();
        module.exports.late = true;
    }, 1);
    assert.equal(seen.filter(value => value === shared).length, 2, "once while partial, once on completion");
    K.metro.getAll();
    K.metro.findByProps("late");
    assert.equal(seen.filter(value => value === shared).length, 2, "later lookups must not announce it again");
});

test("a console that throws cannot break logging", async () => {
    const context = vm.createContext({ console: { error() { throw new Error("broken console"); }, log() { throw new Error("broken console"); } } });
    vm.runInContext(await readFile(path.join(repoRoot, "runtime", "core.js"), "utf8"), context);
    assert.doesNotThrow(() => context.__KORG_INTERNAL__.log.error("still fine"));
});

test("errors are recorded once, capped, and sent to the native reporter", async () => {
    const sent = [];
    const context = vm.createContext({ console: { error() {}, warn() {}, log() {} }, __KORG_NATIVE__: { report: text => sent.push(text) } });
    vm.runInContext(await readFile(path.join(repoRoot, "runtime", "core.js"), "utf8"), context);
    const K = context.__KORG_INTERNAL__;
    assert.equal(sent[0], "boot\nKorg 0.2.0: core loaded");
    K.reportError("loader", { name: "TypeError", message: "bad thing" });
    K.reportError("loader", { name: "TypeError", message: "bad thing" });
    assert.equal(K.errors.length, 1);
    assert.equal(K.errors[0].count, 2);
    assert.deepEqual(sent.slice(1), ["error\nloader: TypeError: bad thing"]);
    // Logger: warnings and errors are recorded with their scope, debug and info are not.
    const log = K.makeLogger("plugin");
    log.info("quiet"); log.debug("quiet");
    log.warn("careful", { message: "inner warning" });
    log.error("failed", { name: "RangeError", message: "inner error" });
    assert.deepEqual(Array.from(K.errors.slice(1), entry => entry.text), ["plugin warn: careful Error: inner warning", "plugin error: failed RangeError: inner error"]);
    // Twenty are kept, the oldest first to go; nothing here can throw.
    for (let index = 0; index < 30; index++) K.reportError("flood", `problem ${index}`);
    assert.equal(K.errors.length, 20);
    assert.equal(K.errors.at(-1).text, "flood: problem 29");
    assert.doesNotThrow(() => K.reportError("hostile", { get message() { throw new Error("getter"); }, stack: "stack" }));
    // The native reporter has a budget so a runaway error loop cannot flood the host.
    for (let index = 0; index < 500; index++) K.reportError("loop", `distinct ${index}`);
    assert.ok(sent.length <= 200, `sent ${sent.length}`);
});

test("a native reporter that throws cannot break the runtime", async () => {
    const context = vm.createContext({ console: { error() {}, warn() {}, log() {} }, __KORG_NATIVE__: { report() { throw new Error("native side is gone"); } } });
    vm.runInContext(await readFile(path.join(repoRoot, "runtime", "core.js"), "utf8"), context);
    const K = context.__KORG_INTERNAL__;
    assert.doesNotThrow(() => K.reportError("source", new Error("still recorded")));
    assert.equal(K.errors.length, 1);
    assert.doesNotThrow(() => K.native.status("Metro: hooks __d=yes __r=yes"));
});

test("ErrorUtils is wrapped whether it already exists or appears later, and the host handler still runs", async () => {
    for (const early of [true, false]) {
        const context = vm.createContext({ console: { error() {}, warn() {}, log() {} } });
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", "core.js"), "utf8"), context);
        const K = context.__KORG_INTERNAL__;
        const define = `globalThis.ErrorUtils = { _h: (error) => { throw error; }, setGlobalHandler(handler) { this._h = handler; }, getGlobalHandler() { return this._h; } }; globalThis.calls = [];`;
        if (early) vm.runInContext(define, context);
        K.installErrorHooks();
        K.installErrorHooks();   // installing twice must not double-wrap
        if (!early) vm.runInContext(define, context);
        vm.runInContext("ErrorUtils.setGlobalHandler(function (error, fatal) { calls.push([error.message, fatal]); });", context);
        vm.runInContext("ErrorUtils.getGlobalHandler()({ name: 'Error', message: 'boom' }, true);", context);
        assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [["boom", true]], `original handler still called (early=${early})`);
        assert.equal(K.errors.length, 1, `recorded once (early=${early})`);
        assert.match(K.errors[0].text, /^Uncaught fatal error: Error: boom/);
        // The handler that was installed before Korg arrived is wrapped as well (default handler rethrows).
        const fresh = vm.createContext({ console: { error() {}, warn() {}, log() {} } });
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", "core.js"), "utf8"), fresh);
        vm.runInContext(define, fresh);
        fresh.__KORG_INTERNAL__.installErrorHooks();
        assert.throws(() => vm.runInContext("ErrorUtils.getGlobalHandler()(new Error('default handler'), false)", fresh), /default handler/);
        assert.match(fresh.__KORG_INTERNAL__.errors[0].text, /^Uncaught error: Error: default handler/);
    }
});

test("the loader's native storage is the backend: round trip, keys, failures, and Discord's modules are never searched", async () => {
    const files = new Map();
    const native = { storage(operation, key, value) {
        if (operation === "get") return files.has(key) ? files.get(key) : undefined;
        if (operation === "set") { if (key.includes("fail")) return "disk full"; files.set(key, value); return undefined; }
        if (operation === "remove") { files.delete(key); return undefined; }
        if (operation === "keys") return JSON.stringify([...files.keys()]);
        return "unknown";
    } };
    // Discord's Zustand persist adapter looks like AsyncStorage and returns objects. It must be ignored entirely.
    const decoy = { getItem: () => ({ state: {} }), setItem() { throw new Error("the decoy must never be written"); }, removeItem() {} };
    const hostModules = new Map([[1, { isInitialized: true, publicModule: { exports: decoy } }]]);
    let enumerations = 0;
    function hostRequire() {}
    hostRequire.getModules = () => { enumerations += 1; return hostModules; };
    const { K } = await runtime({ __r: hostRequire, __KORG_NATIVE__: native });
    const baseline = enumerations;   // Metro's own scan when it installs its hooks
    assert.equal(K.storage.status, "persistent");
    assert.equal(K.storage.source, "native files");
    const scope = K.storage.createScope("t");
    await scope.AsyncStorage.setItem("a b", "1");
    await scope.AsyncStorage.setItem("é中😀", "unicode ✓");
    assert.equal(await scope.AsyncStorage.getItem("a b"), "1");
    assert.equal(await scope.AsyncStorage.getItem("missing"), null);
    assert.deepEqual(plain((await scope.AsyncStorage.getAllKeys()).sort()), ["a b", "é中😀"].sort());
    await scope.AsyncStorage.removeItem("a b");
    assert.equal(await scope.AsyncStorage.getItem("a b"), null);
    await assert.rejects(scope.AsyncStorage.setItem("fail", "x"), /native storage write failed: disk full/);
    const settings = await scope.createStorage("settings", { defaults: { n: 1 } });
    settings.n = 2;
    await settings.flush();
    assert.deepEqual(JSON.parse(files.get("korg:t:settings")), { n: 2 });
    assert.equal(enumerations, baseline, "Discord's modules are not searched when native storage exists");
});

test("a host object that returns non-strings is refused with a clear error instead of corrupting a read", async () => {
    const persistAdapter = { getItem: () => ({ state: { volume: 1 } }), setItem() {}, removeItem() {} };
    const hostModules = new Map([[1, { isInitialized: true, publicModule: { exports: persistAdapter } }]]);
    function hostRequire() {}
    hostRequire.getModules = () => hostModules;
    const { K } = await runtime({ __r: hostRequire });
    await assert.rejects(K.storage.AsyncStorage.getItem("x"), /non-string/);
});

test("diagnostics status is sent whenever it changes, never sampled away, and never repeated", async () => {
    const sent = [];
    const host = hostFixture();
    const { K, context } = await runtime({ __r: host.require, __d: host.define, __KORG_NATIVE__: { report: text => sent.push(text) } }, modules);
    for (const name of ["themes", "plugins", "ui", "start"]) {
        vm.runInContext(await readFile(path.join(repoRoot, "runtime", `${name}.js`), "utf8"), context);
    }
    const statuses = () => sent.filter(message => message.startsWith("status\n")).map(message => message.slice(7));
    assert.ok(statuses().length >= 1, "a status is sent at start");
    assert.match(statuses().at(-1), /React missing, react-native missing, AppRegistry missing/);
    const before = statuses().length;
    for (let call = 0; call < 5; call++) K.reportStatus();
    assert.equal(statuses().length, before, "an unchanged status is not sent again");
    host.publishAll(context);
    assert.match(statuses().at(-1), /AppRegistry found \(module\)/);
    assert.match(statuses().at(-1), /wrapper installed/);
    host.AppRegistry.registerComponent("Root", () => function Root() {});
    const wrapped = host.AppRegistry.runApplication("Root", {});
    assert.match(statuses().at(-1), /apps registered: Root; apps run: Root/);
    assert.match(statuses().at(-1), /phase=wrapped; not rendered/);
    const container = wrapped.type(wrapped.props);
    const guard = container.props.children[1];
    const overlay = guard.props.children;
    overlay.type(overlay.props);
    assert.match(statuses().at(-1), /phase=rendered; rendered, mounted/);
    assert.match(statuses().at(-1), /Storage: /);
    assert.ok(statuses().every(text => text.length < 1500), "every status fits the diagnostics screen");
});
