(function (K) {
    "use strict";
    const records = new Set();
    const listeners = new Set();
    const notifying = new Set();
    // Each exports object is announced once. Replaying every module on every lookup made one
    // findByProps cost O(modules^2) once a listener did its own lookups, as the UI listener does.
    const notified = new Set();
    const wrappers = new WeakMap();
    const factories = new WeakMap();
    const hooks = new Map();
    // Which Metro functions have been called at least once; the first call of each is reported to the native loader.
    const seen = new Set();
    let lastError;
    let scanning = false;
    const looksLikeExports = value => value !== null && (typeof value === "object" || typeof value === "function");

    function record(value) {
        if (!looksLikeExports(value)) return value;
        records.add(value);
        try {
            const descriptors = Object.getOwnPropertyDescriptors(value);
            for (const key of Reflect.ownKeys(descriptors)) {
                const descriptor = descriptors[key];
                if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") && looksLikeExports(descriptor.value)) records.add(descriptor.value);
            }
        } catch (error) { lastError = error; }
        return value;
    }
    function notify(value, completed = false) {
        // A finished factory is announced even if a scan already saw its partial exports; that happens once per module.
        if (!looksLikeExports(value) || notifying.has(value) || (!completed && notified.has(value))) return;
        notified.add(value);
        notifying.add(value);
        try {
            for (const listener of Array.from(listeners)) {
                try { listener(value); } catch (error) { lastError = error; }
            }
        } finally { notifying.delete(value); }
    }
    function captureModule(module) {
        try {
            if (!module || module.isInitialized === false) return;
            let publicExports;
            let exports;
            try { publicExports = module.publicModule && module.publicModule.exports; } catch (error) { lastError = error; }
            try { exports = module.exports; } catch (error) { lastError = error; }
            record(publicExports);
            record(exports);
            notify(exports || publicExports);
        } catch (error) { lastError = error; }
    }
    function wrapFactory(factory) {
        if (factories.has(factory)) return factories.get(factory);
        const wrapped = function (...args) {
            const result = factory.apply(this, args);
            try {
                const module = args[4];
                let exports = args[5];
                try { if (module) exports = module.exports; } catch (error) { lastError = error; }
                record(exports);
                notify(exports, true);
            } catch (error) { lastError = error; }
            return result;
        };
        factories.set(factory, wrapped);
        factories.set(wrapped, wrapped);
        return wrapped;
    }
    function wrap(value, name) {
        if (typeof value !== "function") return value;
        let byName = wrappers.get(value);
        if (!byName) wrappers.set(value, byName = new Map());
        if (byName.has(name)) return byName.get(name);
        const wrapped = function (...args) {
            hookGlobal("__d");
            hookGlobal("__r");
            const first = !seen.has(name);
            seen.add(name);
            if (name === "__d" && typeof args[0] === "function") args[0] = wrapFactory(args[0]);
            const result = value.apply(this, args);
            if (name === "__r") {
                record(result);
                notify(result);
            }
            if (K.reportStatus) K.reportStatus(first);
            return result;
        };
        byName.set(name, wrapped);
        try {
            for (const key of Reflect.ownKeys(value)) {
                if (["name", "length", "prototype", "caller", "arguments"].includes(key)) continue;
                try {
                    const descriptor = Object.getOwnPropertyDescriptor(value, key);
                    if (key === "getModules" && descriptor && typeof descriptor.value === "function") descriptor.value = descriptor.value.bind(value);
                    Object.defineProperty(wrapped, key, descriptor);
                } catch (error) { lastError = error; }
            }
        } catch (error) { lastError = error; }
        return wrapped;
    }
    function hookGlobal(name) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
            if (descriptor && hooks.has(name) && descriptor.get === hooks.get(name)) return true;
            if (descriptor && descriptor.configurable === false) return false;
            let current = descriptor && "value" in descriptor ? descriptor.value : undefined;
            const getter = function () {
                const value = descriptor && descriptor.get ? descriptor.get.call(this) : current;
                return wrap(value, name);
            };
            Object.defineProperty(globalThis, name, {
                configurable: true,
                enumerable: descriptor ? descriptor.enumerable : true,
                get: getter,
                set(value) {
                    if (descriptor && descriptor.set) {
                        try { descriptor.set.call(this, value); } catch (error) { lastError = error; }
                    } else current = value;
                },
            });
            hooks.set(name, getter);
            return true;
        } catch (error) {
            lastError = error;
            return false;
        }
    }
    function scan() {
        if (scanning) return;
        scanning = true;
        try {
            const require = globalThis.__r;
            if (require && typeof require.getModules === "function") {
                const modules = require.getModules();
                const values = modules && typeof modules.values === "function" ? modules.values() : Object.values(modules || {});
                for (const module of values) captureModule(module);
            }
        } catch (error) { lastError = error; }
        finally { scanning = false; }
    }
    function install() {
        // Metro may replace configurable accessors with defineProperty during startup.
        hookGlobal("__d");
        hookGlobal("__r");
        scan();
    }
    function getAll() {
        install();
        return Array.from(records);
    }
    function subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("metro.subscribe requires a listener");
        // A new listener hears about modules captured before it subscribed; older listeners do not hear them again.
        const earlier = Array.from(notified);
        listeners.add(listener);
        scan();
        for (const value of earlier) {
            if (!listeners.has(listener)) break;
            try { listener(value); } catch (error) { lastError = error; }
        }
        return () => listeners.delete(listener);
    }
    function find(filter) {
        if (typeof filter !== "function") throw new TypeError("metro.find requires a predicate");
        return getAll().find(value => {
            try { return filter(value); } catch { return false; }
        });
    }
    function findByProps(...properties) {
        const props = properties.length === 1 && Array.isArray(properties[0]) ? properties[0] : properties;
        return find(value => props.every(key => key in Object(value)));
    }
    function findByName(name, defaultExport = true) {
        for (const value of getAll()) {
            const candidates = [];
            if (defaultExport && looksLikeExports(value)) {
                try {
                    const descriptor = Object.getOwnPropertyDescriptor(value, "default");
                    if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")) candidates.push(descriptor.value);
                } catch { /* An inaccessible export is not a match. */ }
            }
            candidates.push(value);
            const match = candidates.find(candidate => typeof candidate === "function" && (candidate.displayName === name || candidate.name === name));
            if (match) return match;
        }
        return undefined;
    }
    function findByStoreName(name) {
        return find(value => {
            if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
            try { return typeof value.getName === "function" && value.getName() === name; } catch { return false; }
        });
    }
    const common = {};
    // Hermes shares one binding across loop iterations, so each getter is made by a function call.
    function defineCommon(name) {
        const candidates = name === "React" ? ["createElement", "useState"] : name === "ReactNative" ? ["View", "Text"] : ["dispatch", "subscribe"];
        Object.defineProperty(common, name, {
            enumerable: true,
            get() {
                const found = findByProps(...candidates);
                if (!found) throw new Error(`Korg Metro module unavailable: ${name}`);
                return found;
            },
        });
    }
    ["React", "ReactNative", "FluxDispatcher"].forEach(name => defineCommon(name));
    function status() {
        const active = {};
        for (const name of ["__d", "__r"]) {
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
            active[name] = Boolean(descriptor && hooks.has(name) && descriptor.get === hooks.get(name));
        }
        return { moduleCount: records.size, hooks: active, error: lastError ? String(lastError.message || lastError) : null };
    }
    K.reportStatus = function (force) {
        const snapshot = { metro: status(), ui: K.ui && K.ui.status ? K.ui.status() : { phase: "waiting" }, errors: K.errors ? K.errors.length : 0 };
        globalThis.__KORG_DIAGNOSTICS__ = snapshot;
        if (K.native && typeof K.native.status === "function") K.native.status(snapshot, force === true);
        return snapshot;
    };
    K.metro = { status, install, refresh: getAll, getAll, find, findByProps, findByName, findByStoreName, common, subscribe, get lastError() { return lastError; } };
    install();
    K.reportStatus(true);
})(globalThis.__KORG_INTERNAL__);