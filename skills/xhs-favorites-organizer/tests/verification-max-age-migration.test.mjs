// The organization migration takes the resource freshness limit from the domain profile, like every
// other place that judges freshness (see verification-max-age.test.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyMigration, migrationTargetPaths, planMigration } from "../scripts/migrate-organization-state.mjs";
import { verificationMaxAgeDays } from "../scripts/resource-quality.mjs";
import { contentRevision, evidenceRevision } from "../scripts/content-revision.mjs";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { generateCandidates } from "../scripts/generate-curation-candidates.mjs";
import { sealCandidateRevision } from "../scripts/normalize-evidence.mjs";
import { hex, profile, root, skillResource } from "./public-judgement-fixtures.mjs";

const withLimit = (value) => ({ ...profile, resource_index: { ...profile.resource_index, verification_max_age_days: value } });
const BAD_LIMITS = [null, 1.5, "30"];
const capturedMessage = (action) => { try { action(); } catch (error) { return error.message; } throw new Error("expected a configuration error"); };
const CREATED = "2026-10-10T00:00:00.000Z";
const APPLIED = "2026-10-10T00:01:00.000Z";
// Checked four days before the migration runs: fresh under a limit of 4 or more, stale under 3 or less.
const FOUR_DAYS_OLD = "2026-10-06";
const normal = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();

// A legacy record for an accepted Skill whose audit is current in every respect, so the only thing that
// can turn it from "unchanged" into "pending" is the resource having gone stale.
function acceptedSkillRecord() {
  const resource = skillResource({ verified_at: FOUR_DAYS_OLD });
  const note = { title: resource.name, description: "Synthetic migration body", tags: [], media_type: "note" };
  const curation = {
    title: resource.name, category: "Synthetic", category_override: false, category_reason: "",
    summary: "Reviewed synthetic Skill summary.", action: "Install it in a controlled workspace.",
    themes: ["testing"], tools: [resource.name], kind: "Skill",
  };
  const methods = [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("b") }];
  const contentSha256 = contentRevision(note);
  const evidenceSha256 = evidenceRevision({ contentSha256, comments: [], commentsChecked: true, methods });
  const seed = generateCandidates({
    catalog: [{ id: "skill-note", ...note, content_sha256: contentSha256 }],
    scope: { note_ids: ["skill-note"] },
    profile: { classification: { default: "Other" } },
  })[0];
  const candidate = sealCandidateRevision({
    ...seed, title: normal(curation.title), summary: normal(curation.summary), action: normal(curation.action),
    themes: curation.themes, tools: curation.tools, kind: "Skill",
    evidence_sha256: evidenceSha256, evidence_dependencies: methods, blockers: [],
  }, {
    status: "verified", resource_id: resource.id, reason_code: "",
    resource_identity_sha256: resource.resource_identity_sha256,
    verification_snapshot_sha256: resource.verification_snapshot_sha256,
  });
  return {
    id: "skill-note", note, curation, evidence: { comments: [], comments_checked: true, methods }, resources: [resource],
    audit: {
      status: "accepted", content_sha256: contentSha256, evidence_sha256: evidenceSha256,
      candidate_revision: candidate.candidate_revision, curation_revision: curationRevision(curation),
      evidence_dependencies: methods, resource_id: resource.id,
      resource_identity_sha256: resource.resource_identity_sha256,
      verification_snapshot_sha256: resource.verification_snapshot_sha256,
    },
  };
}
const skillInventory = () => ({ schema_version: 1, records: [acceptedSkillRecord()] });

test("migration reads the profile's limit: an accepted Skill checked four days ago is unchanged at 30 and pending at 1", () => {
  const fresh = planMigration(skillInventory(), { now: CREATED, root: tmpdir(), profile: withLimit(30) });
  assert.equal(fresh.counts.unchanged, 1);
  assert.equal(fresh.counts.pending, 0);
  const stale = planMigration(skillInventory(), { now: CREATED, root: tmpdir(), profile: withLimit(1) });
  assert.equal(stale.counts.unchanged, 0);
  assert.equal(stale.counts.pending, 1);
});

test("the limit is part of what a dry run confirms", () => {
  const at = (limit) => planMigration(skillInventory(), { now: CREATED, root: tmpdir(), profile: withLimit(limit) });
  assert.notEqual(at(30).dry_run_id, at(1).dry_run_id);
  assert.equal(at(30).dry_run_id, at(30).dry_run_id);
});

