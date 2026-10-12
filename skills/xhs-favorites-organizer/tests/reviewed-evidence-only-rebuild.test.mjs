import test from "node:test";
import assert from "node:assert/strict";
import { formalCurationDecision } from "../scripts/curation-quality.mjs";

// Issue 17: a note the reviewer accepted is rebuilt from the evidence the reviewer listed.
// When it still fails, the reason shown must say what really changed.

const hex = (character) => character.repeat(64);
const sealResource = (resource) => Object.assign(resource, expectedResourceRevisions(resource));

const current = {
  content_sha256: hex("a"), evidence_sha256: hex("b"), candidate_revision: hex("c"), curation_revision: hex("d"),
  evidence_dependencies: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("e") }],
  resource_required: false, resource_id: "", resource_identity_sha256: "", verification_snapshot_sha256: "", resource_fresh: false,
};
const accepted = { status: "accepted", ...current };

test("an accepted note whose evidence changed is reported as evidence_changed, not audit_pending", () => {
  const decision = formalCurationDecision({
    publishable: false,
    auditEntry: { ...accepted, evidence_sha256: hex("1") },
    currentRevisions: current,
    kind: "Note",
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason_code, "evidence_changed");
});

test("an accepted note whose content changed is reported as content_changed", () => {
  const decision = formalCurationDecision({
    publishable: false,
    auditEntry: { ...accepted, content_sha256: hex("2") },
    currentRevisions: current,
    kind: "Note",
  });
  assert.equal(decision.reason_code, "content_changed");
});

test("an unpublishable note with no audit, or a rejected one, keeps its own reason", () => {
  assert.equal(formalCurationDecision({ publishable: false, auditEntry: null, currentRevisions: current, kind: "Note" }).reason_code, "audit_pending");
  assert.equal(formalCurationDecision({ publishable: false, auditEntry: { status: "rejected" }, currentRevisions: current, kind: "Note" }).reason_code, "audit_rejected");
});

// --- Builders: the reason shown for a note that is not accepted comes from the sealed candidate ---

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { expectedResourceRevisions } from "../scripts/resource-quality.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const builder = (name) => join(root, "skills/xhs-favorites-organizer/scripts", name);

// Builds the web data from a catalog, a curation file that holds no entry for the note (it is not
// accepted), and the sealed candidates the curation step produced for it.
async function buildWeb({ notes, candidates, audit, resources }) {
  const work = await mkdtemp(join(tmpdir(), "favsense-reviewed-evidence-"));
  const paths = Object.fromEntries(["catalog", "config", "curation", "audit", "baseline", "profile", "resources", "candidates", "public"].map((name) => [name, join(work, `${name}.json`)]));
  const profile = JSON.parse(await readFile(join(root, "config/domain-profiles/software.json"), "utf8"));
  try {
    await Promise.all([
      writeFile(paths.catalog, JSON.stringify({ version: 1, notes })),
      writeFile(paths.config, JSON.stringify({
        version: 1, domain_profile: paths.profile, curation_file: paths.curation,
        curation_quality: { publish_only_accepted: true, audit_file: paths.audit, baseline_file: paths.baseline },
        boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {},
      })),
      writeFile(paths.curation, "{}"),
      writeFile(paths.audit, JSON.stringify({ version: 2, notes: audit })),
      writeFile(paths.baseline, JSON.stringify({ version: 1, note_ids: [], curation_hashes: {} })),
      writeFile(paths.profile, JSON.stringify(profile)),
      writeFile(paths.resources, JSON.stringify({ verified_at: "2026-10-10", resources })),
      writeFile(paths.candidates, JSON.stringify(candidates)),
      mkdir(join(work, "point"), { recursive: true }),
    ]);
    const common = [
      "--catalog", paths.catalog, "--config", paths.config, "--curation", paths.curation,
      "--profile", paths.profile, "--resources", paths.resources, "--candidates", paths.candidates,
      "--effective-date", "2026-10-10", "--diandian-dir", join(work, "point"),
    ];
    const site = spawnSync(process.execPath, [builder("build-public-site.mjs"), ...common, "--video-analysis", join(work, "video"), "--output", paths.public], { cwd: root, encoding: "utf8" });
    assert.equal(site.status, 0, site.stderr || site.stdout);
    const publicData = JSON.parse(await readFile(paths.public, "utf8"));
    return Object.fromEntries(publicData.notes.map((note) => [note.id, note]));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function sealedCandidate({ kind, tools = [], text }) {
  const entry = {
    category: "Synthetic", themes: ["testing"], summary: `Sealed summary for ${text}`, action: "Review the note.",
    tools, kind, content_sha256: hex("c"), evidence_sha256: hex("e"), candidate_revision: hex("f"),
    evidence_dependencies: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("1") }],
    review_status: "pending", review_reason_code: "audit_pending",
  };
  return entry;
}

function auditFor(entry, overrides = {}) {
  return {
    status: "accepted", reviewed_at: "2026-08-29", evidence_methods: ["comments"], comments_checked: true, claims_supported: true,
    resource_status: "not_applicable", unresolved_facts: [],
    content_sha256: entry.content_sha256, evidence_sha256: entry.evidence_sha256, candidate_revision: entry.candidate_revision,
    curation_revision: curationRevision(entry), evidence_dependencies: entry.evidence_dependencies, ...overrides,
  };
}

test("a not-accepted note shows the sealed candidate's reason, not the builder's own guess at its kind", async () => {
  const expiredSkill = sealResource({
    id: "github-owner-repo", name: "Synthetic expired Skill", aliases: [], type: "Agent Skill",
    canonical_repo: "owner/repo", repo: "https://github.com/owner/repo",
    download: "https://github.com/owner/repo/archive/refs/heads/main.zip", stars: "4", stars_numeric: 4,
    license: "MIT", skill_manifest: "SKILL.md", compatibility: ["Codex"], compatibility_evidence: ["README.md"],
    verified_at: "2026-08-27", status: "verified", usage_note: "Synthetic fixture checked more than 30 days ago.",
  });
  // Reads like a Skill to the builder's own wording rules, but the curation step sealed it as a plain note.
  const noteId = "note-looks-like-a-skill";
  // Does not read like a Skill, but the curation step sealed it as one whose resource check has expired.
  const skillId = "skill-reads-like-a-workflow";
  // Reads like a Skill and was sealed as one whose resource check has expired.
  const plainSkillId = "skill-reads-like-a-skill";
  const noteCandidate = sealedCandidate({ kind: "Note", text: "note" });
  const skillCandidate = sealedCandidate({ kind: "Skill", tools: [expiredSkill.name], text: "skill" });
  const plainSkillCandidate = sealedCandidate({ kind: "Skill", tools: [expiredSkill.name], text: "plain skill" });
  const built = await buildWeb({
    notes: {
      [noteId]: { note_id: noteId, title: "Claude skill walkthrough", description: "A Claude skill walkthrough", published_at: "2026-08-23", source_boards: ["Synthetic"], content_sha256: hex("c") },
      [skillId]: { note_id: skillId, title: "Weekly routine", description: "A weekly routine for the team", published_at: "2026-08-23", source_boards: ["Synthetic"], content_sha256: hex("c") },
      [plainSkillId]: { note_id: plainSkillId, title: "Token saving Skill", description: "A Claude skill that saves tokens", published_at: "2026-08-23", source_boards: ["Synthetic"], content_sha256: hex("c") },
    },
    candidates: { [noteId]: noteCandidate, [skillId]: skillCandidate, [plainSkillId]: plainSkillCandidate },
    audit: {
      // The saved evidence moved since the review.
      [noteId]: auditFor(noteCandidate, { evidence_sha256: hex("9") }),
      [skillId]: auditFor(skillCandidate, { resource_status: "verified", resource_id: expiredSkill.id, resource_identity_sha256: hex("2"), verification_snapshot_sha256: hex("3") }),
      [plainSkillId]: auditFor(plainSkillCandidate, { resource_status: "verified", resource_id: expiredSkill.id, resource_identity_sha256: hex("2"), verification_snapshot_sha256: hex("3") }),
    },
    resources: [expiredSkill],
  });
  assert.equal(built[noteId].summaryReason, "evidence_changed");
  assert.equal(built[skillId].summaryReason, "resource_stale");
  assert.equal(built[plainSkillId].summaryReason, "resource_stale");
  // Neither unaccepted note is presented as a confirmed Skill.
  for (const id of [noteId, skillId, plainSkillId]) {
    assert.notEqual(built[id].kind, "Skill", id);
    assert.deepEqual(built[id].resourceIds, [], id);
  }
});

// --- Snapshot: the builders are handed the sealed candidates of every note that is not accepted ---

test("the snapshot freezes the sealed candidates of notes that are not accepted for the builders", async () => {
  const { unacceptedCandidates, materializeCapturedInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const bundle = {
    schema_version: 1, outcome: "ready_for_safe_build", scope: { note_ids: ["kept", "waiting", "gone"] },
    curation: {
      kept: { review_status: "accepted", kind: "Note" },
      waiting: { review_status: "pending", kind: "Skill" },
      gone: { review_status: "unavailable", kind: "Note" },
    },
  };
  assert.deepEqual(unacceptedCandidates(bundle), {
    waiting: { review_status: "pending", kind: "Skill" },
    gone: { review_status: "unavailable", kind: "Note" },
  });
  const work = await mkdtemp(join(tmpdir(), "favsense-snapshot-candidates-"));
  try {
    const frozen = await materializeCapturedInputs(work, { inputs: [], config: {}, bundleSource: Buffer.from(JSON.stringify(bundle)) }, {});
    assert.deepEqual(JSON.parse(await readFile(frozen.candidates, "utf8")), unacceptedCandidates(bundle));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
