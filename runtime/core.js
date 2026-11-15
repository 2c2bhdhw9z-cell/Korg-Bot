(function (root) {
    "use strict";
    if (root.__KORG_INTERNAL__) return;
    const K = {
        version: "0.2.0",
        ready: Promise.resolve(),
        _loggers: new Map(),
        makeLogger(name) {
            const scope = String(name || "korg");
            if (this._loggers.has(scope)) return this._loggers.get(scope);
            const logger = {};
            for (const level of ["debug", "info", "warn", "error"]) {
                logger[level] = (...args) => {
                    // The loader can run before the host installs a console; logging must never throw.
                    const sink = root.console;
                    if (!sink) return;
                    const method = sink[level] || sink.log;
                    if (typeof method === "function") { try { method.call(sink, `[Korg:${scope}]`, ...args); } catch { /* A broken console must not break the runtime. */ } }
                };
            }
            this._loggers.set(scope, logger);
            return logger;
        },
    };
    K.log = K.makeLogger("runtime");
    root.__KORG_INTERNAL__ = K;
})(globalThis);