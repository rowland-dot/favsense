import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const hex = (character) => character.repeat(64);
const testRoot = dirname(fileURLToPath(import.meta.url));
const migrationFixturePath = resolve(testRoot, "../test-fixtures/organization-migration-v1.json");
const loadMigrationFixture = async () => JSON.parse(await readFile(migrationFixturePath, "utf8"));
const execFileAsync = promisify(execFile);
const migrationOldBytes = (key, marker) => JSON.stringify({
  organization_state: { schema_version: 2, notes: { old: { marker } } },
  curation_audit: { schema_version: 2, notes: { old: { marker } } },
  resource_assessments: { schema_version: 1, notes: { old: { marker } } },
  formal_curation: { old: { title: marker } },
  formal_resources: { verified_at: "2026-08-01", resources: [] },
  point_records: { marker },
}[key]);

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

test("formal output decision binds acceptance, current point evidence, and verified Skill resources", async () => {
  const { formalCurationDecision } = await import("../scripts/curation-quality.mjs");
  const current = {
    content_sha256: hex("a"), evidence_sha256: hex("b"), candidate_revision: hex("c"),
    curation_revision: hex("d"), evidence_dependencies: [{ method: "diandian_summary", provider: "xiaohongshu-diandian", version: hex("2"), result_sha256: hex("e") }],
    resource_required: true, resource_id: "github-owner-repo", resource_identity_sha256: hex("f"),
    verification_snapshot_sha256: hex("1"), resource_fresh: true,
  };
  const decision = formalCurationDecision({
    publishable: true,
    auditEntry: { status: "accepted", ...current },
    currentRevisions: current,
    point: { version: 2, provider: "xiaohongshu-diandian", prompt_version: hex("2"), content_sha256: hex("a"), summary: "Current point summary", summary_sha256: hex("e") },
    kind: "Skill",
    resource: { id: "github-owner-repo" }
  });
  assert.deepEqual(decision, {
    accepted: true,
    reason_code: "",
    summary_source: "point",
    content_sha256: hex("a"),
    evidence_sha256: hex("b"),
    resource_ids: ["github-owner-repo"]
  });
  assert.equal(formalCurationDecision({ ...decision, publishable: false }).accepted, false);
  assert.equal(formalCurationDecision({ publishable: true, currentRevisions: current }).accepted, false);
  assert.equal(formalCurationDecision({ publishable: true, auditEntry: { status: "accepted", ...current } }).accepted, false);
  assert.equal(formalCurationDecision({
    publishable: true,
    auditEntry: { status: "accepted", ...current },
    currentRevisions: current,
    point: { version: 2, provider: "xiaohongshu-diandian", prompt_version: hex("9"), content_sha256: hex("a"), summary: "Stale prompt", summary_sha256: hex("e") },
    kind: "Skill",
    resource: { id: "github-owner-repo" }
  }).summary_source, "curation");
  assert.equal(formalCurationDecision({
    publishable: true,
    auditEntry: { status: "accepted", ...current },
    currentRevisions: { ...current, evidence_sha256: hex("9") },
    point: null,
    kind: "Skill",
    resource: null
  }).reason_code, "resource_stale");
});

