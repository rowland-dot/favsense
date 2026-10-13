import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { curationRevision } from "./curation-revision.mjs";
import { containsCredentialShape } from "./sensitive-data.mjs";
import { isDiandianRefusal } from "./diandian-refusal.mjs";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const REVISION_KEYS = ["content_sha256", "evidence_sha256", "candidate_revision", "curation_revision"];
const HASH = /^[a-f0-9]{64}$/;

function canonicalDependencies(value) {
  if (!Array.isArray(value)) return null;
  const normalized = value.map((dependency) => {
    if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) return null;
    if (Object.keys(dependency).sort().join(",") !== "method,provider,result_sha256,version") return null;
    const result = Object.fromEntries(Object.entries(dependency).map(([key, item]) => [key, clean(item)]));
    if (!result.method || !result.provider || !result.version || !HASH.test(result.result_sha256)) return null;
    return result;
  });
  if (normalized.includes(null)) return null;
  return normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

// The curation step seals a candidate for every note in scope, but only accepted ones reach the formal
// curation file. The rest are handed to the builders separately so both judge a not-accepted note from
// the same sealed kind and revisions instead of each guessing from the note text.
export function sealedCandidateFor(candidates, noteId) {
  if (!candidates || typeof candidates !== "object" || Array.isArray(candidates) || !Object.hasOwn(candidates, noteId)) return null;
  const entry = candidates[noteId];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
}

export function acceptedRevisionsCurrent(auditEntry, current = {}) {
  if (!auditEntry || auditEntry.status !== "accepted") return false;
  if (!REVISION_KEYS.every((key) => HASH.test(clean(auditEntry[key])) && auditEntry[key] === current[key])) return false;
  const auditedDependencies = canonicalDependencies(auditEntry.evidence_dependencies);
  const currentDependencies = canonicalDependencies(current.evidence_dependencies);
  if (!auditedDependencies || !currentDependencies || JSON.stringify(auditedDependencies) !== JSON.stringify(currentDependencies)) return false;
  if (current.resource_required === true) {
    return Boolean(
      clean(auditEntry.resource_id) === clean(current.resource_id)
      && clean(current.resource_id)
      && HASH.test(clean(auditEntry.resource_identity_sha256))
      && auditEntry.resource_identity_sha256 === current.resource_identity_sha256
      && HASH.test(clean(auditEntry.verification_snapshot_sha256))
      && auditEntry.verification_snapshot_sha256 === current.verification_snapshot_sha256
      && current.resource_fresh === true
    );
  }
  return true;
}

