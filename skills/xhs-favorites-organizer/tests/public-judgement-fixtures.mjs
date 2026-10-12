// Inputs shared by the public judgement tests: the module's own tests and the tests that run the
// web builder on the same notes.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { expectedResourceRevisions } from "../scripts/resource-quality.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const hex = (character) => character.repeat(64);
export const profile = JSON.parse(await readFile(join(root, "config/domain-profiles/software.json"), "utf8"));
export const config = { boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }] };

// Real DianDian replies, some of them refusals to read the note: the one table both copies of the refusal rule are held to.
export const diandianReplyCases = JSON.parse(
  await readFile(join(root, "skills/xhs-favorites-organizer/test-fixtures/diandian-refusal-cases.json"), "utf8")
).cases;
export const refusalReply = diandianReplyCases.find((entry) => entry.id === "refusal-cannot-open-link-asks-for-copy").text;
export const normalReply = diandianReplyCases.find((entry) => entry.id === "summary-starts-with-according-to-your-note").text;

// A fixed clock that is not the date the suite runs on, so a call site that forgets to pass it
// cannot pass by accident.
export const TODAY = "2026-10-10";
export const PROMPT = hex("7");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sealResource = (resource) => Object.assign(resource, expectedResourceRevisions(resource));

export function skillResource(overrides = {}) {
  return sealResource({
    id: "github-owner-repo", name: "Official synthetic Skill", aliases: [], type: "Agent Skill",
    canonical_repo: "owner/repo", repo: "https://github.com/owner/repo",
    download: "https://github.com/owner/repo/archive/refs/heads/main.zip", stars: "4", stars_numeric: 4,
    license: "MIT", skill_manifest: "SKILL.md", compatibility: ["Codex"], compatibility_evidence: ["README.md"],
    verified_at: "2026-10-05", status: "verified", usage_note: "Synthetic verified fixture.", ...overrides,
  });
}

export const note = (overrides = {}) => ({
  note_id: "n1", title: "Official synthetic Skill", description: "Synthetic safe body",
  published_at: "2026-10-01", source_boards: ["Synthetic"], content_sha256: hex("c"), ...overrides,
});

// An accepted, current Skill note: reviewed entry, matching audit record, current point summary,
// one fresh official resource. `input` is what the module takes for note "n1".
export function acceptedSkill({ resource = skillResource(), pointText = "Accepted point summary for the synthetic Skill." } = {}) {
  const pointSha = sha256(pointText);
  const entry = {
    category: "Synthetic", themes: ["testing"], summary: "Accepted formal synthetic summary with enough detail for review.",
    action: "Inspect the verified synthetic Skill before installing it in a controlled workspace.",
    tools: [resource.name], kind: "Skill", evidence_sha256: hex("e"), candidate_revision: hex("f"),
    evidence_dependencies: [{ method: "diandian_summary", provider: "xiaohongshu-diandian", version: PROMPT, result_sha256: pointSha }],
  };
  const audit = {
    status: "accepted", reviewed_at: "2026-10-02", evidence_methods: ["comments", "diandian_summary", "official_source"],
    comments_checked: true, claims_supported: true, resource_status: "verified", unresolved_facts: [],
    diandian_summary_sha256: pointSha, curation_sha256: curationRevision(entry),
    content_sha256: hex("c"), evidence_sha256: entry.evidence_sha256, candidate_revision: entry.candidate_revision,
    curation_revision: curationRevision(entry), evidence_dependencies: entry.evidence_dependencies,
    resource_id: resource.id, resource_identity_sha256: resource.resource_identity_sha256,
    verification_snapshot_sha256: resource.verification_snapshot_sha256,
  };
  const point = { version: 2, provider: "xiaohongshu-diandian", prompt_version: PROMPT, summary: pointText, summary_sha256: pointSha, content_sha256: hex("c") };
  return {
    entry, audit, resource, pointText, point,
    input: {
      noteId: "n1", note: note(), curation: { n1: entry }, sealedCandidates: {},
      quality: { policy: { publish_only_accepted: true }, audit: { version: 2, notes: { n1: audit } }, baselineIds: new Set(), baselineRevisions: new Map() },
      point, resourceRegistry: { verified_at: TODAY, resources: [resource] }, config, profile,
      effectiveDate: TODAY, promptVersion: PROMPT,
    },
  };
}

// The point summary as it is stored on disk for the builders to read.
export const pointFile = (id, { point }) => ({
  version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: id, title: "Official synthetic Skill",
  summary: point.summary, content_sha256: point.content_sha256, prompt_version: point.prompt_version,
  request_sha256: hex("8"), summary_sha256: point.summary_sha256, captured_at: "2026-10-02T00:00:00.000Z",
});
