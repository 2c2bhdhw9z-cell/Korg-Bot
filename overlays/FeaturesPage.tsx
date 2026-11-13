/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * Adapted from Rain's plugin settings APIs at ra1ncord/rain@4b091e1698aa983c5f4e694ae243c9a6fd8b52fb.
 */
import { BundleUpdaterManager } from "@api/native/modules";
import { useSettings } from "@api/settings";
import { openAlert } from "@api/ui/alerts";
import { NavigationNative } from "@metro/common";
import { AlertActionButton, AlertActions, AlertModal, Stack, TableRow, TableRowGroup, TableSwitchRow, Text } from "@metro/common/components";
import { getPluginSettingsComponent, pluginInstances, usePluginSettings } from "@plugins";
import { useRef, useState } from "react";
import { Platform, ScrollView, TextInput, View } from "react-native";
import { categoryOrder, featureAvailability, featureCatalog, packChanges, packs, riskNotes, saveFeatures, flushBeforeReload, useFeatureStatus } from "./features";
import { useKorgRuntime } from "./runtime";

function confirm(title: string, content: string, action: string, proceed: () => void) {
    openAlert("korg-features-confirm", <AlertModal title={title} content={content} actions={<AlertActions>
        <AlertActionButton text={action} variant="primary" onPress={proceed} />
        <AlertActionButton text="Cancel" variant="secondary" />
    </AlertActions>} />);
}

export default function FeaturesPage() {
    const navigation = NavigationNative.useNavigation();
    const { safeMode, developerSettings } = useSettings();
    const settings = usePluginSettings(state => state.settings);
    const status = useFeatureStatus();
    const { settings: globalSettings, pendingOperations } = useKorgRuntime();
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("All");
    const [notice, setNotice] = useState("");
    const working = useRef(false);
    const catalog = featureCatalog(pluginInstances, developerSettings);
    const blocked = status.hydration !== "ready" || globalSettings !== "ready" || !usePluginSettings.persist.hasHydrated() || status.saving;
    const visible = catalog.filter(item => (category === "All" || item.category === category) &&
        `${item.plugin.name} ${item.plugin.description} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));

    async function apply(changes: Record<string, boolean>) {
        if (working.current || blocked) return;
        working.current = true;
        setNotice("");
        try {
            await saveFeatures(usePluginSettings, changes);
            setNotice("Saved. Reload Discord to apply changes.");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "Could not save feature preferences.");
        } finally { working.current = false; }
    }

    async function reload() {
        if (working.current) return;
        working.current = true;
        try {
            await flushBeforeReload();
            BundleUpdaterManager.reload();
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "Could not finish saving preferences. Try again.");
        } finally { working.current = false; }
    }

    function change(id: string, value: boolean) {
        const plugin = pluginInstances.get(id);
        if (!plugin || id.startsWith("core") || id === "customeffects" || plugin.devOnly && !developerSettings || featureAvailability(plugin, Platform.OS)) return;
        if (value && riskNotes[id]) {
            confirm(`Enable ${plugin.name}?`, `${riskNotes[id]} This change takes effect after reload.`, "Enable", () => void apply({ [id]: true }));
        } else void apply({ [id]: value });
    }

    async function retry() {
        if (working.current || status.saving) return;
        working.current = true;
        setNotice("");
        try {
            if (globalSettings === "error") await useSettings.persist.rehydrate();
            if (status.hydration === "error") await usePluginSettings.persist.rehydrate();
            if (useFeatureStatus.getState().hydration !== "ready" || useKorgRuntime.getState().settings !== "ready") {
                setNotice("Saved settings still could not be read. Check device storage and retry.");
            } else setNotice("Saved preferences loaded. Reload Discord to apply them.");
        } catch { setNotice("Could not load saved preferences. Retry loading."); }
        finally { working.current = false; }
    }

    return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 18, paddingBottom: 48 }}>
        <Stack spacing={18}>
            <Text variant="heading-lg/bold" accessibilityRole="header">Features</Text>
            <Text variant="text-sm/normal" color="text-muted">
                Bundled with Korg. No packs are applied automatically. Switches show saved choices, not what is running now. Changes apply after reload.
            </Text>
            {safeMode && <Text variant="text-sm/normal" color="text-muted">Safe mode is on. Saved feature choices will not run until safe mode is off and Discord is reloaded.</Text>}
            {status.pendingReload && <TableRowGroup title="Pending changes">
                <TableRow label="Reload to apply" subLabel="Finish calls or unsent messages first" disabled={status.saving || pendingOperations > 0}
                    onPress={() => confirm("Reload Discord?", "This can interrupt a call or an unsent message.", "Reload", () => void reload())} />
            </TableRowGroup>}
            {(status.hydration === "error" || globalSettings === "error") && <TableRowGroup title="Recovery">
                <TableRow label="Retry loading saved preferences" subLabel="No saved choices will be cleared" disabled={status.saving} onPress={() => void retry()} />
            </TableRowGroup>}
            <Text variant="text-sm/normal" accessibilityLiveRegion="polite" color="text-muted">
                {notice || (blocked ? "Waiting for saved preferences. Changes are paused." : `${catalog.length} bundled features available to browse.`)}
            </Text>
            <TableRowGroup title="Quick packs">
                {Object.entries(packs).map(([name, ids]) => {
                    const changes = packChanges(ids, pluginInstances, Platform.OS);
                    const remaining = Object.keys(changes).filter(id => !settings[id]?.enabled);
                    return <TableRow key={name} label={name} subLabel={`${Object.keys(changes).length} compatible features · ${remaining.length} not selected`}
                        trailing={<TableRow.TrailingText text="Add" />} disabled={blocked || remaining.length === 0}
                        onPress={() => void apply(Object.fromEntries(remaining.map(id => [id, true])))} />;
                })}
            </TableRowGroup>
            <TextInput value={query} onChangeText={setQuery} placeholder="Search features" accessibilityLabel="Search features"
                style={{ paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: "#777", borderRadius: 6, color: "#EAE3F5" }}
                placeholderTextColor="#B6A9CB" />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Feature categories">
                <View style={{ flexDirection: "row", gap: 8 }}>
                    {["All", ...categoryOrder].map(name => <Text key={name} onPress={() => setCategory(name)} accessibilityRole="button"
                        accessibilityState={{ selected: category === name }} style={{ padding: 9, color: category === name ? "#C6A5FF" : "#D4C7E8" }}>{name}</Text>)}
                </View>
            </ScrollView>
            {categoryOrder.map(group => {
                const items = visible.filter(item => item.category === group);
                if (!items.length) return null;
                return <TableRowGroup key={group} title={group}>
                    {items.map(({ id, plugin, availability }) => {
                        const component = getPluginSettingsComponent(id);
                        return <View key={id}>
                            <TableSwitchRow label={plugin.name} subLabel={`${plugin.description}${availability ? ` · ${availability}` : ""}${riskNotes[id] ? ` · ${riskNotes[id]}` : ""}`}
                                value={settings[id]?.enabled ?? false} disabled={blocked || Boolean(availability)}
                                onValueChange={(value: boolean) => change(id, value)} />
                            {component && <TableRow label={`${plugin.name} settings`} arrow subLabel="Plugin options; changes may need a reload"
                                onPress={() => navigation.push("RAIN_CUSTOM_PAGE", { title: plugin.name, render: component })} />}
                        </View>;
                    })}
                </TableRowGroup>;
            })}
            {!visible.length && <Text variant="text-sm/normal" color="text-muted">No matching features.</Text>}
        </Stack>
    </ScrollView>;
}
