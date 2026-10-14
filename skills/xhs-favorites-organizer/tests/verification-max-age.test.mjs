// One number decides how many days a resource check stays fresh: the domain profile's
// resource_index.verification_max_age_days. These tests hold every place that judges freshness to it.

import test from "node:test";
import assert from "node:assert/strict";
import * as quality from "../scripts/resource-quality.mjs";
import { judgePublicNote } from "../scripts/public-judgement.mjs";
import { runCurationPipeline } from "../scripts/run-curation-pipeline.mjs";
import { mergeResults } from "../scripts/merge-curation-results.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { config, hex, note, profile, root, skillResource, TODAY } from "./public-judgement-fixtures.mjs";

// The same profile with a different limit (or a broken one).
const withLimit = (value) => ({ ...profile, resource_index: { ...profile.resource_index, verification_max_age_days: value } });
// A Skill resource checked four days before TODAY: fresh under a limit of 4 or more, stale under 3 or less.
const FOUR_DAYS_OLD = "2026-10-06";
const BAD_LIMITS = [null, 1.5, "30"];
const capturedMessage = (action) => { try { action(); } catch (error) { return error.message; } throw new Error("expected a configuration error"); };

const KEY = "resource_index.verification_max_age_days";

test("the limit comes from the profile: 30 when the key is absent, the stated number when present", () => {
  assert.equal(quality.verificationMaxAgeDays({}), 30);
  assert.equal(quality.verificationMaxAgeDays({ resource_index: {} }), 30);
  assert.equal(quality.verificationMaxAgeDays({ resource_index: { verification_max_age_days: 1 } }), 1);
  assert.equal(quality.verificationMaxAgeDays({ resource_index: { verification_max_age_days: 0 } }), 0);
  assert.equal(quality.verificationMaxAgeDays({ resource_index: { verification_max_age_days: 90 } }), 90);
});

