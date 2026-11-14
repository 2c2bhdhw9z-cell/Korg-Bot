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
                    const method = console[level] || console.log;
                    method.call(console, `[Korg:${scope}]`, ...args);
                };
            }
            this._loggers.set(scope, logger);
            return logger;
        },
    };
    K.log = K.makeLogger("runtime");
    root.__KORG_INTERNAL__ = K;
})(globalThis);