import { createHash } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const clean = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const digest = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export function generateCandidates({ catalog = [], scope = {}, profile = {}, priorCandidates = [] } = {}) {
  if (!Array.isArray(catalog) || !Array.isArray(scope.note_ids)) throw new Error("CANDIDATE_INPUT_INVALID");
  const notes = new Map(catalog.map((note) => [clean(note.id ?? note.note_id), note]));
  const prior = new Map(priorCandidates.map((candidate) => [clean(candidate.id), candidate]));
  return [...new Set(scope.note_ids.map(clean).filter(Boolean))].sort().map((id) => {
    const note = notes.get(id);
    if (!note || !HASH.test(clean(note.content_sha256))) throw new Error("CANDIDATE_SCOPE_NOTE_INVALID");
    const seed = {
      schema_version: 1,
      id,
      content_sha256: note.content_sha256,
      title: clean(note.title ?? note.display_title),
      description: clean(note.description),
      default_kind: clean(profile?.classification?.default || "Other"),
      prior_revision: HASH.test(clean(prior.get(id)?.candidate_revision)) ? prior.get(id).candidate_revision : "",
    };
    return {
      id,
      content_sha256: seed.content_sha256,
      title: seed.title || "待核验收藏",
      summary: "",
      action: "",
      themes: [],
      tools: [],
      kind: seed.default_kind,
      status: "pending_review",
      blockers: ["evidence_missing"],
      candidate_seed_revision: digest(seed),
    };
  });
}
