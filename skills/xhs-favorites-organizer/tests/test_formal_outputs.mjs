import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { expectedResourceRevisions } from "../scripts/resource-quality.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hex = (character) => character.repeat(64);
const sealResource = (resource) => Object.assign(resource, expectedResourceRevisions(resource));

test("accepted confirmed Skill produces the same safe formal outcome in KB and public JSON", async () => {
  const work = await mkdtemp(join(tmpdir(), "favsense-formal-output-"));
  const output = join(work, "knowledge-base");
  const noteId = "synthetic-skill";
  const pointSummary = "Current accepted point summary for the synthetic confirmed Skill.";
  const pointSummarySha256 = createHash("sha256").update(pointSummary, "utf8").digest("hex");
  const verifiedAt = new Date().toISOString().slice(0, 10);
  const promptVersion = hex("9");
  const resource = sealResource({
    id: "github-owner-repo", name: "Official synthetic Skill", aliases: [], type: "Agent Skill",
    canonical_repo: "owner/repo", repo: "https://github.com/owner/repo",
    download: "https://github.com/owner/repo/archive/refs/heads/main.zip", stars: "4", stars_numeric: 4,
    license: "MIT", skill_manifest: "SKILL.md", compatibility: ["Codex"], compatibility_evidence: ["README.md"],
    verified_at: verifiedAt, status: "verified", usage_note: "Synthetic verified fixture."
  });
  const staleResource = sealResource({
    ...resource,
    id: "github-old-repo",
    name: "Stale synthetic Skill",
    canonical_repo: "old/repo",
    repo: "https://github.com/old/repo",
    download: "https://github.com/old/repo/archive/refs/heads/main.zip",
    verified_at: "2020-01-01",
  });
  const profile = JSON.parse(await readFile(join(root, "config/domain-profiles/software.json"), "utf8"));
  const paths = Object.fromEntries(["catalog", "config", "curation", "audit", "profile", "resources", "public"].map((name) => [name, join(work, `${name}.json`)]));
  const curationEntry = {
    category: "Synthetic", themes: ["testing"], summary: "Accepted formal synthetic summary with enough detail for review.",
    action: "Inspect the verified synthetic Skill before installing it in a controlled workspace.",
    tools: [resource.name, staleResource.name], kind: "Skill", evidence_sha256: hex("e"), candidate_revision: hex("f"),
    evidence_dependencies: [{ method: "diandian_summary", provider: "xiaohongshu-diandian", version: promptVersion, result_sha256: pointSummarySha256 }]
  };
  const formalRevisions = {
    content_sha256: hex("c"), evidence_sha256: curationEntry.evidence_sha256,
    candidate_revision: curationEntry.candidate_revision, curation_revision: curationRevision(curationEntry),
    evidence_dependencies: curationEntry.evidence_dependencies, resource_id: resource.id,
    resource_identity_sha256: resource.resource_identity_sha256,
    verification_snapshot_sha256: resource.verification_snapshot_sha256
  };
  try {
    await Promise.all([
      writeFile(paths.catalog, JSON.stringify({ version: 1, notes: { [noteId]: {
        note_id: noteId, title: "Official synthetic Skill", description: "Synthetic safe body", published_at: "2026-08-23", source_boards: ["Synthetic"], content_sha256: hex("c")
      } } })),
      writeFile(paths.config, JSON.stringify({
        version: 1, domain_profile: paths.profile, curation_file: paths.curation,
        curation_quality: { publish_only_accepted: true, audit_file: paths.audit },
        boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {}
      })),
      writeFile(paths.curation, JSON.stringify({ [noteId]: curationEntry })),
      writeFile(paths.audit, JSON.stringify({ version: 2, notes: { [noteId]: {
        status: "accepted", reviewed_at: "2026-08-23", evidence_methods: ["comments", "diandian_summary", "official_source"],
        comments_checked: true, claims_supported: true, resource_status: "verified", unresolved_facts: [],
        diandian_summary_sha256: pointSummarySha256, curation_sha256: formalRevisions.curation_revision,
        ...formalRevisions
      } } })),
      writeFile(paths.profile, JSON.stringify(profile)),
      writeFile(paths.resources, JSON.stringify({ verified_at: verifiedAt, resources: [resource, staleResource] })),
      mkdir(join(work, "point"), { recursive: true })
    ]);
    await writeFile(join(work, "point", `${noteId}.json`), JSON.stringify({
      version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: noteId,
      title: resource.name, summary: pointSummary, content_sha256: formalRevisions.content_sha256,
      prompt_version: promptVersion, request_sha256: hex("8"), summary_sha256: pointSummarySha256,
      captured_at: "2026-08-23T00:00:00.000Z"
    }));
    const common = ["--catalog", paths.catalog, "--config", paths.config, "--curation", paths.curation, "--profile", paths.profile, "--resources", paths.resources, "--build-version", hex("d")];
    const kb = spawnSync(process.execPath, [join(root, "skills/xhs-favorites-organizer/scripts/build-knowledge-base.mjs"), ...common, "--diandian-dir", join(work, "point"), "--output", output], { cwd: root, encoding: "utf8" });
    assert.equal(kb.status, 0, kb.stderr || kb.stdout);
    const site = spawnSync(process.execPath, [join(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs"), ...common, "--diandian-dir", join(work, "point"), "--video-analysis", join(work, "video"), "--output", paths.public], { cwd: root, encoding: "utf8" });
    assert.equal(site.status, 0, site.stderr || site.stdout);

    const checklist = await readFile(join(output, "05-Skills成果", "GitHub-Skills核验清单.md"), "utf8");
    const card = await readFile(join(output, "02-知识卡片", `${noteId}.md`), "utf8");
    const publicData = JSON.parse(await readFile(paths.public, "utf8"));
    for (const expected of [resource.name, resource.type, resource.repo, resource.download, "MIT", "SKILL.md", "Codex", "verified", verifiedAt, "4"]) {
      assert.match(checklist, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(card, /Skill 核验/);
    for (const expected of [resource.id, resource.name, resource.type, resource.repo, resource.download, "MIT", "SKILL.md", "Codex", "verified", verifiedAt, "4"]) {
      assert.match(card, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(card, new RegExp(pointSummary));
    assert.doesNotMatch(card, /Stale synthetic Skill|old\/repo/);
    assert.equal(publicData.meta.buildVersion, hex("d"));
    assert.equal(publicData.notes[0].summaryStatus, "accepted");
    assert.equal(publicData.notes[0].summaryReason, "");
    assert.equal(Object.hasOwn(publicData.notes[0], "candidateKind"), false);
    assert.equal(publicData.notes[0].kind, "Skill");
    assert.deepEqual(publicData.notes[0].tools, [resource.name]);
    assert.deepEqual(publicData.notes[0].resources, [resource.name]);
    assert.deepEqual(publicData.notes[0].resourceIds, ["github-owner-repo"]);
    assert.doesNotMatch(checklist, /old\/repo|Stale synthetic Skill/);
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.match(packageJson.scripts["test:knowledge"], /test_formal_outputs\.mjs/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("unverified Skill stays a pending candidate without a guessed resource or legacy point", async () => {
  const work = await mkdtemp(join(tmpdir(), "favsense-formal-candidate-"));
  const output = join(work, "knowledge-base");
  const noteId = "synthetic-skill-candidate";
  const legacySummary = "Private legacy candidate summary must never reach formal output.";
  const profile = JSON.parse(await readFile(join(root, "config/domain-profiles/software.json"), "utf8"));
  profile.classification.default = "Skill";
  const paths = Object.fromEntries(["catalog", "config", "curation", "audit", "baseline", "profile", "resources", "public"].map((name) => [name, join(work, `${name}.json`)]));
  const staleResource = sealResource({
    id: "github-stale-repo", name: "Stale candidate Skill", aliases: [], type: "Agent Skill",
    canonical_repo: "stale/repo", repo: "https://github.com/stale/repo",
    download: "https://github.com/stale/repo/archive/refs/heads/main.zip", stars: "1", stars_numeric: 1,
    license: "MIT", skill_manifest: "SKILL.md", compatibility: ["Codex"], compatibility_evidence: ["README.md"],
    verified_at: "2020-01-01", status: "verified", usage_note: "Synthetic stale fixture."
  });
  const candidateEntry = {
    category: "Synthetic", themes: ["testing"], summary: "Candidate summary without verified evidence.",
    action: "Wait for an official source before installation.", tools: [staleResource.name], kind: "Skill"
  };
  try {
    await Promise.all([
      writeFile(paths.catalog, JSON.stringify({ version: 1, notes: { [noteId]: {
        note_id: noteId, title: "Synthetic Skill candidate", description: "Metadata-only candidate with no verified resource.",
        published_at: "2026-08-23", source_boards: ["Synthetic"], content_sha256: hex("4")
      } } })),
      writeFile(paths.config, JSON.stringify({
        version: 1, domain_profile: paths.profile, curation_file: paths.curation,
        curation_quality: { publish_only_accepted: true, audit_file: paths.audit, baseline_file: paths.baseline },
        boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {}
      })),
      writeFile(paths.curation, JSON.stringify({ [noteId]: candidateEntry })),
      writeFile(paths.audit, JSON.stringify({ version: 2, notes: {} })),
      writeFile(paths.baseline, JSON.stringify({
        version: 1,
        note_ids: [noteId],
        curation_hashes: { [noteId]: curationRevision(candidateEntry) }
      })),
      writeFile(paths.profile, JSON.stringify(profile)),
      writeFile(paths.resources, JSON.stringify({ verified_at: "2026-08-23", resources: [staleResource] })),
      mkdir(join(work, "point"), { recursive: true })
    ]);
    await writeFile(join(work, "point", `${noteId}.json`), JSON.stringify({
      version: 1, provider: "xiaohongshu-diandian", prompt: "总结", note_id: noteId,
      title: "Synthetic Skill candidate", summary: legacySummary, content_sha256: hex("4"),
      summary_sha256: createHash("sha256").update(legacySummary, "utf8").digest("hex")
    }));
    const common = ["--catalog", paths.catalog, "--config", paths.config, "--curation", paths.curation, "--profile", paths.profile, "--resources", paths.resources, "--build-version", hex("5")];
    const kb = spawnSync(process.execPath, [join(root, "skills/xhs-favorites-organizer/scripts/build-knowledge-base.mjs"), ...common, "--diandian-dir", join(work, "point"), "--output", output], { cwd: root, encoding: "utf8" });
    assert.equal(kb.status, 0, kb.stderr || kb.stdout);
    const site = spawnSync(process.execPath, [join(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs"), ...common, "--diandian-dir", join(work, "point"), "--video-analysis", join(work, "video"), "--output", paths.public], { cwd: root, encoding: "utf8" });
    assert.equal(site.status, 0, site.stderr || site.stdout);

    const card = await readFile(join(output, "02-知识卡片", `${noteId}.md`), "utf8");
    const checklist = await readFile(join(output, "05-Skills成果", "GitHub-Skills核验清单.md"), "utf8");
    const toolIndex = await readFile(join(output, "03-工具雷达", "工具索引.md"), "utf8");
    const publicData = JSON.parse(await readFile(paths.public, "utf8"));
    assert.match(card, /Skill candidate/);
    assert.doesNotMatch(card, new RegExp(legacySummary));
    assert.doesNotMatch(card, /github\.com|ZIP/);
    assert.doesNotMatch(card, /content_kind: "Skill"|内容形态：Skill|Stale candidate Skill/);
    assert.doesNotMatch(toolIndex, /Stale candidate Skill|stale\/repo/);
    assert.doesNotMatch(checklist, /synthetic-skill-candidate|github\.com\/synthetic/i);
    assert.equal(publicData.notes[0].kind, "Note");
    assert.equal(publicData.notes[0].candidateKind, "Skill");
    assert.equal(publicData.notes[0].summaryStatus, "pending_review");
    assert.deepEqual(publicData.notes[0].tools, []);
    assert.deepEqual(publicData.notes[0].resources, []);
    assert.deepEqual(publicData.notes[0].resourceIds, []);
    assert.equal(publicData.notes[0].evidence.locallyAvailable, false);
    assert.doesNotMatch(JSON.stringify(publicData), new RegExp(legacySummary));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