test("a key that is present but not a non-negative whole number is a named configuration error", () => {
  for (const bad of [null, 1.5, "30", -1, Number.NaN, true, [30], {}]) {
    assert.throws(
      () => quality.verificationMaxAgeDays({ resource_index: { verification_max_age_days: bad } }, "config/domain-profiles/software.json"),
      (error) => error.code === "RESOURCE_MAX_AGE_INVALID"
        && error.message.includes(KEY)
        && error.message.includes("config/domain-profiles/software.json"),
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("a missing profile is an error, never a quiet 30", () => {
  for (const missing of [undefined, null, "software", []]) {
    assert.throws(
      () => quality.verificationMaxAgeDays(missing),
      (error) => error.code === "RESOURCE_PROFILE_REQUIRED",
    );
  }
});

test("freshness takes the limit from its caller and does not invent one", () => {
  const resource = { verified_at: "2026-10-06" };
  assert.equal(quality.resourceFreshness(resource, { today: "2026-10-10", maxAgeDays: 4 }), "fresh");
  assert.equal(quality.resourceFreshness(resource, { today: "2026-10-10", maxAgeDays: 3 }), "stale");
  for (const options of [{ today: "2026-10-10" }, { today: "2026-10-10", maxAgeDays: null }, { today: "2026-10-10", maxAgeDays: 1.5 }, undefined]) {
    assert.throws(
      () => quality.resourceFreshness(resource, options),
      (error) => error.code === "RESOURCE_MAX_AGE_INVALID",
    );
  }
});

// ---- the places that judge freshness all take the profile's limit ----

function judge(limit, verifiedAt = FOUR_DAYS_OLD) {
  const resource = skillResource({ verified_at: verifiedAt });
  return judgePublicNote({
    noteId: "n1", note: note(), addOn: { category: "Synthetic", themes: ["testing"], tools: [resource.name], kind: "Skill" },
    resourceRegistry: { verified_at: TODAY, resources: [resource] }, config, profile: withLimit(limit), effectiveDate: TODAY,
  });
}

async function pipelineResourceStatus(limit) {
  const resource = skillResource({ verified_at: FOUR_DAYS_OLD });
  const result = await runCurationPipeline({
    catalog: [{ id: "n1", title: resource.name, description: "Synthetic safe body", content_sha256: hex("c") }],
    scope: { note_ids: ["n1"] },
    profile: withLimit(limit),
    priorCandidates: [{ id: "n1", kind: "Skill", tools: [resource.name] }],
    resources: { resources: [resource] },
    effective_date: TODAY,
    evidence: [{
      note_id: "n1", content_sha256: hex("c"), public_text: "Synthetic safe body", comments: [], comments_checked: true,
      methods: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("b") }],
    }],
  });
  return result.resource_assessments[0].status;
}

test("public judgement reads the profile's limit: a check four days old is fresh at 30 and stale at 1", () => {
  assert.equal(judge(30).kind, "Skill");
  const strict = judge(1);
  // Too old at a limit of one day: not a confirmed Skill, so no resource goes with it.
  assert.notEqual(strict.kind, "Skill");
  assert.deepEqual(strict.resourceIds, []);
});

test("the curation pipeline reads the profile's limit: a check four days old is verified at 30 and not at 1", async () => {
  assert.equal(await pipelineResourceStatus(30), "verified");
  assert.equal(await pipelineResourceStatus(1), "missing");
});

test("public judgement and the pipeline refuse a broken limit instead of reporting everything stale", async () => {
  for (const bad of BAD_LIMITS) {
    const expected = capturedMessage(() => quality.verificationMaxAgeDays(withLimit(bad)));
    assert.throws(() => judge(bad), (error) => error.code === "RESOURCE_MAX_AGE_INVALID" && error.message === expected, `judgement, ${JSON.stringify(bad)}`);
    await assert.rejects(pipelineResourceStatus(bad), (error) => error.code === "RESOURCE_MAX_AGE_INVALID" && error.message === expected, `pipeline, ${JSON.stringify(bad)}`);
  }
});

test("a broken limit is reported even for a note that is not a Skill", () => {
  const addOn = { category: "Synthetic", themes: ["testing"], tools: [], kind: "Note" };
  assert.throws(
    () => judgePublicNote({ noteId: "n1", note: note(), addOn, resourceRegistry: { resources: [] }, config, profile: withLimit(null), effectiveDate: TODAY }),
    (error) => error.code === "RESOURCE_MAX_AGE_INVALID",
  );
});

// ---- the shipped configuration and the code agree on one number ----

test("the software profile states its limit explicitly", () => {
  assert.equal(Object.hasOwn(profile.resource_index, "verification_max_age_days"), true);
  assert.equal(profile.resource_index.verification_max_age_days, 30);
});

test("no script outside the resolver spells out its own freshness limit", () => {
  const scripts = join(root, "skills/xhs-favorites-organizer/scripts");
  for (const name of readdirSync(scripts).filter((file) => file.endsWith(".mjs"))) {
    const source = readFileSync(join(scripts, name), "utf8");
    assert.doesNotMatch(source, /maxAgeDays\s*[:=]\s*30\b/, `${name} must take the limit from the profile`);
  }
});

// ---- the review merge ----

const transcriptEvidence = (text) => ({
  transcript_text: text,
  transcript_evidence: {
    method: "local_transcription", provider: "faster-whisper", version: "faster-whisper-v1",
    result_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  },
});

// Review input for one accepted Skill note whose official resource was checked four days before TODAY.
function mergeInput() {
  const resource = skillResource({ verified_at: FOUR_DAYS_OLD });
  return {
    catalog: { notes: { current: { type: "视频", description: "当前公开简介", content_sha256: hex("a"), source_boards: ["主题甲"] } } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [resource] },
    scope: { note_ids: ["current"] },
    candidates: {}, audit: { notes: {} }, curation: {},
    evidenceReview: { items: [{ note_id: "current", content_sha256: hex("a"), ...transcriptEvidence("可核验的本地转写正文") }] },
    review: { items: [{
      note_id: "current",
      candidate: {
        title: "具体标题",
        summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度检查。",
        action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
        themes: ["主题"], tools: [resource.name], kind: "Skill",
      },
      audit: {
        status: "accepted", reviewed_at: "2026-10-08", evidence_methods: ["description", "comments", "audio_transcript"],
        comments_checked: true, claims_supported: true, resource_status: "verified", unresolved_facts: [],
      },
    }] },
    today: TODAY,
  };
}

test("the review merge reads the profile's limit: a check four days old is sealed at 30 and refused at 1", () => {
  assert.equal(mergeResults({ ...mergeInput(), profile: withLimit(30) }).counts.accepted, 1);
  assert.throws(
    () => mergeResults({ ...mergeInput(), profile: withLimit(1) }),
    /Skill resource is unavailable or stale/,
  );
});

test("the review merge refuses a broken limit with the same error as every other place", () => {
  for (const bad of BAD_LIMITS) {
    const expected = capturedMessage(() => quality.verificationMaxAgeDays(withLimit(bad)));
    assert.throws(
      () => mergeResults({ ...mergeInput(), profile: withLimit(bad) }),
      (error) => error.code === "RESOURCE_MAX_AGE_INVALID" && error.message === expected,
      JSON.stringify(bad),
    );
  }
});

test("the review merge needs a profile and never falls back to 30", () => {
  assert.throws(
    () => mergeResults(mergeInput()),
    (error) => error.code === "RESOURCE_PROFILE_REQUIRED",
  );
});

// ---- the review merge command line finds the profile through --config ----

const mergeCli = join(root, "skills/xhs-favorites-organizer/scripts/merge-curation-results.mjs");

// A workspace whose review has nothing in it, so the only thing that can go wrong is the profile.
function emptyReviewWorkspace({ config = {}, files = {} } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "favsense-max-age-cli-"));
  const write = (name, value) => {
    mkdirSync(dirname(join(workspace, name)), { recursive: true });
    writeFileSync(join(workspace, name), typeof value === "string" ? value : JSON.stringify(value), "utf8");
  };
  write("config.json", config);
  write("catalog.json", { notes: {} });
  write("scope.json", { note_ids: [] });
  write("review.json", { items: [] });
  write("evidence.json", { items: [] });
  write("candidates.json", {});
  write("resources.json", { resources: [] });
  write("audit.json", { notes: {} });
  write("curation.json", {});
  for (const [name, value] of Object.entries(files)) write(name, value);
  return workspace;
}

