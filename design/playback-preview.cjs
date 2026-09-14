const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../static");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  response.setHeader("Cache-Control", "no-store");
  if (pathname === "/api/playback/terminate") {
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "preview", preview: true }));
    return;
  }
  if (pathname.startsWith("/api/")) {
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    const upstream = http.get({ hostname: "127.0.0.1", port: 18198, path: request.url }, incoming => {
      response.writeHead(incoming.statusCode, { "Content-Type": incoming.headers["content-type"] || "application/json" });
      incoming.pipe(response);
    });
    upstream.setTimeout(10000, () => upstream.destroy());
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    return;
  }
  const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
  fs.readFile(file, (error, body) => {
    if (error) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    response.end(body);
  });
}).listen(18197, "127.0.0.1", () => console.log("Safe playback preview: http://127.0.0.1:18197 (Stop is simulated)"));