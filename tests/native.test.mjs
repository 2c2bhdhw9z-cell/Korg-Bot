import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("native ABI call contract against a synthetic runtime", async () => {
    const compiler = ["clang++", "c++", "g++"].find(command => spawnSync("which", [command], { encoding: "utf8" }).status === 0);
    if (!compiler) return test.skip("No C++ compiler available for synthetic ABI test");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "korg-abi-test-"));
    const source = path.join(tmp, "abi.cpp");
    const binary = path.join(tmp, "abi-test");
    const loader = path.join(root, "native/KorgLoader.mm").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await writeFile(source, `#define KORG_ABI_TEST\n#include "${loader}"\n#include <cassert>\n#include <cstring>\nstruct Runtime { void **vtable; };\nstatic int calls = 0;\nstatic korg::Result evaluate(void *, const std::shared_ptr<const korg::Input> &input, const std::string &url) { ++calls; assert(url == "korg://embedded/bootstrap.js"); assert(input->length() == 5); assert(std::memcmp(input->bytes(), "hello", 5) == 0); return {0, 0, 0}; }\nint main() { void *table[3] = {}; table[2] = reinterpret_cast<void *>(&evaluate); Runtime runtime{table}; korg::evaluate(&runtime, "hello"); assert(calls == 1); }\n`);
    try {
        const built = spawnSync(compiler, ["-std=c++17", source, "-o", binary], { encoding: "utf8" });
        assert.equal(built.status, 0, built.stderr);
        const ran = spawnSync(binary, [], { encoding: "utf8" });
        assert.equal(ran.status, 0, ran.stderr);
    } finally { await rm(tmp, { recursive: true, force: true }); }
});

test("collected native artifact manifest and checksum contract", async t => {
    const out = path.join(root, "artifacts/native");
    try { await stat(out); } catch { return t.skip("No compiled artifact; macOS CI runs this test after native compilation"); }
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.name, "KorgOriginalLoader");
    assert.equal(manifest.version, "0.2.0-native-original");
    assert.equal(manifest.architecture, "arm64");
    assert.equal(manifest.dependencyPolicy, "system-only");
    for (const [name, expected] of Object.entries(manifest.files)) {
        const bytes = await readFile(path.join(out, name));
        assert.equal(bytes.length, expected.bytes, `${name}: size`);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, `${name}: checksum`);
    }
    assert.ok(manifest.files["KorgLoader.dylib"]);
    assert.ok(manifest.files["KorgResources.bundle/korg.js"]);
    assert.ok(manifest.files["KorgResources.bundle/manifest.json"]);
    assert.ok(manifest.files["korg-source.tar.gz"]);
    assert.ok(manifest.files["SOURCE-NOTICE.md"]);
});
