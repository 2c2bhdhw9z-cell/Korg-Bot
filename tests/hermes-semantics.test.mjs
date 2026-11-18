import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkFile, findCompiler } from "../scripts/hermes-scope-check.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Hermes 1.0 (Discord 353) gives all iterations of a loop the same let/const binding, so a closure made in a loop
// sees the last iteration's value. Node follows the spec, so only a source-level check or a real Hermes catches it.
// This is why every before/after patch once ran as "instead" and every logger call used the last level.
test("runtime sources create no closures over loop-scoped variables", async t => {
    const compiler = findCompiler();
    if (!compiler) return t.skip("No Hermes compiler; install hermes-compiler or set HERMESC");
    const folder = path.join(root, "runtime");
    const problems = [];
    for (const name of (await readdir(folder)).filter(file => file.endsWith(".js")).sort()) {
        const file = path.join(folder, name);
        for (const finding of checkFile(compiler, file, await readFile(file, "utf8"))) {
            problems.push(`runtime/${name}:${finding.line} captures ${finding.names.join(", ")} from the loop at line ${finding.loopLine}`);
        }
    }
    assert.deepEqual(problems, [], `Move the closure into a helper function (each call gets its own scope):\n${problems.join("\n")}`);
});

test("the loop-capture checker flags the patterns that broke Korg and accepts the safe ones", async t => {
    const compiler = findCompiler();
    if (!compiler) return t.skip("No Hermes compiler; install hermes-compiler or set HERMESC");
    const temp = await mkdtemp(path.join(os.tmpdir(), "korg-scope-"));
    const analyze = async source => {
        const file = path.join(temp, "sample.js");
        await writeFile(file, source);
        return checkFile(compiler, file, source);
    };
    try {
        const bad = {
            "for-of const": "const o = {}; for (const t of ['a', 'b']) o[t] = () => t;",
            "for-of with a const in the body": "const o = {}; for (const t of ['a']) { const copy = t; o[t] = () => copy; }",
            "for let counter": "const o = []; for (let i = 0; i < 3; i++) o.push(() => i);",
            "for-in": "const o = {}; for (const k in {a: 1}) o[k] = function () { return k; };",
            "while with a let in the body": "const o = []; let n = 0; while (n < 3) { let v = n++; o.push(() => v); }",
            "getter defined in a loop": "const o = {}; for (const n of ['x']) Object.defineProperty(o, n, { get() { return n; } });",
            "nested closure": "const o = []; for (const t of [1]) o.push(() => () => t);",
            "destructured loop variable": "const o = []; for (const [k, v] of [[1, 2]]) o.push(() => k + v);",
            "catch parameter in a loop": "const o = []; for (;;) { try { throw 1; } catch (e) { o.push(() => e); } break; }",
        };
        for (const [name, source] of Object.entries(bad)) assert.ok((await analyze(source)).length >= 1, `should flag: ${name}`);
        const good = {
            "helper function": "const o = {}; function make(t) { return () => t; } for (const t of ['a', 'b']) o[t] = make(t);",
            "forEach": "const o = {}; ['a', 'b'].forEach(t => { o[t] = () => t; });",
            "closure over a variable declared outside the loop": "let total = 0; const add = () => total++; for (const t of [1, 2]) add();",
            "closure with its own parameter of the same name": "const o = []; for (const t of [1]) o.push(t => t * 2);",
            "no closure at all": "let sum = 0; for (const t of [1, 2, 3]) sum += t;",
            "property named like the loop variable": "const o = []; for (const t of [1]) o.push(() => ({ t: 1 }.t));",
            "var is function scoped by design": "const o = []; for (var i = 0; i < 2; i++) { o.push(() => 1); }",
            "waived with a comment": "const o = []; for (const t of [1]) o.push(() => t); // hermes-loop-safe",
        };
        for (const [name, source] of Object.entries(good)) {
            const sourceWithMarker = name === "waived with a comment" ? source.replace("o.push(() => t); //", "o.push(() => t); //") : source;
            assert.deepEqual(await analyze(sourceWithMarker), [], `should accept: ${name}`);
        }
    } finally { await rm(temp, { recursive: true, force: true }); }
});
