// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeEdits } from "../native/patches.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, "native/loader.lock.json"), "utf8"));
const sha256 = data => createHash("sha256").update(data).digest("hex");

function tar(args) {
    return new Promise((resolve, reject) => {
        const child = spawn("tar", args, { stdio: ["ignore", "pipe", "inherit"] });
        let output = "";
        child.stdout.on("data", data => { output += data; });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`tar exited ${code}`)));
    });
}

export async function prepareNative({ projectRoot = root, dist = path.join(projectRoot, "dist"), build = path.join(projectRoot, ".build/native") } = {}) {
    if (!/^[a-f0-9]{40}$/.test(lock.revision) || lock.archive !== `https://codeload.github.com/ra1ncord/RainTweak/tar.gz/${lock.revision}` || !/^[a-f0-9]{64}$/.test(lock.sha256)) {
        throw new Error("Invalid RainTweak source lock");
    }
    // Fail before changing the previous preparation if any build output is missing.
    const inputs = ["korg.js", "korg-source.tar.gz", "LICENSE.rain", "NOTICE.md", "THIRD_PARTY_NOTICES.md"];
    const payload = new Map();
    for (const name of inputs) {
        const data = await readFile(path.join(dist, name));
        if (!data.length) throw new Error(`Missing/empty native payload: dist/${name}`);
        payload.set(name, data);
    }
    const archivePath = path.join(build, "RainTweak-source.tar.gz");
    let archive;
    try {
        archive = await readFile(archivePath);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const response = await fetch(lock.archive, { signal: AbortSignal.timeout(90000) });
        if (!response.ok) throw new Error(`RainTweak source download: HTTP ${response.status}`);
        archive = Buffer.from(await response.arrayBuffer());
    }
    if (sha256(archive) !== lock.sha256) throw new Error("RainTweak source checksum mismatch; delete the corrupt cached archive to retry.");
    await mkdir(build, { recursive: true });
    await writeFile(archivePath, archive);
    // The hash pins this exact tarball. Never extract unverified or arbitrary archive bytes.
    const entries = (await tar(["-tzf", archivePath])).trim().split("\n");
    const prefix = `RainTweak-${lock.revision}/`;
    if (entries.some(name => !name.startsWith(prefix) || name.slice(prefix.length).split("/").includes(".."))) {
        throw new Error("Unsafe RainTweak tarball path");
    }
    const work = path.join(build, "rain-tweak");
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    await tar(["-xzf", archivePath, "--strip-components=1", "-C", work]);
    for (const [relative, transform] of nativeEdits) {
        const filename = path.join(work, relative);
        await writeFile(filename, transform(await readFile(filename, "utf8")));
    }
    const resources = path.join(work, "KorgPayload");
    await mkdir(resources, { recursive: true });
    for (const name of inputs) await writeFile(path.join(resources, name), payload.get(name));
    await cp(path.join(work, "LICENSE"), path.join(resources, "LICENSE.RainTweak"));
    const notice = await readFile(path.join(projectRoot, "native/NOTICE.md"), "utf8");
    await writeFile(path.join(resources, "NOTICE.md"), Buffer.concat([payload.get("NOTICE.md"), Buffer.from(`\n\n${notice}`)]));
    console.log(`Prepared ${work} (RainTweak ${lock.revision}); run Theos package in that directory.`);
    return work;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await prepareNative();
}
