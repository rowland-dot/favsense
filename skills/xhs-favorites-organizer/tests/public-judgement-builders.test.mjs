import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { PROMPT, TODAY, acceptedSkill, note, pointFile, profile, root, skillResource } from "./public-judgement-fixtures.mjs";

// Issue 6 made one public judgement module decide each note for the formal output; issue 39 left the web
// data as that output. Run the web builder on a set of notes and check what the verdict decides.

const builder = (name) => join(root, "skills/xhs-favorites-organizer/scripts", name);

// Builds the web data and returns each note as the web data shows it.
async function buildWeb({ notes, curation = {}, candidates = {}, audit = null, baseline = { note_ids: [], curation_hashes: {} }, profile: profileOverride = profile, resources = [], points = {} }) {
  const work = await mkdtemp(join(tmpdir(), "favsense-public-judgement-"));
  const paths = Object.fromEntries(["catalog", "config", "curation", "audit", "baseline", "profile", "resources", "candidates", "public"].map((name) => [name, join(work, `${name}.json`)]));
  try {
    await Promise.all([
      writeFile(paths.catalog, JSON.stringify({ version: 1, notes })),
      writeFile(paths.config, JSON.stringify({
        version: 1, domain_profile: paths.profile, curation_file: paths.curation,
        ...(audit ? { curation_quality: { publish_only_accepted: true, audit_file: paths.audit, baseline_file: paths.baseline } } : {}),
        boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {},
      })),
      writeFile(paths.curation, JSON.stringify(curation)),
      writeFile(paths.audit, JSON.stringify({ version: 2, notes: audit || {} })),
      writeFile(paths.baseline, JSON.stringify({ version: 1, ...baseline })),
      writeFile(paths.profile, JSON.stringify(profileOverride)),
      writeFile(paths.resources, JSON.stringify({ verified_at: TODAY, resources })),
      writeFile(paths.candidates, JSON.stringify(candidates)),
      mkdir(join(work, "point"), { recursive: true }),
    ]);
    for (const [id, record] of Object.entries(points)) await writeFile(join(work, "point", `${id}.json`), JSON.stringify(record));
    const site = spawnSync(process.execPath, [
      builder("build-public-site.mjs"),
      "--catalog", paths.catalog, "--config", paths.config, "--curation", paths.curation,
      "--profile", paths.profile, "--resources", paths.resources, "--candidates", paths.candidates,
      "--effective-date", TODAY, "--diandian-prompt-version", PROMPT, "--diandian-dir", join(work, "point"),
      "--video-analysis", join(work, "video"), "--output", paths.public,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(site.status, 0, site.stderr || site.stdout);
    return Object.fromEntries(JSON.parse(await readFile(paths.public, "utf8")).notes.map((item) => [item.id, item]));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test("a note with no reviewed entry and no sealed candidate gets the kind the rules decide and its source text", async () => {
  const description = `Weekly workflow review. ${"x".repeat(300)}`;
  const web = await buildWeb({ notes: { plain: note({ note_id: "plain", title: "Weekly review", description }) } });
  assert.equal(web.plain.kind, "Workflow");
  assert.equal(web.plain.summary, description.slice(0, 240));
  assert.deepEqual(web.plain.themes, []);
});

test("a note held only as a sealed Skill candidate whose resource check expired is not presented as a Skill", async () => {
  const resource = skillResource({ verified_at: "2026-09-01" });
  const { entry } = acceptedSkill({ resource });
  const web = await buildWeb({
    notes: { sealed: note({ note_id: "sealed", title: "Skill walkthrough", description: "Plain walkthrough" }) },
    candidates: { sealed: entry }, audit: {}, resources: [resource],
  });
  assert.equal(web.sealed.candidateKind, "Skill");
  assert.notEqual(web.sealed.kind, "Skill");
  assert.deepEqual(web.sealed.resourceIds, []);
  assert.deepEqual(web.sealed.tools, []);
});

test("an entry that names no kind is given the kind the rules decide, never a placeholder", async () => {
  const unkinded = { category: "Synthetic", themes: ["testing"], summary: "每周复盘的可复用工作流。", action: "Run it every week.", tools: [] };
  const web = await buildWeb({ notes: { unkinded: note({ note_id: "unkinded" }) }, curation: { unkinded } });
  assert.equal(web.unkinded.kind, "Workflow");
  assert.equal(web.unkinded.summary, unkinded.summary);
  assert.deepEqual(web.unkinded.themes, ["testing"]);
});

test("a reviewed entry with blank fields stays blank", async () => {
  const entry = { category: "Synthetic", summary: "Reviewed summary, written by hand.", tools: [], kind: "Note" };
  const web = await buildWeb({
    notes: { blank: note({ note_id: "blank", description: "Original post text that must not fill the blanks" }) },
    curation: { blank: entry }, audit: {},
    baseline: { note_ids: ["blank"], curation_hashes: { blank: curationRevision(entry) } },
  });
  assert.equal(web.blank.kind, "Note");
  assert.deepEqual(web.blank.themes, []);
  assert.equal(web.blank.summary, "Reviewed summary, written by hand.");
  assert.equal(web.blank.action, "");
});

test("an accepted Skill is shown with its point summary and resource, and with the reviewed entry's own summary once the point summary is gone", async () => {
  const accepted = acceptedSkill();
  const id = "n1";
  const common = {
    notes: { [id]: note() }, curation: { [id]: accepted.entry }, audit: { [id]: accepted.audit },
    resources: [accepted.resource],
  };
  const current = await buildWeb({ ...common, points: { [id]: pointFile(id, accepted) } });
  assert.equal(current[id].curationStatus, "accepted");
  assert.equal(current[id].kind, "Skill");
  assert.equal(current[id].deepSummarySource, "xiaohongshu-diandian");
  assert.deepEqual(current[id].resourceIds, [accepted.resource.id]);
  assert.deepEqual(current[id].tools, [accepted.resource.name]);
  // No point summary on disk: still accepted, and the reviewed entry's own summary stands in for it.
  const without = await buildWeb(common);
  assert.equal(without[id].curationStatus, "accepted");
  assert.equal(without[id].kind, "Skill");
  assert.equal(without[id].deepSummarySource, "curation");
  assert.deepEqual(without[id].resourceIds, [accepted.resource.id]);
});

test("the web builder reads the resource freshness limit from the profile, and keeps 30 days when it is absent", async () => {
  const accepted = acceptedSkill({ resource: skillResource({ verified_at: "2026-10-08" }) });
  const id = "n1";
  const scenario = (profileOverride) => ({
    notes: { [id]: note() }, curation: { [id]: accepted.entry }, audit: { [id]: accepted.audit },
    resources: [accepted.resource], points: { [id]: pointFile(id, accepted) }, profile: profileOverride,
  });
  const byDefault = await buildWeb(scenario(profile));
  assert.equal(byDefault[id].curationStatus, "accepted");
  assert.deepEqual(byDefault[id].resourceIds, [accepted.resource.id]);
  const strict = await buildWeb(scenario({ ...profile, resource_index: { ...profile.resource_index, verification_max_age_days: 1 } }));
  assert.equal(strict[id].summaryReason, "resource_stale");
  assert.notEqual(strict[id].kind, "Skill");
  assert.deepEqual(strict[id].resourceIds, []);
});
