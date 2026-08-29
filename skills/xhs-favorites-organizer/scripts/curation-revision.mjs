import { createHash } from "node:crypto";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function list(values) {
  return Array.isArray(values) ? [...new Set(values.map(clean).filter(Boolean))] : [];
}

export function publicCurationProjection(entry = {}) {
  return {
    title: clean(entry.title),
    category: clean(entry.category),
    category_override: entry.category_override === true,
    category_reason: clean(entry.category_reason),
    summary: clean(entry.summary),
    action: clean(entry.action),
    themes: list(entry.themes),
    tools: list(entry.tools),
    kind: clean(entry.kind)
  };
}

export function curationRevision(entry) {
  return createHash("sha256")
    .update(JSON.stringify(publicCurationProjection(entry)), "utf8")
    .digest("hex");
}

export function reviewPacketRevision(entry = {}) {
  const { review_packet_sha256: _ignored, ...packet } = entry;
  return createHash("sha256")
    .update(JSON.stringify(packet), "utf8")
    .digest("hex");
}
