// SPDX-License-Identifier: MPL-2.0
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

// Use esbuild's output map so notices follow code actually shipped in the bundle.
export async function dependencyNotices(work) {
    const meta = JSON.parse(await readFile(path.join(work, "dist/metafile.json"), "utf8"));
    const packages = new Map();
    for (const output of Object.values(meta.outputs)) {
        for (const [input, info] of Object.entries(output.inputs)) {
            if (!info.bytesInOutput || !input.includes("node_modules/")) continue;
            let directory = path.dirname(path.resolve(work, input));
            while (directory.startsWith(work + path.sep)) {
                let pkg;
                try { pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")); }
                catch (error) { if (error.code !== "ENOENT") throw error; }
                if (pkg?.name && pkg?.version) {
                    packages.set(`${pkg.name}@${pkg.version}`, { directory, pkg });
                    break;
                }
                directory = path.dirname(directory);
            }
        }
    }
    if (!packages.size) throw new Error("No bundled dependencies found in esbuild metadata");
    const sections = ["# Third-party notices\n\nKorg incorporates the following packages. Their original license terms apply to their code; the complete bundle is not exclusively MPL-2.0 licensed.\n"];
    for (const [name, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
        const candidates = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice|copyright)([._-]|$)/i.test(name));
        const notices = [];
        for (const filename of candidates.sort()) {
            const full = path.join(directory, filename);
            if ((await stat(full)).isFile()) notices.push(`### ${filename}\n\n${await readFile(full, "utf8")}`);
        }
        if (!notices.length) throw new Error(`Missing license text for bundled dependency ${name}`);
        sections.push(`## ${name}\n\nDeclared license: ${JSON.stringify(pkg.license ?? "See text below")}\n\n${notices.join("\n\n")}`);
    }
    return sections.join("\n\n") + "\n";
}
