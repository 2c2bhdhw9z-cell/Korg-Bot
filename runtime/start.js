(function (K) {
    "use strict";

    const startedAt = Date.now();
    K.runtime = Object.assign(K.runtime || {}, { ready: false, startedAt });
    let result;
    try {
        // AppRegistry must be wrapped in this stack, before the host registers its root.
        result = K.ui && typeof K.ui.initialize === "function" ? K.ui.initialize() : { attached: false, reason: "Korg UI module is unavailable" };
    } catch (error) {
        K.log.error("Korg UI initialization failed", error);
        result = { attached: false, reason: String(error && error.message || error) };
    }
    const boot = Promise.resolve(result).then(ui => {
        K.runtime = Object.assign(K.runtime || {}, { ready: true, startedAt, ui });
        return ui;
    }).catch(error => {
        K.log.error("Korg runtime startup failed", error);
        K.runtime = Object.assign(K.runtime || {}, { ready: false, startedAt, error: String(error && error.message || error) });
        return null;
    });
    K.runtime.boot = boot;
})(globalThis.__KORG_INTERNAL__);