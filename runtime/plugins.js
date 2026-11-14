(function (K) {
    "use strict";

    const STORE_KEY = "korg.runtime.plugins.v1";
    const MAX_SOURCE = 2 * 1024 * 1024;
    const entries = new Map();
    const active = new Map();
    const listeners = new Set();
    const storage = K.storage.createScope(STORE_KEY);
    let queue = Promise.resolve();
    let initialization;
    let initialized = false;
    let initializationError = null;

    function message(error) { return String(error && error.message || error); }
    function snapshot() {
        return Array.from(entries.values(), item => ({ ...item, source: undefined, active: active.has(item.id), hasSettings: Boolean(getSettings(item.id)) }));
    }
    function emit() {
        for (const listener of listeners) {
            try { listener(snapshot()); } catch (error) { K.log.warn("Plugin listener failed", error); }
        }
    }
    async function persist(items = entries) {
        await storage.AsyncStorage.setItem("registry", JSON.stringify({ version: 1, plugins: Array.from(items.values()) }));
        if (typeof storage.flush === "function") await storage.flush();
    }
    function serialized(work) {
        const result = queue.then(work);
        queue = result.catch(() => {});
        return result;
    }
    function makeId(url) { return `remote-${encodeURIComponent(url)}`; }
    function validHttps(value, base) {
        let parsed;
        try { parsed = base === undefined ? new URL(value) : new URL(value, base); }
        catch { throw new Error("Enter a valid HTTPS URL"); }
        if ((parsed.protocol || String(parsed.href).split(":")[0] + ":").toLowerCase() !== "https:") throw new Error("Only HTTPS plugin URLs are accepted");
        // Some React Native URL implementations omit protocol/pathname getters.
        if (typeof parsed.href !== "string" || !/^https:\/\/[^/\s?#]+/i.test(parsed.href)) throw new Error("Enter a valid HTTPS URL");
        return parsed.href;
    }
    function utf8Size(text) {
        if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
        let size = 0;
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            if (code < 0x80) size++;
            else if (code < 0x800) size += 2;
            else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xDC00 && text.charCodeAt(index + 1) <= 0xDFFF) { size += 4; index++; }
            else size += 3;
        }
        return size;
    }
    async function fetchText(url, limit) {
        if (typeof fetch !== "function") throw new Error("This runtime does not provide fetch");
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller && typeof setTimeout === "function" ? setTimeout(() => controller.abort(), 20000) : null;
        try {
            const response = await fetch(url, { redirect: "follow", ...(controller ? { signal: controller.signal } : {}) });
            if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
            const finalUrl = validHttps(response.url || url);
            const length = Number(response.headers && response.headers.get("content-length"));
            if (Number.isFinite(length) && length > limit) throw new Error("Downloaded file exceeds the 2 MiB limit");
            const text = await response.text();
            if (utf8Size(text) > limit) throw new Error("Downloaded file exceeds the 2 MiB limit");
            return { text, url: finalUrl };
        } finally { if (timer !== null) clearTimeout(timer); }
    }
    function parseManifest(text) {
        let manifest;
        try { manifest = JSON.parse(text); } catch { throw new Error("Plugin manifest is not valid JSON"); }
        if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Plugin manifest must be an object");
        if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new Error("Plugin manifest needs a name");
        if (manifest.main !== undefined && (typeof manifest.main !== "string" || !manifest.main || manifest.main.includes("..") || /^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(manifest.main))) {
            throw new Error("Manifest main must be a relative bundle path");
        }
        return manifest;
    }
    async function resolveSource(input, kind) {
        const url = validHttps(input);
        if (kind === "bundle") {
            const bundle = await fetchText(url, MAX_SOURCE);
            const name = url.split(/[?#]/)[0].split("/").pop() || "Remote plugin";
            return { ...bundle, name, description: "", manifestUrl: null, manifest: { name } };
        }
        if (kind !== "manifest") throw new Error("Choose a bundle URL or a manifest URL");
        const result = await fetchText(url, MAX_SOURCE);
        const manifest = parseManifest(result.text);
        const bundle = await fetchText(validHttps(manifest.main || "index.js", result.url), MAX_SOURCE);
        return { ...bundle, name: manifest.name.trim(), description: typeof manifest.description === "string" ? manifest.description : "", manifestUrl: result.url, manifest };
    }
    function evaluate(source, api) {
        const module = { exports: {} };
        const requirePlugin = name => {
            if (name === "react" || name === "react-native") {
                const provided = K.ui && K.ui.modules && K.ui.modules[name];
                return provided || K.metro.common[name === "react" ? "React" : "ReactNative"];
            }
            if (name === "vendetta" || name === "bunny") return api[name];
            const match = /^@(vendetta|bunny)\/(metro(?:\/common)?|patcher|storage|logger|ui(?:\/components)?|plugin)$/.exec(name);
            if (match) {
                const parts = match[2].split("/");
                const target = api[match[1]][parts[0]];
                if (target !== undefined) return parts[1] ? target[parts[1]] : target;
            }
            throw new Error(`Plugin dependency is not available: ${name}`);
        };
        let compiled;
        let expression = true;
        try { compiled = new Function("vendetta", "bunny", "module", "exports", "require", `return (${source}\n);`); }
        catch (error) {
            // Only compilation may fall back. A SyntaxError thrown by plugin code must run once.
            if (!(error instanceof SyntaxError)) throw error;
            expression = false;
            compiled = new Function("vendetta", "bunny", "module", "exports", "require", source);
        }
        const result = compiled(api.vendetta, api.bunny, module, module.exports, requirePlugin);
        let value = expression && result != null ? result : module.exports;
        if (value && value.default) value = value.default;
        if (typeof value === "function") value = { onLoad: value };
        if (!value || typeof value !== "object") throw new Error("Plugin bundle must export an object or lifecycle function");
        return value;
    }
    function cleanup(scope) {
        try {
            if (typeof scope.unpatchAll === "function") scope.unpatchAll();
            else if (scope.patcher && typeof scope.patcher.unpatchAll === "function") scope.patcher.unpatchAll();
        } catch (error) { K.log.error("Plugin patch cleanup failed", error); }
    }
    async function start(item) {
        if (active.has(item.id)) return;
        const scope = K.createCompatibility(item.id);
        try {
            const vendetta = scope.vendetta || scope;
            const bunny = scope.bunny || scope;
            const ownStorage = await (scope.storage || vendetta.storage).createStorage("settings", { defaults: {} });
            for (const api of new Set([vendetta, bunny])) {
                api.plugin = { id: item.id, manifest: item.manifest || { name: item.name, description: item.description }, options: item.options || {}, storage: ownStorage };
            }
            const plugin = evaluate(item.source, { vendetta, bunny });
            if (typeof plugin.onLoad === "function") await plugin.onLoad();
            active.set(item.id, { plugin, scope });
        } catch (error) { cleanup(scope); throw error; }
    }
    async function stop(item) {
        const record = active.get(item.id);
        if (!record) return;
        active.delete(item.id);
        try { if (typeof record.plugin.onUnload === "function") await record.plugin.onUnload(); }
        finally { cleanup(record.scope); }
    }
    function initialize() {
        if (initialization) return initialization;
        if (initialized) return Promise.resolve(snapshot());
        initialization = Promise.resolve().then(async () => {
            try {
                const raw = await storage.AsyncStorage.getItem("registry");
                const saved = raw == null ? null : JSON.parse(raw);
                if (saved != null && (saved.version !== 1 || !Array.isArray(saved.plugins))) throw new Error("Invalid plugin registry; cache left unchanged");
                const loaded = new Map();
                for (const item of saved && saved.plugins || []) {
                    if (!item || typeof item.source !== "string" || utf8Size(item.source) > MAX_SOURCE) throw new Error("Invalid cached plugin; cache left unchanged");
                    const inputUrl = validHttps(item.inputUrl || item.manifestUrl || item.url);
                    item.url = validHttps(item.url);
                    const id = makeId(inputUrl);
                    loaded.set(id, { ...item, id, inputUrl, kind: item.kind || (item.manifestUrl ? "manifest" : "bundle"), manifest: item.manifest || { name: item.name, description: item.description } });
                }
                for (const [id, item] of loaded) entries.set(id, item);
                initialized = true;
                initializationError = null;
                for (const item of entries.values()) {
                    if (!item.enabled) continue;
                    try { await start(item); }
                    catch (error) { item.error = message(error); K.log.error(`Plugin ${item.name} failed to start`, error); }
                }
                emit();
                return snapshot();
            } catch (error) {
                initializationError = message(error);
                K.log.error("Could not load remote plugin registry; writes blocked until retry", error);
                emit();
                throw error;
            } finally { initialization = null; }
        });
        // Callers still receive the rejection, but startup may intentionally proceed without awaiting it.
        initialization.catch(() => {});
        return initialization;
    }
    async function replace(previous, item) {
        const next = new Map(entries);
        next.set(item.id, item);
        // Never stop an enabled plugin or discard its cache until the new cache is saved.
        try { await persist(next); }
        catch (error) {
            try { await persist(); } catch (saveError) { K.log.error("Could not restore plugin cache after save failure", saveError); }
            throw error;
        }
        try {
            if (previous) await stop(previous);
            if (item.enabled) await start(item);
            entries.set(item.id, item);
        } catch (error) {
            if (previous) previous.error = message(error);
            try { await persist(); } catch (saveError) { K.log.error("Could not restore plugin cache", saveError); }
            if (previous && previous.enabled && !active.has(previous.id)) {
                try { await start(previous); } catch (startError) { K.log.error("Could not restart previous plugin", startError); }
            }
            emit();
            throw error;
        }
        emit();
        return snapshot().find(entry => entry.id === item.id);
    }
    async function install(url, options) {
        await initialize();
        const kind = typeof options === "string" ? options : options && options.kind || "bundle";
        const inputUrl = validHttps(url);
        return serialized(async () => {
            const resolved = await resolveSource(inputUrl, kind);
            const id = makeId(inputUrl);
            const previous = entries.get(id);
            const item = { id, inputUrl, kind, name: resolved.name, description: resolved.description, url: resolved.url, manifestUrl: resolved.manifestUrl, manifest: resolved.manifest,
                source: resolved.text, enabled: previous ? previous.enabled : false, installedAt: previous ? previous.installedAt : Date.now(), updatedAt: Date.now(), error: null,
                options: typeof options === "object" && options.options || previous && previous.options || {} };
            return replace(previous, item);
        });
    }
    async function update(id) {
        await initialize();
        return serialized(async () => {
            const previous = entries.get(id);
            if (!previous) throw new Error("Plugin is not installed");
            const resolved = await resolveSource(previous.inputUrl, previous.kind);
            return replace(previous, { ...previous, ...resolved, source: resolved.text, text: undefined, updatedAt: Date.now(), error: null });
        });
    }
    async function setEnabled(id, enabled) {
        await initialize();
        return serialized(async () => {
            const item = entries.get(id);
            if (!item) throw new Error("Plugin is not installed");
            if (Boolean(enabled) === Boolean(item.enabled) && (!enabled || active.has(id))) return;
            return replace(item, { ...item, enabled: Boolean(enabled), error: null });
        });
    }
    async function remove(id) {
        await initialize();
        return serialized(async () => {
            const item = entries.get(id);
            if (!item) return false;
            const next = new Map(entries);
            next.delete(id);
            try { await persist(next); }
            catch (error) {
                try { await persist(); } catch (saveError) { K.log.error("Could not restore plugin registry after save failure", saveError); }
                throw error;
            }
            try { await stop(item); }
            catch (error) {
                try { await persist(); } catch (saveError) { K.log.error("Could not restore plugin registry", saveError); }
                if (item.enabled) { try { await start(item); } catch (startError) { K.log.error("Could not restart plugin", startError); } }
                throw error;
            }
            entries.delete(id);
            emit();
            return true;
        });
    }
    function getSettings(id) {
        const record = active.get(id);
        if (!record) return null;
        const candidate = record.plugin.settings || record.plugin.Settings;
        return typeof candidate === "function" || candidate && typeof candidate === "object" ? candidate : null;
    }
    function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    function status() { return { initialized, loading: Boolean(initialization), error: initializationError }; }
    K.plugins = Object.freeze({ initialize, retry: initialize, install, update, setEnabled, remove, list: snapshot, subscribe, status, getSettings, isActive: id => active.has(id) });
})(globalThis.__KORG_INTERNAL__);