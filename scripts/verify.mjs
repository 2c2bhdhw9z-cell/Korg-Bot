import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "dist");
const names = ["core.js", "metro.js", "patcher.js", "storage.js", "compat.js", "themes.js", "plugins.js", "ui.js", "start.js"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
assert.equal(manifest.name, "KorgOriginalRuntime");
assert.equal(manifest.version, "0.2.0");
assert.deepEqual(manifest.plugins, []);
assert.deepEqual(manifest.dependencies, []);
assert.equal(manifest.thirdPartyPluginsBundled, false);
assert.deepEqual(manifest.runtimeDependenciesBundled, []);
assert.deepEqual(Object.keys(manifest.sources).sort(), names.map(name => `runtime/${name}`).sort());
let expected = "";
for (const name of names) {
    const bytes = await readFile(path.join(root, "runtime", name));
    assert.equal(manifest.sources[`runtime/${name}`], hash(bytes), `${name}: source hash mismatch`);
    expected += `// Source: runtime/${name}\n${bytes.toString("utf8").trimEnd()}\n\n`;
}
const bundle = await readFile(path.join(dist, "korg.js"), "utf8");
assert.equal(bundle, expected, "Bundle is not exact deterministic source concatenation");
new vm.Script(bundle, { filename: "korg.js" });
console.log(`Verified ${manifest.name} ${manifest.version}: ${names.length} local sources, syntax, and hashes; plugins and dependencies are empty.`);
