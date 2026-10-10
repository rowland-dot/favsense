import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateCandidates } from "../scripts/generate-curation-candidates.mjs";
import { attachEvidenceToCandidates, normalizeEvidencePacket, sealCandidateRevision } from "../scripts/normalize-evidence.mjs";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { formalCurationDecision } from "../scripts/curation-quality.mjs";
import { runCurationPipeline } from "../scripts/run-curation-pipeline.mjs";

// A rebuild that sees the same note content and the same evidence must keep a note accepted.
// Each case here stores an audit the way the review step wrote it, then rebuilds from the same inputs.

const hex = (character) => character.repeat(64);
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// The two shapes the review step stored for a non-Skill note's resource assessment.
// A note whose tools the reviewer checked was stored as verified; every other note as missing.
const STORED_NON_SKILL_ASSESSMENT = {
  verified: { status: "verified", resource_id: "", reason_code: "resource_not_applicable", resource_identity_sha256: "", verification_snapshot_sha256: "", resource: null },
  missing: { status: "missing", resource_id: "", reason_code: "resource_not_applicable", resource_identity_sha256: "", verification_snapshot_sha256: "", resource: null },
};

function packetFor(methods) {
  return {
    note_id: "note-a",
    content_sha256: hex("a"),
    public_text: "safe facts",
    comments: [],
    comments_checked: true,
    methods: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: sha("safe facts") }, ...methods],
  };
}

function baseInput(methods) {
  return {
    catalog: [{ id: "note-a", title: "Synthetic", description: "safe facts", content_sha256: hex("a") }],
    scope: { note_ids: ["note-a"] },
    profile: { classification: { default: "Other" } },
    evidence: [packetFor(methods)],
  };
}

// Stores a note the way the review step did: a sealed candidate plus an accepted audit entry.
function storedAcceptedNote({ methods, resourceStatus, tools }) {
  const prior = {
    id: "note-a", title: "Synthetic", summary: "A concrete summary of the note.", action: "Try the tool on a real sample.",
    themes: ["theme"], tools, kind: "Tool", category: "", category_override: false, category_reason: "",
  };
  const seed = generateCandidates({
    catalog: [{ id: "note-a", title: "Synthetic", description: "safe facts", content_sha256: hex("a") }],
    scope: { note_ids: ["note-a"] },
    profile: { classification: { default: "Other" } },
    priorCandidates: [prior],
  });
  const packet = normalizeEvidencePacket(packetFor(methods));
  const sealed = sealCandidateRevision(
    attachEvidenceToCandidates(seed, [packet])[0],
    STORED_NON_SKILL_ASSESSMENT[resourceStatus === "verified" ? "verified" : "missing"],
  );
  const audit = {
    status: "accepted",
    resource_status: resourceStatus,
    content_sha256: sealed.content_sha256,
    evidence_sha256: sealed.evidence_sha256,
    candidate_revision: sealed.candidate_revision,
    curation_revision: curationRevision(sealed),
    evidence_dependencies: sealed.evidence_dependencies,
  };
  return { sealed, audit };
}

function rebuildInput({ methods, stored }) {
  return {
    ...baseInput(methods),
    priorCandidates: [{ id: "note-a", ...stored.sealed }],
    current_curation: { "note-a": stored.sealed },
    current_audit: { notes: { "note-a": stored.audit } },
  };
}

const TRANSCRIPT_METHOD = { method: "audio_transcript", provider: "local-transcription", version: "1", result_sha256: sha("local transcript text") };

test("an accepted non-Skill note whose tools were checked stays accepted on rebuild", async () => {
  const methods = [TRANSCRIPT_METHOD];
  const stored = storedAcceptedNote({ methods, resourceStatus: "verified", tools: ["Cursor"] });
  const rebuilt = await runCurationPipeline(rebuildInput({ methods, stored }));
  assert.equal(rebuilt.curation["note-a"].review_status, "accepted");
  assert.equal(rebuilt.curation["note-a"].candidate_revision, stored.audit.candidate_revision);
  // The count of notes still waiting on a resource check is unchanged by this representation.
  assert.equal(rebuilt.counts.resource_pending, 1);
});

test("an accepted non-Skill note with no tools to check stays accepted on rebuild", async () => {
  const methods = [TRANSCRIPT_METHOD];
  const stored = storedAcceptedNote({ methods, resourceStatus: "not_applicable", tools: [] });
  const rebuilt = await runCurationPipeline(rebuildInput({ methods, stored }));
  assert.equal(rebuilt.curation["note-a"].review_status, "accepted");
});

test("a note whose evidence really changed goes back to review even when its tools were checked", async () => {
  const stored = storedAcceptedNote({ methods: [TRANSCRIPT_METHOD], resourceStatus: "verified", tools: ["Cursor"] });
  const changed = [{ ...TRANSCRIPT_METHOD, result_sha256: sha("a different transcript") }];
  const rebuilt = await runCurationPipeline(rebuildInput({ methods: changed, stored }));
  assert.equal(rebuilt.curation["note-a"].review_status, "pending");
});

test("an accepted Skill note with an expired resource check reports resource_stale, not audit_pending", () => {
  const current = {
    content_sha256: hex("a"), evidence_sha256: hex("b"), candidate_revision: hex("c"), curation_revision: hex("d"),
    evidence_dependencies: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("e") }],
    resource_required: true, resource_id: "", resource_identity_sha256: "", verification_snapshot_sha256: "", resource_fresh: false,
  };
  const auditEntry = { status: "accepted", ...current, resource_id: "github-owner-repo", resource_identity_sha256: hex("f"), verification_snapshot_sha256: hex("1") };
  const expired = formalCurationDecision({ publishable: false, auditEntry, currentRevisions: current, kind: "Skill", resource: null });
  assert.equal(expired.accepted, false);
  assert.equal(expired.reason_code, "resource_stale");
  // Other reasons keep their own codes.
  assert.equal(formalCurationDecision({ publishable: false, auditEntry, currentRevisions: current, kind: "Note", resource: null }).reason_code, "audit_pending");
  assert.equal(formalCurationDecision({ publishable: false, auditEntry: { status: "rejected" }, currentRevisions: current, kind: "Skill", resource: null }).reason_code, "audit_rejected");
  assert.equal(formalCurationDecision({ publishable: false, auditEntry: null, currentRevisions: current, kind: "Skill", resource: null }).reason_code, "audit_pending");
});
