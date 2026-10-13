import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { HASH, clean, containedEvidenceFile, currentEvidence, readContainedText, readEvidence } from "./evidence-files.mjs";
import { parseFormalPointSummaryRecord } from "./curation-quality.mjs";
import { reviewPacketRevision } from "./curation-revision.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}`);
    result[key.slice(2)] = value;
  }
  for (const required of [
    "catalog", "scope", "candidates", "resources", "evidence-root",
    "diandian-prompt-version", "output"
  ]) {
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

const STABLE_NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isStableNoteId(value) {
  return typeof value === "string"
    && STABLE_NOTE_ID.test(value)
    && !UNSAFE_OBJECT_KEYS.has(value);
}

function readDiandianSummary(root, noteId, contentSha256, expectedPromptVersion) {
  if (!root || !isStableNoteId(noteId) || !HASH.test(expectedPromptVersion)) return "";
  const source = readContainedText(
    containedEvidenceFile(root, noteId, `${noteId}.json`, 512 * 1024, false)
  );
  if (!source) return "";
  try {
    const record = parseFormalPointSummaryRecord(
      JSON.parse(source.replace(/^\uFEFF/, "")),
      noteId,
      expectedPromptVersion
    );
    return record?.content_sha256 === contentSha256 ? record.summary : "";
  } catch {
    return "";
  }
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[\s\-_.·/\\()[\]（）【】]/g, "");
}

function aliasesFor(resource) {
  return [resource.name, ...(Array.isArray(resource.aliases) ? resource.aliases : [])]
    .map(normalized)
    .filter(Boolean);
}

