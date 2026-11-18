import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("native ABI call contract against a synthetic runtime", async t => {
    const compiler = ["clang++", "c++", "g++"].find(command => spawnSync("which", [command], { encoding: "utf8" }).status === 0);
    if (!compiler) return t.skip("No C++ compiler available for synthetic ABI test");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "korg-abi-test-"));
    const source = path.join(tmp, "abi.cpp");
    const binary = path.join(tmp, "abi-test");
    const loader = path.join(root, "native/KorgLoader.mm").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await writeFile(source, `#define KORG_ABI_TEST
#include "${loader}"
#include <cassert>
#include <cstring>
#include <map>
#include <vector>

// A jsi::Runtime whose virtual table has the React Native 0.86 / Hermes 1.0 shape: slot 0 castInterface, slot 1
// evaluateJavaScript, and the destructors last. Slot 2 (prepareJavaScript) must never be called to evaluate.
struct FakeRuntime { void **vtable; };
static int evaluated = 0, prepared = 0;
static korg::Value evaluateJavaScript(korg::Runtime *, const std::shared_ptr<const korg::Input> &input, const std::string &url) {
    ++evaluated;
    assert(url == "korg://embedded/bootstrap.js");
    assert(input->length() == 5);
    assert(std::memcmp(input->bytes(), "hello", 5) == 0);
    return korg::Value();
}
static korg::Value prepareJavaScript(korg::Runtime *, const std::shared_ptr<const korg::Input> &, const std::string &) { ++prepared; return korg::Value(); }

int main() {
    void *table[korg::slot::count] = {};
    table[korg::slot::evaluateJavaScript] = reinterpret_cast<void *>(&evaluateJavaScript);
    table[2] = reinterpret_cast<void *>(&prepareJavaScript);
    FakeRuntime runtime{table};
    korg::evaluate(reinterpret_cast<korg::Runtime *>(&runtime), "hello");
    assert(evaluated == 1 && prepared == 0);
    static_assert(korg::slot::evaluateJavaScript == 1, "evaluateJavaScript is slot 1 in the 0.86 layout");

    // The layout check accepts a table whose anchors are all where the real engine has them, and refuses damage.
    std::map<std::string, void *> symbols;
    std::vector<void *> vtable(2 + korg::slot::count, nullptr);
    char addresses[64];
    int next = 0;
    for (const korg::Anchor &anchor : korg::layoutAnchors()) {
        void *address = &addresses[next++];
        symbols[anchor.symbol] = address;
        vtable[2 + anchor.slot] = address;
    }
    static char pureVirtual;
    for (size_t slot = 1; slot <= 8; ++slot) vtable[2 + slot] = &pureVirtual;
    static std::map<std::string, void *> *global;
    global = &symbols;
    symbols["_ZTVN8facebook3jsi7RuntimeE"] = vtable.data();
    korg::Lookup lookup = [](const char *name) -> void * { auto found = global->find(name); return found == global->end() ? nullptr : found->second; };
    assert(korg::checkLayout(lookup).empty());
    assert(korg::layoutAnchors().size() >= 15);
    std::swap(vtable[2 + 47], vtable[2 + 50]);
    assert(!korg::checkLayout(lookup).empty());          // two anchors swapped
    std::swap(vtable[2 + 47], vtable[2 + 50]);
    vtable[2 + 3] = &addresses[0];
    assert(!korg::checkLayout(lookup).empty());          // slots 1-8 are no longer one pure-virtual stub
    vtable[2 + 3] = &pureVirtual;
    vtable[2 + korg::slot::completeDestructor] = &addresses[1];
    assert(!korg::checkLayout(lookup).empty());          // something that is not the destructor is where it should be
    vtable[2 + korg::slot::completeDestructor] = nullptr;
    symbols.erase(korg::layoutAnchors()[3].symbol);
    assert(!korg::checkLayout(lookup).empty());          // the host does not export an anchor function
}
`);
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
