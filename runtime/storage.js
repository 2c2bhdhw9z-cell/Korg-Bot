(function (K) {
    "use strict";
    let injectedBackend;
    const scopes = new Map();
    const queues = new Map();
    const rawTargets = new WeakMap();
    let discovering = false;

    function discoverBackend() {
        if (injectedBackend) return injectedBackend;
        if (globalThis.__KORG_TEST_DISABLE_DISCOVERY__ || !K.metro || discovering) return null;
        discovering = true;
        try { for (const exports of K.metro.getAll()) {
            for (const name of [null, "default"]) {
                let item;
                try { item = name === null ? exports : exports && exports[name]; } catch { continue; }
                if (item && ["getItem", "setItem", "removeItem"].every(key => typeof item[key] === "function")) return item;
            }
        }
        return null;
        } finally { discovering = false; }
    }
    function requireBackend() {
        const backend = discoverBackend();
        if (!backend) throw new Error("Korg storage unavailable: host AsyncStorage module has not been found");
        return backend;
    }
    function enqueue(id, operation) {
        const previous = queues.get(id) || Promise.resolve();
        const result = previous.catch(() => {}).then(operation);
        queues.set(id, result);
        result.catch(() => {});
        return result;
    }
    async function settled(id) {
        // Reads wait for writes, but a failed write must not permanently block reads.
        const pending = queues.get(id);
        if (pending) await pending.catch(() => {});
    }
    async function flush(id) {
        let pending;
        do {
            pending = queues.get(id);
            if (pending) await pending;
        } while (pending !== queues.get(id));
    }
    function makeAsyncStorage(id, suppliedBackend) {
        const prefix = `korg:${encodeURIComponent(id)}:`;
        const key = value => prefix + encodeURIComponent(String(value));
        const backend = () => suppliedBackend || requireBackend();
        const read = async operation => { await settled(id); return operation(backend()); };
        const allKeys = async store => {
            if (typeof store.getAllKeys !== "function") throw new Error("Storage backend does not implement getAllKeys");
            return (await store.getAllKeys()).filter(name => typeof name === "string" && name.startsWith(prefix));
        };
        // Multi operations are ordered batches, not transactions: a backend may fail partway.
        return Object.freeze({
            getItem(name) { return read(store => store.getItem(key(name))); },
            setItem(name, value) { const text = String(value); return enqueue(id, () => backend().setItem(key(name), text)); },
            removeItem(name) { return enqueue(id, () => backend().removeItem(key(name))); },
            multiGet(names) { const keys = Array.from(names, String); return read(store => Promise.all(keys.map(async name => [name, await store.getItem(key(name))]))); },
            multiSet(pairs) { const items = Array.from(pairs, ([name, value]) => [key(name), String(value)]); return enqueue(id, async () => { const store = backend(); for (const [name, value] of items) await store.setItem(name, value); }); },
            multiRemove(names) { const keys = Array.from(names, key); return enqueue(id, async () => { const store = backend(); for (const name of keys) await store.removeItem(name); }); },
            getAllKeys() { return read(async store => (await allKeys(store)).map(name => decodeURIComponent(name.slice(prefix.length)))); },
            clear() { return enqueue(id, async () => { const store = backend(); for (const name of await allKeys(store)) await store.removeItem(name); }); },
        });
    }
    const unwrap = value => rawTargets.get(value) || value;
    function serialize(value, replaced, replacement) {
        const ancestors = new Set();
        function copy(item) {
            item = unwrap(item);
            if (!item || typeof item !== "object") return item;
            if (ancestors.has(item)) throw new TypeError("Circular storage data cannot be persisted");
            ancestors.add(item);
            const source = item === replaced ? replacement : item;
            const output = Array.isArray(source) ? new Array(source.length) : {};
            for (const name of Object.keys(source)) {
                const descriptor = Object.getOwnPropertyDescriptor(source, name);
                if (!descriptor || !("value" in descriptor)) throw new TypeError("Storage data must use data properties, not getters");
                Object.defineProperty(output, name, { value: copy(descriptor.value), enumerable: true, configurable: true, writable: true });
            }
            ancestors.delete(item);
            return output;
        }
        return JSON.stringify(copy(value));
    }
    function clone(value) { return JSON.parse(serialize(value)); }
    function deepProxy(value, write, wait) {
        const proxies = new WeakMap();
        function wrap(item) {
            item = unwrap(item);
            if (!item || typeof item !== "object") return item;
            if (proxies.has(item)) return proxies.get(item);
            function change(target, property, operation) {
                if (target === value && property === "flush") throw new TypeError("Storage flush is reserved");
                if (operation.fixed) throw new TypeError("Persistent fixed storage properties cannot be changed");
                const shadow = Array.isArray(target) ? [] : {};
                for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(target))) {
                    const copy = { ...descriptor };
                    if ("value" in copy) copy.writable = true;
                    if (name !== "length") copy.configurable = true;
                    Object.defineProperty(shadow, name, copy);
                }
                if (!operation(shadow)) return false;
                // Validate and capture before changing live data. Circular writes leave it intact.
                const snapshot = serialize(value, target, shadow);
                if (!operation(target)) return false;
                write(snapshot);
                return true;
            }
            const proxy = new Proxy(item, {
                get(target, property, receiver) { return wrap(Reflect.get(target, property, receiver)); },
                set(target, property, next) {
                    const descriptor = Object.getOwnPropertyDescriptor(target, property);
                    const operation = object => Reflect.set(object, property, unwrap(next));
                    if (descriptor && !descriptor.configurable && !descriptor.writable) Object.defineProperty(operation, "fixed", { value: true });
                    return change(target, property, operation);
                },
                deleteProperty(target, property) {
                    const current = Object.getOwnPropertyDescriptor(target, property);
                    if (current && !current.configurable) throw new TypeError("Persistent fixed storage properties cannot be deleted");
                    return change(target, property, object => Reflect.deleteProperty(object, property));
                },
                defineProperty(target, property, descriptor) {
                    if (descriptor.get || descriptor.set) throw new TypeError("Storage data must use data properties, not getters");
                    const next = { ...descriptor };
                    if ("value" in next) next.value = wrap(unwrap(next.value));
                    const current = Object.getOwnPropertyDescriptor(target, property);
                    if (!current && descriptor.configurable === false && "value" in next && !descriptor.writable) {
                        throw new TypeError("Persistent fixed storage properties are not supported");
                    }
                    return change(target, property, object => Reflect.defineProperty(object, property, next));
                },
                preventExtensions() { throw new TypeError("Persistent storage objects must remain extensible"); },
                setPrototypeOf() { throw new TypeError("Persistent storage prototypes cannot be changed"); },
            });
            proxies.set(item, proxy);
            rawTargets.set(proxy, item);
            return proxy;
        }
        Object.defineProperty(value, "flush", { value: wait, enumerable: false, configurable: false, writable: false });
        return wrap(value);
    }
    function createScope(id) {
        id = String(id);
        if (scopes.has(id)) return scopes.get(id);
        const AsyncStorage = makeAsyncStorage(id);
        const named = new Map();
        const custom = new WeakMap();
        const wait = () => flush(id);
        // createStorage(name?, { defaults? }) returns a shared hydration Promise.
        // Value backends support get()/set(object) or read()/write(object), with no
        // host keys or host backend passed to them. They own their supplied data.
        // AsyncStorage backends use getItem/setItem(namespacedKey, JSON text).
        // Supplying any backend never changes Korg's process-wide backend.
        function createStorage(keyOrBackend = "settings", options = {}) {
            const isName = typeof keyOrBackend === "string";
            if (!isName && (!keyOrBackend || typeof keyOrBackend !== "object")) return Promise.reject(new TypeError("Expected a storage key or backend object"));
            const cache = isName ? named : custom;
            if (cache.has(keyOrBackend)) return cache.get(keyOrBackend);
            const promise = Promise.resolve().then(async () => {
                let read;
                let save;
                if (isName) {
                    read = async () => { const raw = await AsyncStorage.getItem(keyOrBackend); return raw == null ? null : JSON.parse(raw); };
                    save = text => AsyncStorage.setItem(keyOrBackend, text);
                } else {
                    const backend = keyOrBackend;
                    const pair = typeof backend.get === "function" && typeof backend.set === "function" ? ["get", "set"] :
                        typeof backend.read === "function" && typeof backend.write === "function" ? ["read", "write"] : null;
                    if (pair) {
                        read = async () => { await settled(id); return backend[pair[0]](); };
                        save = text => { const snapshot = JSON.parse(text); return enqueue(id, () => backend[pair[1]](snapshot)); };
                    } else if (typeof backend.getItem === "function" && typeof backend.setItem === "function") {
                        const own = makeAsyncStorage(id, backend);
                        const name = options.key === undefined ? "settings" : String(options.key);
                        read = async () => { const raw = await own.getItem(name); return raw == null ? null : JSON.parse(raw); };
                        save = text => own.setItem(name, text);
                    } else throw new TypeError("Storage backend must implement get/set, read/write, or getItem/setItem");
                }
                const loaded = await read();
                const defaults = options.defaults === undefined ? {} : options.defaults;
                const value = clone(loaded == null ? defaults : loaded);
                if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Storage root must be a JSON object");
                if (Object.prototype.hasOwnProperty.call(value, "flush")) throw new TypeError("Storage flush is reserved");
                return deepProxy(value, save, wait);
            });
            cache.set(keyOrBackend, promise);
            promise.catch(() => { if (cache.get(keyOrBackend) === promise) cache.delete(keyOrBackend); });
            return promise;
        }
        const scope = Object.freeze({ AsyncStorage, createStorage, flush: wait });
        scopes.set(id, scope);
        return scope;
    }
    K.storage = {
        createStorage: (keyOrBackend, options) => createScope("runtime").createStorage(keyOrBackend, options),
        createScope,
        AsyncStorage: createScope("runtime").AsyncStorage,
        async flushAll() {
            const results = await Promise.allSettled(Array.from(queues.keys(), flush));
            const failed = results.find(result => result.status === "rejected");
            if (failed) throw failed.reason;
        },
        setBackend(backend) {
            if (backend !== null && (!backend || typeof backend.getItem !== "function" || typeof backend.setItem !== "function" || typeof backend.removeItem !== "function")) throw new TypeError("Storage backend must implement getItem, setItem, and removeItem");
            injectedBackend = backend;
        },
        get status() { return discoverBackend() ? "persistent" : "unavailable"; },
    };
})(globalThis.__KORG_INTERNAL__);