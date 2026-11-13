// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeEdits } from "../native/patches.mjs";
import { prepareNative } from "../scripts/prepare-native.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, "native/loader.lock.json"), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function archiveBytes() {
    const cached = path.join(root, ".build/native/RainTweak-source.tar.gz");
    try { return await readFile(cached); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const response = await fetch(lock.archive, { signal: AbortSignal.timeout(90000) });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
}

test("pinned RainTweak native patches apply exactly and package bundled Korg", async () => {
    const archive = await archiveBytes();
    assert.equal(sha256(archive), lock.sha256);
    const tmp = await mkdtemp(path.join(os.tmpdir(), "korg-native-test-"));
    try {
        const build = path.join(tmp, "native");
        const dist = path.join(tmp, "dist");
        await mkdir(build, { recursive: true });
        await mkdir(dist);
        await writeFile(path.join(build, "RainTweak-source.tar.gz"), archive);
        for (const name of ["korg.js", "korg-source.tar.gz", "LICENSE.rain", "NOTICE.md", "THIRD_PARTY_NOTICES.md"]) {
            await writeFile(path.join(dist, name), `test payload ${name}`);
        }
        const work = await prepareNative({ projectRoot: root, dist, build });
        const original = path.join(tmp, "original");
        await mkdir(original);
        const extract = spawnSync("tar", ["-xzf", path.join(build, "RainTweak-source.tar.gz"), "--strip-components=1", "-C", original]);
        assert.equal(extract.status, 0, extract.stderr?.toString());
        for (const [relative, patch] of nativeEdits) {
            const before = await readFile(path.join(original, relative), "utf8");
            const after = await readFile(path.join(work, relative), "utf8");
            assert.equal(after, patch(before), relative);
            assert.throws(() => patch(after), /Upstream changed/, `${relative} should not reapply`);
        }
        const tweak = await readFile(path.join(work, "Sources/Tweak.xm"), "utf8");
        const config = await readFile(path.join(work, "Sources/LoaderConfig.m"), "utf8");
        const settings = await readFile(path.join(work, "Sources/Settings.m"), "utf8");
        const make = await readFile(path.join(work, "Makefile"), "utf8");
        assert.match(tweak, /stringByAppendingPathComponent:@"korg\.js"/);
        assert.match(tweak, /\[JSI evaluate:bundle tag:@"korg:bundle" runtime:runtime\]/);
        assert.match(tweak, /return nil; \/\/ No network fallback/);
        assert.doesNotMatch(tweak, /releases\/download\/latest/);
        assert.match(tweak, /!\[targetURL\.scheme isEqualToString:@"https"\]/);
        assert.match(tweak, /korgEmbedded/);
        assert.match(tweak, /\[http\.URL\.scheme isEqualToString:@"https"\]/);
        assert.match(settings, /\[response\.URL\.scheme isEqualToString:@"https"\]/);
        assert.match(tweak, /loaderName", jsi::String::createFromUtf8\(runtime, "RainTweak"\)/);
        assert.doesNotMatch(config, /localhost:4040/);
        assert.match(settings, /Reset to Bundled Korg/);
        assert.doesNotMatch(settings, /showBundleSelector\(self\)/);
        assert.match(make, /BunnyResources_RESOURCE_FILES = KorgPayload\/korg\.js /);
        assert.equal((await readFile(path.join(work, "KorgPayload/korg.js"), "utf8")), "test payload korg.js");
        assert.equal(await readFile(path.join(work, "KorgPayload/LICENSE.RainTweak"), "utf8"), await readFile(path.join(original, "LICENSE"), "utf8"));
        assert.deepEqual((await readdir(path.join(work, "KorgPayload"))).sort(), ["LICENSE.RainTweak", "LICENSE.rain", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "korg-source.tar.gz", "korg.js"].sort());
        // A reused download must be verified before any source is modified.
        await writeFile(path.join(build, "RainTweak-source.tar.gz"), "tampered");
        await assert.rejects(prepareNative({ projectRoot: root, dist, build }), /checksum mismatch/);
        assert.equal(await readFile(path.join(work, "Sources/Tweak.xm"), "utf8"), tweak);
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
});