test("formal point loader rejects legacy and incomplete prompt contracts", async () => {
  const { loadFormalPointSummary } = await import("../scripts/curation-quality.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-formal-point-"));
  const noteId = "note-a";
  const summary = "Safe current formal summary.";
  const { createHash } = await import("node:crypto");
  const summarySha256 = createHash("sha256").update(summary, "utf8").digest("hex");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${noteId}.json`), JSON.stringify({ version: 1, provider: "xiaohongshu-diandian", prompt: "总结", note_id: noteId, title: "Legacy", summary }));
    assert.equal(loadFormalPointSummary(root, noteId), null);
    await writeFile(join(root, `${noteId}.json`), JSON.stringify({ version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: noteId, title: "Incomplete", summary, content_sha256: hex("a"), summary_sha256: summarySha256 }));
    assert.equal(loadFormalPointSummary(root, noteId), null);
    await writeFile(join(root, `${noteId}.json`), JSON.stringify({
      version: 2, provider: "xiaohongshu-diandian", prompt: "总结", prompt_version: hex("b"), note_id: noteId,
      title: {}, summary, content_sha256: hex("a"), request_sha256: hex("c"), summary_sha256: summarySha256,
      captured_at: 123
    }));
    assert.equal(loadFormalPointSummary(root, noteId), null);
    await writeFile(join(root, `${noteId}.json`), JSON.stringify({
      version: 2, provider: "xiaohongshu-diandian", prompt: "总结", prompt_version: hex("b"), note_id: noteId,
      title: "Whitespace hash", summary, content_sha256: hex("a"), request_sha256: ` ${hex("c")} `,
      summary_sha256: summarySha256, captured_at: "2026-08-23T00:00:00.000Z"
    }));
    assert.equal(loadFormalPointSummary(root, noteId), null);
    await writeFile(join(root, `${noteId}.json`), JSON.stringify({
      version: 2, provider: "xiaohongshu-diandian", prompt: "总结", prompt_version: hex("b"), note_id: noteId,
      title: "Current", summary, content_sha256: hex("a"), request_sha256: hex("c"), summary_sha256: summarySha256,
      captured_at: "2026-08-23T00:00:00.000Z"
    }));
    assert.equal(loadFormalPointSummary(root, noteId)?.prompt_version, hex("b"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("curation pipeline seals evidence and resource state before review", async () => {
  const { runCurationPipeline } = await import("../scripts/run-curation-pipeline.mjs");
  const events = [];
  const result = await runCurationPipeline({
    catalog: [{ id: "note-a", title: "Synthetic Skill", description: "safe facts", content_sha256: hex("a") }],
    scope: { note_ids: ["note-a"] }, profile: { classification: { default: "Other" } },
    evidence: [{ note_id: "note-a", content_sha256: hex("a"), public_text: "safe facts", comments: [], comments_checked: true, methods: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("b") }] }],
  }, { onStage: (stage) => events.push(stage) });
  assert.deepEqual(events, ["scope", "audit_placeholders", "candidate_seed", "evidence", "resource_assessment", "candidate_seal", "review", "merge", "validate"]);
  assert.equal(result.outcome, "ready_for_safe_build");
  assert.deepEqual(result.scope, { note_ids: ["note-a"] });
  assert.equal(result.counts.pending, 1);
  assert.match(result.candidates[0].candidate_revision, /^[a-f0-9]{64}$/);
});

test("curation pipeline preserves only revision-current accepted work and requires an exact review set", async () => {
  const { runCurationPipeline } = await import("../scripts/run-curation-pipeline.mjs");
  const { curationRevision } = await import("../scripts/curation-revision.mjs");
  const input = {
    catalog: [{ id: "note-a", title: "Synthetic", description: "safe facts", content_sha256: hex("a") }],
    scope: { note_ids: ["note-a"] },
    profile: { classification: { default: "Other" } },
    evidence: [{ note_id: "note-a", content_sha256: hex("a"), public_text: "safe facts", comments: [], comments_checked: true, methods: [{ method: "public_text", provider: "favsense", version: "1", result_sha256: hex("b") }] }],
  };
  const pending = await runCurationPipeline(input);
  const current = pending.curation["note-a"];
  const accepted = await runCurationPipeline({
    ...input,
    priorCandidates: [{ id: "note-a", ...current }],
    current_curation: { "note-a": current },
    current_audit: {
      notes: {
        "note-a": {
          status: "accepted",
          content_sha256: current.content_sha256,
          evidence_sha256: current.evidence_sha256,
          candidate_revision: current.candidate_revision,
          curation_revision: curationRevision(current),
          evidence_dependencies: current.evidence_dependencies,
        },
      },
    },
  });
  assert.equal(accepted.curation["note-a"].review_status, "accepted");
  assert.equal(curationRevision(accepted.curation["note-a"]), curationRevision(current));
  await assert.rejects(
    runCurationPipeline(input, { review: async () => [{ id: "outside", status: "accepted" }] }),
    /CURATION_REVIEW_SCOPE_INVALID/,
  );
});

test("confirmed Skill requires exactly one complete fresh verified resource", async () => {
  const { validateVerifiedResource, confirmedSkillResource, expectedResourceRevisions } = await import("../scripts/resource-quality.mjs");
  const resource = {
    id: "github-owner-repo", name: "Official", type: "Agent Skill", canonical_repo: "owner/repo",
    repo: "https://github.com/owner/repo", download: "https://github.com/owner/repo/archive/refs/heads/main.zip",
    license: "MIT", skill_manifest: "skills/demo/SKILL.md", verified_at: "2026-07-24", stars_numeric: 10,
    compatibility: ["Codex"], compatibility_evidence: ["README.md"], status: "verified",
  };
  Object.assign(resource, expectedResourceRevisions(resource));
  assert.deepEqual(validateVerifiedResource(resource, { today: "2026-08-23", maxAgeDays: 30 }), []);
  assert.equal(confirmedSkillResource([resource], { today: "2026-08-23", maxAgeDays: 30 }).id, resource.id);
  assert.equal(confirmedSkillResource([], { today: "2026-08-23", maxAgeDays: 30 }), null);
  assert.equal(confirmedSkillResource([resource, resource], { today: "2026-08-23", maxAgeDays: 30 }), null);

  const mismatchedDownload = {
    ...resource,
    download: "https://github.com/attacker/other/archive/refs/heads/main.zip",
  };
  assert.ok(validateVerifiedResource(mismatchedDownload, {
    today: "2026-08-23", maxAgeDays: 30,
  }).includes("download_url_invalid"));
  assert.equal(confirmedSkillResource([mismatchedDownload], {
    today: "2026-08-23", maxAgeDays: 30,
  }), null);

  const mutations = [
    [{ canonical_repo: "owner/renamed", id: "github-owner-renamed", repo: "https://github.com/owner/renamed", download: "https://github.com/owner/renamed/archive/refs/heads/main.zip" }, "identity_revision_invalid"],
    [{ name: "Renamed official Skill" }, "identity_revision_invalid"],
    [{ type: "Tool" }, "identity_revision_invalid"],
    [{ download: "https://github.com/owner/repo/archive/refs/heads/develop.zip" }, "snapshot_revision_invalid"],
    [{ license: "Apache-2.0" }, "identity_revision_invalid"],
    [{ skill_manifest: "skills/other/SKILL.md" }, "identity_revision_invalid"],
    [{ compatibility: ["Claude"] }, "identity_revision_invalid"],
    [{ compatibility_evidence: ["COMPATIBILITY.md"] }, "identity_revision_invalid"],
    [{ stars_numeric: 11 }, "snapshot_revision_invalid"],
    [{ verified_at: "2026-07-25" }, "snapshot_revision_invalid"],
  ];
  for (const [change, expectedError] of mutations) {
    const errors = validateVerifiedResource({ ...resource, ...change }, {
      today: "2026-08-23", maxAgeDays: 30,
    });
    assert.ok(errors.includes(expectedError), `${JSON.stringify(change)} must invalidate ${expectedError}`);
  }
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
  const accepts = [];
  const repository = { full_name: "owner/repo", name: "repo", default_branch: "main", stargazers_count: 4, license: { spdx_id: "MIT" } };
  const candidate = { canonical_repo: "owner/repo", name: "Forged display name", manifest_path: "SKILL.md", compatibility: ["Codex"], compatibility_evidence: ["README.md"] };
  const officialFiles = {
    "SKILL.md": "---\nname: demo\ndescription: Official synthetic Skill fixture\n---\n",
    "README.md": "Compatibility: Codex",
  };
  const result = await verifyGitHubResource(candidate, {
    today: "2026-08-23",
    fetch: async (url, options) => {
      urls.push(String(url));
      accepts.push(options.headers.Accept);
      if (String(url).endsWith("/repos/owner/repo")) return new Response(JSON.stringify(repository), { status: 200 });
      const file = Object.keys(officialFiles).find((name) => String(url).includes(`/contents/${name}?`));
      if (!file) return new Response("", { status: 404 });
      return options.headers.Accept === "application/vnd.github.raw+json"
        ? new Response(officialFiles[file], { status: 200, headers: { "content-type": "application/vnd.github.raw+json" } })
        : new Response(JSON.stringify({ type: "file", encoding: "base64", content: btoa(officialFiles[file]) }), {
          status: 200,
          headers: { "content-type": "application/vnd.github+json" },
        });
    },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.name, "repo");
  assert.equal(result.stars_numeric, 4);
  assert.deepEqual(result.compatibility_evidence, ["README.md"]);
  assert.ok(urls.every((url) => !url.includes("/search/")));
  assert.ok(urls.every((url) => url.startsWith("https://api.github.com/repos/owner/repo")));
  assert.equal(accepts[0], "application/vnd.github+json");
  assert.ok(accepts.slice(1).every((accept) => accept === "application/vnd.github.raw+json"));

  for (const invalidRepository of [
    { ...repository, name: "" },
    { ...repository, name: "other" },
    { ...repository, stargazers_count: undefined },
    { ...repository, stargazers_count: "4" },
    { ...repository, stargazers_count: -1 },
  ]) {
    await assert.rejects(
      verifyGitHubResource(candidate, {
        today: "2026-08-23",
        fetch: async (url) => String(url).endsWith("/repos/owner/repo")
          ? new Response(JSON.stringify(invalidRepository), { status: 200 })
          : new Response(officialFiles["SKILL.md"], { status: 200 }),
      }),
      /RESOURCE_REPOSITORY_METADATA_INVALID/,
    );
  }

  await assert.rejects(
    verifyGitHubResource(candidate, {
      today: "2026-08-23",
      fetch: async (url) => String(url).endsWith("/repos/owner/repo")
        ? new Response(JSON.stringify(repository), { status: 200 })
        : new Response("not a Skill manifest", { status: 200 }),
    }),
    /RESOURCE_MANIFEST_INVALID/,
  );
  await assert.rejects(
    verifyGitHubResource(candidate, {
      today: "2026-08-23",
      fetch: async (url) => String(url).endsWith("/repos/owner/repo")
        ? new Response(JSON.stringify(repository), { status: 200 })
        : new Response(String(url).includes("/contents/SKILL.md?") ? officialFiles["SKILL.md"] : "No supported runtime listed.", { status: 200 }),
    }),
    /RESOURCE_COMPATIBILITY_UNCONFIRMED/,
  );
  for (const explicitDenial of [
    "This project does not support Codex.",
    "This project isn’t compatible with Codex.",
    "This project cannot support Codex.",
  ]) {
    await assert.rejects(
      verifyGitHubResource(candidate, {
        today: "2026-08-23",
        fetch: async (url) => {
          if (String(url).endsWith("/repos/owner/repo")) return new Response(JSON.stringify(repository), { status: 200 });
          return new Response(String(url).includes("/contents/SKILL.md?")
            ? "---\nname: demo\ndescription: Official synthetic Skill fixture\ncompatibility: Codex\n---\n"
            : explicitDenial, { status: 200 });
        },
      }),
      /RESOURCE_COMPATIBILITY_CONFLICT/,
    );
  }
  for (const deniedCompatibility of [
    "Compatibility: incompatible with Codex",
    "Compatibility: all except Codex",
    "Compatibility: works with Codex",
  ]) {
    await assert.rejects(
      verifyGitHubResource(candidate, {
        today: "2026-08-23",
        fetch: async (url) => String(url).endsWith("/repos/owner/repo")
          ? new Response(JSON.stringify(repository), { status: 200 })
          : new Response(String(url).includes("/contents/SKILL.md?")
            ? officialFiles["SKILL.md"]
            : deniedCompatibility, { status: 200 }),
      }),
      /RESOURCE_COMPATIBILITY_(?:CONFLICT|UNCONFIRMED)/,
    );
  }
  const manifestEvidence = await verifyGitHubResource(
    { ...candidate, compatibility_evidence: ["NOTICE.md"] },
    {
      today: "2026-08-23",
      fetch: async (url) => {
        if (String(url).endsWith("/repos/owner/repo")) return new Response(JSON.stringify(repository), { status: 200 });
        return new Response(String(url).includes("/contents/SKILL.md?")
          ? "---\nname: demo\ndescription: Official synthetic Skill fixture\ncompatibility: Codex\n---\n"
          : "License notice only.", { status: 200 });
      },
    },
  );
  assert.deepEqual(manifestEvidence.compatibility_evidence, ["SKILL.md"]);
  await assert.rejects(
    verifyGitHubResource(candidate, {
      today: "2026-08-23",
      fetch: async (url) => String(url).endsWith("/repos/owner/repo")
        ? new Response(JSON.stringify(repository), { status: 200 })
        : new Response(String(url).includes("/contents/SKILL.md?")
          ? officialFiles["SKILL.md"]
          : "This project does not support Codex.", { status: 200 }),
    }),
    /RESOURCE_COMPATIBILITY_CONFLICT/,
  );
  await assert.rejects(
    verifyGitHubResource(candidate, {
      today: "2026-08-23",
      fetch: async (url) => String(url).endsWith("/repos/owner/repo")
        ? new Response("{}", { status: 200, headers: { "content-length": String(256 * 1024 + 1) } })
        : new Response(officialFiles["SKILL.md"], { status: 200 }),
    }),
    /RESOURCE_RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(
    verifyGitHubResource(candidate, {
      today: "2026-08-23",
      fetch: async (url) => {
        if (String(url).endsWith("/repos/owner/repo")) return new Response(JSON.stringify(repository), { status: 200 });
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            controller.close();
          },
        }), { status: 200 });
      },
    }),
    /RESOURCE_RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(
    verifyGitHubResource(candidate, {
      today: "2026-08-23",
      timeoutMs: 5,
      fetch: async () => new Promise(() => {}),
    }),
    /RESOURCE_FETCH_TIMEOUT/,
  );
  await assert.rejects(
    verifyGitHubResource(candidate, {
      today: "2026-08-23",
      deadlineAt: Date.now() - 1,
      fetch: async () => new Response("unused", { status: 200 }),
    }),
    /RESOURCE_STAGE_TIMEOUT/,
  );
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

test("journaled transaction rejects a transaction-root swap before its first staging write", async (context) => {
  const { executeJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-journal-root-swap-"));
  const transactionRoot = join(root, "transactions");
  const originalRoot = join(root, "transactions-original");
  const outside = await mkdtemp(join(tmpdir(), "favsense-journal-outside-"));
  const transaction = join(outside, ".organization-tx-tx-root-swap");
  const sentinel = join(transaction, "must-remain.txt");
  const target = join(root, "left.txt");
  let swapped = false;
  try {
    await mkdir(transactionRoot);
    await mkdir(transaction);
    await writeFile(sentinel, "outside sentinel");
    await writeFile(target, "old-left");
    const probe = join(root, "junction-probe");
    try {
      await symlink(outside, probe, process.platform === "win32" ? "junction" : "dir");
      await rm(probe);
    } catch (error) {
      context.skip(`transaction-root swap fixture unavailable: ${error.code}`);
      return;
    }
    const content = {
      toString() {
        renameSync(transactionRoot, originalRoot);
        symlinkSync(outside, transactionRoot, process.platform === "win32" ? "junction" : "dir");
        swapped = true;
        return "new-left";
      }
    };

    const outcome = await executeJournaledTransaction({
        root,
        transactionRoot,
        id: "tx-root-swap",
        participants: [{ name: "left", target, content }]
      }).catch((error) => error);

    assert.equal(await readFile(target, "utf8"), "old-left");
    assert.deepEqual(await readdir(transaction), ["must-remain.txt"]);
    assert.equal(await readFile(sentinel, "utf8"), "outside sentinel");
    assert.equal(outcome?.message, "TRANSACTION_PATH_CHANGED");
  } finally {
    if (swapped) {
      unlinkSync(transactionRoot);
      renameSync(originalRoot, transactionRoot);
    }
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("journaled transaction recovery rolls a simulated process crash back to one old generation", async () => {
  const { executeJournaledTransaction, recoverJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-journal-crash-"));
  const left = join(root, "left.txt");
  const right = join(root, "right.txt");
  const participants = [
    { name: "left", target: left, content: "new-left" },
    { name: "right", target: right, content: "new-right" },
  ];
  try {
    await writeFile(left, "old-left");
    await writeFile(right, "old-right");
    await assert.rejects(
      executeJournaledTransaction({ root, id: "tx-crash", participants, failAt: "crash:right" }),
      /SIMULATED_CRASH/,
    );
    assert.deepEqual(
      await recoverJournaledTransaction({ root, id: "tx-crash", participants }),
      { schema_version: 1, outcome: "rolled_back", transaction_id: "tx-crash" },
    );
    assert.equal(await readFile(left, "utf8"), "old-left");
    assert.equal(await readFile(right, "utf8"), "old-right");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journaled recovery preserves a committed generation when cleanup was interrupted", async () => {
  const { executeJournaledTransaction, recoverJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-journal-committed-"));
  const left = join(root, "left.txt");
  const right = join(root, "right.txt");
  const participants = [
    { name: "left", target: left, content: "new-left" },
    { name: "right", target: right, content: "new-right" },
  ];
  try {
    await writeFile(left, "old-left");
    await writeFile(right, "old-right");
    await assert.rejects(
      executeJournaledTransaction({ root, id: "tx-committed", participants, failAt: "crash:committed" }),
      /SIMULATED_CRASH/,
    );
    assert.deepEqual(
      await recoverJournaledTransaction({ root, id: "tx-committed", participants }),
      { schema_version: 1, outcome: "committed", transaction_id: "tx-committed" },
    );
    assert.equal(await readFile(left, "utf8"), "new-left");
    assert.equal(await readFile(right, "utf8"), "new-right");
    await assert.rejects(
      lstat(join(root, ".organization-tx-tx-committed")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journaled recovery removes a newly created target after rename-before-journal crash", async () => {
  const { executeJournaledTransaction, recoverJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-journal-new-crash-"));
  const target = join(root, "new.txt");
  const participants = [{ name: "new-target", target, content: "new" }];
  try {
    await assert.rejects(
      executeJournaledTransaction({ root, id: "tx-new-crash", participants, failAt: "crash-after-swap:new-target" }),
      /SIMULATED_CRASH/,
    );
    assert.equal(await readFile(target, "utf8"), "new");
    await recoverJournaledTransaction({ root, id: "tx-new-crash", participants });
    await assert.rejects(readFile(target, "utf8"), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journaled recovery rejects a duplicate-name corrupted coordinator journal before mutation", async () => {
  const { executeJournaledTransaction, recoverJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-journal-corrupt-"));
  const left = join(root, "left.txt");
  const right = join(root, "right.txt");
  const participants = [
    { name: "left", target: left, content: "new-left" },
    { name: "right", target: right, content: "new-right" },
  ];
  try {
    await writeFile(left, "old-left");
    await writeFile(right, "old-right");
    await assert.rejects(
      executeJournaledTransaction({ root, id: "tx-corrupt", participants, failAt: "crash:right" }),
      /SIMULATED_CRASH/,
    );
    const journalPath = join(root, ".organization-tx-tx-corrupt", "journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.participants[1].name = journal.participants[0].name;
    await writeFile(journalPath, JSON.stringify(journal));
    await assert.rejects(
      recoverJournaledTransaction({ root, id: "tx-corrupt", participants }),
      /TRANSACTION_RECOVERY_PARTICIPANTS_INVALID/,
    );
    assert.equal(await readFile(left, "utf8"), "new-left");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journaled recovery rejects a redirected journal before mutating live or backup data", async (context) => {
  const { executeJournaledTransaction, recoverJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-journal-redirect-"));
  const target = join(root, "left.txt");
  const participants = [{ name: "left", target, content: "new-left" }];
  const transaction = join(root, ".organization-tx-tx-redirect");
  const journalPath = join(transaction, "journal.json");
  const backup = join(transaction, "backup-left");
  try {
    await writeFile(target, "old-left");
    await assert.rejects(
      executeJournaledTransaction({
        root,
        id: "tx-redirect",
        participants,
        failAt: "crash-after-swap:left",
      }),
      /SIMULATED_CRASH/,
    );
    const redirectedJournal = join(root, "outside-journal.json");
    await writeFile(redirectedJournal, await readFile(journalPath));
    await rm(journalPath);
    try {
      await symlink(redirectedJournal, journalPath, "file");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
      try {
        await link(redirectedJournal, journalPath);
      } catch (linkError) {
        context.skip(`redirected journal fixture unavailable: ${linkError.code}`);
        return;
      }
    }

    await assert.rejects(
      recoverJournaledTransaction({ root, id: "tx-redirect", participants }),
      /TRANSACTION_JOURNAL_UNSAFE/,
    );
    assert.equal(await readFile(target, "utf8"), "new-left");
    assert.equal(await readFile(backup, "utf8"), "old-left");
    const journalInfo = await lstat(journalPath);
    assert.equal(journalInfo.isSymbolicLink() || journalInfo.nlink > 1, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journaled recovery fails closed when immutable participant state is corrupted", async () => {
  const { executeJournaledTransaction, recoverJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-journal-state-corrupt-"));
  const target = join(root, "left.txt");
  const participants = [{ name: "left", target, content: "new-left" }];
  const transaction = join(root, ".organization-tx-tx-state-corrupt");
  const backup = join(transaction, "backup-left");
  try {
    await writeFile(target, "old-left");
    await assert.rejects(
      executeJournaledTransaction({
        root,
        id: "tx-state-corrupt",
        participants,
        failAt: "crash-after-swap:left",
      }),
      /SIMULATED_CRASH/,
    );
    const journalPath = join(transaction, "journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.participants[0].had_live = false;
    await writeFile(journalPath, JSON.stringify(journal));

    await assert.rejects(
      recoverJournaledTransaction({ root, id: "tx-state-corrupt", participants }),
      /TRANSACTION_JOURNAL_STATE_INVALID/,
    );
    assert.equal(await readFile(target, "utf8"), "new-left");
    assert.equal(await readFile(backup, "utf8"), "old-left");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable journal recovery survives an abrupt child exit at a phase boundary", async () => {
  const { recoverJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-journal-abrupt-exit-"));
  const left = join(root, "left.txt");
  const right = join(root, "right.txt");
  const participants = [
    { name: "left", target: left, content: "new-left" },
    { name: "right", target: right, content: "new-right" },
  ];
  const moduleUrl = pathToFileURL(resolve(testRoot, "../scripts/journaled-transaction.mjs")).href;
  try {
    await writeFile(left, "old-left");
    await writeFile(right, "old-right");
    const child = `
      const { executeJournaledTransaction } = await import(${JSON.stringify(moduleUrl)});
      await executeJournaledTransaction({
        root: ${JSON.stringify(root)},
        id: "tx-abrupt-exit",
        participants: ${JSON.stringify(participants)},
        beforeParticipant: async (name) => { if (name === "right") process.exit(73); },
      });
    `;
    await assert.rejects(
      execFileAsync(process.execPath, ["--input-type=module", "-e", child]),
      (error) => error?.code === 73,
    );

    await recoverJournaledTransaction({ root, id: "tx-abrupt-exit", participants });
    assert.equal(await readFile(left, "utf8"), "old-left");
    assert.equal(await readFile(right, "utf8"), "old-right");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration dry-run is deterministic, count-only, conservative, and writes no live files", async () => {
  const { planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-dry-run-"));
  try {
    await writeFile(join(root, "sentinel.txt"), "old");
    const before = await readdir(root);
    const first = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
    const second = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
    const reordered = planMigration({ ...fixture, records: [...fixture.records].reverse() }, { now: "2026-08-23T00:00:00.000Z", root });

    assert.deepEqual(first, second);
    assert.deepEqual(first, reordered);
    const conflicting = structuredClone(fixture);
    conflicting.records.push({
      ...structuredClone(conflicting.records.find((record) => record.id === "note-unresolved")),
      note: { ...conflicting.records.find((record) => record.id === "note-unresolved").note, description: "conflict" },
    });
    const conflictFirst = planMigration(conflicting, { now: "2026-08-23T00:00:00.000Z", root });
    const conflictReordered = planMigration(
      { ...conflicting, records: [...conflicting.records].reverse() },
      { now: "2026-08-23T00:00:00.000Z", root },
    );
    assert.equal(conflictFirst.dry_run_id, conflictReordered.dry_run_id);
    assert.deepEqual(Object.keys(first).sort(), [
      "apply_performed", "counts", "created_at", "dry_run_id", "expires_at",
      "next_command", "schema_version",
    ]);
    assert.deepEqual(first.counts, {
      input_records: 6,
      input_unique: 5,
      duplicates: 1,
      unchanged: 1,
      migrated: 1,
      pending: 3,
      rejected: 0,
    });
    assert.equal(first.counts.input_unique, first.counts.unchanged + first.counts.migrated + first.counts.pending + first.counts.rejected);
    assert.match(first.dry_run_id, /^[a-f0-9]{64}$/);
    assert.equal(first.expires_at, "2026-08-23T00:15:00.000Z");
    assert.equal(first.next_command.endsWith(`--apply --confirm ${first.dry_run_id}`), true);
    assert.equal(JSON.stringify(first).includes("note-current"), false);
    assert.equal(JSON.stringify(first).includes("Current accepted note"), false);
    assert.deepEqual(await readdir(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration rejects Windows-alias and DOS-device IDs before dry-run or apply mutation", async () => {
  const { applyMigration, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-id-alias-"));
  const base = fixture.records[0];
  const lower = { ...structuredClone(base), id: "caseid" };
  const upper = { ...structuredClone(base), id: "CASEID" };
  const aliases = { ...fixture, records: [lower, upper] };
  const safeInput = { ...fixture, records: [lower] };
  const createdAt = "2026-08-23T00:00:00.000Z";
  try {
    await writeFile(join(root, "sentinel.txt"), "unchanged");
    assert.throws(
      () => planMigration(aliases, { now: createdAt, root }),
      /MIGRATION_RECORD_FILENAME_ALIAS/,
    );
    assert.throws(
      () => planMigration({ ...fixture, records: [{ ...structuredClone(base), id: "CON" }] }, { now: createdAt, root }),
      /MIGRATION_RECORD_FILENAME_RESERVED/,
    );

    const report = planMigration(safeInput, { now: createdAt, root });
    await assert.rejects(
      applyMigration(aliases, {
        root,
        report,
        confirm: report.dry_run_id,
        now: "2026-08-23T00:01:00.000Z",
      }),
      /MIGRATION_RECORD_FILENAME_ALIAS/,
    );
    assert.equal(await readFile(join(root, "sentinel.txt"), "utf8"), "unchanged");
    assert.deepEqual(await readdir(root), ["sentinel.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration apply requires the matching unexpired dry-run confirmation", async () => {
  const { applyMigration, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  for (const [confirmation, now, code] of [
    ["mismatch", "2026-08-23T00:01:00.000Z", "MIGRATION_CONFIRMATION_MISMATCH"],
    ["matching", "2026-08-23T00:16:00.000Z", "MIGRATION_CONFIRMATION_EXPIRED"],
    ["matching", "2026-08-22T23:59:00.000Z", "MIGRATION_CONFIRMATION_EXPIRED"],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "favsense-migration-confirm-"));
    try {
      const targets = migrationTargetPaths(root);
      for (const target of Object.values(targets)) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "old");
      }
      const report = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
      const confirm = confirmation === "matching" ? report.dry_run_id : hex("f");
      await assert.rejects(
        applyMigration(fixture, { root, report, confirm, now }),
        (error) => error?.code === code && error?.next_action === "rerun_dry_run",
      );
      for (const target of Object.values(targets)) assert.equal(await readFile(target, "utf8"), "old");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-stale-"));
  try {
    const targets = migrationTargetPaths(root);
    for (const target of Object.values(targets)) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "old");
    }
    const report = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
    await assert.rejects(
      applyMigration(fixture, {
        root,
        report: { ...report, next_command: "tampered" },
        confirm: report.dry_run_id,
        now: "2026-08-23T00:01:00.000Z",
      }),
      (error) => error?.code === "MIGRATION_REPORT_STALE" && error?.next_action === "rerun_dry_run",
    );
    for (const target of Object.values(targets)) assert.equal(await readFile(target, "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const sourceRoot = await mkdtemp(join(tmpdir(), "favsense-migration-source-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "favsense-migration-target-"));
  try {
    const report = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root: sourceRoot });
    await assert.rejects(
      applyMigration(fixture, {
        root: targetRoot,
        report,
        confirm: report.dry_run_id,
        now: "2026-08-23T00:01:00.000Z",
      }),
      (error) => error?.code === "MIGRATION_REPORT_STALE",
    );
    assert.deepEqual(await readdir(targetRoot), []);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("migration apply rejects a concurrent distinct plan before touching shared targets", async () => {
  const { applyMigration, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const firstInput = await loadMigrationFixture();
  const secondInput = structuredClone(firstInput);
  secondInput.records[0].note.title = "Distinct synthetic migration plan";
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-concurrent-"));
  try {
    const firstReport = planMigration(firstInput, { now: "2026-08-23T00:00:00.000Z", root });
    const secondReport = planMigration(secondInput, { now: "2026-08-23T00:00:00.000Z", root });
    assert.notEqual(firstReport.dry_run_id, secondReport.dry_run_id);
    const lock = join(root, ".xhs-favorites", "organization-migration", ".apply-lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      nonce: "synthetic-active-owner",
      dry_run_id: firstReport.dry_run_id,
    }));

    await assert.rejects(
      applyMigration(secondInput, {
        root,
        report: secondReport,
        confirm: secondReport.dry_run_id,
        now: "2026-08-23T00:01:00.000Z",
      }),
      (error) => error?.code === "MIGRATION_ALREADY_RUNNING"
        && error?.next_action === "rerun_dry_run",
    );
    for (const target of Object.values(migrationTargetPaths(root))) {
      await assert.rejects(lstat(target), (error) => error?.code === "ENOENT");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration mutation lock rejects a junction root without writing through it", async (context) => {
  const { applyMigration, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const input = await loadMigrationFixture();
  const parent = await mkdtemp(join(tmpdir(), "favsense-migration-junction-"));
  const target = join(parent, "target");
  const linkedRoot = join(parent, "linked-root");
  await mkdir(target);
  try {
    try {
      await symlink(target, linkedRoot, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        context.skip(`junction unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const report = planMigration(input, { now: "2026-08-23T00:00:00.000Z", root: linkedRoot });
    await assert.rejects(
      applyMigration(input, {
        root: linkedRoot,
        report,
        confirm: report.dry_run_id,
        now: "2026-08-23T00:01:00.000Z",
      }),
      /MIGRATION_(?:ROOT_UNSAFE|LOCK_INVALID)/,
    );
    assert.deepEqual(await readdir(target), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("migration apply maps legacy uncertainty honestly and keeps unverified Skill private", async () => {
  const { applyMigration, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const { expectedResourceRevisions } = await import("../scripts/resource-quality.mjs");
  const fixture = await loadMigrationFixture();
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-apply-"));
  try {
    const initialTargets = migrationTargetPaths(root);
    await mkdir(initialTargets.point_records, { recursive: true });
    await writeFile(join(initialTargets.point_records, "note-point.json"), '{"version":1}');
    await writeFile(join(initialTargets.point_records, "unrelated.json"), '{"safe":"preserved"}');
    await mkdir(dirname(initialTargets.formal_resources), { recursive: true });
    const retainedResource = {
        id: "github-unrelated-safe",
        name: "Preserved safe registry entry",
        type: "Agent Skill",
        canonical_repo: "unrelated/safe",
        repo: "https://github.com/unrelated/safe",
        download: "https://github.com/unrelated/safe/archive/refs/heads/main.zip",
        license: "MIT",
        skill_manifest: "SKILL.md",
        verified_at: "2026-08-01",
        stars_numeric: 1,
        compatibility: ["Codex"],
        compatibility_evidence: ["README.md"],
        status: "verified",
    };
    Object.assign(retainedResource, expectedResourceRevisions(retainedResource));
    await writeFile(initialTargets.formal_resources, JSON.stringify({
      verified_at: "2026-08-01",
      resources: [retainedResource],
    }));
    const report = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
    const result = await applyMigration(fixture, {
      root,
      report,
      confirm: report.dry_run_id,
      now: "2026-08-23T00:01:00.000Z",
    });
    assert.deepEqual(result, { schema_version: 1, outcome: "applied", dry_run_id: report.dry_run_id, counts: report.counts });
    const targets = migrationTargetPaths(root);
    const state = JSON.parse(await readFile(targets.organization_state, "utf8"));
    const points = {
      "note-point": JSON.parse(await readFile(join(targets.point_records, "note-point.json"), "utf8")),
    };
    const formalCuration = JSON.parse(await readFile(targets.formal_curation, "utf8"));
    const formalResources = JSON.parse(await readFile(targets.formal_resources, "utf8"));

    assert.equal(state.notes["note-current"].dimensions.curation.status, "accepted");
    assert.equal(state.notes["note-unresolved"].dimensions.summary.status, "stale");
    assert.equal(state.notes["note-unresolved"].dimensions.summary.reason_code, "unknown_legacy");
    assert.equal(state.notes["note-invalid-point"].dimensions.summary.reason_code, "unknown_legacy");
    assert.equal(state.notes["note-false-skill"].dimensions.resource.status, "candidate");
    assert.equal(state.notes["note-false-skill"].candidate_kind, "Skill");
    assert.equal(state.notes["note-false-skill"].confirmed_kind, "Other");
    assert.equal(points["note-point"].version, 2);
    assert.match(points["note-point"].content_sha256, /^[a-f0-9]{64}$/);
    assert.match(points["note-point"].summary_sha256, /^[a-f0-9]{64}$/);
    const { createHash } = await import("node:crypto");
    assert.equal(
      points["note-point"].request_sha256,
      createHash("sha256").update(`${points["note-point"].title}\0${points["note-point"].summary}`, "utf8").digest("hex"),
    );
    assert.equal(points["note-point"].summary_sha256, state.notes["note-point"].evidence_dependencies[0].result_sha256);
    assert.equal(JSON.parse(await readFile(join(targets.point_records, "unrelated.json"), "utf8")).safe, "preserved");
    assert.equal(formalResources.resources[0].id, "github-unrelated-safe");
    assert.equal(formalResources.verified_at, "2026-08-01");
    assert.deepEqual(Object.keys(formalCuration), ["note-current"]);
    const { currentFormalRevisions } = await import("../scripts/curation-quality.mjs");
    assert.ok(currentFormalRevisions(
      { content_sha256: state.notes["note-current"].content_sha256 },
      formalCuration["note-current"],
      null,
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration preserves independently current curation when the same note has a legacy point", async () => {
  const { applyMigration, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  const combined = structuredClone(fixture);
  for (const record of combined.records.filter((item) => item.id === "note-current")) {
    record.legacy_prompt_version = hex("c");
    record.point = {
      version: 1,
      provider: "xiaohongshu-diandian",
      prompt: "总结",
      title: record.note.title,
      summary: "Independent current synthetic point.",
      captured_at: "2026-08-20T00:00:00.000Z",
    };
  }
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-combined-"));
  try {
    const report = planMigration(combined, { now: "2026-08-23T00:00:00.000Z", root });
    const result = await applyMigration(combined, {
      root, report, confirm: report.dry_run_id, now: "2026-08-23T00:01:00.000Z",
    });
    assert.equal(result.counts.migrated, 2);
    const targets = migrationTargetPaths(root);
    const formal = JSON.parse(await readFile(targets.formal_curation, "utf8"));
    const point = JSON.parse(await readFile(join(targets.point_records, "note-current.json"), "utf8"));
    assert.equal(formal["note-current"].summary, "Reviewed synthetic summary.");
    assert.equal(point.summary, "Independent current synthetic point.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration keeps invalid v2 point contracts pending and undiscoverable", async () => {
  const { applyMigration, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const { loadFormalPointSummary } = await import("../scripts/curation-quality.mjs");
  const fixture = await loadMigrationFixture();
  for (const invalid of ["empty-title", "oversize-summary"]) {
    const input = structuredClone(fixture);
    const record = input.records.find((item) => item.id === "note-point");
    if (invalid === "empty-title") {
      record.note.title = "";
      record.point.title = "";
    } else {
      record.point.summary = "x".repeat(200_001);
    }
    const root = await mkdtemp(join(tmpdir(), "favsense-migration-invalid-point-"));
    try {
      const report = planMigration(input, { now: "2026-08-23T00:00:00.000Z", root });
      assert.equal(report.counts.migrated, 0);
      assert.equal(report.counts.pending, 4);
      await applyMigration(input, {
        root, report, confirm: report.dry_run_id, now: "2026-08-23T00:01:00.000Z",
      });
      assert.equal(loadFormalPointSummary(migrationTargetPaths(root).point_records, "note-point"), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("migration journal faults restore every live participant and keep a safe private manifest", async () => {
  const { applyMigration, migrationPrivatePaths, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  for (const participant of ["organization-state", "point-records", "curation-audit", "resource-assessments", "formal-curation", "formal-resources"]) {
    const root = await mkdtemp(join(tmpdir(), "favsense-migration-fault-"));
    try {
      const targets = migrationTargetPaths(root);
      for (const [key, target] of Object.entries(targets)) {
        if (key === "point_records") {
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "old.json"), migrationOldBytes(key, participant));
        } else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, migrationOldBytes(key, participant));
        }
      }
      const report = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
      await assert.rejects(
        applyMigration(fixture, {
          root,
          report,
          confirm: report.dry_run_id,
          now: "2026-08-23T00:01:00.000Z",
          failAt: `swap:${participant}`,
        }),
        /FAULT_INJECTION/,
      );
      for (const [key, target] of Object.entries(targets)) {
        const snapshot = key === "point_records" ? join(target, "old.json") : target;
        assert.equal(await readFile(snapshot, "utf8"), migrationOldBytes(key, participant));
      }
      const manifest = await readFile(migrationPrivatePaths(root, report.dry_run_id).rollback_manifest, "utf8");
      assert.equal(manifest.includes(root), false);
      assert.equal(manifest.includes("note-current"), false);
      assert.deepEqual(Object.keys(JSON.parse(manifest)).sort(), ["dry_run_id", "participants", "schema_version", "status"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("migration restart recovery rolls back crashes at every durable participant boundary", async () => {
  const { applyMigration, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  const liveParticipants = [
    "organization-state", "point-records", "curation-audit",
    "resource-assessments", "formal-curation", "formal-resources",
  ];
  const boundaries = liveParticipants.flatMap((participant) => [
    { participant, failAt: `crash:${participant}` },
    { participant, failAt: `crash-after-swap:${participant}` },
  ]);
  boundaries.push(
    { participant: "rollback-manifest", failAt: "crash:rollback-manifest" },
    { participant: "rollback-manifest", failAt: "crash-after-swap:rollback-manifest" },
  );
  for (const { participant, failAt } of boundaries) {
    const root = await mkdtemp(join(tmpdir(), "favsense-migration-crash-"));
    try {
      const targets = migrationTargetPaths(root);
      for (const [key, target] of Object.entries(targets)) {
        if (key === "point_records") {
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "old.json"), migrationOldBytes(key, participant));
        } else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, migrationOldBytes(key, participant));
        }
      }
      const report = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
      await assert.rejects(
        applyMigration(fixture, {
          root, report, confirm: report.dry_run_id,
          now: "2026-08-23T00:01:00.000Z", failAt,
        }),
        /SIMULATED_CRASH/,
      );
      await assert.rejects(
        applyMigration(fixture, {
          root, report, confirm: report.dry_run_id, now: "2026-08-23T00:01:00.000Z",
        }),
        (error) => error?.code === "MIGRATION_RECOVERED_RERUN_DRY_RUN",
      );
      for (const [key, target] of Object.entries(targets)) {
        const snapshot = key === "point_records" ? join(target, "old.json") : target;
        assert.equal(await readFile(snapshot, "utf8"), migrationOldBytes(key, participant));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("snapshot capture fails closed while a crashed migration journal requires recovery", async () => {
  const { applyMigration, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const fixture = await loadMigrationFixture();
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-snapshot-block-"));
  try {
    const targets = migrationTargetPaths(root);
    for (const [key, target] of Object.entries(targets)) {
      if (key === "point_records") {
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "old.json"), migrationOldBytes(key, "snapshot-block"));
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, migrationOldBytes(key, "snapshot-block"));
      }
    }
    const report = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
    await assert.rejects(applyMigration(fixture, {
      root,
      report,
      confirm: report.dry_run_id,
      now: "2026-08-23T00:01:00.000Z",
      failAt: "crash-after-swap:organization-state",
    }), /SIMULATED_CRASH/);
    const kbTarget = join(root, "published-kb");
    const publicTarget = join(root, "published.json");
    await mkdir(kbTarget);
    await writeFile(join(kbTarget, "build.json"), '{"build_version":"old"}');
    await writeFile(publicTarget, '{"meta":{"buildVersion":"old"}}');
    const beforeState = await readFile(targets.organization_state, "utf8");
    const calls = [];
    await assert.rejects(buildOrganizationSnapshot({
      root,
      kbTarget,
      publicTarget,
      sealedScopeDigest: "a".repeat(64),
      curationInputDigest: "b".repeat(64),
      configDigest: "c".repeat(64),
      inputRevisionDigest: "d".repeat(64),
      effectiveDate: "2026-08-25",
      prepareSnapshot: async () => { calls.push("capture"); return {}; },
      buildKnowledgeBase: async () => { calls.push("kb"); },
      buildPublicSite: async () => { calls.push("public"); },
    }), /SNAPSHOT_MIGRATION_RECOVERY_REQUIRED/);
    assert.deepEqual(calls, []);
    assert.equal(await readFile(targets.organization_state, "utf8"), beforeState);
    assert.equal(await readFile(join(kbTarget, "build.json"), "utf8"), '{"build_version":"old"}');
    assert.equal(await readFile(publicTarget, "utf8"), '{"meta":{"buildVersion":"old"}}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration reports and backups are rejected from the public tree and documented as private", async () => {
  const { validatePublicTree } = await import("../scripts/public-tree-policy.mjs");
  for (const artifact of ["migration-reports", "dry-run-report.json", "migration-v2.json", "organization-state.backup"]) {
    const publicRoot = await mkdtemp(join(tmpdir(), "favsense-public-migration-"));
    try {
      await writeFile(join(publicRoot, "index.html"), "<!doctype html><title>safe</title>");
      if (artifact === "migration-reports") {
        await mkdir(join(publicRoot, artifact));
        await writeFile(join(publicRoot, artifact, "report.json"), '{"counts":{"migrated":1}}');
      } else {
        await writeFile(join(publicRoot, artifact), "{}");
      }
      await assert.rejects(validatePublicTree(publicRoot), /migration artifact/i);
    } finally {
      await rm(publicRoot, { recursive: true, force: true });
    }
  }
  const standard = await readFile(resolve(testRoot, "../references/curation-standard.md"), "utf8");
  assert.match(standard, /默认 dry-run/);
  assert.match(standard, /不得对真实.*--apply/);
});

test("migration rejects credential-shaped legacy material before planning", async () => {
  const { planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-private-"));
  try {
    const unsafe = structuredClone(fixture);
    unsafe.records[0].curation.cookie = "private-value";
    assert.throws(
      () => planMigration(unsafe, { now: "2026-08-23T00:00:00.000Z", root }),
      /MIGRATION_INPUT_INVALID/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration rejects record ids that can mutate ordinary object prototypes", async () => {
  const { planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-prototype-"));
  try {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      const unsafe = structuredClone(fixture);
      unsafe.records[0].id = id;
      assert.throws(
        () => planMigration(unsafe, { now: "2026-08-23T00:00:00.000Z", root }),
        /MIGRATION_RECORD_INVALID/,
      );
    }
    assert.equal(Object.prototype.schema_version, undefined);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration rejects malformed live participant JSON without replacing it", async () => {
  const { applyMigration, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-invalid-live-"));
  try {
    const target = migrationTargetPaths(root).formal_curation;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "not-json");
    const report = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
    await assert.rejects(
      applyMigration(fixture, {
        root, report, confirm: report.dry_run_id, now: "2026-08-23T00:01:00.000Z",
      }),
      /MIGRATION_TARGET_SCHEMA_INVALID/,
    );
    assert.equal(await readFile(target, "utf8"), "not-json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration rejects credential-shaped retained formal curation without replacing it", async () => {
  const { applyMigration, migrationTargetPaths, planMigration } = await import("../scripts/migrate-organization-state.mjs");
  const fixture = await loadMigrationFixture();
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-invalid-retained-"));
  try {
    const target = migrationTargetPaths(root).formal_curation;
    const original = '{"old":{"title":"safe","cookie":"synthetic-secret"}}';
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, original);
    const report = planMigration(fixture, { now: "2026-08-23T00:00:00.000Z", root });
    await assert.rejects(
      applyMigration(fixture, {
        root, report, confirm: report.dry_run_id, now: "2026-08-23T00:01:00.000Z",
      }),
      /MIGRATION_TARGET_SCHEMA_INVALID/,
    );
    assert.equal(await readFile(target, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration CLI confirmation failure returns a closed rerun instruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "favsense-migration-cli-"));
  const script = resolve(testRoot, "../scripts/migrate-organization-state.mjs");
  const report = ".xhs-favorites/migration-reports/synthetic.json";
  try {
    await execFileAsync(process.execPath, [
      script, "--input", migrationFixturePath, "--root", root, "--report", report,
    ]);
    await assert.rejects(
      execFileAsync(process.execPath, [
        script, "--input", migrationFixturePath, "--root", root, "--report", report,
        "--apply", "--confirm", hex("f"),
      ]),
      (error) => (
        error?.code === 1
        && error?.stderr === "MIGRATION_CONFIRMATION_MISMATCH phase: migration; next: rerun dry-run\n"
      ),
    );
    assert.equal((await readdir(root)).includes("skills"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