export function prepareReview({
  catalog,
  scope,
  candidates,
  resources,
  evidenceRoot,
  diandianRoot,
  expectedPromptVersion = "",
  supplementalReview = null
}) {
  if (
    !scope
    || !Array.isArray(scope.note_ids)
    || scope.note_ids.some((noteId) => !isStableNoteId(noteId))
    || new Set(scope.note_ids).size !== scope.note_ids.length
  ) throw new Error("Review scope contains an invalid or duplicate note ID");
  if (expectedPromptVersion && !HASH.test(expectedPromptVersion)) {
    throw new Error("DianDian prompt version is invalid");
  }
  const notes = catalog.notes || catalog;
  const resourceItems = Array.isArray(resources) ? resources : resources.resources || [];
  const resourceLookup = new Map();
  for (const resource of resourceItems) for (const alias of aliasesFor(resource)) resourceLookup.set(alias, resource);
  const supplementalById = new Map(
    (Array.isArray(supplementalReview?.items) ? supplementalReview.items : [])
      .map((item) => [String(item?.note_id || ""), item])
      .filter(([noteId]) => isStableNoteId(noteId))
  );

  const items = [];
  for (const noteId of scope.note_ids) {
    const note = Object.hasOwn(notes, noteId) ? notes[noteId] : undefined;
    const candidate = Object.hasOwn(candidates, noteId) ? candidates[noteId] : undefined;
    const supplemental = supplementalById.get(noteId);
    const supplementalMethods = Array.isArray(supplemental?.audit?.evidence_methods)
      ? supplemental.audit.evidence_methods
      : [];
    const hasImageReview = supplementalMethods.includes("image_review");
    const contentSha256 = clean(note?.content_sha256);
    const transcript = currentEvidence(
      readEvidence(evidenceRoot, noteId, "transcription.json"),
      contentSha256,
      { status: "transcribed", method: "local_transcription" }
    );
    const visualOcr = currentEvidence(
      readEvidence(evidenceRoot, noteId, "visual-ocr.json"),
      contentSha256,
      { status: "extracted", method: "local_image_ocr" }
    );
    const transcriptText = transcript?.text || "";
    const visualText = visualOcr?.text || "";
    const diandianSummaryText = readDiandianSummary(
      diandianRoot,
      noteId,
      contentSha256,
      expectedPromptVersion
    );
    const diandianSummarySha256 = diandianSummaryText
      ? createHash("sha256").update(diandianSummaryText, "utf8").digest("hex")
      : "";
    const publicText = clean([note?.title, note?.description, ...(note?.tags || [])].filter(Boolean).join(" "));
    const searchableEvidence = normalized([publicText, transcriptText, visualText, diandianSummaryText].join(" "));
    const blockers = [];
    const toolChecks = [];
    const evidenceMethods = [];

    if (publicText) evidenceMethods.push("description");
    if (note?.comment_evidence_checked === true) evidenceMethods.push("comments");
    if (transcriptText) evidenceMethods.push("audio_transcript");
    if (visualText) evidenceMethods.push("image_ocr");
    if (diandianSummaryText) evidenceMethods.push("diandian_summary");
    if (hasImageReview) evidenceMethods.push("image_review");

    if (!note) blockers.push("scope-note-missing-from-catalog");
    if (!candidate) blockers.push("candidate-missing");
    if (note?.comment_evidence_checked !== true) blockers.push("comments-unchecked");
    if (note?.type === "视频" && !transcriptText && !visualText && !diandianSummaryText) blockers.push("video-body-evidence-missing");
    if (note?.type === "图文" && !visualText && !hasImageReview) {
      blockers.push("image-text-review-required");
    }
    if (clean(candidate?.summary).length < 32) blockers.push("summary-too-short");
    // Optional since issue 99; one that is written must still be real.
    if (clean(candidate?.action) && clean(candidate.action).length < 16) blockers.push("action-too-short");
    if (!clean(candidate?.kind)) blockers.push("kind-missing");
    if (!Array.isArray(candidate?.themes) || !candidate.themes.length) blockers.push("themes-missing");

    for (const tool of Array.isArray(candidate?.tools) ? candidate.tools : []) {
      const resource = resourceLookup.get(normalized(tool));
      const mentioned = normalized(tool).length >= 3 && searchableEvidence.includes(normalized(tool));
      toolChecks.push({ name: tool, mentioned_in_evidence: mentioned, indexed: Boolean(resource) });
      if (!mentioned) blockers.push(`tool-not-in-evidence:${tool}`);
      if (!resource) blockers.push(`resource-not-indexed:${tool}`);
    }

    const item = {
      note_id: noteId,
      content_sha256: contentSha256,
      media_type: note?.type || "",
      source_boards: note?.source_boards || [],
      public_text: publicText,
      transcript_text: transcriptText,
      transcript_evidence: transcript?.evidence || null,
      visual_text: visualText,
      visual_evidence: visualOcr?.evidence || null,
      diandian_summary_text: diandianSummaryText,
      diandian_summary_sha256: diandianSummarySha256,
      evidence_methods: evidenceMethods,
      candidate: candidate || null,
      tool_checks: toolChecks,
      blockers: [...new Set(blockers)]
    };
    item.review_packet_sha256 = reviewPacketRevision(item);
    items.push(item);
  }
  return {
    version: 1,
    created_at: new Date().toISOString(),
    scope_count: items.length,
    structurally_ready: items.filter((item) => item.blockers.length === 0).length,
    items
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = prepareReview({
    catalog: readJson(options.catalog, "catalog"),
    scope: readJson(options.scope, "scope"),
    candidates: readJson(options.candidates, "candidates"),
    resources: readJson(options.resources, "resources"),
    evidenceRoot: path.resolve(options["evidence-root"]),
    diandianRoot: path.resolve(options["diandian-dir"] || ".xhs-favorites/diandian-summaries"),
    expectedPromptVersion: options["diandian-prompt-version"],
    supplementalReview: options["supplemental-review"]
      ? readJson(options["supplemental-review"], "supplemental review")
      : null
  });
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ scope: result.scope_count, structurallyReady: result.structurally_ready })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