async function appliedFormalResourceIds(limit) {
  const workspace = mkdtempSync(join(tmpdir(), "favsense-max-age-apply-"));
  try {
    const kept = skillResource({
      id: "github-unrelated-safe", name: "Preserved registry entry", canonical_repo: "unrelated/safe",
      repo: "https://github.com/unrelated/safe", download: "https://github.com/unrelated/safe/archive/refs/heads/main.zip",
    });
    const { formal_resources: target } = migrationTargetPaths(workspace);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ verified_at: FOUR_DAYS_OLD, resources: [kept] }), "utf8");
    const runProfile = withLimit(limit);
    const report = planMigration(skillInventory(), { now: CREATED, root: workspace, profile: runProfile });
    await applyMigration(skillInventory(), { root: workspace, report, confirm: report.dry_run_id, now: APPLIED, profile: runProfile });
    return JSON.parse(readFileSync(target, "utf8")).resources.map((resource) => resource.id);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("applying a migration keeps a stored Skill resource only while it is fresh under the profile's limit", async () => {
  assert.ok((await appliedFormalResourceIds(30)).includes("github-unrelated-safe"));
  assert.equal((await appliedFormalResourceIds(1)).includes("github-unrelated-safe"), false);
});

test("a limit changed after the dry run makes the apply refuse the confirmed report", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "favsense-max-age-changed-"));
  try {
    const report = planMigration(skillInventory(), { now: CREATED, root: workspace, profile: withLimit(30) });
    await assert.rejects(
      applyMigration(skillInventory(), { root: workspace, report, confirm: report.dry_run_id, now: APPLIED, profile: withLimit(1) }),
      (error) => error.code === "MIGRATION_REPORT_STALE" && error.next_action === "rerun_dry_run",
    );
    assert.equal(existsSync(migrationTargetPaths(workspace).organization_state), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("migration refuses a broken limit with the same error as every other place, and needs a profile", async () => {
  for (const bad of BAD_LIMITS) {
    const expected = capturedMessage(() => verificationMaxAgeDays(withLimit(bad)));
    assert.throws(
      () => planMigration(skillInventory(), { now: CREATED, root: tmpdir(), profile: withLimit(bad) }),
      (error) => error.code === "RESOURCE_MAX_AGE_INVALID" && error.message === expected,
      `plan, ${JSON.stringify(bad)}`,
    );
    await assert.rejects(
      applyMigration(skillInventory(), { root: tmpdir(), report: { dry_run_id: hex("a") }, confirm: hex("a"), now: APPLIED, profile: withLimit(bad) }),
      (error) => error.code === "RESOURCE_MAX_AGE_INVALID" && error.message === expected,
      `apply, ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(
    () => planMigration(skillInventory(), { now: CREATED, root: tmpdir() }),
    (error) => error.code === "RESOURCE_PROFILE_REQUIRED",
  );
});

// ---- the command line finds the profile through the workspace's collection config ----

const migrateCli = join(root, "skills/xhs-favorites-organizer/scripts/migrate-organization-state.mjs");
const setProfileLimit = (workspace, limit) => writeFileSync(
  join(workspace, "config/domain-profiles/software.json"), JSON.stringify(withLimit(limit)), "utf8",
);

function migrationWorkspace(limit) {
  const workspace = mkdtempSync(join(tmpdir(), "favsense-max-age-migrate-cli-"));
  mkdirSync(join(workspace, "config/domain-profiles"), { recursive: true });
  writeFileSync(join(workspace, "config/xhs-favorites.json"), JSON.stringify({}), "utf8");
  setProfileLimit(workspace, limit);
  writeFileSync(join(workspace, "inventory.json"), readFileSync(join(root, "skills/xhs-favorites-organizer/test-fixtures/organization-migration-v1.json")));
  return workspace;
}

const runMigrate = (workspace, ...extra) => spawnSync(process.execPath, [
  migrateCli, "--input", join(workspace, "inventory.json"), "--root", workspace,
  "--report", ".xhs-favorites/migration-reports/run.json", ...extra,
], { encoding: "utf8" });

test("migration command line: a limit edited between dry run and apply is refused and nothing is written", () => {
  const workspace = migrationWorkspace(30);
  try {
    const dryRun = runMigrate(workspace);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const { dry_run_id: id } = JSON.parse(dryRun.stdout);
    setProfileLimit(workspace, 1);
    const refused = runMigrate(workspace, "--apply", "--confirm", id);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /MIGRATION_REPORT_STALE/);
    assert.equal(existsSync(migrationTargetPaths(workspace).organization_state), false);
    setProfileLimit(workspace, 30);
    const applied = runMigrate(workspace, "--apply", "--confirm", id);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).outcome, "applied");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("migration command line: a broken limit names the profile file and the key", () => {
  const workspace = migrationWorkspace("30");
  try {
    const result = runMigrate(workspace);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /RESOURCE_MAX_AGE_INVALID: config\/domain-profiles\/software\.json: resource_index\.verification_max_age_days /);
    assert.equal(result.stderr.includes(workspace), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
