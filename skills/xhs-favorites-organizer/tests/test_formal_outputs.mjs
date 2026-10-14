import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expectedResourceRevisions } from "../scripts/resource-quality.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hex = (character) => character.repeat(64);
const sealResource = (resource) => Object.assign(resource, expectedResourceRevisions(resource));

test("a confirmed Skill produces the safe formal outcome in the public JSON", async () => {
  const work = await mkdtemp(join(tmpdir(), "favsense-formal-output-"));
  const noteId = "synthetic-skill";
  const pointSummary = "Current saved point summary for the synthetic confirmed Skill.";
  const pointSummarySha256 = createHash("sha256").update(pointSummary, "utf8").digest("hex");
  const verifiedAt = new Date().toISOString().slice(0, 10);
  const promptVersion = hex("7");
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
  const paths = Object.fromEntries(["catalog", "config", "curation", "profile", "resources", "public"].map((name) => [name, join(work, `${name}.json`)]));
  const curationEntry = {
    category: "Synthetic", themes: ["testing"], tools: [resource.name, staleResource.name], kind: "Skill",
  };
  try {
    await Promise.all([
      writeFile(paths.catalog, JSON.stringify({ version: 1, notes: { [noteId]: {
        note_id: noteId, title: "Official synthetic Skill", description: "Synthetic safe body", published_at: "2026-08-23", source_boards: ["Synthetic"], content_sha256: hex("c")
      } } })),
      writeFile(paths.config, JSON.stringify({
        version: 1, domain_profile: paths.profile, curation_file: paths.curation,
        boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {}
      })),
      writeFile(paths.curation, JSON.stringify({ [noteId]: curationEntry })),
      writeFile(paths.profile, JSON.stringify(profile)),
      writeFile(paths.resources, JSON.stringify({ verified_at: verifiedAt, resources: [resource, staleResource] })),
      mkdir(join(work, "point"), { recursive: true })
    ]);
    await writeFile(join(work, "point", `${noteId}.json`), JSON.stringify({
      version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: noteId,
      title: resource.name, summary: pointSummary, content_sha256: hex("c"),
      prompt_version: promptVersion, request_sha256: hex("8"), summary_sha256: pointSummarySha256,
      captured_at: "2026-08-23T00:00:00.000Z"
    }));
    const site = spawnSync(process.execPath, [
      join(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs"),
      "--catalog", paths.catalog, "--config", paths.config, "--curation", paths.curation,
      "--profile", paths.profile, "--resources", paths.resources, "--build-version", hex("d"),
      "--diandian-dir", join(work, "point"), "--video-analysis", join(work, "video"), "--output", paths.public
    ], { cwd: root, encoding: "utf8" });
    assert.equal(site.status, 0, site.stderr || site.stdout);

    const publicData = JSON.parse(await readFile(paths.public, "utf8"));
    const card = publicData.notes[0];
    assert.equal(publicData.meta.buildVersion, hex("d"));
    assert.equal(card.mainSource, "diandian");
    assert.equal(card.mainText, pointSummary);
    assert.equal(card.replyDamaged, false);
    assert.equal(card.kind, "Skill");
    // Both tools the post names are shown; only the one with a fresh official resource is confirmed.
    assert.deepEqual(card.tools, [resource.name, staleResource.name]);
    assert.deepEqual(card.unverifiedTools, [staleResource.name]);
    assert.deepEqual(card.resources, [resource.name]);
    assert.deepEqual(card.resourceIds, ["github-owner-repo"]);
    assert.doesNotMatch(JSON.stringify(card), /old\/repo/);

    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.match(packageJson.scripts["test:knowledge"], /test_formal_outputs\.mjs/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
