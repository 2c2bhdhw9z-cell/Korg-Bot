import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// The bundle reaches Hermes as plain source text, and Node's vm accepts syntax Hermes rejects.
// Hermes 0.12 (React Native 0.80, bytecode 96) refuses `async` functions; Hermes 1.0 (bytecode 98,
// the version Rain's `rain.98.hbc` release targets) accepts them. CI installs the npm package
// `hermes-compiler`; set HERMESC to test against another compiler.
function findCompiler() {
    if (process.env.HERMESC) return process.env.HERMESC;
    const folder = { linux: "linux64-bin", darwin: "osx-bin", win32: "win64-bin" }[process.platform];
    const name = process.platform === "win32" ? "hermesc.exe" : "hermesc";
    const candidate = folder && path.join(root, "node_modules", "hermes-compiler", "hermesc", folder, name);
    return candidate && existsSync(candidate) ? candidate : null;
}

test("the built runtime bundle compiles with Hermes", async t => {
    const compiler = findCompiler();
    if (!compiler) return t.skip("No Hermes compiler; install hermes-compiler or set HERMESC");
    const built = spawnSync(process.execPath, [path.join(root, "scripts/build.mjs")], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const temp = await mkdtemp(path.join(os.tmpdir(), "korg-hermes-"));
    try {
        const result = spawnSync(compiler, ["-emit-binary", "-out", path.join(temp, "korg.hbc"), path.join(root, "dist/korg.js")], { encoding: "utf8" });
        // A compiler that cannot run on this machine (wrong architecture, no execute bit) is not a bundle error.
        if (result.error) return t.skip(`Hermes compiler could not run: ${result.error.message}`);
        const errors = `${result.stdout}${result.stderr}`.split("\n").filter(line => /\berror:/.test(line));
        assert.deepEqual(errors, [], `Hermes rejected the bundle:\n${errors.join("\n")}`);
        assert.equal(result.status, 0, result.stderr);
    } finally { await rm(temp, { recursive: true, force: true }); }
});
