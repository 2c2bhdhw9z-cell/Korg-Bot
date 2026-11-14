import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
const sourceNames = ["core.js", "metro.js", "patcher.js", "storage.js", "compat.js", "themes.js", "plugins.js", "ui.js", "start.js"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sources = [];
const sourceHashes = {};
for (const name of sourceNames) {
    const bytes = await readFile(path.join(root, "runtime", name));
    sourceHashes[`runtime/${name}`] = hash(bytes);
    sources.push(`// Source: runtime/${name}\n${bytes.toString("utf8").trimEnd()}\n\n`);
}
const bundle = sources.join("");
new vm.Script(bundle, { filename: "korg.js" });
const manifest = {
    name: "KorgOriginalRuntime",
    version: "0.2.0",
    sources: sourceHashes,
    plugins: [],
    dependencies: [],
    thirdPartyPluginsBundled: false,
    runtimeDependenciesBundled: [],
};
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "korg.js"), bundle);
await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${manifest.name} ${manifest.version} from ${sourceNames.length} local runtime sources.`);
