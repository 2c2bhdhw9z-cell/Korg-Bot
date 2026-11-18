(function (root) {
    "use strict";
    if (root.__KORG_INTERNAL__) return;
    const MAX_TEXT = 3000;
    const MAX_ERRORS = 20;
    const MAX_NATIVE_MESSAGES = 200;
    const MAX_STATUS_MESSAGES = 600;
    let nativeMessages = 0;
    let statusMessages = 0;
    let lastStatus = "";

    // Turns anything thrown into readable text. Never throws.
    function describe(value) {
        try {
            if (value && typeof value === "object" && ("message" in value || "stack" in value)) {
                const head = `${value.name || "Error"}: ${value.message === undefined ? "" : value.message}`;
                const stack = typeof value.stack === "string" ? value.stack : "";
                return stack ? (stack.indexOf(head) === 0 ? stack : `${head}\n${stack}`) : head;
            }
            return String(value);
        } catch (_) { return "(unprintable value)"; }
    }

    // The native loader installs __KORG_NATIVE__.report before this file runs. It is absent in tests and the browser
    // preview, and reporting must never be able to break the runtime.
    function deliver(kind, text) {
        const bridge = root.__KORG_NATIVE__;
        if (!bridge || typeof bridge.report !== "function") return false;
        bridge.report(`${kind}\n${String(text).slice(0, MAX_TEXT)}`);
        return true;
    }
    const native = {
        send(kind, text) {
            try {
                if (nativeMessages >= MAX_NATIVE_MESSAGES) return;
                if (deliver(kind, text)) nativeMessages += 1;
            } catch (_) { /* Diagnostics are best effort. */ }
        },
        // The status text is sent whenever it differs from the last one sent, so what the diagnostics screen shows is
        // always the latest state. (An earlier build sampled every 256th report, and the screen showed stale state.)
        // Status messages have their own budget so a burst of errors can never crowd them out.
        status(text) {
            try {
                const value = String(text);
                if (value === lastStatus || statusMessages >= MAX_STATUS_MESSAGES) return;
                if (deliver("status", value)) { lastStatus = value; statusMessages += 1; }
            } catch (_) { /* Diagnostics are best effort. */ }
        },
    };

    const K = {
        version: "0.2.0",
        ready: Promise.resolve(),
        errors: [],
        native,
        describe,
        _loggers: new Map(),
        // Remembers an error for the diagnostics screen and sends it to the native loader.
        reportError(source, error) {
            try {
                const text = `${source}: ${describe(error)}`.slice(0, MAX_TEXT);
                const last = K.errors[K.errors.length - 1];
                if (last && last.text === text) { last.count += 1; return last; }
                const entry = { at: Date.now(), text, count: 1 };
                K.errors.push(entry);
                if (K.errors.length > MAX_ERRORS) K.errors.shift();
                native.send("error", text);
                return entry;
            } catch (_) { return null; }
        },
        makeLogger(name) {
            const scope = String(name || "korg");
            if (this._loggers.has(scope)) return this._loggers.get(scope);
            const logger = {};
            // forEach, not a loop statement: Hermes would give every iteration's closure the same `level`.
            ["debug", "info", "warn", "error"].forEach(level => {
                logger[level] = (...args) => {
                    if (level === "warn" || level === "error") K.reportError(`${scope} ${level}`, args.map(describe).join(" "));
                    // The loader can run before the host installs a console; logging must never throw.
                    const sink = root.console;
                    if (!sink) return;
                    const method = sink[level] || sink.log;
                    if (typeof method === "function") { try { method.call(sink, `[Korg:${scope}]`, ...args); } catch { /* A broken console must not break the runtime. */ } }
                };
            });
            this._loggers.set(scope, logger);
            return logger;
        },
        // React Native defines ErrorUtils in its own startup, after Korg. Wrap the global handler as soon as it appears so
        // uncaught errors are recorded before the host handles (or crashes on) them.
        installErrorHooks() {
            function wrapHandler(handler) {
                if (typeof handler !== "function" || handler.__korgWrapped) return handler;
                const wrapped = function (error, isFatal) {
                    K.reportError(isFatal ? "Uncaught fatal error" : "Uncaught error", error);
                    return handler.apply(this, arguments);
                };
                wrapped.__korgWrapped = true;
                return wrapped;
            }
            function wrapUtils(utils) {
                try {
                    if (!utils || utils.__korgWrapped || typeof utils.setGlobalHandler !== "function") return utils;
                    const setGlobalHandler = utils.setGlobalHandler;
                    utils.setGlobalHandler = function (handler) { return setGlobalHandler.call(this, wrapHandler(handler)); };
                    if (typeof utils.getGlobalHandler === "function") {
                        const current = utils.getGlobalHandler();
                        if (current) setGlobalHandler.call(utils, wrapHandler(current));
                    }
                    utils.__korgWrapped = true;
                } catch (error) { K.reportError("ErrorUtils hook", error); }
                return utils;
            }
            // Release builds of React Native do not turn on Hermes' promise rejection tracking, so Korg does. HermesInternal
            // is frozen, so an existing tracker cannot be wrapped; a later call by the host simply replaces this one.
            try {
                const hermes = root.HermesInternal;
                if (hermes && typeof hermes.enablePromiseRejectionTracker === "function") {
                    const pending = new Map();
                    hermes.enablePromiseRejectionTracker({
                        allRejections: true,
                        onUnhandled(id, rejection) {
                            pending.set(id, rejection);
                            // A rejection is only reported if nothing handled it within a few microtask turns, because code
                            // often attaches its catch right after creating the promise.
                            Promise.resolve().then(() => null).then(() => null).then(() => null).then(() => {
                                if (!pending.has(id)) return;
                                pending.delete(id);
                                K.reportError("Unhandled promise rejection", rejection);
                            });
                        },
                        onHandled(id) { pending.delete(id); },
                    });
                }
            } catch (error) { K.reportError("Promise rejection hook", error); }
            try {
                const descriptor = Object.getOwnPropertyDescriptor(root, "ErrorUtils");
                if (descriptor && "value" in descriptor) { wrapUtils(descriptor.value); return; }
                if (descriptor && descriptor.configurable === false) return;
                let current = descriptor && descriptor.get ? descriptor.get.call(root) : undefined;
                Object.defineProperty(root, "ErrorUtils", {
                    configurable: true,
                    enumerable: true,
                    get() { return current; },
                    set(value) { current = wrapUtils(value); },
                });
                if (current) current = wrapUtils(current);
            } catch (error) { K.reportError("Error hook installation", error); }
        },
    };
    K.log = K.makeLogger("runtime");
    root.__KORG_INTERNAL__ = K;
    native.send("boot", `Korg ${K.version}: core loaded`);
})(globalThis);