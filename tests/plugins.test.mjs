import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../runtime/plugins.js", import.meta.url), "utf8");
const runtimeSources = Object.fromEntries(await Promise.all(["core", "metro", "patcher", "storage", "compat", "themes", "plugins", "ui", "start"].map(async name => [name, await readFile(new URL(`../runtime/${name}.js`, import.meta.url), "utf8")])));
const CACHE_KEY = "korg.runtime.plugins.v1:registry";
const response = (text, url = "https://example.test/plugin.js", status = 200) => ({
    ok: status >= 200 && status < 300, status, url,
    headers: { get: () => String(new TextEncoder().encode(text).length) }, text: async () => text,
});
const bundle = "module.exports = { onLoad() {}, onUnload() {} };";
function fixture(fetcher = async url => response(bundle, url), options = {}) {
    const disk = options.disk || new Map();
    const logs = [];
    const scopes = [];
    const objects = new Map();
    const context = vm.createContext({ URL, fetch: fetcher, AbortController, TextEncoder: options.noEncoder ? undefined : TextEncoder,
        setTimeout, clearTimeout, __KORG_INTERNAL__: null });
    const control = { available: true, readError: null, saveError: null, flushError: null };
    const createScope = id => ({
        AsyncStorage: {
            async getItem(key) {
                if (!control.available) throw Error("storage unavailable");
                if (control.readError) throw control.readError;
                return disk.get(`${id}:${key}`) ?? null;
            },
            async setItem(key, value) {
                if (!control.available) throw Error("storage unavailable");
                if (control.saveError) throw control.saveError;
                disk.set(`${id}:${key}`, value);
            },
        },
    async createStorage(key, settings) {
        const fullKey = `${id}:${key}`;
        if (!objects.has(fullKey)) objects.set(fullKey, structuredClone(settings?.defaults || {}));
        return objects.get(fullKey);
    },
        async flush() { if (control.flushError) throw control.flushError; },
    });
    const React = { count: 0, useState() { return [0, () => { React.count++; }]; }, useEffect(callback) { callback(); } };
    const K = {
        log: Object.fromEntries(["info", "warn", "error"].map(level => [level, (...values) => logs.push([level, ...values])])),
        metro: { common: { React } },
        storage: { createScope, createStorage: async (key, options) => createScope("core").createStorage(key, options), get status() { return control.available ? "persistent" : "unavailable"; } },
        createCompatibility(id) {
            const scope = { id, metro: { common: { React } }, patcher: {}, storage: createScope(id), ui: {}, plugin: {},
                unpatchAll() { this.cleaned = true; } };
            scopes.push(scope);
            return scope;
        },
    };
    context.__KORG_INTERNAL__ = K;
    vm.runInContext(source, context);
    return { plugins: K.plugins, K, context, disk, logs, scopes, control, React };
}
const saved = fixture => JSON.parse(fixture.disk.get(CACHE_KEY));

test("installs bundle disabled and passes awaited, isolated plugin storage and manifest", async () => {
    const f = fixture(async url => response("module.exports = { onLoad() { const p = require('@vendetta/plugin'); p.storage.loads = (p.storage.loads || 0) + 1; if (p.storage.then) throw Error('not awaited'); }, Settings() {} };", url));
    const item = await f.plugins.install("https://example.test/a.js", { kind: "bundle", options: { mode: "demo" } });
    assert.equal(item.enabled, false);
    assert.equal(saved(f).plugins.length, 1);
    await f.plugins.setEnabled(item.id, true);
    assert.equal(f.plugins.isActive(item.id), true);
    assert.equal(f.scopes[0].plugin.storage.loads, 1);
    assert.equal(f.scopes[0].plugin.manifest.name, "a.js");
    assert.equal(f.scopes[0].plugin.options.mode, "demo");
    assert.equal(typeof f.plugins.getSettings(item.id), "function");
    await f.plugins.setEnabled(item.id, false);
    await f.plugins.setEnabled(item.id, true);
    assert.equal(f.scopes.at(-1).plugin.storage.loads, 2);
    const other = await f.plugins.install("https://example.test/b.js", "bundle");
    await f.plugins.setEnabled(other.id, true);
    assert.equal(f.scopes.at(-1).plugin.storage.loads, 1);
});

test("manifest resolves relative bundle and redirects remain HTTPS", async () => {
    const requests = [];
    const f = fixture(async url => {
        requests.push(url);
        if (url.endsWith("plugin.json")) return response('{"name":"Demo","description":"Example","main":"src/main.js","version":"1"}', "https://cdn.test/path/plugin.json");
        return response(bundle, "https://cdn.test/path/src/main.js");
    });
    const item = await f.plugins.install("https://example.test/plugin.json", "manifest");
    assert.equal(item.name, "Demo");
    assert.deepEqual(requests, ["https://example.test/plugin.json", "https://cdn.test/path/src/main.js"]);
    await f.plugins.setEnabled(item.id, true);
    assert.equal(f.scopes[0].plugin.manifest.version, "1");
    const unsafe = fixture(async url => response(bundle, "http://insecure.test/a.js"));
    await assert.rejects(unsafe.plugins.install("https://example.test/a.js", "bundle"), /Only HTTPS/);
});

