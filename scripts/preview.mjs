// SPDX-License-Identifier: MPL-2.0
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../preview/", import.meta.url));
const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 5173);
const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
    "/icon.svg": ["icon.svg", "image/svg+xml"],
};
const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const item = files[url.pathname];
    if (!item || !["GET", "HEAD"].includes(req.method)) {
        res.writeHead(404); res.end("Not found"); return;
    }
    try {
        const bytes = await readFile(path.join(root, item[0]));
        res.writeHead(200, {
            "Content-Type": item[1], "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
        res.writeHead(500); res.end("Preview file unavailable");
    }
});
server.listen(port, "0.0.0.0", () => console.log(`Korg preview ready at http://localhost:${port}`));
