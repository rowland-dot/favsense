import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { curationRevision } from "./curation-revision.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}`);
    result[key.slice(2)] = value;
  }
  for (const required of ["review", "existing-audit", "curation", "output", "reviewed-at"]) {
    if (!result[required]) throw new Error(`--${required} is required`);
  }
  return result;
}

function readJson(filename, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filename), "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
}

function pendingRecord(item, reviewedAt) {
  const allowedMethods = new Set([
    "description", "comments", "audio_transcript", "visual_ocr", "image_ocr", "image_review",
    "video_analysis", "diandian_summary"
  ]);
  const methods = Array.isArray(item.evidence_methods)
    ? item.evidence_methods.filter((method) => allowedMethods.has(method))
    : [];
  if (item.public_text && !methods.includes("description")) methods.push("description");
  if (!item.blockers.includes("comments-unchecked") && !methods.includes("comments")) methods.push("comments");
  if (item.transcript_text && !methods.includes("audio_transcript")) methods.push("audio_transcript");
  if (item.visual_text && !methods.includes("visual_ocr")) methods.push("visual_ocr");
  if (item.diandian_summary_text && !methods.includes("diandian_summary")) methods.push("diandian_summary");
  const record = {
    status: "pending",
    reviewed_at: reviewedAt,
    evidence_methods: methods,
    comments_checked: !item.blockers.includes("comments-unchecked"),
    claims_supported: false,
    resource_status: item.tool_checks.length ? "unresolved" : "not_applicable",
    unresolved_facts: item.blockers,
    reason: item.blockers.length
      ? `尚未通过深度整理：${item.blockers.join("；")}`
      : "证据包结构完整，但尚未完成人工或 Agent 语义复核"
  };
  if (/^[a-f0-9]{64}$/.test(String(item.diandian_summary_sha256 || ""))) {
    record.diandian_summary_sha256 = item.diandian_summary_sha256;
  }
  if (item.candidate && typeof item.candidate === "object" && !Array.isArray(item.candidate)) {
    record.curation_sha256 = curationRevision(item.candidate);
  }
  return record;
}

export function initializeAudit(review, existingAudit, curation, reviewedAt) {
  const notes = { ...(existingAudit.notes || {}) };
  for (const item of review.items || []) {
    const existing = notes[item.note_id];
    const usesDiandian = Array.isArray(existing?.evidence_methods)
      && existing.evidence_methods.includes("diandian_summary");
    const sameDiandianRevision = !usesDiandian
      || (/^[a-f0-9]{64}$/.test(String(item.diandian_summary_sha256 || ""))
        && existing.diandian_summary_sha256 === item.diandian_summary_sha256);
    const sameCurationRevision = Object.hasOwn(curation, item.note_id)
      && /^[a-f0-9]{64}$/.test(String(existing?.curation_sha256 || ""))
      && existing.curation_sha256 === curationRevision(curation[item.note_id]);
    if (existing?.status === "accepted" && sameCurationRevision && sameDiandianRevision) continue;
    notes[item.note_id] = pendingRecord(item, reviewedAt);
  }
  return { version: 1, updated_at: new Date().toISOString(), notes };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = initializeAudit(
    readJson(options.review, "review"),
    readJson(options["existing-audit"], "existing audit"),
    readJson(options.curation, "curation"),
    options["reviewed-at"]
  );
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const scoped = new Set(readJson(options.review, "review").items.map((item) => item.note_id));
  const counts = { accepted: 0, pending: 0, rejected: 0 };
  for (const [noteId, note] of Object.entries(result.notes)) if (scoped.has(noteId) && counts[note.status] !== undefined) counts[note.status] += 1;
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