test("runtime SyntaxError runs once; startup failures clean scope and restore state", async () => {
    for (const code of [
        "(() => { require('react').count++; throw new SyntaxError('runtime syntax'); })()",
        "module.exports = { onLoad() { require('react').count++; throw Error('broken'); } };",
    ]) {
        const f = fixture(async url => response(code, url));
        const item = await f.plugins.install("https://example.test/fail.js", "bundle");
        await assert.rejects(f.plugins.setEnabled(item.id, true), /runtime syntax|broken/);
        assert.equal(f.React.count, 1);
        assert.equal(f.plugins.isActive(item.id), false);
        assert.equal(saved(f).plugins[0].enabled, false);
        assert.equal(f.scopes[0].cleaned, true);
    }
});

test("partial dependency mappings expose compatibility namespaces", async () => {
    const f = fixture(async url => response("module.exports = { onLoad() { for (const root of ['vendetta', 'bunny']) { if (!require('@' + root + '/storage').createStorage) throw Error('storage'); if (!require('@' + root + '/plugin').storage) throw Error('plugin'); if (!require('@' + root + '/metro/common').React) throw Error('common'); } } };", url));
    const item = await f.plugins.install("https://example.test/api.js", "bundle");
    await f.plugins.setEnabled(item.id, true);
    assert.equal(f.plugins.isActive(item.id), true);
});

test("updates preserve enablement and old cache on download, save, or replacement failure", async () => {
    let body = bundle;
    const f = fixture(async url => response(body, url));
    const item = await f.plugins.install("https://example.test/update.js", "bundle");
    await f.plugins.setEnabled(item.id, true);
    const oldCache = f.disk.get(CACHE_KEY);
    body = "x".repeat(2 * 1024 * 1024 + 1);
    await assert.rejects(f.plugins.update(item.id), /2 MiB/);
    assert.equal(f.disk.get(CACHE_KEY), oldCache);
    assert.equal(f.plugins.isActive(item.id), true);
    body = "module.exports = { onLoad() {} };";
    f.control.saveError = Error("save refused");
    await assert.rejects(f.plugins.update(item.id), /save refused/);
    assert.equal(f.disk.get(CACHE_KEY), oldCache);
    f.control.saveError = null;
    body = "module.exports = { onLoad() { throw Error('replacement failed'); } };";
    await assert.rejects(f.plugins.update(item.id), /replacement failed/);
    assert.equal(saved(f).plugins[0].source, bundle);
    assert.equal(f.plugins.isActive(item.id), true);
    body = "module.exports = { onLoad() {} };";
    await f.plugins.update(item.id);
    assert.equal(f.plugins.list()[0].enabled, true);
    assert.equal(f.plugins.isActive(item.id), true);
    assert.equal(saved(f).plugins[0].source, body);
});

test("full URL identity avoids hash collisions and redirect aliases", async () => {
    const f = fixture(async () => response(bundle, "https://cdn.test/shared.js"));
    const a = await f.plugins.install("https://example.test/a.js?x=1&y=2", "bundle");
    const b = await f.plugins.install("https://example.test/a.js?x=1%26y=2", "bundle");
    assert.notEqual(a.id, b.id);
    assert.equal(a.id, `remote-${encodeURIComponent("https://example.test/a.js?x=1&y=2")}`);
    assert.equal(f.plugins.list().length, 2);
});

test("initialization shares its promise, preserves unreadable cache, and retries", async () => {
    const f = fixture();
    f.control.readError = Error("read failed");
    const first = f.plugins.initialize();
    assert.equal(f.plugins.initialize(), first);
    await assert.rejects(first, /read failed/);
    await assert.rejects(f.plugins.install("https://example.test/a.js", "bundle"), /read failed/);
    assert.match(f.plugins.status().error, /read failed/);
    f.control.readError = null;
    await f.plugins.retry();
    await f.plugins.install("https://example.test/a.js", "bundle");
    assert.equal(saved(f).plugins.length, 1);
    const raw = f.disk.get(CACHE_KEY);
    f.disk.set(CACHE_KEY, "bad JSON");
    const broken = fixture(undefined, { disk: f.disk });
    await assert.rejects(broken.plugins.initialize(), /JSON/);
    await assert.rejects(broken.plugins.install("https://example.test/b.js", "bundle"), /JSON/);
    assert.equal(broken.disk.get(CACHE_KEY), "bad JSON");
    f.disk.set(CACHE_KEY, raw);
});

test("reload restores enabled plugins without network and remove stops them", async () => {
    const first = fixture(async url => response(bundle, url));
    const item = await first.plugins.install("https://example.test/persist.js", "bundle");
    await first.plugins.setEnabled(item.id, true);
    const second = fixture(async () => { throw Error("network must not be needed"); }, { disk: first.disk });
    await Promise.all([second.plugins.initialize(), second.plugins.initialize()]);
    assert.equal(second.plugins.isActive(item.id), true);
    assert.equal(await second.plugins.remove(item.id), true);
    assert.equal(second.plugins.isActive(item.id), false);
    assert.equal(second.plugins.list().length, 0);
});

