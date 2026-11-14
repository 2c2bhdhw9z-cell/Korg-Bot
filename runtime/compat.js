(function (K) {
    "use strict";
    const registry = new Map();
    const nativeNames = ["View", "Text", "Switch", "Pressable", "TextInput", "ScrollView"];
    function nativeModule() {
        try { return K.metro.common.ReactNative; } catch { return undefined; }
    }
    const uiComponents = {};
    for (const name of nativeNames) {
        Object.defineProperty(uiComponents, name, {
            enumerable: true,
            get() {
                const native = nativeModule();
                return native && native[name];
            },
        });
    }
    function createCompatibility(id) {
        const owner = String(id || "anonymous");
        if (registry.has(owner)) return registry.get(owner);
        const patcher = K.patcher.createScope(owner);
        const storage = K.storage.createScope(owner);
        const logger = K.makeLogger(owner);
        if (!logger.log) logger.log = logger.info;
        const metro = {
            find: K.metro.find,
            findByProps: K.metro.findByProps,
            findByName: K.metro.findByName,
            findByStoreName: K.metro.findByStoreName,
            getAll: K.metro.getAll,
            common: K.metro.common,
            filters: {
                byProps: (...props) => value => props.every(key => key in Object(value)),
                byName: (name, defaultExport = true) => value => K.metro.findByName(name, defaultExport) === value,
                byStoreName: name => value => K.metro.findByStoreName(name) === value,
            },
        };
        const api = {
            metro,
            patcher,
            logger,
            storage,
            ui: { components: uiComponents },
            plugin: { id: owner },
            unpatchAll: patcher.unpatchAll,
        };
        Object.defineProperty(api, "AsyncStorage", { enumerable: true, get: () => storage.AsyncStorage });
        Object.defineProperty(api, "ReactNative", { enumerable: true, get: nativeModule });
        Object.defineProperty(api, "React", { enumerable: true, get: () => K.metro.common.React });
        Object.defineProperty(api, "common", { enumerable: true, get: () => K.metro.common });
        registry.set(owner, api);
        return api;
    }
    K.createCompatibility = createCompatibility;
    K.compatibility = registry;
    const root = globalThis.window && (typeof globalThis.window === "object" || typeof globalThis.window === "function") ? globalThis.window : globalThis;
    for (const target of new Set([globalThis, root])) {
        for (const name of ["vendetta", "bunny"]) {
            try {
                Object.defineProperty(target, name, {
                    configurable: true,
                    enumerable: true,
                    get() { return createCompatibility("legacy-global"); },
                });
            } catch (error) { K.log.warn(`Could not expose ${name} compatibility global`, error); }
        }
    }
})(globalThis.__KORG_INTERNAL__);