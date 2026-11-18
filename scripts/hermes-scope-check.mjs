// Finds closures that capture block-scoped variables declared inside a loop.
//
// Hermes (checked against 1.0.0 / bytecode 98, the engine in Discord 353) gives every iteration of a loop the
// SAME binding for `let`/`const`, so a closure created in iteration 1 sees the value from the last iteration:
//
//     for (const type of ["before", "after", "instead"]) scope[type] = () => type;   // all three return "instead"
//
// Node/V8 follows the language spec, so the Node tests cannot see this. React Native apps avoid it because their
// build step rewrites such loops; Korg's source is handed to the engine untouched, so it has to avoid the pattern.
// The fix is always the same: create the closure in a helper function, which gives each call its own scope.
//
// The analysis works on the ESTree JSON that `hermesc -dump-ast` prints. It is conservative on purpose: a name
// declared anywhere inside a function counts as shadowing, and a closure that only runs synchronously is still
// reported. A flagged line can be silenced with a `hermes-loop-safe` comment on the same line when the closure is
// provably not kept past the iteration.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const FUNCTIONS = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);

export function findCompiler() {
    if (process.env.HERMESC) return process.env.HERMESC;
    const folder = { linux: "linux64-bin", darwin: "osx-bin", win32: "win64-bin" }[process.platform];
    const name = process.platform === "win32" ? "hermesc.exe" : "hermesc";
    const candidate = folder && path.join(root, "node_modules", "hermes-compiler", "hermesc", folder, name);
    return candidate && existsSync(candidate) ? candidate : null;
}

export function parse(compiler, file) {
    const result = spawnSync(compiler, ["-dump-ast", "-dump-source-location=loc", file], { encoding: "utf8", maxBuffer: 1 << 28 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`hermesc could not parse ${file}:\n${result.stderr}`);
    return JSON.parse(result.stdout);
}

function children(node) {
    const out = [];
    for (const [key, value] of Object.entries(node)) {
        if (key === "loc" || key === "range") continue;
        if (Array.isArray(value)) { for (const item of value) if (item && typeof item === "object" && item.type) out.push([key, item]); }
        else if (value && typeof value === "object" && value.type) out.push([key, value]);
    }
    return out;
}

function patternNames(pattern, into) {
    if (!pattern) return into;
    switch (pattern.type) {
        case "Identifier": into.add(pattern.name); break;
        case "ObjectPattern": for (const property of pattern.properties) patternNames(property.type === "RestElement" ? property.argument : property.value, into); break;
        case "ArrayPattern": for (const element of pattern.elements) patternNames(element, into); break;
        case "AssignmentPattern": patternNames(pattern.left, into); break;
        case "RestElement": patternNames(pattern.argument, into); break;
        default: break;
    }
    return into;
}

// Names the loop gives a fresh binding per iteration: let/const/class/function declarations and catch parameters
// anywhere in the loop (head and body), without looking inside nested functions.
function loopScopedNames(loop) {
    const names = new Set();
    (function walk(node, isRoot) {
        if (!isRoot && FUNCTIONS.has(node.type)) { if (node.type === "FunctionDeclaration" && node.id) names.add(node.id.name); return; }
        if (node.type === "VariableDeclaration" && node.kind !== "var") for (const declarator of node.declarations) patternNames(declarator.id, names);
        if (node.type === "ClassDeclaration" && node.id) names.add(node.id.name);
        if (node.type === "CatchClause" && node.param) patternNames(node.param, names);
        for (const [, child] of children(node)) walk(child, false);
    })(loop, true);
    return names;
}

// Identifier names a function uses that it does not declare itself (conservative: any declaration inside shadows).
function freeNames(fn) {
    const used = new Set();
    const declared = new Set();
    (function walk(node, parent, key) {
        if (node.type === "Identifier") {
            const skip = parent && ((parent.type === "MemberExpression" && key === "property" && !parent.computed)
                || (parent.type === "Property" && key === "key" && !parent.computed)
                || (parent.type === "MethodDefinition" && key === "key" && !parent.computed)
                || ((parent.type === "PropertyDefinition" || parent.type === "ClassProperty") && key === "key" && !parent.computed)
                || ((parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") && key === "label"));
            if (!skip) used.add(node.name);
            return;
        }
        if (FUNCTIONS.has(node.type)) {
            if (node.id) declared.add(node.id.name);
            for (const param of node.params || []) patternNames(param, declared);
        }
        if (node.type === "VariableDeclaration") for (const declarator of node.declarations) patternNames(declarator.id, declared);
        if (node.type === "ClassDeclaration" || node.type === "ClassExpression") { if (node.id) declared.add(node.id.name); }
        if (node.type === "CatchClause" && node.param) patternNames(node.param, declared);
        for (const [childKey, child] of children(node)) walk(child, node, childKey);
    })(fn, null, null);
    for (const name of declared) used.delete(name);
    return used;
}

export function findLoopClosureCaptures(ast, sourceLines = []) {
    const findings = [];
    (function walk(node) {
        if (LOOPS.has(node.type)) {
            const scoped = loopScopedNames(node);
            if (scoped.size) {
                (function findFunctions(inner) {
                    if (FUNCTIONS.has(inner.type)) {
                        const captured = [...freeNames(inner)].filter(name => scoped.has(name));
                        const line = inner.loc && inner.loc.start.line;
                        const waived = line && /hermes-loop-safe/.test(sourceLines[line - 1] || "");
                        if (captured.length && !waived) findings.push({ line, column: inner.loc && inner.loc.start.column, loopLine: node.loc && node.loc.start.line, names: captured.sort() });
                        return; // the outermost closure is what captures the binding
                    }
                    for (const [, child] of children(inner)) findFunctions(child);
                })(node);
            }
        }
        for (const [, child] of children(node)) walk(child);
    })(ast);
    return findings;
}

export function checkFile(compiler, file, sourceText) {
    return findLoopClosureCaptures(parse(compiler, file), sourceText.split("\n"));
}
