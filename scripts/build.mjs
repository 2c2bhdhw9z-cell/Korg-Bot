// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchSettings, patchThemes, patchSettingsStore, patchColorPreferences, patchThemesPage, patchThemeInfoSheet, patchUpdater, replaceOnce } from "./patches.mjs";
import { dependencyNotices } from "./licenses.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const upstream = JSON.parse(await readFile(path.join(root, "upstream.json"), "utf8"));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const buildRoot = path.join(root, ".build");
const work = path.join(buildRoot, `rain-${upstream.revision}`);
const output = path.join(root, "dist");

function run(command, args, cwd = root, capture = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd, shell: false,
            stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
            env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
        });
        let text = "";
        child.stdout?.on("data", chunk => { text += chunk; });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve(text.trim()) : reject(new Error(`${command} exited ${code}`)));
    });
}
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

await mkdir(buildRoot, { recursive: true });
const archivePath = path.join(buildRoot, "rain-source.tar.gz");
let archive;
try {
    archive = await readFile(archivePath);
} catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log(`Downloading pinned Rain source ${upstream.revision.slice(0, 7)}…`);
    const response = await fetch(upstream.archive, { signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`Source download failed: HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
}
if (sha256(archive) !== upstream.sha256) throw new Error("Upstream source checksum mismatch; no code was executed.");
await writeFile(archivePath, archive);

// Preserve installed packages, but reconstruct all source on every build.
await mkdir(work, { recursive: true });
for (const item of await readdir(work)) {
    if (item !== "node_modules") await rm(path.join(work, item), { recursive: true, force: true });
}
await run("tar", ["-xzf", archivePath, "--strip-components=1", "-C", work]);

const edits = [
    ["src/plugins/_core/settings/index.tsx", patchSettings],
    ["src/plugins/_core/painter/themes/index.ts", patchThemes],
    ["src/api/settings.ts", patchSettingsStore],
    ["src/plugins/_core/painter/themes/preferences.ts", patchColorPreferences],
    ["src/rain/pages/Themes/index.tsx", patchThemesPage],
    ["src/rain/pages/Themes/sheets/ThemeInfoActionSheet.tsx", patchThemeInfoSheet],
    ["src/rain/pages/Updater/index.tsx", patchUpdater],
    ["scripts/build.mjs", source => replaceOnce(source,
        "    await build({ ...config, ...overrideConfig });",
        '    const result = await build({ ...config, ...overrideConfig, metafile: true });\n    await fs.writeFile("dist/metafile.json", JSON.stringify(result.metafile));',
        "dependency output map")],
];
for (const [relative, transform] of edits) {
    const filename = path.join(work, relative);
    await writeFile(filename, transform(await readFile(filename, "utf8")));
}
await mkdir(path.join(work, "src/rain/pages/Korg"), { recursive: true });
await cp(path.join(root, "overlays/KorgPage.tsx"), path.join(work, "src/rain/pages/Korg/index.tsx"));
await cp(path.join(root, "overlays/runtime.ts"), path.join(work, "src/rain/pages/Korg/runtime.ts"));

console.log("Installing locked upstream dependencies…");
await run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], work);
console.log("Building Korg using Rain's production Hermes pipeline…");
await run("node", ["scripts/build.mjs", "--release-branch=main", "--build-bytecode"], work);

const info = JSON.parse(await readFile(path.join(work, "dist/info.json"), "utf8"));
const bytecodePath = info.paths.find(file => /\.\d+\.hbc$/.test(file));
if (!bytecodePath) throw new Error("Hermes bytecode compilation did not produce a file. Build is incomplete.");

// Stage the complete distributable before replacing an older successful build.
const prepared = path.join(buildRoot, "distribution");
await rm(prepared, { recursive: true, force: true });
await mkdir(prepared, { recursive: true });
const bytecodeName = `korg.${info.hermesBytecodeVersion}.hbc`;
await cp(path.join(work, "dist/rain.js"), path.join(prepared, "korg.js"));
await cp(path.join(work, bytecodePath), path.join(prepared, bytecodeName));
await cp(path.join(work, "LICENSE"), path.join(prepared, "LICENSE.rain"));
await cp(path.join(root, "NOTICE.md"), path.join(prepared, "NOTICE.md"));
await cp(path.join(root, "docs/INSTALL.md"), path.join(prepared, "INSTALL.md"));
await writeFile(path.join(prepared, "THIRD_PARTY_NOTICES.md"), await dependencyNotices(work));

// MPL source form includes the actual modified files, the original license,
// locked dependencies, and build tools. No node_modules or proprietary app.
const sourceDir = path.join(prepared, "source");
await mkdir(sourceDir, { recursive: true });
for (const name of ["src", "scripts", "shims", "package.json", "bun.lock", "tsconfig.json", "LICENSE"]) {
    await cp(path.join(work, name), path.join(sourceDir, name), { recursive: true });
}
await cp(path.join(root, "NOTICE.md"), path.join(sourceDir, "KORG-NOTICE.md"));
await cp(path.join(prepared, "THIRD_PARTY_NOTICES.md"), path.join(sourceDir, "THIRD_PARTY_NOTICES.md"));
await run("tar", ["-czf", path.join(prepared, "korg-source.tar.gz"), "-C", prepared, "source"]);
await rm(sourceDir, { recursive: true, force: true });

const files = {};
for (const name of ["korg.js", bytecodeName, "korg-source.tar.gz", "LICENSE.rain", "NOTICE.md", "INSTALL.md", "THIRD_PARTY_NOTICES.md"]) {
    const data = await readFile(path.join(prepared, name));
    files[name] = { bytes: data.length, sha256: sha256(data) };
}
const manifest = {
    name: "Korg", version: pkg.version,
    status: "experimental; built on Linux; iPhone runtime not verified",
    upstreamRevision: upstream.revision,
    upstreamArchiveSha256: upstream.sha256,
    supportedDiscordBuildIOS: upstream.supportedDiscordBuildIOS,
    hermesBytecodeVersion: info.hermesBytecodeVersion,
    source: "korg-source.tar.gz",
    files,
};
await writeFile(path.join(prepared, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await run("node", ["scripts/verify.mjs", prepared]);
const backup = path.join(buildRoot, "previous-dist");
await rm(backup, { recursive: true, force: true });
let hadPrevious = false;
try {
    await rename(output, backup);
    hadPrevious = true;
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
try {
    await rename(prepared, output);
} catch (error) {
    if (hadPrevious) await rename(backup, output);
    throw error;
}
// Retain the prior successful distribution until the next successful build.
console.log(`Korg ${pkg.version}: dist/korg.js and dist/${bytecodeName}`);
console.log("Modified source, licenses, installation notes, and SHA-256 manifest are included.");
