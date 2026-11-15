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
    // Patched components keep displayName and other statics so name lookups still find them.
    function copyStatics(from, to) {
        for (const key of Reflect.ownKeys(from)) {
            if (key === "name" || key === "length" || key === "prototype" || key === "caller" || key === "arguments") continue;
            try { Object.defineProperty(to, key, Object.getOwnPropertyDescriptor(from, key)); } catch { /* A fixed property stays as the wrapper defined it. */ }
        }
    }
    function rebuild(record) {
        const active = record.patches.filter(item => item.active).sort((a, b) => a.order - b.order);
        let wrapped = record.original;
        for (const patch of active) {
            const next = wrapped;
            wrapped = function (...incoming) {
                const receiver = this;
                // A reference captured before unpatch() must stop running the callback.
                if (!patch.active) return next.apply(receiver, incoming);
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
            // The method was inherited: drop our own copy instead of shadowing the prototype forever.
            else Reflect.deleteProperty(record.object, record.key);
            const entries = methods.get(record.object);
            entries.delete(record.key);
            if (!entries.size) methods.delete(record.object);
            return;
        }
        copyStatics(record.original, wrapped);
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
            try { rebuild(record); }
            catch (error) {
                // The property could not be redefined (for example it is non-configurable): leave no ghost patch behind.
                record.patches.splice(record.patches.indexOf(patch), 1);
                owned.delete(patch);
                if (!record.patches.length) {
                    const entries = methods.get(object);
                    if (entries) { entries.delete(method); if (!entries.size) methods.delete(object); }
                }
                throw error;
            }
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
            let failure;
            for (const patch of Array.from(owned)) {
                patch.active = false;
                owned.delete(patch);
                // One failed restore must not leave the remaining patches installed.
                try { rebuild(patch.record); } catch (error) { if (failure === undefined) failure = { error }; }
            }
            if (failure) throw failure.error;
        };
        return scope;
    }
    K.patcher = { createScope };
})(globalThis.__KORG_INTERNAL__);