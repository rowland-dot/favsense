import fs from "node:fs";
import path from "node:path";
import { curationRevision } from "./curation-revision.mjs";
import { auditCuration } from "./validate-curation.mjs";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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
