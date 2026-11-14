(function (K) {
    "use strict";
    const methods = new WeakMap();
    let sequence = 0;

    function methodRecord(object, key) {
        let entries = methods.get(object);
        if (!entries) methods.set(object, entries = new Map());
        let record = entries.get(key);
        if (!record) {
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            const original = object[key];
            if (typeof original !== "function") throw new TypeError("Cannot patch a non-function method");
            record = { object, key, descriptor, original, patches: [] };
            entries.set(key, record);
        }
        return record;
    }
    function rebuild(record) {
        const active = record.patches.filter(item => item.active).sort((a, b) => a.order - b.order);
        let wrapped = record.original;
        for (const patch of active) {
            const next = wrapped;
            wrapped = function (...incoming) {
                const receiver = this;
                let args = incoming;
                if (patch.type === "before") {
                    const replacement = patch.callback(args, receiver);
                    if (Array.isArray(replacement)) args = replacement;
                    return next.apply(receiver, args);
                }
                if (patch.type === "instead") return patch.callback(args, (...replacementArgs) => next.apply(receiver, replacementArgs), receiver);
                const result = next.apply(receiver, args);
                const replacement = patch.callback(args, result, receiver);
                return replacement === undefined ? result : replacement;
            };
        }
        if (!active.length) {
            if (record.descriptor) Object.defineProperty(record.object, record.key, record.descriptor);
            else Object.defineProperty(record.object, record.key, { configurable: true, enumerable: true, writable: true, value: record.original });
            const entries = methods.get(record.object);
            entries.delete(record.key);
            if (!entries.size) methods.delete(record.object);
            return;
        }
        if (record.descriptor && "value" in record.descriptor) {
            Object.defineProperty(record.object, record.key, { ...record.descriptor, value: wrapped });
        } else {
            Object.defineProperty(record.object, record.key, { configurable: true, enumerable: record.descriptor ? record.descriptor.enumerable : true, writable: true, value: wrapped });
        }
    }
    function createScope(owner) {
        const owned = new Set();
        function add(type, method, object, callback) {
            if (!object || typeof callback !== "function") throw new TypeError("A patch needs a target and callback");
            const record = methodRecord(object, method);
            const patch = { type, callback, active: true, order: sequence++, record };
            record.patches.push(patch);
            owned.add(patch);
            rebuild(record);
            return function unpatch() {
                if (!patch.active) return;
                patch.active = false;
                owned.delete(patch);
                rebuild(record);
            };
        }
        const scope = { owner: String(owner || "anonymous") };
        for (const type of ["before", "after", "instead"]) scope[type] = (method, object, callback) => add(type, method, object, callback);
        scope.unpatchAll = () => {
            for (const patch of Array.from(owned)) {
                patch.active = false;
                owned.delete(patch);
                rebuild(patch.record);
            }
        };
        return scope;
    }
    K.patcher = { createScope };
})(globalThis.__KORG_INTERNAL__);