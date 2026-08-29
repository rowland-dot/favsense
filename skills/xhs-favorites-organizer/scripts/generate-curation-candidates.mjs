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
    const previous = prior.get(id);
    const seed = {
      schema_version: 1,
      id,
      content_sha256: note.content_sha256,
      title: clean(note.title ?? note.display_title),
      description: clean(note.description),
      default_kind: clean(profile?.classification?.default || "Other"),
      prior_revision: HASH.test(clean(previous?.candidate_revision)) ? previous.candidate_revision : "",
    };
    return {
      id,
      content_sha256: seed.content_sha256,
      title: clean(previous?.title) || seed.title || "待核验收藏",
      category: clean(previous?.category),
      category_override: previous?.category_override === true,
      category_reason: clean(previous?.category_reason),
      summary: clean(previous?.summary),
      action: clean(previous?.action),
      themes: Array.isArray(previous?.themes) ? previous.themes.map(clean).filter(Boolean) : [],
      tools: Array.isArray(previous?.tools) ? previous.tools.map(clean).filter(Boolean) : [],
      kind: clean(previous?.kind) || seed.default_kind,
      status: "pending_review",
      blockers: ["evidence_missing"],
      candidate_seed_revision: digest(seed),
    };
  });
}
