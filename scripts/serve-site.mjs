#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../site");
const host = "127.0.0.1";
const requestedPort = Number.parseInt(process.env.PORT || "8766", 10);
if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
  throw new Error("PORT must be between 1024 and 65535");
}

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

function resolveRequestPath(rawUrl) {
  const pathname = decodeURIComponent(new URL(rawUrl, `http://${host}:${requestedPort}`).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

const server = createServer(async (request, response) => {
  if (!request.socket.remoteAddress?.match(/^(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/)) {
    response.writeHead(403).end("Local preview only");
    return;
  }
  if (!new Set(["GET", "HEAD"]).has(request.method || "")) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let filePath;
  try {
    filePath = resolveRequestPath(request.url || "/");
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  if (!filePath) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": mimeTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": filePath.includes(`${sep}.local${sep}`) ? "no-store" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(requestedPort, host, () => {
  console.log(`FavSense · 拾光台已启动：http://${host}:${requestedPort}`);
  console.log("按 Ctrl+C 停止预览。");
});
