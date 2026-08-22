import { createHash } from "node:crypto";

const METHOD_KEYS = ["method", "provider", "result_sha256", "version"];
const HASH = /^[a-f0-9]{64}$/;

function text(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

function stringList(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/[\s,，]+/u);
  return [...new Set(values.map(text).filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function sha(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function contentRevision(note = {}) {
  return sha({
    title: text(note.title ?? note.display_title),
    description: text(note.description ?? note.desc ?? note.content),
    tags: stringList(note.tags ?? note.tag_list),
    media_type: text(note.media_type ?? note.type ?? note.note_type).toLowerCase(),
  });
}

function normalizeMethod(method) {
  if (!method || typeof method !== "object" || Array.isArray(method) || Object.keys(method).sort().join(",") !== METHOD_KEYS.join(",")) {
    throw new Error("EVIDENCE_METHOD_SCHEMA_INVALID");
  }
  const normalized = {
    method: text(method.method), provider: text(method.provider), version: text(method.version), result_sha256: text(method.result_sha256),
  };
  if (!normalized.method || !normalized.provider || !normalized.version || !HASH.test(normalized.result_sha256)) throw new Error("EVIDENCE_METHOD_SCHEMA_INVALID");
  return normalized;
}

export function evidenceRevision({ contentSha256, comments = [], commentsChecked = false, methods = [] }) {
  if (!HASH.test(String(contentSha256 || ""))) throw new Error("CONTENT_REVISION_INVALID");
  if (!Array.isArray(comments) || !Array.isArray(methods)) throw new Error("EVIDENCE_SCHEMA_INVALID");
  const normalizedComments = [...new Map(comments.map((comment) => text(typeof comment === "object" ? comment.text : comment))
    .filter(Boolean).map((comment) => [sha(comment), comment])).entries()]
    .sort(([left], [right]) => left.localeCompare(right)).slice(0, 30)
    .map(([result_sha256, value]) => ({ result_sha256, value }));
  const normalizedMethods = methods.map(normalizeMethod).sort((left, right) => (
    [left.method, left.provider, left.version, left.result_sha256].join("\0")
      .localeCompare([right.method, right.provider, right.version, right.result_sha256].join("\0"))
  ));
  return sha({ content_sha256: contentSha256, comments_checked: commentsChecked === true, comments: normalizedComments, methods: normalizedMethods });
}

export function normalizeEvidenceMethod(method) {
  return normalizeMethod(method);
}

