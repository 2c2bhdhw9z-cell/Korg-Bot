import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Runs Korg's loader core and the built runtime inside a REAL Hermes engine (the version Discord 353 ships), with a
// simulated Discord around it. It needs the engine's source and a build of it, which are too big to vendor:
//
//   git clone --depth 1 --branch hermes-v250829098.0.15 https://github.com/facebook/hermes.git /tmp/hermes-src
//   cmake -S /tmp/hermes-src -B /tmp/hermes-build -G Ninja -DCMAKE_BUILD_TYPE=Release -DHERMES_ENABLE_TEST_SUITE=OFF
//   ninja -C /tmp/hermes-build hermesvm
//   HERMES_SRC=/tmp/hermes-src HERMES_BUILD=/tmp/hermes-build npm test
//
// Optionally set METRO_REQUIRE to metro-runtime's src/polyfills/require.js to use Metro's own module system.
// The macOS CI job builds Hermes and runs this too, which is the closest thing to a device: Apple arm64, libc++.
test("loader core and the Korg runtime work inside a real Hermes engine", async t => {
    const src = process.env.HERMES_SRC;
    const build = process.env.HERMES_BUILD;
    if (!src || !build) return t.skip("Set HERMES_SRC and HERMES_BUILD to run against the real engine (see this test's comment)");
    const compiler = ["clang++", "c++", "g++"].find(command => spawnSync("which", [command], { encoding: "utf8" }).status === 0);
    if (!compiler) return t.skip("No C++ compiler");
    const built = spawnSync(process.execPath, [path.join(root, "scripts/build.mjs")], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const temp = await mkdtemp(path.join(os.tmpdir(), "korg-engine-"));
    try {
        const binary = path.join(temp, "harness");
        const lib = path.join(build, "lib");
        const includes = [`${src}/API`, `${src}/API/jsi`, `${src}/public`, `${src}/include`, `${src}/external/llvh/include`, `${build}/external/llvh/include`];
        const compiled = spawnSync(compiler, ["-std=c++17", "-O1", "-fexceptions", ...includes.map(dir => `-I${dir}`),
            path.join(root, "tests/native/hermes-harness.cpp"), `-L${lib}`, "-lhermesvm", `-Wl,-rpath,${lib}`, "-o", binary], { encoding: "utf8", maxBuffer: 1 << 26 });
        assert.equal(compiled.status, 0, `harness did not compile:\n${compiled.stderr}`);
        const args = [path.join(root, "dist/korg.js"), path.join(root, "tests/native/scenario.js")];
        if (process.env.METRO_REQUIRE && existsSync(process.env.METRO_REQUIRE)) args.push(process.env.METRO_REQUIRE);
        const ran = spawnSync(binary, args, { encoding: "utf8", maxBuffer: 1 << 26, timeout: 120000 });
        const failures = ran.stdout.split("\n").filter(line => line.startsWith("FAIL") || line.includes("threw"));
        assert.equal(ran.status, 0, `Real-engine checks failed:\n${failures.join("\n")}\n---\n${ran.stdout.slice(-4000)}${ran.stderr}`);
        assert.match(ran.stdout, /ALL PASSED/);
    } finally { await rm(temp, { recursive: true, force: true }); }
});
