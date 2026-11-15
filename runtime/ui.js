(function (K) {
    "use strict";

    // The host's React, react-native and AppRegistry. Each is recognised by a cheap check on the module that has just
    // finished loading, so attaching costs nothing per module. (An earlier build searched every module again on each
    // module load, which made start-up quadratic.)
    let React;
    let Native;
    let registry;
    let patchScope;
    let providerInstalled = false;
    let listening = false;
    let subscriptions = false;
    let capturing = false;
    let retrying = false;
    let lastPalette = null;
    let loading;
    let backendWasAvailable = false;
    let preferencesRequested = false;
    let heartbeatPending = false;
    let heartbeatTicks = 0;
    let boundary;
    const subscribers = new Set();
    const hostState = {
        attached: false, phase: "waiting", rootWrapped: false, reason: "Waiting for React Native application registry",
        react: false, reactNative: false, registry: "", composed: false, registered: [], ran: [], renders: 0, mounted: false, overlayError: "",
    };
    function status() { return { ...hostState, registered: hostState.registered.slice(), ran: hostState.ran.slice() }; }
    const names = list => (list.length ? list.join(", ") : "none");
    // The lines the diagnostics screen shows: what Korg found, what it did, and how far the app got.
    function describe() {
        const s = hostState;
        const lines = [
            `Host: React ${s.react ? "found" : "missing"}, react-native ${s.reactNative ? "found" : "missing"}, AppRegistry ${s.registry ? `found (${s.registry})` : "missing"}`,
            `Root: wrapper ${s.attached ? (s.composed ? "installed, combined with another" : "installed") : "not installed"}; apps registered: ${names(s.registered)}; apps run: ${names(s.ran)}`,
            `Overlay: phase=${s.phase}; ${s.renders ? "rendered" : "not rendered"}${s.mounted ? ", mounted" : ""}${s.overlayError ? `; ERROR ${s.overlayError}` : ""}`,
        ];
        if (s.reason) lines.push(`UI note: ${s.reason}`);
        return lines;
    }
    function report() {
        if (K.runtime && K.runtime.ui) Object.assign(K.runtime.ui, hostState);
        if (K.reportStatus) K.reportStatus();
    }
    // Explains why the UI is not attached yet; reported only when the explanation changes.
    function note(reason) {
        if (hostState.reason === reason) return;
        hostState.reason = reason;
        report();
    }
    const state = { visible: false, url: "", kind: "bundle", notice: "", plugins: [], theme: "graphite", busy: false, settingsId: null };

    // ---- Recognising the host's modules without reading anything that could run host code --------------------------
    const isObject = value => value !== null && (typeof value === "object" || typeof value === "function");
    function ownValue(object, key) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            return descriptor && "value" in descriptor ? descriptor.value : undefined;
        } catch { return undefined; }
    }
    // react-native's index defines its exports as lazy getters; asking whether one exists must not call it.
    function ownKey(object, key) {
        try { return Object.getOwnPropertyDescriptor(object, key) !== undefined; } catch { return false; }
    }
    const looksLikeReact = value => isObject(value) && ["createElement", "useState", "useEffect"].every(key => typeof ownValue(value, key) === "function");
    const looksLikeNative = value => isObject(value) && ["AppRegistry", "View", "Text", "Pressable", "Modal"].every(key => ownKey(value, key));
    const looksLikeRegistry = value => isObject(value) && ["registerComponent", "runApplication", "setWrapperComponentProvider"].every(key => typeof ownValue(value, key) === "function");
    function adoptReact(value) { React = value; hostState.react = true; if (K.metro && K.metro.prefer) K.metro.prefer("React", value); }
    function adoptNative(value) { Native = value; hostState.reactNative = true; if (K.metro && K.metro.prefer) K.metro.prefer("ReactNative", value); }
    function adoptRegistry(value, source) { registry = value; hostState.registry = source; }
    // Looks at one module's exports, and at the two places an AppRegistry export hides: `default` and `.AppRegistry`.
    function considerExports(exports) {
        if (!isObject(exports) || (React && Native && registry)) return;
        for (const candidate of [exports, ownValue(exports, "default"), ownValue(exports, "AppRegistry")]) {
            if (!isObject(candidate)) continue;
            if (!React && looksLikeReact(candidate)) adoptReact(candidate);
            if (!Native && looksLikeNative(candidate)) adoptNative(candidate);
            if (!registry && looksLikeRegistry(candidate)) adoptRegistry(candidate, "module");
        }
    }
    // React Native's AppRegistry module also stores the registry in a global. Watching that global finds the registry
    // at the moment it is created, and works even if Metro's hooks were installed too late to see the module.
    function considerGlobalRegistry(value) {
        if (registry || !isObject(value)) return;
        let usable = false;
        try { usable = typeof value.registerComponent === "function" && typeof value.setWrapperComponentProvider === "function"; } catch { usable = false; }
        if (usable) { adoptRegistry(value, "RN$AppRegistry"); progress(); }
    }
    function watchRegistryGlobal() {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, "RN$AppRegistry");
            if (descriptor) { if ("value" in descriptor) considerGlobalRegistry(descriptor.value); return; }
            Object.defineProperty(globalThis, "RN$AppRegistry", {
                configurable: true,
                enumerable: true,
                get() { return undefined; },
                set(value) {
                    // Become an ordinary property again first: the native side reads this global to start the app.
                    Object.defineProperty(globalThis, "RN$AppRegistry", { value, writable: true, configurable: true, enumerable: true });
                    try { considerGlobalRegistry(value); } catch (error) { K.log.warn("Korg could not inspect AppRegistry", error); }
                },
            });
        } catch (error) { K.log.warn("Korg could not watch RN$AppRegistry", error); }
    }
    // Slower, broader search for anything still missing. Only runs from a timer or a render, never during module loading.
    function resolveHost() {
        const supplied = K.ui && K.ui.modules;
        if (supplied) {
            if (!React && supplied.react) adoptReact(supplied.react);
            if (!Native && supplied["react-native"]) adoptNative(supplied["react-native"]);
        }
        if ((!React || !Native || !registry) && K.metro && typeof K.metro.getAll === "function") {
            let modules = [];
            try { modules = K.metro.getAll(); } catch { modules = []; }
            for (const exports of modules) {
                considerExports(exports);
                if (React && Native && registry) break;
            }
        }
        const find = (...properties) => { try { return K.metro && K.metro.findByProps ? K.metro.findByProps(...properties) : undefined; } catch { return undefined; } };
        if (!React) { const found = find("createElement", "useState", "useEffect"); if (found) adoptReact(found); }
        if (!Native) { const found = find("View", "Text", "AppRegistry"); if (found) adoptNative(found); }
        if (!registry) { const found = find("registerComponent", "getAppKeys", "setWrapperComponentProvider"); if (found) adoptRegistry(found, "module scan"); }
        if (!registry && Native) {
            // Reading a lazy export can start module initialization, which is only safe from here.
            try { const candidate = Native.AppRegistry; if (isObject(candidate) && typeof candidate.setWrapperComponentProvider === "function") adoptRegistry(candidate, "react-native export"); } catch { /* Not available yet. */ }
        }
        progress();
    }

    function update(values) {
        Object.assign(state, values);
        for (const listener of subscribers) {
            try { listener(); } catch (error) { K.log.warn("UI subscriber failed", error); }
        }
    }
    function colors() { return K.themes.colors(); }
    function notifyTheme(palette, theme) {
        if (theme === state.theme && palette === lastPalette) return;
        lastPalette = palette;
        state.theme = theme;
        update({});
    }
    function useState() {
        const [, render] = React.useState(0);
        return render;
    }
    function subscribeRender(render) {
        React.useEffect(() => {
            const listener = () => render(value => value + 1);
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        }, []);
    }
    async function perform(callback) {
        if (state.busy) return;
        update({ busy: true, notice: "Working..." });
        try { await callback(); update({ notice: "Saved" }); }
        catch (error) { update({ notice: String(error && error.message || error) }); }
        finally { update({ busy: false, plugins: K.plugins.list() }); }
    }
    function Button(props) {
        const palette = colors();
        const disabled = Boolean(props.disabled || state.busy);
        return React.createElement(Native.Pressable || Native.TouchableOpacity || Native.View, {
            onPress: disabled ? undefined : props.onPress, disabled, accessibilityRole: "button",
            accessibilityState: { disabled }, style: { padding: 11, marginVertical: 3, borderRadius: 5, backgroundColor: palette.surface, borderColor: palette.accent, borderWidth: 1, opacity: disabled ? 0.5 : 1 },
        }, React.createElement(Native.Text, { style: { color: palette.text, fontWeight: "600", textAlign: "center" } }, props.title));
    }
    function Text(props) {
        const palette = colors();
        return React.createElement(Native.Text, { style: { color: props.muted ? palette.muted : palette.text, marginVertical: 4 } }, props.children);
    }
    function close() { if (!state.busy) update({ visible: false, settingsId: null }); }
    function open() { update({ visible: true }); }
    function Settings() {
        const render = useState();
        subscribeRender(render);
        const current = state;
        const palette = colors();
        const View = Native.View;
        const pluginStatus = K.plugins.status ? K.plugins.status() : {};
        const themeStatus = K.themes.status ? K.themes.status() : {};
        const rows = current.plugins.map(item => React.createElement(View, { key: item.id, style: { paddingVertical: 8, borderBottomWidth: 1, borderColor: palette.border } },
            React.createElement(Native.Text, { style: { color: palette.text, fontWeight: "600" } }, item.name),
            item.description ? React.createElement(Text, { muted: true }, item.description) : null,
            item.error ? React.createElement(Text, { muted: true }, item.error) : null,
            React.createElement(View, { style: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 } },
                React.createElement(Button, { title: item.enabled ? "Disable" : "Enable", onPress: () => perform(() => K.plugins.setEnabled(item.id, !item.enabled)) }),
                React.createElement(Button, { title: "Update", onPress: () => perform(() => K.plugins.update(item.id)) }),
                React.createElement(Button, { title: "Remove", onPress: () => perform(() => K.plugins.remove(item.id)) }),
                item.hasSettings ? React.createElement(Button, { title: "Settings", onPress: () => update({ settingsId: item.id }) }) : null)));
        const pluginSettings = current.settingsId && K.plugins.getSettings(current.settingsId);
        const content = pluginSettings ? React.createElement(View, null,
            React.createElement(Text, null, "Plugin settings"),
            typeof pluginSettings === "function" ? React.createElement(pluginSettings) : React.createElement(Text, null, JSON.stringify(pluginSettings)), 
            React.createElement(Button, { title: "Back", onPress: () => update({ settingsId: null }) })) : React.createElement(Native.ScrollView || View, Native.ScrollView ? { keyboardShouldPersistTaps: "handled" } : null,
            React.createElement(Native.Text, { style: { color: palette.text, fontSize: 21, fontWeight: "700", marginBottom: 12 } }, "Korg"),
            React.createElement(Text, null, "Remote plugins execute code with this app's privileges. Only install bundles you trust."),
            Native.TextInput ? React.createElement(Native.TextInput, { value: current.url, editable: !current.busy, onChangeText: url => { if (!state.busy) update({ url }); },
                placeholder: "https://.../plugin.js", placeholderTextColor: palette.muted, autoCapitalize: "none", autoCorrect: false, keyboardType: "url", accessibilityLabel: "Plugin URL",
                style: { color: palette.text, borderColor: palette.border, borderWidth: 1, padding: 10, marginVertical: 10 } }) : React.createElement(Text, { muted: true }, "Host text input is unavailable"),
            React.createElement(View, { style: { flexDirection: "row", gap: 8 } },
                React.createElement(Button, { title: current.kind === "bundle" ? "Bundle URL selected" : "Use bundle URL", onPress: () => update({ kind: "bundle" }) }),
                React.createElement(Button, { title: current.kind === "manifest" ? "Manifest selected" : "Use manifest", onPress: () => update({ kind: "manifest" }) })),
            React.createElement(Button, { title: "Install (disabled by default)", disabled: !current.url.trim() || !Native.TextInput,
                onPress: () => perform(async () => { await K.plugins.install(current.url.trim(), { kind: current.kind }); update({ url: "" }); }) }),
            React.createElement(Text, { muted: true }, current.notice),
            pluginStatus.error ? React.createElement(Text, { muted: true }, `Plugin cache: ${pluginStatus.error}`) : null,
            themeStatus.error ? React.createElement(Text, { muted: true }, `Appearance: ${themeStatus.error}`) : null,
            React.createElement(Button, { title: "Retry loading saved preferences", onPress: () => perform(retry) }),
            React.createElement(Native.Text, { style: { color: palette.text, fontSize: 17, fontWeight: "600", marginTop: 18 } }, `Plugins (${current.plugins.length})`),
            ...rows,
            React.createElement(Native.Text, { style: { color: palette.text, fontSize: 17, fontWeight: "600", marginTop: 18 } }, "Korg appearance"),
            React.createElement(Text, { muted: true }, "These colors apply to Korg's controls and settings."),
            ...Object.keys(K.themes.palettes).map(name => React.createElement(Button, { key: name, title: `${name === current.theme ? "• " : ""}${name}`, onPress: () => perform(() => K.themes.select(name)) })));
        const panel = React.createElement(Native.SafeAreaView || View, { style: { flex: 1, padding: 18, backgroundColor: palette.background } },
            content, React.createElement(Button, { title: "Close", onPress: close }));
        if (Native.Modal) return React.createElement(Native.Modal, { visible: current.visible, animationType: "slide", onRequestClose: close }, panel);
        return current.visible ? React.createElement(View, { style: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 } }, panel) : null;
    }
    // ---- The wrapper the app is rendered inside ---------------------------------------------------------------------
    // AppRegistry reads its wrapper provider every time an app starts, so installing ours works whether Discord has
    // registered its root yet or not, and needs no change to the app's own registration.
    function getBoundary() {
        if (boundary !== undefined) return boundary;
        if (!React || typeof React.Component !== "function") return (boundary = null);
        class KorgBoundary extends React.Component {
            constructor(props) { super(props); this.state = { failed: false }; }
            static getDerivedStateFromError() { return { failed: true }; }
            componentDidCatch(error) {
                hostState.overlayError = String(error && error.message || error).slice(0, 200);
                K.reportError("Korg overlay render error", error);
                report();
            }
            render() { return this.state.failed ? null : this.props.children; }
        }
        return (boundary = KorgBoundary);
    }
    function Overlay(props) {
        const render = useState();
        subscribeRender(render);
        React.useEffect(() => { if (!hostState.mounted) { hostState.mounted = true; report(); } }, []);
        hostState.renders += 1;
        if (hostState.phase !== "rendered") { hostState.phase = "rendered"; report(); hostReady(); }
        const controls = [
            React.createElement(Native.View, { key: "korg-button", style: { position: "absolute", right: 12, bottom: 24 } }, React.createElement(Button, { title: "K", onPress: open })),
            React.createElement(Settings, { key: "korg-settings" }),
        ];
        const Guard = getBoundary();
        // The app sits beside the controls, never inside the guard, so a failure in Korg's UI cannot take the app down.
        return React.createElement(Native.View, { style: { flex: 1 } }, props.children, Guard ? React.createElement(Guard, null, controls) : controls);
    }
    function KorgWrapper(props) {
        if (!React || !Native) resolveHost();
        // Without React there is nothing to draw with: show the app untouched rather than a blank screen.
        if (!React || !Native || !K.plugins || !K.themes) return props.children === undefined ? null : props.children;
        return React.createElement(Overlay, props);
    }
    function wrapperProvider() {
        hostState.rootWrapped = true;
        if (hostState.phase !== "rendered") hostState.phase = "wrapped";
        report();
        return KorgWrapper;
    }
    wrapperProvider.__korg = true;
    // If something else installs its own wrapper later, run both rather than losing one.
    function combine(theirs) {
        function combined(params) {
            const Inner = theirs(params);
            if (!Inner || !React) return Inner || KorgWrapper;
            return function Combined(props) { return React.createElement(KorgWrapper, null, React.createElement(Inner, props)); };
        }
        combined.__korg = true;
        return combined;
    }
    function remember(list, name) {
        const text = String(name);
        if (list.includes(text) || list.length >= 8) return;
        list.push(text);
        report();
    }
    function installProvider() {
        if (providerInstalled || !registry || !K.patcher) return providerInstalled;
        try {
            const scope = patchScope || (patchScope = K.patcher.createScope("korg-runtime-ui"));
            // Observers only: they record which apps register and run, and never change the call.
            scope.before("registerComponent", registry, args => { remember(hostState.registered, args[0]); });
            scope.before("runApplication", registry, args => { remember(hostState.ran, args[0]); hostReady(); });
            scope.before("setWrapperComponentProvider", registry, args => {
                const next = args[0];
                if (typeof next !== "function" || next.__korg) return;
                hostState.composed = true;
                args[0] = combine(next);
            });
            registry.setWrapperComponentProvider(wrapperProvider);
            providerInstalled = true;
            try { if (typeof registry.getAppKeys === "function") for (const key of registry.getAppKeys()) remember(hostState.registered, key); } catch { /* Optional detail. */ }
            Object.assign(hostState, { attached: true, phase: hostState.phase === "waiting" ? "captured" : hostState.phase });
            update({ plugins: K.plugins ? K.plugins.list() : [], theme: K.themes ? K.themes.current() : "graphite" });
        } catch (error) {
            K.log.warn("Korg UI host attachment failed", error);
            note(`Host attachment failed: ${String(error && error.message || error)}`);
        }
        return providerInstalled;
    }
    // Brings the explanation and the diagnostics up to date after anything was found.
    function progress() {
        if (registry && !providerInstalled) installProvider();
        const missing = [];
        if (!React) missing.push("React");
        if (!Native) missing.push("react-native");
        if (!registry) missing.push("AppRegistry");
        if (hostState.reason && hostState.reason.indexOf("Host attachment failed") === 0) { report(); return providerInstalled; }
        const reason = missing.length ? `Waiting for host modules: ${missing.join(", ")} not found yet` : null;
        if (hostState.reason !== reason) { hostState.reason = reason; }
        report();
        return providerInstalled;
    }
    // The app is starting (or has started), so saved plugins and appearance can load without racing the host's modules.
    function hostReady() {
        if (preferencesRequested || !K.plugins || !K.themes) return;
        preferencesRequested = true;
        backendWasAvailable = Boolean(K.storage && K.storage.status === "persistent");
        retry().catch(() => {});
    }
    function retry() {
        if (loading) return loading;
        retrying = true;
        let retryPromise;
        retryPromise = Promise.all([
            Promise.resolve().then(() => K.plugins.retry ? K.plugins.retry() : K.plugins.initialize()),
            Promise.resolve().then(() => K.themes.retry ? K.themes.retry() : K.themes.initialize()),
        ].map(promise => promise.then(value => ({ value }), error => ({ error })))).then(results => {
            update({ plugins: K.plugins.list(), theme: K.themes.current() });
            const failed = results.find(result => result.error);
            if (failed) throw failed.error;
            return results;
        }).finally(() => { retrying = false; if (loading === retryPromise) loading = null; if (React && Native && !subscribers.size) update({}); });
        loading = retryPromise;
        loading.catch(error => { update({ notice: String(error && error.message || error) }); });
        return loading;
    }
    function onCapture(value) {
        if (capturing) return;
        capturing = true;
        try { if (!React || !Native || !registry) { considerExports(value); if (registry && !providerInstalled) progress(); } }
        catch (error) { K.log.warn("Korg could not inspect a module", error); }
        finally { capturing = false; }
        if (React && Native && registry) { /* nothing more to look for */ } else startHeartbeat();
        if (!preferencesRequested) return;
        const available = !retrying && K.storage && K.storage.status === "persistent";
        if (available && !backendWasAvailable && K.plugins && K.themes) {
            backendWasAvailable = true;
            // A backend can arrive while the first read is already failing.
            if (loading) loading.then(() => {}, () => { retry(); });
            else retry();
        } else if (!available) backendWasAvailable = false;
    }
    // A slow safety net: some of this only happens after the host has finished loading, and nothing else would run then.
    function startHeartbeat() {
        if (heartbeatPending || typeof globalThis.setTimeout !== "function") return;
        if (hostState.mounted || heartbeatTicks >= 150) return;
        heartbeatPending = true;
        const timer = globalThis.setTimeout(tick, heartbeatTicks < 20 ? 1000 : 5000);
        if (timer && typeof timer.unref === "function") timer.unref();
    }
    function tick() {
        heartbeatPending = false;
        heartbeatTicks += 1;
        try {
            if (!React || !Native || !registry) resolveHost(); else progress();
            if (heartbeatTicks >= 5) hostReady();
        } catch (error) { K.log.warn("Korg UI heartbeat failed", error); }
        startHeartbeat();
    }
    function initialize() {
        // Subscribe and watch before touching persistence or yielding to a promise.
        watchRegistryGlobal();
        if (!listening && K.metro && typeof K.metro.subscribe === "function") {
            listening = true;
            K.metro.subscribe(onCapture);
        }
        if (!subscriptions && K.plugins && K.themes) {
            subscriptions = true;
            K.plugins.subscribe(plugins => update({ plugins }));
            if (typeof K.themes.subscribe === "function") K.themes.subscribe((palette, theme) => notifyTheme(palette, theme));
        }
        // At boot this finds nothing and costs nothing; when called later it looks for anything still missing.
        if (!React || !Native || !registry) resolveHost(); else progress();
        startHeartbeat();
        return hostState;
    }
    K.ui = Object.assign(K.ui || {}, { status, describe, initialize, retry, openSettings: open,
        components: Object.assign(K.ui && K.ui.components || {}, { Text, Button }),
        showToast: message => {
            if (!Native) resolveHost();
            if (Native && Native.Alert && typeof Native.Alert.alert === "function") Native.Alert.alert("Korg", String(message));
            else update({ notice: String(message) });
        } });
})(globalThis.__KORG_INTERNAL__);
