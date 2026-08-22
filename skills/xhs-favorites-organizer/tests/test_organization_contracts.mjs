import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hex = (character) => character.repeat(64);

test("content revision changes only when body facts change", async () => {
  const { contentRevision } = await import("../scripts/content-revision.mjs");
  const base = { title: "Cafe\u0301 Skill", description: "line  one", tags: ["b", "a"], media_type: "note", comments: ["one"], board_ids: ["private"] };
  assert.equal(contentRevision(base), contentRevision({ ...base, title: "Café Skill", description: "line one", comments: ["changed"], board_ids: ["other"] }));
  assert.notEqual(contentRevision(base), contentRevision({ ...base, description: "different body" }));
});
test("comment and method changes update evidence not content revision", async () => {
  const { contentRevision, evidenceRevision } = await import("../scripts/content-revision.mjs");
  const note = { title: "Example", description: "Body", tags: [], media_type: "video" };
  const content = contentRevision(note);
  const first = evidenceRevision({ contentSha256: content, comments: [" clue "], commentsChecked: true, methods: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("a") }] });
  const permuted = evidenceRevision({ contentSha256: content, comments: ["clue", "clue"], commentsChecked: true, methods: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("a") }] });
  assert.equal(first, permuted);
  assert.notEqual(first, evidenceRevision({ contentSha256: content, comments: ["new clue"], commentsChecked: true, methods: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("a") }] }));
});

test("accepted restoration requires final current revisions and conditional dependencies", async () => {
  const { acceptedRevisionsCurrent } = await import("../scripts/curation-quality.mjs");
  const current = {
    content_sha256: hex("a"), evidence_sha256: hex("b"), candidate_revision: hex("c"),
    curation_revision: hex("d"), evidence_dependencies: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("e") }],
  };
  const audit = { status: "accepted", ...current };
  assert.equal(acceptedRevisionsCurrent(audit, current), true);
  assert.equal(acceptedRevisionsCurrent({ ...audit, candidate_revision: "" }, current), false);
  assert.equal(acceptedRevisionsCurrent({ ...audit, evidence_sha256: hex("f") }, current), false);
  assert.equal(acceptedRevisionsCurrent(audit, { ...current, resource_required: false }), true);
  assert.equal(acceptedRevisionsCurrent(audit, { ...current, resource_required: true }), false);
});

test("candidate generation is deterministic and honest when evidence is missing", async () => {
  const { generateCandidates } = await import("../scripts/generate-curation-candidates.mjs");
  const input = { catalog: [{ id: "note-a", title: "神级 Skill", description: "", content_sha256: hex("a") }], scope: { note_ids: ["note-a"] }, profile: { classification: { default: "Other" } }, priorCandidates: [] };
  const first = generateCandidates(input);
  const second = generateCandidates(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first[0].tools, []);
  assert.equal(first[0].status, "pending_review");
  assert.deepEqual(first[0].blockers, ["evidence_missing"]);
  assert.equal("candidate_revision" in first[0], false);
});

test("normalized evidence binds exact dependencies and final candidate sealing", async () => {
  const { normalizeEvidencePacket, attachEvidenceToCandidates, sealCandidateRevision } = await import("../scripts/normalize-evidence.mjs");
  const packet = normalizeEvidencePacket({ content_sha256: hex("a"), public_text: "safe facts", comments: [], comments_checked: true, methods: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("b") }] });
  assert.deepEqual(packet.methods[0], { method: "public_text", provider: "favsense", version: "1", result_sha256: hex("b") });
  const attached = attachEvidenceToCandidates([{ id: "note-a", content_sha256: hex("a"), candidate_seed_revision: hex("c"), blockers: ["evidence_missing"], tools: [] }], [packet]);
  const sealed = sealCandidateRevision(attached[0], { status: "missing", resource_id: "", reason_code: "resource_not_applicable", resource_identity_sha256: "", verification_snapshot_sha256: "", resource: null });
  assert.match(sealed.candidate_revision, /^[a-f0-9]{64}$/);
  assert.equal(sealed.evidence_sha256, packet.evidence_sha256);
});

