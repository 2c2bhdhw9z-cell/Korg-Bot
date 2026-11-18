import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/preview.mjs", import.meta.url));

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    });
}
function rawRequest(port, text) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
        let reply = "";
        socket.setEncoding("utf8");
        socket.on("data", chunk => { reply += chunk; });
        socket.on("error", reject);
        socket.on("close", () => resolve(reply));
    });
}

test("preview server answers a malformed request line with 400 and keeps serving", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [script, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    let exited = null;
    child.once("exit", code => { exited = code; });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("preview server did not start")), 10000);
            child.stdout.on("data", chunk => { if (String(chunk).includes("Korg design preview")) { clearTimeout(timer); resolve(); } });
            child.once("exit", code => { clearTimeout(timer); reject(new Error(`preview server exited with ${code}`)); });
        });
        const bad = await rawRequest(port, "GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert.match(bad, /^HTTP\/1\.1 400 /);
        assert.equal(exited, null, "server must survive a malformed request");
        const good = await rawRequest(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert.match(good, /^HTTP\/1\.1 200 /);
        const missing = await rawRequest(port, "GET /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert.match(missing, /^HTTP\/1\.1 404 /);
    } finally { child.kill(); }
});