test("rejects non-HTTPS, unsafe manifest paths, dependencies, and oversized UTF-8 without TextEncoder", async () => {
    const f = fixture(async url => response('{"name":"x","main":"../outside.js"}', url));
    await assert.rejects(f.plugins.install("http://example.test/a.js", "bundle"), /HTTPS/);
    await assert.rejects(f.plugins.install("https://example.test/plugin.json", "manifest"), /relative bundle path/);
    const unsupported = fixture(async url => response("require('fs')", url));
    const item = await unsupported.plugins.install("https://example.test/a.js", "bundle");
    await assert.rejects(unsupported.plugins.setEnabled(item.id, true), /dependency is not available/);
    assert.equal(unsupported.scopes[0].cleaned, true);
    for (const text of ["é".repeat(1048577), "😀".repeat(524289), "\uD800".repeat(699051)]) {
        const large = fixture(async url => response(text, url), { noEncoder: true });
        await assert.rejects(large.plugins.install("https://example.test/a.js", "bundle"), /2 MiB/);
    }
});


test("themes use scoped storage, notify subscribers, and roll back failed persistence", async () => {
    const f = fixture();
    const values = new Map();
    f.K.storage = { createScope: () => ({
        AsyncStorage: {
            async getItem(key) { return values.get(key) ?? null; },
            async setItem(key, value) { if (f.control.saveError) throw f.control.saveError; values.set(key, value); },
        },
        async flush() {},
    }) };
    vm.runInContext(runtimeSources.themes, f.context);
    const changes = [];
    f.K.themes.subscribe((_palette, name) => changes.push(name));
    await f.K.themes.initialize();
    await f.K.themes.select("paper");
    assert.equal(f.K.themes.colors().background, "#F2F2EE");
    assert.deepEqual(changes, ["graphite", "paper"]);
    f.control.saveError = Error("write failed");
    await assert.rejects(f.K.themes.select("ember"), /write failed/);
    assert.equal(f.K.themes.current(), "paper");
});

test("startup attaches synchronously before blocked theme/plugin persistence", () => {
    const K = { log: { info() {}, warn() {}, error() {} }, ui: { initialize() { this.called = true; return { attached: true }; } }, themes: { initialize() { throw Error("must not await theme first"); } } };
    const context = vm.createContext({ __KORG_INTERNAL__: K, Promise, Date });
    vm.runInContext(runtimeSources.start, context);
    assert.equal(K.ui.called, true);
    assert.equal(K.runtime.ready, false);
});

test("UI waits for Metro host modules, attaches before registration, and rerenders from real themes", async () => {
    const f = fixture();
    const featureStore = new Map();
    f.K.storage = { createScope: () => ({
        AsyncStorage: { async getItem(key) { return featureStore.get(key) ?? null; }, async setItem(key, value) { featureStore.set(key, value); } },
        async flush() {},
    }) };
    vm.runInContext(runtimeSources.themes, f.context);
    vm.runInContext(runtimeSources.plugins, f.context);
    const listeners = new Set();
    const calls = [];
    const Native = Object.fromEntries(["View", "Text", "Modal", "SafeAreaView", "ScrollView", "TextInput", "Pressable"].map(key => [key, key]));
    Native.AppRegistry = { registerComponent(name, provider) { calls.push(name); return provider(); } };
    let renders = 0;
    const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useState: () => [0, () => { renders++; }], useEffect: callback => { callback(); } };
    f.K.metro = { common: {}, findByProps() { return undefined; }, getAll() { return []; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
    f.K.patcher = { createScope() { return {
        before(method, target, callback) {
            const original = target[method];
            target[method] = function (...args) { callback(args); return original.apply(this, args); };
        },
        after(method, target, callback) {
            const original = target[method];
            target[method] = function (...args) { const result = original.apply(this, args); return callback(args, result) ?? result; };
        },
        unpatchAll() {},
    }; } };
    vm.runInContext(runtimeSources.ui, f.context);
    const result = f.K.ui.initialize();
    assert.equal(result.attached, false);
    f.K.metro.common.React = React;
    f.K.metro.common.ReactNative = Native;
    for (const listener of listeners) listener();
    assert.equal(f.K.runtime?.ui?.attached, undefined);
    const provider = Native.AppRegistry.registerComponent("Root", () => function Root() {});
    assert.equal(typeof provider, "object");
    assert.equal(typeof provider.type, "function");
    provider.type(provider.props);
    assert.deepEqual(calls, ["Root"]);
    await Promise.resolve();
    await Promise.resolve();
    const palette = f.K.themes.colors();
    await f.K.themes.select("paper");
    assert.notEqual(f.K.themes.colors(), palette);
});