test("confirmed Skill requires exactly one complete fresh verified resource", async () => {
  const { validateVerifiedResource, confirmedSkillResource } = await import("../scripts/resource-quality.mjs");
  const resource = {
    id: "github-owner-repo", name: "Official", type: "Agent Skill", canonical_repo: "owner/repo",
    repo: "https://github.com/owner/repo", download: "https://github.com/owner/repo/archive/refs/heads/main.zip",
    license: "MIT", skill_manifest: "skills/demo/SKILL.md", verified_at: "2026-07-24", stars_numeric: 10,
    compatibility: ["Codex"], compatibility_evidence: ["README.md"], resource_identity_sha256: hex("a"),
    verification_snapshot_sha256: hex("b"), status: "verified",
  };
  assert.deepEqual(validateVerifiedResource(resource, { today: "2026-08-23", maxAgeDays: 30 }), []);
  assert.equal(confirmedSkillResource([resource], { today: "2026-08-23", maxAgeDays: 30 }).id, resource.id);
  assert.equal(confirmedSkillResource([], { today: "2026-08-23", maxAgeDays: 30 }), null);
  assert.equal(confirmedSkillResource([resource, resource], { today: "2026-08-23", maxAgeDays: 30 }), null);
});

test("resource freshness is day-30 inclusive and day-31 stale", async () => {
  const { resourceFreshness } = await import("../scripts/resource-quality.mjs");
  assert.equal(resourceFreshness({ verified_at: "2026-07-24" }, { today: "2026-08-23", maxAgeDays: 30 }), "fresh");
  assert.equal(resourceFreshness({ verified_at: "2026-07-23" }, { today: "2026-08-23", maxAgeDays: 30 }), "stale");
  assert.equal(resourceFreshness({ verified_at: "invalid" }, { today: "2026-08-23", maxAgeDays: 30 }), "stale");
  assert.equal(resourceFreshness({ verified_at: "2026-08-24" }, { today: "2026-08-23", maxAgeDays: 30 }), "stale");
});

test("GitHub verifier requests only the supplied canonical repository and never searches", async () => {
  const { verifyGitHubResource } = await import("../scripts/verify-github-resources.mjs");
  const urls = [];
  const result = await verifyGitHubResource({ canonical_repo: "owner/repo", manifest_path: "SKILL.md", compatibility: ["Codex"], compatibility_evidence: ["README.md"] }, {
    today: "2026-08-23",
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/repos/owner/repo")) return new Response(JSON.stringify({ full_name: "owner/repo", default_branch: "main", stargazers_count: 4, license: { spdx_id: "MIT" } }), { status: 200 });
      return new Response("name: demo", { status: 200 });
    },
  });
  assert.equal(result.status, "verified");
  assert.ok(urls.every((url) => !url.includes("/search/")));
  assert.ok(urls.every((url) => url.startsWith("https://api.github.com/repos/owner/repo")));
});

test("journaled transaction restores every participant to one generation", async () => {
  const { executeJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-journal-"));
  const left = join(root, "left.txt");
  const right = join(root, "right.txt");
  await writeFile(left, "old"); await writeFile(right, "old");
  await assert.rejects(executeJournaledTransaction({ root, id: "tx-safe", participants: [{ name: "left", target: left, content: "new" }, { name: "right", target: right, content: "new" }], failAt: "swap:right" }));
  assert.equal(await readFile(left, "utf8"), "old");
  assert.equal(await readFile(right, "utf8"), "old");
});

test("migration dry-run conserves stable IDs and writes no live files", async () => {
  const { planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const result = planMigration({ records: [{ id: "a", state: "accepted" }, { id: "a", state: "accepted" }, { id: "b", state: "legacy" }, { id: "c", state: "invalid" }], today: "2026-08-23" });
  assert.equal(result.counts.input_unique, 3);
  assert.equal(result.counts.input_unique, result.counts.unchanged + result.counts.migrated + result.counts.pending + result.counts.rejected);
  assert.match(result.dry_run_id, /^[a-f0-9]{64}$/);
  assert.equal(result.apply_performed, false);
});
