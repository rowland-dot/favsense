#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const siteRoot = resolve(root, "site");
const token = "a".repeat(64);
const testHeader = "favsense-synthetic-v1";
const scenarios = new Set(["success", "partial", "build-failed", "publish-failed", "safety-stopped"]);
let scenario = "success";

const knowledge = {
  meta: { noteCount: 2, frameEvidenceCount: 0, verifiedNoteCount: 1, resourceCount: 1, resourceIndexEnabled: true, kindLabels: { Other: "其他", Skill: "Skill" }, resourceIndex: { groups: [{ label: "Skills", pattern: "Agent Skill" }], default_group: "其他", sorts: [{ id: "name-asc", label: "按名称", field: "name", type: "text", direction: "asc" }] } },
  categories: [{ name: "Synthetic", count: 2 }],
  notes: [
    { id: "note-accepted", title: "Verified synthetic Skill", category: "Synthetic", kind: "Skill", publishedAt: "2026-08-23", summary: "Accepted synthetic summary.", summaryStatus: "accepted", summaryReason: "", themes: ["testing"], tools: ["Official synthetic Skill"], resources: ["Official synthetic Skill"], evidence: { method: "curation", label: "已审核" }, reviewedAt: "2026-08-23" },
    { id: "note-pending", title: "Pending synthetic note", category: "Synthetic", kind: "Other", candidateKind: "Skill", publishedAt: "2026-08-23", summary: "Safe metadata fallback.", summaryStatus: "pending_review", summaryReason: "audit_pending", themes: [], tools: [], resources: [], evidence: { method: "source-metadata", label: "待审核" } },
  ],
  resources: [{ id: "github-owner-repo", name: "Official synthetic Skill", type: "Agent Skill", description: "Synthetic verified fixture.", aliases: [], actions: [{ label: "官方仓库", url: "https://github.com/owner/repo" }, { label: "下载 ZIP", url: "https://github.com/owner/repo/archive/refs/heads/main.zip" }, { label: "文档", url: "https://github.com/owner/repo/blob/main/README.md" }], attributes: [{ label: "许可证", value: "MIT" }] }],
};

function syncStatus() {
  const common = { ok: true, board_count: 1, processed_boards: 1, scanned: 2, new: 0, summarized: 1, summary_total: 2, summary_pending: 0, summary_failed: 0, core_completed: true, summary_plan_pending: false, summary_finalizing: false };
  if (scenario === "build-failed") return { ...common, state: "completed", summary_finalize_error: "build_failed" };
  if (scenario === "publish-failed") return { ...common, state: "completed", publish_status: "failed" };
  if (scenario === "safety-stopped") return { ...common, state: "safety-stopped", error: "safety_signal" };
  if (scenario === "partial") return { ...common, state: "completed", summary_failed: 1, summary_halt_reason: "transport_failed" };
  return { ...common, state: "completed", publish_status: "unchanged" };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "access-control-allow-origin": "http://127.0.0.1:8766", "access-control-allow-headers": "content-type,x-xhs-bridge-token,x-favsense-test", "access-control-allow-methods": "GET,POST,OPTIONS" });
  response.end(body);
}

function safeStaticPath(pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = resolve(siteRoot, relative);
  return target.startsWith(`${siteRoot}\\`) || target.startsWith(`${siteRoot}/`) ? target : null;
}

function staticServer({ manager }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/__health") return sendJson(response, 200, { ok: true });
    if (manager && url.pathname === "/__test/reset" && request.method === "POST") { scenario = "success"; return sendJson(response, 200, { ok: true }); }
    if (manager && url.pathname === "/__test/scenario" && request.method === "POST") {
      if (request.headers["x-favsense-test"] !== testHeader) return sendJson(response, 403, { ok: false });
      let raw = ""; for await (const chunk of request) raw += chunk;
      const next = JSON.parse(raw || "{}").scenario;
      if (!scenarios.has(next)) return sendJson(response, 400, { ok: false });
      scenario = next; return sendJson(response, 200, { ok: true });
    }
    if (manager && url.pathname === "/.local/bridge.json") return sendJson(response, 200, { baseUrl: "http://127.0.0.1:8768" });
    if (!manager && url.pathname === "/.local/bridge.json") return sendJson(response, 404, { ok: false });
    if (url.pathname === "/data/knowledge.json") return sendJson(response, 200, knowledge);
    const target = safeStaticPath(url.pathname);
    if (!target) { response.writeHead(404); return response.end(); }
    try {
      const body = await readFile(target);
      const type = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" }[extname(target)] || "application/octet-stream";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }); response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
}

const bridge = createServer(async (request, response) => {
  if (request.method === "OPTIONS") return sendJson(response, 204, {});
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/local-session") return sendJson(response, 200, { ok: true, protocol_version: 11, token, browser_session: { owner: "sop-cdp", ready: true }, diandian_available: true });
  if (request.headers["x-xhs-bridge-token"] !== token) return sendJson(response, 404, { ok: false });
  if (url.pathname === "/boards") return sendJson(response, 200, [{ id: "synthetic", name: "Synthetic", enabled: true, available: true, advertised_count: 2, captured_count: 2 }]);
  if (url.pathname === "/sync/status" || url.pathname === "/sync/start") return sendJson(response, 200, syncStatus());
  if (url.pathname === "/notes/organization-status") return sendJson(response, 200, { ok: true, note_id: "note-pending", summary: "Captured private synthetic summary", evidence_methods: ["point"], blockers: ["audit_pending"] });
  return sendJson(response, 404, { ok: false });
});

function listen(server, port) {
  return new Promise((resolvePromise, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolvePromise));
}

if (process.argv.includes("--help")) {
  console.log("--scenario success|partial|build-failed|publish-failed|safety-stopped (UX-01..14 / VC-QA-01..15)");
  process.exit(0);
}
const scenarioIndex = process.argv.indexOf("--scenario");
if (scenarioIndex >= 0 && scenarios.has(process.argv[scenarioIndex + 1])) scenario = process.argv[scenarioIndex + 1];

const servers = [staticServer({ manager: true }), staticServer({ manager: false }), bridge];
try {
  await listen(servers[0], 8766); await listen(servers[1], 8767); await listen(servers[2], 8768);
  console.log(JSON.stringify({ ok: true, fixture: "organization-recovery", manager: "http://127.0.0.1:8766", public: "http://127.0.0.1:8767" }));
} catch {
  console.error("FIXTURE_PORT_CONFLICT fixture: stop the existing synthetic fixture and retry"); process.exit(1);
}
const stop = () => { for (const server of servers) server.close(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
