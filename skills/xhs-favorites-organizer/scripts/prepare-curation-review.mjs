import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { containsCredentialShape } from "./sensitive-data.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}`);
    result[key.slice(2)] = value;
  }
  for (const required of ["catalog", "scope", "candidates", "resources", "evidence-root", "output"]) {
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

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const STABLE_NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isStableNoteId(value) {
  return typeof value === "string"
    && STABLE_NOTE_ID.test(value)
    && !UNSAFE_OBJECT_KEYS.has(value);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function containedEvidenceFile(root, noteId, filename, maxBytes, nested) {
  if (!root) return null;
  const base = path.resolve(root);
  const parts = nested ? [noteId] : [];
  let current = base;
  try {
    const rootMetadata = fs.lstatSync(base);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("unsafe root");
    }
    const bindings = [{ filename: base, metadata: rootMetadata, directory: true }];
    for (const part of parts) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) return null;
      const metadata = fs.lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("unsafe directory");
      }
      bindings.push({ filename: current, metadata, directory: true });
    }
    const target = path.join(current, filename);
    const relativeTarget = path.relative(base, target);
    if (
      !relativeTarget
      || path.isAbsolute(relativeTarget)
      || relativeTarget === ".."
      || relativeTarget.startsWith(`..${path.sep}`)
      || !fs.existsSync(target)
    ) return null;
    const metadata = fs.lstatSync(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("unsafe file");
    }
    if (metadata.size > maxBytes) return null;
    bindings.push({ filename: target, metadata, directory: false });
    const realBase = fs.realpathSync.native(base);
    const realTarget = fs.realpathSync.native(target);
    const relativeRealTarget = path.relative(realBase, realTarget);
    if (
      path.isAbsolute(relativeRealTarget)
      || relativeRealTarget === ".."
      || relativeRealTarget.startsWith(`..${path.sep}`)
    ) throw new Error("outside root");
    return { base, target, maxBytes, bindings };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Curation evidence path is unsafe");
  }
}

function readContainedText(binding) {
  if (!binding) return null;
  let descriptor;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(binding.target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    const expectedTarget = binding.bindings.at(-1).metadata;
    if (!opened.isFile() || !sameFileIdentity(opened, expectedTarget) || opened.size > binding.maxBytes) {
      throw new Error("opened evidence identity changed");
    }
    const text = fs.readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(text, "utf8") > binding.maxBytes) return null;
    for (const item of binding.bindings) {
      const current = fs.lstatSync(item.filename);
      if (
        current.isSymbolicLink()
        || (item.directory ? !current.isDirectory() : !current.isFile())
        || !sameFileIdentity(current, item.metadata)
      ) throw new Error("evidence identity changed");
    }
    const realBase = fs.realpathSync.native(binding.base);
    const realTarget = fs.realpathSync.native(binding.target);
    const relativeTarget = path.relative(realBase, realTarget);
    if (
      path.isAbsolute(relativeTarget)
      || relativeTarget === ".."
      || relativeTarget.startsWith(`..${path.sep}`)
    ) throw new Error("evidence escaped root");
    const after = fs.fstatSync(descriptor);
    if (!sameFileIdentity(after, opened)) throw new Error("opened evidence identity changed");
    return text;
  } catch {
    throw new Error("Curation evidence path is unsafe");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readDiandianSummary(root, noteId) {
  if (!root || !isStableNoteId(noteId)) return "";
  const source = readContainedText(
    containedEvidenceFile(root, noteId, `${noteId}.json`, 512 * 1024, false)
  );
  if (!source) return "";
  try {
    const record = JSON.parse(source.replace(/^\uFEFF/, ""));
    if (
      !record
      || typeof record !== "object"
      || Array.isArray(record)
      || record.version !== 1
      || record.provider !== "xiaohongshu-diandian"
      || record.prompt !== "总结"
      || record.note_id !== noteId
      || containsCredentialShape(record)
    ) return "";
    const summary = String(record.summary || "").replace(/\r\n?/g, "\n").trim();
    return summary && summary.length <= 200_000 ? summary : "";
  } catch {
    return "";
  }
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[\s\-_.·/\\()[\]（）【】]/g, "");
}

function readEvidence(root, noteId, filename) {
  const source = readContainedText(
    containedEvidenceFile(root, noteId, filename, 16 * 1024 * 1024, true)
  );
  if (!source) return null;
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function aliasesFor(resource) {
  return [resource.name, ...(Array.isArray(resource.aliases) ? resource.aliases : [])]
    .map(normalized)
    .filter(Boolean);
}

export function prepareReview({ catalog, scope, candidates, resources, evidenceRoot, diandianRoot, supplementalReview = null }) {
  if (
    !scope
    || !Array.isArray(scope.note_ids)
    || scope.note_ids.some((noteId) => !isStableNoteId(noteId))
    || new Set(scope.note_ids).size !== scope.note_ids.length
  ) throw new Error("Review scope contains an invalid or duplicate note ID");
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
    const transcript = readEvidence(evidenceRoot, noteId, "transcription.json");
    const visualOcr = readEvidence(evidenceRoot, noteId, "visual-ocr.json");
    const transcriptText = clean(transcript?.text);
    const visualText = visualOcr
      ? clean(visualOcr.text || visualOcr.ocr_text || JSON.stringify(visualOcr))
      : "";
    const diandianSummaryText = readDiandianSummary(diandianRoot, noteId);
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
    if (visualText) evidenceMethods.push("visual_ocr");
    if (diandianSummaryText) evidenceMethods.push("diandian_summary");
    if (hasImageReview) evidenceMethods.push("image_review");

    if (!note) blockers.push("scope-note-missing-from-catalog");
    if (!candidate) blockers.push("candidate-missing");
    if (note?.comment_evidence_checked !== true) blockers.push("comments-unchecked");
    if (note?.type === "视频" && !transcriptText && !visualText && !diandianSummaryText) blockers.push("video-body-evidence-missing");
    if (note?.type === "图文" && !diandianSummaryText && !hasImageReview) blockers.push("image-text-review-required");
    if (clean(candidate?.summary).length < 32) blockers.push("summary-too-short");
    if (clean(candidate?.action).length < 16) blockers.push("action-too-short");
    if (!clean(candidate?.kind)) blockers.push("kind-missing");
    if (!Array.isArray(candidate?.themes) || !candidate.themes.length) blockers.push("themes-missing");

    for (const tool of Array.isArray(candidate?.tools) ? candidate.tools : []) {
      const resource = resourceLookup.get(normalized(tool));
      const mentioned = normalized(tool).length >= 3 && searchableEvidence.includes(normalized(tool));
      toolChecks.push({ name: tool, mentioned_in_evidence: mentioned, indexed: Boolean(resource) });
      if (!mentioned) blockers.push(`tool-not-in-evidence:${tool}`);
      if (!resource) blockers.push(`resource-not-indexed:${tool}`);
    }

    items.push({
      note_id: noteId,
      media_type: note?.type || "",
      source_boards: note?.source_boards || [],
      public_text: publicText,
      transcript_text: transcriptText,
      visual_text: visualText,
      diandian_summary_text: diandianSummaryText,
      diandian_summary_sha256: diandianSummarySha256,
      evidence_methods: evidenceMethods,
      candidate: candidate || null,
      tool_checks: toolChecks,
      blockers: [...new Set(blockers)]
    });
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
