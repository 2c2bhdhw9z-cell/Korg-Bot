// A stand-in for the parts of Discord that Korg touches, run inside a real Hermes engine AFTER Korg's bootstrap, the
// same order the real app's bundle uses. It has Metro's define/require contract, React Native's lazily-evaluated module
// exports, an AppRegistry, AsyncStorage, ErrorUtils, RN's string-based URL, and a small React-like renderer with hooks.
//
// Every check reports through the native function Korg's loader installs, so a failure here is visible exactly where it
// would be on a device. Run by tests/native-hermes.test.mjs; not part of the app.
(function () {
    "use strict";
    const native = globalThis.__KORG_NATIVE__;
    const K = globalThis.__KORG_INTERNAL__;
    const check = (condition, message) => native.report(`test\n${condition ? "PASS" : "FAIL"}: ${message}`);
    const fail = (message, error) => native.report(`test\nFAIL: ${message}: ${error && error.stack || error}`);

    // ---- Host globals React Native provides that Hermes itself does not ----------------------------------------------
    // RN 0.80+ `URL`: string based, appends "/" to a URL without query or fragment, getters for little else.
    class ReactNativeURL {
        constructor(url) {
            if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(url)) throw new TypeError(`Invalid URL: ${url}`);
            this._url = url;
            if (!this._url.endsWith("/") && !(this._url.includes("?") || this._url.includes("#"))) this._url += "/";
        }
        get href() { return this._url; }
        toString() { return this._url; }
    }
    globalThis.URL = ReactNativeURL;
    const requested = [];
    const PLUGIN_URL = "https://plugins.example.test/greeter.js";
    const PLUGIN_SOURCE = "module.exports = { onLoad() { vendetta.patcher.after('greet', globalThis.__greeter, (args, result) => result + '!'); }, onUnload() {} };";
    const BROKEN_URL = "https://plugins.example.test/broken.js";
    const BROKEN_SOURCE = "module.exports = { onLoad() { throw new Error('plugin exploded on purpose'); } };";
    globalThis.fetch = async url => {
        requested.push(url);
        const text = url.indexOf("broken") >= 0 ? BROKEN_SOURCE : PLUGIN_SOURCE;
        return { ok: true, status: 200, url, headers: { get: () => String(text.length) }, text: async () => text };
    };

    // ---- Timers. A bare Hermes engine has none; React Native provides them, and Hermes' promise rejection tracker needs them.
    const timers = new Map();
    let nextTimer = 1;
    globalThis.setTimeout = callback => { timers.set(nextTimer, callback); return nextTimer++; };
    globalThis.clearTimeout = id => { timers.delete(id); };
    const runTimers = () => { for (const [id, callback] of Array.from(timers)) { timers.delete(id); callback(); } };

    // ---- ErrorUtils, as React Native's error-guard polyfill defines it (before any module runs) -------------------------
    const handled = [];
    let globalHandler = error => { throw error; };
    globalThis.ErrorUtils = {
        setGlobalHandler(handler) { globalHandler = handler; },
        getGlobalHandler() { return globalHandler; },
        reportError(error) { globalHandler(error, false); },
        reportFatalError(error) { globalHandler(error, true); },
    };
    globalThis.ErrorUtils.setGlobalHandler((error, isFatal) => { handled.push({ message: error.message, isFatal }); });

    // ---- A very small React ------------------------------------------------------------------------------------------
    const instances = new Map();
    let current = null;
    let effects = [];
    let rootElement = null;
    let rendering = false;
    let dirty = false;
    let tree = null;
    function createElement(type, props, ...children) {
        const merged = Object.assign({}, props);
        if (children.length) merged.children = children.length === 1 ? children[0] : children;
        return { type, props: merged };
    }
    function useState(initial) {
        const instance = current;
        const index = instance.cursor++;
        if (!instance.hooks[index]) instance.hooks[index] = { value: typeof initial === "function" ? initial() : initial };
        const hook = instance.hooks[index];
        if (!hook.set) hook.set = next => {
            const value = typeof next === "function" ? next(hook.value) : next;
            if (Object.is(value, hook.value)) return;
            hook.value = value;
            dirty = true;
            if (!rendering) flush();
        };
        return [hook.value, hook.set];
    }
    function useEffect(callback, deps) {
        const instance = current;
        const index = instance.cursor++;
        const previous = instance.hooks[index];
        const changed = !previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((dep, at) => !Object.is(dep, previous.deps[at]));
        if (!changed) return;
        const hook = { deps, cleanup: previous && previous.cleanup };
        instance.hooks[index] = hook;
        effects.push(() => { if (hook.cleanup) hook.cleanup(); hook.cleanup = callback(); });
    }
    function renderNode(element, path) {
        if (element === null || element === undefined || typeof element === "boolean") return null;
        if (typeof element === "string" || typeof element === "number") return { text: String(element) };
        if (Array.isArray(element)) return { list: element.map((child, at) => renderNode(child, `${path}.${at}`)) };
        if (typeof element.type === "function") {
            let instance = instances.get(path);
            if (!instance || instance.type !== element.type) { instance = { type: element.type, hooks: [], cursor: 0 }; instances.set(path, instance); }
            instance.cursor = 0;
            const outer = current;
            current = instance;
            let output;
            try { output = element.type(element.props); } finally { current = outer; }
            return { component: element.type.displayName || element.type.name, props: element.props, child: renderNode(output, `${path}/c`) };
        }
        const children = element.props.children === undefined ? [] : [].concat(element.props.children);
        return { host: element.type, props: element.props, children: children.map((child, at) => renderNode(child, `${path}/${at}`)) };
    }
    function flush() {
        rendering = true;
        try {
            for (let pass = 0; pass < 25 && (dirty || pass === 0); pass++) {
                dirty = false;
                effects = [];
                tree = renderNode(rootElement, "root");
                const queued = effects;
                effects = [];
                for (const run of queued) run();
            }
        } finally { rendering = false; }
    }
    function visit(node, callback) {
        if (!node) return;
        callback(node);
        if (node.child) visit(node.child, callback);
        for (const child of node.children || node.list || []) visit(child, callback);
    }
    function textOf(node) {
        let text = "";
        visit(node, item => { if (item.text !== undefined) text += item.text; });
        return text;
    }
    function find(predicate) {
        let found = null;
        visit(tree, node => { if (!found && predicate(node)) found = node; });
        return found;
    }
    const pressableWithText = label => find(node => node.host === "Pressable" && textOf(node) === label);
    const press = label => { const node = pressableWithText(label); if (!node) throw new Error(`No button labelled ${label}`); node.props.onPress(); };
    const React = { createElement, useState, useEffect };

    // ---- React Native's module, with lazily-evaluated exports like the real index.js ---------------------------------------
    const getterCalls = {};
    const hostComponent = name => function HostComponent(props) { return createElement(name, props); };
    const components = {
        View: hostComponent("View"), Text: hostComponent("Text"), Pressable: hostComponent("Pressable"),
        ScrollView: hostComponent("ScrollView"), TextInput: hostComponent("TextInput"), SafeAreaView: hostComponent("SafeAreaView"),
        Switch: hostComponent("Switch"),
        Modal: function Modal(props) { return props.visible ? createElement("Modal", props) : null; },
    };
    const providers = new Map();
    const AppRegistry = {
        registerComponent(key, provider) { providers.set(key, provider); return key; },
        getAppKeys() { return Array.from(providers.keys()); },
    };
    const ReactNative = {};
    function lazy(name, value) { Object.defineProperty(ReactNative, name, { enumerable: true, get() { getterCalls[name] = (getterCalls[name] || 0) + 1; return value; } }); }
    Object.keys(components).forEach(name => lazy(name, components[name]));
    lazy("AppRegistry", AppRegistry);

    // ---- AsyncStorage ---------------------------------------------------------------------------------------------------
    const disk = new Map();
    const AsyncStorage = {
        getItem: async key => (disk.has(key) ? disk.get(key) : null),
        setItem: async (key, value) => { disk.set(key, String(value)); },
        removeItem: async key => { disk.delete(key); },
        getAllKeys: async () => Array.from(disk.keys()),
    };

    // ---- The app itself -------------------------------------------------------------------------------------------------
    function DiscordApp() { return createElement(components.View, null, createElement(components.Text, null, "Discord channel list")); }

    // ---- Metro. Use the real polyfill when the test supplies it, otherwise the same contract in a few lines. -------------------
    if (typeof globalThis.__r !== "function") {
        const modules = new Map();
        const define = (factory, id, dependencyMap) => { if (!modules.has(id)) modules.set(id, { factory, dependencyMap, isInitialized: false, publicModule: { exports: {} } }); };
        const metroRequire = id => {
            const mod = modules.get(id);
            if (!mod) throw new Error(`Requiring unknown module "${id}"`);
            if (mod.isInitialized) return mod.publicModule.exports;
            mod.isInitialized = true;
            const module = mod.publicModule;
            const importDefault = other => { const value = metroRequire(other); return value && value.__esModule ? value.default : value; };
            mod.factory(globalThis, metroRequire, importDefault, metroRequire, module, module.exports, mod.dependencyMap);
            return module.exports;
        };
        globalThis.__r = metroRequire;
        globalThis.__d = define;
    }
    const ID = { react: 101, reactNative: 102, storage: 103, app: 104 };
    __d((g, r, i, a, module) => { module.exports = React; }, ID.react, []);
    __d((g, r, i, a, module) => { module.exports = ReactNative; }, ID.reactNative, []);
    __d((g, r, i, a, module) => { module.exports = { __esModule: true, default: AsyncStorage }; }, ID.storage, []);
    __d((g, r) => {
        // Like Discord's entry point: pull in the framework, then register the root component.
        const RN = r(ID.reactNative);
        r(ID.react);
        RN.AppRegistry.registerComponent("Discord", () => DiscordApp);
    }, ID.app, []);
    globalThis.__greeter = { greet() { return "hello"; } };

    async function main() {
        // 1. Starting the app registers its root through Korg's wrapper without losing it.
        __r(ID.storage);
        __r(ID.app);
        check(AppRegistry.getAppKeys().join() === "Discord", "the app's own registerComponent still registers the root (not swallowed by a hook)");
        const status = K.ui.status();
        check(status.attached === true && status.rootWrapped === false || status.attached === true, `Korg attached to AppRegistry (phase=${status.phase})`);
        const provider = providers.get("Discord");
        const Root = provider();
        rootElement = createElement(Root, {});
        flush();
        check(K.ui.status().rootWrapped === true, "the root component is wrapped");
        check(find(node => node.host === "Text" && textOf(node) === "Discord channel list") !== null, "the app's own screen still renders inside Korg's wrapper");
        check(pressableWithText("K") !== null, "the K button is on screen");
        check(Object.keys(getterCalls).length > 0 && getterCalls.AppRegistry >= 1, "react-native's lazy exports were read through getters only when needed");

        // 2. Opening settings.
        press("K");
        check(find(node => node.host === "Modal") !== null, "pressing K opens the settings modal");
        check(find(node => node.host === "Text" && textOf(node) === "Korg") !== null, "the settings screen shows its title");
        check(pressableWithText("Install (disabled by default)") !== null, "the plugin install button is there");
        check(["graphite", "ember", "glacier", "orchard", "plum"].every(name => find(node => node.host === "Pressable" && textOf(node).replace("• ", "") === name)), "all palettes are listed");

        // 3. Choosing a palette persists through the host's AsyncStorage and re-renders.
        press("plum");
        await new Promise(resolve => resolve());
        for (let spin = 0; spin < 10; spin++) await Promise.resolve();
        check(K.themes.current() === "plum", "selecting a palette changes the current palette");
        check(Array.from(disk.keys()).some(key => key.indexOf("korg") >= 0), `the palette was saved to AsyncStorage (keys: ${Array.from(disk.keys()).join(", ")})`);

        // 4. Installing, enabling and disabling a plugin that patches the host.
        const item = await K.plugins.install(PLUGIN_URL, { kind: "bundle" });
        check(requested[0] === PLUGIN_URL, `the plugin was fetched from the exact URL it was given (${requested[0]})`);
        check(globalThis.__greeter.greet() === "hello", "an installed plugin is disabled until enabled");
        await K.plugins.setEnabled(item.id, true);
        check(globalThis.__greeter.greet() === "hello!", "an enabled plugin's after-patch runs in Hermes");
        await K.plugins.setEnabled(item.id, false);
        check(globalThis.__greeter.greet() === "hello", "disabling the plugin removes its patch");

        // 5. A plugin that throws is contained, and the error is recorded for the diagnostics screen.
        const broken = await K.plugins.install(BROKEN_URL, { kind: "bundle" });
        let rejected = null;
        try { await K.plugins.setEnabled(broken.id, true); } catch (error) { rejected = error; }
        check(rejected !== null && /exploded on purpose/.test(String(rejected.message)), "a plugin that throws on load is rejected with its message");

        // 6. Uncaught errors are recorded and still reach the host's own handler.
        globalThis.ErrorUtils.reportFatalError(new Error("fatal probe from scenario"));
        check(handled.length === 1 && handled[0].message === "fatal probe from scenario" && handled[0].isFatal === true, "the host's global error handler still receives the error");
        check(K.errors.some(entry => entry.text.indexOf("fatal probe from scenario") >= 0), "the uncaught error is in Korg's error list");
        globalThis.ErrorUtils.setGlobalHandler((error, isFatal) => { handled.push({ message: error.message, isFatal, replaced: true }); });
        globalThis.ErrorUtils.reportError(new Error("second handler probe"));
        check(handled.length === 2 && handled[1].replaced === true && K.errors.some(entry => entry.text.indexOf("second handler probe") >= 0), "a handler installed later is wrapped too");

        // 7. Promise rejections: an unhandled one is recorded; one handled a moment later is not.
        const lateHandled = Promise.reject(new Error("handled promise probe"));
        await null;
        lateHandled.catch(() => {});
        Promise.reject(new Error("unhandled promise probe"));
        for (let spin = 0; spin < 12; spin++) { runTimers(); await Promise.resolve(); }
        check(K.errors.some(entry => entry.text.indexOf("Unhandled promise rejection: Error: unhandled promise probe") === 0), "an unhandled promise rejection is in Korg's error list");
        check(!K.errors.some(entry => entry.text.indexOf("handled promise probe") >= 0 && entry.text.indexOf("unhandled promise probe") < 0), "a rejection handled a moment later is not reported");

        // 8. Nothing else went wrong.
        const unexpected = K.errors.filter(entry => !/exploded on purpose|fatal probe|second handler probe|unhandled promise probe|Plugin broken\.js failed|Could not restart/.test(entry.text));
        check(unexpected.length === 0, `no unexpected errors were recorded${unexpected.length ? ": " + unexpected.map(entry => entry.text.split("\n")[0]).join(" | ") : ""}`);
        native.report("test\nPASS: scenario finished");
    }
    main().catch(error => fail("scenario crashed", error));
})();
