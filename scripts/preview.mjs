import http from "node:http";
import { readFile } from "node:fs/promises";

const directory = new URL("../preview/", import.meta.url);
const assets = new Map([
    ["/", ["index.html", "text/html"]],
    ["/index.html", ["index.html", "text/html"]],
    ["/app.js", ["app.js", "text/javascript"]],
    ["/style.css", ["style.css", "text/css"]],
    ["/icon.svg", ["icon.svg", "image/svg+xml"]],
]);
const flags = process.argv.slice(2);
const at = flags.indexOf("--port");
const port = Number(at < 0 ? process.env.PORT || 5173 : flags[at + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid preview port");
const server = http.createServer(async (request, response) => {
    const entry = assets.get(new URL(request.url, "http://local.invalid").pathname);
    if (!entry || !["GET", "HEAD"].includes(request.method)) {
        response.writeHead(404).end();
        return;
    }
    try {
        const contents = await readFile(new URL(entry[0], directory));
        response.writeHead(200, {
            "Content-Type": `${entry[1]}; charset=utf-8`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'self'; connect-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'none'; base-uri 'none'",
        }).end(request.method === "HEAD" ? undefined : contents);
    } catch {
        response.writeHead(500).end("Preview unavailable");
    }
});
server.listen(port, "0.0.0.0", () => console.log(`Korg design preview: http://localhost:${port}`));
