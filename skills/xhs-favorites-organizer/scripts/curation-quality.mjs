import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { curationRevision } from "./curation-revision.mjs";
import { containsCredentialShape } from "./sensitive-data.mjs";
import { auditCuration } from "./validate-curation.mjs";

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

export function loadCurationAudit(workspace, config) {
  const policy = config.curation_quality || {};
  if (policy.publish_only_accepted !== true) {
    return { policy, audit: { notes: {} }, baselineIds: new Set(), baselineRevisions: new Map() };
  }
  const filename = path.resolve(workspace, policy.audit_file || ".xhs-favorites/curation-audit.json");
  let audit;
  try {
    audit = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`curation quality audit could not be read: ${error.message}`);
  }
  let baselineIds = new Set();
  let baselineRevisions = new Map();
  if (policy.baseline_file) {
    const baselineFilename = path.resolve(workspace, policy.baseline_file);
    try {
      const baseline = JSON.parse(fs.readFileSync(baselineFilename, "utf8").replace(/^\uFEFF/, ""));
      baselineIds = new Set(Array.isArray(baseline.note_ids) ? baseline.note_ids.map(clean).filter(Boolean) : []);
      baselineRevisions = new Map(Object.entries(baseline.curation_hashes || {})
        .map(([noteId, revision]) => [clean(noteId), clean(revision)])
        .filter(([noteId, revision]) => noteId && /^[a-f0-9]{64}$/.test(revision)));
    } catch (error) {
      throw new Error(`curation publication baseline could not be read: ${error.message}`);
    }
  }
  return { policy, audit, baselineIds, baselineRevisions };
}

export function hasCompleteAcceptedAudit(noteId, note, entry, audit, context = {}) {
  if (!entry || !context.config || !context.resources) return false;
  if (context.currentRevisions && !acceptedRevisionsCurrent(audit?.notes?.[noteId], context.currentRevisions)) return false;
  const result = auditCuration({
    catalog: { notes: { [noteId]: note } },
    config: context.config,
    curation: { [noteId]: entry },
    resources: context.resources,
    audit: { notes: { [noteId]: audit?.notes?.[noteId] } },
    scopeIds: [noteId]
  });
  return result.fatal.length === 0 && result.report.totals.accepted === 1;
}

export function isPublishableCuration(
  noteId,
  note,
  curation,
  policy,
  audit,
  baselineIds = new Set(),
  baselineRevisions = new Map(),
  context = {}
) {
  if (policy.publish_only_accepted !== true) return true;
  if (!Object.hasOwn(curation, noteId)) return false;
  const entry = curation[noteId];
  if (baselineIds.has(noteId) && baselineRevisions.get(noteId) === curationRevision(entry)) return true;
  return hasCompleteAcceptedAudit(noteId, note, entry, audit, context);
}

export function loadFormalPointSummary(directory, noteId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(noteId || ""))) return null;
  const base = path.resolve(directory);
  const target = path.resolve(base, `${noteId}.json`);
  if (path.dirname(target) !== base) return null;
  try {
    const metadata = fs.statSync(target);
    if (!metadata.isFile() || metadata.size > 512 * 1024) return null;
    const record = JSON.parse(fs.readFileSync(target, "utf8").replace(/^\uFEFF/, ""));
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
      || !clean(record.captured_at)
      || containsCredentialShape(record)
    ) return null;
    const summary = record.summary.replace(/\r\n?/g, "\n").trim();
    if (!summary || summary.length > 200_000) return null;
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
  } catch {
    return null;
  }
}

export function currentFormalRevisions(note, entry, resource = null) {
  const candidate = {
    content_sha256: clean(note?.content_sha256),
    evidence_sha256: clean(entry?.evidence_sha256),
    candidate_revision: clean(entry?.candidate_revision),
    curation_revision: entry ? curationRevision(entry) : "",
    evidence_dependencies: entry?.evidence_dependencies,
    resource_required: clean(entry?.kind) === "Skill",
    resource_id: clean(resource?.id),
    resource_identity_sha256: clean(resource?.resource_identity_sha256),
    verification_snapshot_sha256: clean(resource?.verification_snapshot_sha256),
    resource_fresh: resource !== null,
  };
  return REVISION_KEYS.every((key) => HASH.test(candidate[key])) && canonicalDependencies(candidate.evidence_dependencies)
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

function revisionReason(auditEntry, current) {
  if (!auditEntry || auditEntry.status !== "accepted") return "audit_pending";
  if (auditEntry.content_sha256 !== current?.content_sha256) return "content_changed";
  if (auditEntry.evidence_sha256 !== current?.evidence_sha256) return "evidence_changed";
  return "audit_pending";
}

export function formalCurationDecision({
  publishable = false,
  auditEntry = null,
  currentRevisions = null,
  point = null,
  kind = "",
  resource = null,
} = {}) {
  const base = {
    accepted: false,
    reason_code: "audit_pending",
    summary_source: "metadata",
    content_sha256: clean(currentRevisions?.content_sha256),
    evidence_sha256: clean(currentRevisions?.evidence_sha256),
    resource_ids: [],
  };
  if (!publishable) return base;
  if (clean(kind) === "Skill" && !clean(resource?.id)) return { ...base, reason_code: "resource_stale" };
  if (!auditEntry || !currentRevisions || !acceptedRevisionsCurrent(auditEntry, currentRevisions)) {
    return { ...base, reason_code: revisionReason(auditEntry, currentRevisions) };
  }
  const pointDependencyCurrent = Boolean(
    point?.version === 2
    && HASH.test(clean(point.prompt_version))
    && point.content_sha256 === currentRevisions.content_sha256
    && currentRevisions.evidence_dependencies.some((dependency) => (
      dependency.method === "diandian_summary"
      && dependency.provider === point.provider
      && dependency.version === point.prompt_version
      && dependency.result_sha256 === point.summary_sha256
    ))
  );
  return {
    accepted: true,
    reason_code: "",
    summary_source: pointDependencyCurrent ? "point" : "curation",
    content_sha256: clean(currentRevisions?.content_sha256),
    evidence_sha256: clean(currentRevisions?.evidence_sha256),
    resource_ids: clean(resource?.id) ? [resource.id] : [],
  };
}

export function publicEvidenceStatus(noteId, audit, isFrameVerified = false, acceptedAuditIsCurrent = false) {
  if (acceptedAuditIsCurrent) {
    return {
      method: "已按媒体类型读取内容、检查评论，并对关键资源完成必要核验",
      locallyAvailable: true
    };
  }
  return {
    method: isFrameVerified
      ? "已结合本地视频证据核验内容"
      : "目前依据原帖公开文字整理，媒体内容尚未完整解读",
    locallyAvailable: Boolean(isFrameVerified)
  };
}