// Notes whose post can no longer be opened, as the review audit records them. Only the card's source-line
// label uses this; it never changes a title or text. No audit file configured, or none on disk, means none.
export function loadUnreachableNoteIds(workspace, config) {
  const file = config?.curation_quality?.audit_file;
  if (!file) return new Set();
  let audit;
  try {
    audit = JSON.parse(fs.readFileSync(path.resolve(workspace, file), "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw new Error(`curation audit could not be read: ${error.message}`);
  }
  return new Set(Object.entries(audit?.notes || {}).filter(([, entry]) => entry?.status === "unavailable").map(([id]) => id));
}

export function parseFormalPointSummaryRecord(record, noteId, expectedPromptVersion = "") {
  const expectedKeys = [
    "captured_at",
    "content_sha256",
    "note_id",
    "prompt",
    "prompt_version",
    "provider",
    "request_sha256",
    "summary",
    "summary_sha256",
    "title",
    "version",
  ];
  if (
    !record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).sort().join(",") !== expectedKeys.join(",")
    || record.version !== 2
    || record.provider !== "xiaohongshu-diandian"
    || record.prompt !== "总结"
    || record.note_id !== noteId
    || typeof record.title !== "string"
    || typeof record.summary !== "string"
    || typeof record.captured_at !== "string"
    || typeof record.prompt_version !== "string"
    || typeof record.content_sha256 !== "string"
    || typeof record.request_sha256 !== "string"
    || typeof record.summary_sha256 !== "string"
    || !clean(record.title)
    || !HASH.test(record.prompt_version)
    || !HASH.test(record.content_sha256)
    || !HASH.test(record.request_sha256)
    || !HASH.test(record.summary_sha256)
    || (expectedPromptVersion && record.prompt_version !== expectedPromptVersion)
    || !clean(record.captured_at)
    || containsCredentialShape(record)
  ) return null;
  const summary = record.summary.replace(/\r\n?/g, "\n").trim();
  if (!summary || summary.length > 200_000) return null;
  // A reply that says DianDian could not read the note is not a summary of it.
  if (isDiandianRefusal(summary)) return null;
  const summarySha256 = createHash("sha256").update(summary, "utf8").digest("hex");
  if (record.summary_sha256 !== summarySha256) return null;
  return {
    version: record.version,
    provider: record.provider,
    prompt_version: record.prompt_version,
    summary,
    summary_sha256: summarySha256,
    content_sha256: record.content_sha256
  };
}

// Exact (bigint) file info: ordinary Number values round the 64-bit Windows file number, so two
// different files can look like the same one and a swapped-in file would pass the identity checks below.
const EXACT = { bigint: true };
const MAX_POINT_SUMMARY_BYTES = 512 * 1024;

export function loadFormalPointSummary(directory, noteId, expectedPromptVersion) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(noteId || ""))) return null;
  if (expectedPromptVersion !== undefined && !HASH.test(expectedPromptVersion)) return null;
  const base = path.resolve(directory);
  const target = path.resolve(base, `${noteId}.json`);
  if (path.dirname(target) !== base) return null;
  let descriptor;
  try {
    const baseMetadata = fs.lstatSync(base, EXACT);
    const metadata = fs.lstatSync(target, EXACT);
    if (
      !baseMetadata.isDirectory()
      || baseMetadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size > BigInt(MAX_POINT_SUMMARY_BYTES)
    ) return null;
    const realBase = fs.realpathSync.native(base);
    const realTarget = fs.realpathSync.native(target);
    const relativeTarget = path.relative(realBase, realTarget);
    if (
      path.isAbsolute(relativeTarget)
      || relativeTarget === ".."
      || relativeTarget.startsWith(`..${path.sep}`)
    ) return null;
    const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, EXACT);
    if (
      !opened.isFile()
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.size > BigInt(MAX_POINT_SUMMARY_BYTES)
    ) return null;
    const source = fs.readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_POINT_SUMMARY_BYTES) return null;
    const after = fs.lstatSync(target, EXACT);
    const openedAfter = fs.fstatSync(descriptor, EXACT);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || after.dev !== metadata.dev
      || after.ino !== metadata.ino
      || openedAfter.dev !== opened.dev
      || openedAfter.ino !== opened.ino
      || fs.realpathSync.native(target) !== realTarget
    ) return null;
    return parseFormalPointSummaryRecord(
      JSON.parse(source.replace(/^\uFEFF/, "")),
      noteId,
      expectedPromptVersion
    );
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function currentFormalRevisions(note, entry, resource = null, expectedPromptVersion = "") {
  const dependencies = canonicalDependencies(entry?.evidence_dependencies);
  if (!dependencies) return null;
  const pointDependencies = dependencies.filter((dependency) => dependency.method === "diandian_summary");
  if (
    pointDependencies.length
    && (
      !HASH.test(expectedPromptVersion)
      || pointDependencies.some((dependency) => dependency.version !== expectedPromptVersion)
    )
  ) return null;
  const candidate = {
    content_sha256: clean(note?.content_sha256),
    evidence_sha256: clean(entry?.evidence_sha256),
    candidate_revision: clean(entry?.candidate_revision),
    curation_revision: entry ? curationRevision(entry) : "",
    evidence_dependencies: dependencies,
    resource_required: clean(entry?.kind) === "Skill",
    resource_id: clean(resource?.id),
    resource_identity_sha256: clean(resource?.resource_identity_sha256),
    verification_snapshot_sha256: clean(resource?.verification_snapshot_sha256),
    resource_fresh: resource !== null,
  };
  return REVISION_KEYS.every((key) => HASH.test(candidate[key]))
    ? candidate
    : null;
}

export function formalContentKind(profile, candidateKind, accepted = false) {
  const kind = clean(candidateKind);
  if (kind !== "Skill" || accepted) return kind;
  const defaultKind = clean(profile?.classification?.default);
  if (defaultKind !== "Skill" && Object.hasOwn(profile?.content_kinds || {}, defaultKind)) return defaultKind;
  if (Object.hasOwn(profile?.content_kinds || {}, "Note")) return "Note";
  throw new Error("Skill candidates require a declared non-Skill neutral content kind");
}
