import { createHash } from "node:crypto";
import { evidenceRevision, normalizeEvidenceMethod } from "./content-revision.mjs";

const HASH = /^[a-f0-9]{64}$/;
const clean = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const digest = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export function normalizeEvidencePacket(input = {}) {
  const contentSha256 = clean(input.content_sha256);
  if (!HASH.test(contentSha256) || !Array.isArray(input.methods)) throw new Error("EVIDENCE_PACKET_INVALID");
  const methods = input.methods.map(normalizeEvidenceMethod).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const evidenceSha256 = evidenceRevision({ contentSha256, comments: input.comments || [], commentsChecked: input.comments_checked === true, methods });
  return {
    schema_version: 1,
    note_id: clean(input.note_id),
    content_sha256: contentSha256,
    evidence_sha256: evidenceSha256,
    public_text_sha256: digest(clean(input.public_text)),
    comments_checked: input.comments_checked === true,
    methods,
  };
}

export function attachEvidenceToCandidates(candidates, packets) {
  if (!Array.isArray(candidates) || !Array.isArray(packets)) throw new Error("EVIDENCE_ATTACH_INVALID");
  return candidates.map((candidate) => {
    const packet = packets.find((item) => item.note_id && item.note_id === candidate.id)
      || packets.find((item) => item.content_sha256 === candidate.content_sha256);
    if (!packet || packet.content_sha256 !== candidate.content_sha256) return candidate;
    return {
      ...candidate,
      evidence_sha256: packet.evidence_sha256,
      evidence_dependencies: packet.methods,
      blockers: (candidate.blockers || []).filter((blocker) => blocker !== "evidence_missing"),
    };
  });
}

export function sealCandidateRevision(candidate, resourceAssessment = {}) {
  if (!HASH.test(clean(candidate.content_sha256)) || !HASH.test(clean(candidate.evidence_sha256)) || !HASH.test(clean(candidate.candidate_seed_revision))) throw new Error("CANDIDATE_NOT_READY_TO_SEAL");
  const resource = {
    status: clean(resourceAssessment.status || "missing"),
    resource_id: clean(resourceAssessment.resource_id),
    reason_code: clean(resourceAssessment.reason_code || "resource_not_applicable"),
    resource_identity_sha256: clean(resourceAssessment.resource_identity_sha256),
    verification_snapshot_sha256: clean(resourceAssessment.verification_snapshot_sha256),
  };
  const semantic = {
    id: candidate.id, content_sha256: candidate.content_sha256, evidence_sha256: candidate.evidence_sha256,
    title: clean(candidate.title), summary: clean(candidate.summary), action: clean(candidate.action),
    themes: [...new Set(candidate.themes || [])].map(clean).filter(Boolean).sort(),
    tools: [...new Set(candidate.tools || [])].map(clean).filter(Boolean).sort(), kind: clean(candidate.kind),
    blockers: [...new Set(candidate.blockers || [])].sort(), resource,
  };
  return { ...candidate, ...semantic, resource_assessment: resource, candidate_revision: digest(semantic) };
}