function runMerge(workspace) {
  const at = (name) => join(workspace, name);
  return spawnSync(process.execPath, [
    mergeCli, "--catalog", at("catalog.json"), "--config", at("config.json"), "--scope", at("scope.json"),
    "--review", at("review.json"), "--evidence-review", at("evidence.json"), "--candidates", at("candidates.json"),
    "--resources", at("resources.json"), "--audit", at("audit.json"), "--curation", at("curation.json"),
    "--expected-count", "0",
  ], { cwd: workspace, encoding: "utf8" });
}

test("merge command line: with no domain_profile in --config it reads config/domain-profiles/software.json", () => {
  const ok = emptyReviewWorkspace({ files: { "config/domain-profiles/software.json": profile } });
  const missing = emptyReviewWorkspace();
  try {
    const good = runMerge(ok);
    assert.equal(good.status, 0, good.stderr);
    const bad = runMerge(missing);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /DOMAIN_PROFILE_UNREADABLE: config\/domain-profiles\/software\.json/);
    assert.equal(bad.stderr.includes(missing), false, "the message names the profile relative to the workspace, not the machine path");
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("merge command line: a broken limit names the profile file --config points at and the key", () => {
  const workspace = emptyReviewWorkspace({
    config: { domain_profile: "profiles/strict.json" },
    files: { "profiles/strict.json": withLimit("30") },
  });
  try {
    const result = runMerge(workspace);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^curation-merge: CURATION_MERGE_INPUT_INVALID: RESOURCE_MAX_AGE_INVALID: profiles\/strict\.json: resource_index\.verification_max_age_days /);
    assert.equal(result.stderr.includes(workspace), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
