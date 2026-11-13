// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "dist");
const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
const upstream = JSON.parse(await readFile(path.join(root, "upstream.json"), "utf8"));
assert.equal(manifest.upstreamRevision, upstream.revision);
assert.equal(manifest.source, "korg-source.tar.gz");
assert.ok(Number.isInteger(manifest.hermesBytecodeVersion) && manifest.hermesBytecodeVersion > 0);
const expectedFiles = ["korg.js", `korg.${manifest.hermesBytecodeVersion}.hbc`, "korg-source.tar.gz", "LICENSE.rain", "NOTICE.md", "INSTALL.md", "THIRD_PARTY_NOTICES.md"];
assert.deepEqual(Object.keys(manifest.files).sort(), expectedFiles.sort(), "Manifest must include every distribution file");
for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(path.join(dist, name));
    assert.equal(bytes.length, expected.bytes, `${name}: wrong size`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, `${name}: wrong checksum`);
}
const bundle = await readFile(path.join(dist, "korg.js"), "utf8");
new vm.Script(bundle, { filename: "korg.js" });
assert.match(bundle, /korg:amethyst/);
assert.match(bundle, /korg:midnight/);
assert.match(bundle, /KORG_HOME/);
assert.match(bundle, /Undo last theme change/);
const bytecode = await readFile(path.join(dist, `korg.${manifest.hermesBytecodeVersion}.hbc`));
assert.equal(bytecode.subarray(0, 8).toString("hex"), "c61fbc03c103191f", "Invalid Hermes bytecode magic");
assert.equal(bytecode.readUInt32LE(8), manifest.hermesBytecodeVersion);
const source = await readFile(path.join(dist, manifest.source));
assert.equal(source.subarray(0, 2).toString("hex"), "1f8b", "Source archive must be gzip");
const archiveEntries = execFileSync("tar", ["-tzf", path.join(dist, manifest.source)], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).split("\n");
for (const required of ["source/LICENSE", "source/bun.lock", "source/scripts/build.mjs", "source/src/rain/pages/Korg/index.tsx", "source/src/rain/pages/Korg/runtime.ts", "source/THIRD_PARTY_NOTICES.md"]) {
    assert.ok(archiveEntries.includes(required), `Missing source archive entry: ${required}`);
}
assert.match(await readFile(path.join(dist, "THIRD_PARTY_NOTICES.md"), "utf8"), /zustand@/);
console.log(`Verified Korg ${manifest.version}: JavaScript syntax, branding, Hermes ${manifest.hermesBytecodeVersion}, source archive, and ${Object.keys(manifest.files).length} checksums.`);
console.log("This validates build artifacts; a real iPhone/Discord runtime test is still required.");
