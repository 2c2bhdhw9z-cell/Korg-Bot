(function (K) {
    "use strict";
    const records = new Set();
    const listeners = new Set();
    const notifying = new Set();
    const wrappers = new WeakMap();
    const factories = new WeakMap();
    let hooked = false;
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
    function notify(value) {
        if (!looksLikeExports(value) || notifying.has(value)) return;
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
                notify(exports);
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
            if (name === "__d" && typeof args[0] === "function") args[0] = wrapFactory(args[0]);
            const result = value.apply(this, args);
            if (name === "__r") captureModule(result);
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
        if (!hooked) {
            hooked = true;
            hookGlobal("__d");
            hookGlobal("__r");
        }
        scan();
    }
    function getAll() {
        install();
        return Array.from(records);
    }
    function subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("metro.subscribe requires a listener");
        listeners.add(listener);
        scan();
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
    for (const name of ["React", "ReactNative", "FluxDispatcher"]) {
        Object.defineProperty(common, name, {
            enumerable: true,
            get() {
                const candidates = name === "React" ? ["createElement", "useState"] : name === "ReactNative" ? ["View", "Text"] : ["dispatch", "subscribe"];
                const found = findByProps(...candidates);
                if (!found) throw new Error(`Korg Metro module unavailable: ${name}`);
                return found;
            },
        });
    }
    K.metro = { install, refresh: getAll, getAll, find, findByProps, findByName, findByStoreName, common, subscribe, get lastError() { return lastError; } };
    install();
})(globalThis.__KORG_INTERNAL__);