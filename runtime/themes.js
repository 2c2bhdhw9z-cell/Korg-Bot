(function (K) {
    "use strict";

    const palettes = Object.freeze({
        graphite: { background: "#171A1D", surface: "#23282C", text: "#F0F2F3", muted: "#AAB2B8", accent: "#55C2A5", border: "#3A4248" },
        ember: { background: "#201916", surface: "#30231E", text: "#F5EDE8", muted: "#C0A99C", accent: "#F08A62", border: "#594238" },
        glacier: { background: "#151D22", surface: "#202C32", text: "#ECF4F5", muted: "#A5B9BD", accent: "#62C6D2", border: "#35474D" },
        orchard: { background: "#192019", surface: "#252F24", text: "#EFF3E9", muted: "#B0BDA7", accent: "#A5C96B", border: "#3F4D39" },
        plum: { background: "#211A20", surface: "#30252F", text: "#F3ECF2", muted: "#C0AEBE", accent: "#DA86B7", border: "#4B3948" },
        paper: { background: "#F2F2EE", surface: "#FFFFFF", text: "#202522", muted: "#68716C", accent: "#237E69", border: "#D3D8D2" },
    });
    const storage = K.storage.createScope("korg.runtime.appearance");
    let selected = "graphite";
    let initialization;
    let initialized = false;
    let initializationError = null;
    let queue = Promise.resolve();
    const listeners = new Set();
    for (const palette of Object.values(palettes)) Object.freeze(palette);

    function notify() {
        for (const listener of listeners) {
            try { listener(palettes[selected], selected); }
            catch (error) { K.log.warn("Appearance listener failed", error); }
        }
    }
    function initialize() {
        if (initialization) return initialization;
        if (initialized) return Promise.resolve(selected);
        initialization = Promise.resolve().then(async () => {
            try {
                const saved = await storage.AsyncStorage.getItem("selected");
                if (Object.prototype.hasOwnProperty.call(palettes, saved)) selected = saved;
                initialized = true;
                initializationError = null;
                notify();
                return selected;
            } catch (error) {
                initializationError = String(error && error.message || error);
                K.log.error("Could not load appearance preference", error);
                throw error;
            } finally { initialization = null; }
        });
        initialization.catch(() => {});
        return initialization;
    }
    async function select(name) {
        if (!Object.prototype.hasOwnProperty.call(palettes, name)) throw new Error("Unknown Korg theme");
        await initialize();
        const result = queue.then(async () => {
            await storage.AsyncStorage.setItem("selected", name);
            if (typeof storage.flush === "function") await storage.flush();
            selected = name;
            notify();
        });
        queue = result.catch(() => {});
        return result;
    }
    function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    K.themes = Object.freeze({ palettes, initialize, retry: initialize, select, subscribe, current: () => selected, colors: () => palettes[selected],
        status: () => ({ initialized, loading: Boolean(initialization), error: initializationError }) });
})(globalThis.__KORG_INTERNAL__);