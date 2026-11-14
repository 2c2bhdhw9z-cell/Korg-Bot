(function (K) {
    "use strict";

    let React;
    let Native;
    let attachedRegistry;
    let listening = false;
    let enumerationHooked = false;
    let subscriptions = false;
    let attaching = false;
    let capturing = false;
    let retrying = false;
    let registeredScopes = 0;
    let lastPalette = null;
    let loading;
    let backendWasAvailable = false;
    const subscribers = new Set();
    const hostState = { attached: false, reason: "Waiting for React Native application registry" };
    const state = { visible: false, url: "", kind: "bundle", notice: "", plugins: [], theme: "graphite", busy: false, settingsId: null };

    function hostModule(name, common, required) {
        const supplied = K.ui && K.ui.modules && K.ui.modules[name];
        if (supplied) return supplied;
        try { if (K.metro && K.metro.common && K.metro.common[common]) return K.metro.common[common]; } catch { /* Not captured yet. */ }
        if (globalThis[common]) return globalThis[common];
        try { return K.metro && K.metro.findByProps(...required); } catch { return undefined; }
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
            React.createElement(Button, { title: "Back", onPress: () => update({ settingsId: null }) })) : React.createElement(Native.ScrollView || View, null,
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
    function Overlay(props) {
        const render = useState();
        subscribeRender(render);
        return React.createElement(Native.View, { style: { flex: 1 } },
            React.createElement(props.Component, props.props),
            React.createElement(Native.View, { style: { position: "absolute", right: 12, bottom: 24 } }, React.createElement(Button, { title: "K", onPress: open })),
            React.createElement(Settings));
    }
    function attach() {
        if (attaching) return Boolean(attachedRegistry);
        attaching = true;
        try {
            const resolvedReact = hostModule("react", "React", ["createElement", "useState", "useEffect"]);
            const resolvedNative = hostModule("react-native", "ReactNative", ["View", "Text", "AppRegistry"]);
            if (resolvedReact) React = resolvedReact;
            if (resolvedNative) Native = resolvedNative;
            const registry = Native && Native.AppRegistry;
            if (!registry || typeof registry.registerComponent !== "function" || !K.patcher) return false;
            if (registry === attachedRegistry) return true;
            const scope = K.patcher.createScope("korg-runtime-ui");
            registeredScopes++;
            scope.before("registerComponent", registry, args => {
                const provider = args[1];
                if (typeof provider !== "function" || args[0] === "KorgRuntimeUI") return;
                args[1] = function (...providerArgs) {
                    const Component = provider.apply(this, providerArgs);
                    function KorgOverlay(props) {
                        useState();
                        // React can arrive after AppRegistry. Resolve again when the host renders.
                        attach();
                        if (!React || !Native || !K.plugins || !K.themes) return null;
                        return React.createElement(Overlay, { Component, props });
                    }
                    return React && Native ? React.createElement(KorgOverlay, providerArgs[0] || {}) : KorgOverlay;
                };
            });
            attachedRegistry = registry;
            Object.assign(hostState, { attached: true, reason: null });
            if (K.runtime && K.runtime.ui) Object.assign(K.runtime.ui, hostState);
            update({ plugins: K.plugins ? K.plugins.list() : [], theme: K.themes ? K.themes.current() : "graphite" });
            return true;
        } catch (error) { K.log.warn("Korg UI host attachment failed", error); return false; }
        finally { attaching = false; }
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
    function onCapture() {
        if (capturing) return;
        capturing = true;
        try { attach(); } finally { capturing = false; }
        const available = !capturing && !retrying && K.storage && K.storage.status === "persistent";
        if (available && !backendWasAvailable && K.plugins && K.themes) {
            backendWasAvailable = true;
            // A backend can arrive while the first read is already failing.
            if (loading) loading.then(() => {}, () => { retry(); });
            else retry();
        } else if (!available) backendWasAvailable = false;
    }
    function initialize() {
        // Subscribe and hook before touching persistence or yielding to a promise.
        if (!listening && K.metro && typeof K.metro.subscribe === "function") {
            listening = true;
            K.metro.subscribe(onCapture);
        }
        if (!enumerationHooked && !registeredScopes && K.metro && K.metro.getAll && K.patcher) {
            enumerationHooked = true;
            const scope = K.patcher.createScope("korg-runtime-ui-metro");
            scope.after("getAll", K.metro, (_args, modules) => { onCapture(); return modules; });
        }
        attach();
        if (!subscriptions && K.plugins && K.themes) {
            subscriptions = true;
            K.plugins.subscribe(plugins => update({ plugins }));
            if (typeof K.themes.subscribe === "function") K.themes.subscribe((palette, theme) => notifyTheme(palette, theme));
            retry();
        }
        return hostState;
    }
    K.ui = Object.assign(K.ui || {}, { initialize, retry, openSettings: open,
        components: Object.assign(K.ui && K.ui.components || {}, { Text, Button }),
        showToast: message => {
            attach();
            if (Native && Native.Alert && typeof Native.Alert.alert === "function") Native.Alert.alert("Korg", String(message));
            else update({ notice: String(message) });
        } });
})(globalThis.__KORG_INTERNAL__);