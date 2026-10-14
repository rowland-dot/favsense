import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TODAY, note, profile, root, skillResource } from "./public-judgement-fixtures.mjs";

// One public judgement module decides each note's kind, resources and tools for the formal output. Run the web
// builder on a set of notes and check what that verdict decides. What each card says is in
// faithful-cards-builder.test.mjs.

const builder = (name) => join(root, "skills/xhs-favorites-organizer/scripts", name);

// Builds the web data and returns each note as the web data shows it.
async function buildWeb({ notes, curation = {}, candidates = {}, profile: profileOverride = profile, resources = [] }) {
  const work = await mkdtemp(join(tmpdir(), "favsense-public-judgement-"));
  const paths = Object.fromEntries(["catalog", "config", "curation", "profile", "resources", "candidates", "public"].map((name) => [name, join(work, `${name}.json`)]));
  try {
    await Promise.all([
      writeFile(paths.catalog, JSON.stringify({ version: 1, notes })),
      writeFile(paths.config, JSON.stringify({
        version: 1, domain_profile: paths.profile, curation_file: paths.curation,
        boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {},
      })),
      writeFile(paths.curation, JSON.stringify(curation)),
      writeFile(paths.profile, JSON.stringify(profileOverride)),
      writeFile(paths.resources, JSON.stringify({ verified_at: TODAY, resources })),
      writeFile(paths.candidates, JSON.stringify(candidates)),
      mkdir(join(work, "point"), { recursive: true }),
    ]);
    const site = spawnSync(process.execPath, [
      builder("build-public-site.mjs"),
      "--catalog", paths.catalog, "--config", paths.config, "--curation", paths.curation,
      "--profile", paths.profile, "--resources", paths.resources, "--candidates", paths.candidates,
      "--effective-date", TODAY, "--diandian-dir", join(work, "point"),
      "--video-analysis", join(work, "video"), "--output", paths.public,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(site.status, 0, site.stderr || site.stdout);
    return Object.fromEntries(JSON.parse(await readFile(paths.public, "utf8")).notes.map((item) => [item.id, item]));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test("a note with no add-on and no sealed candidate gets the kind the rules decide", async () => {
  const web = await buildWeb({ notes: { plain: note({ note_id: "plain", title: "Weekly review", description: `Weekly workflow review. ${"x".repeat(300)}` }) } });
  assert.equal(web.plain.kind, "Workflow");
  assert.deepEqual(web.plain.themes, []);
  assert.deepEqual(web.plain.tools, []);
});

test("a note held only as a sealed Skill candidate whose resource check expired is not presented as a Skill", async () => {
  const resource = skillResource({ verified_at: "2026-09-01" });
  const web = await buildWeb({
    notes: { sealed: note({ note_id: "sealed", title: "Skill walkthrough", description: "Plain walkthrough" }) },
    candidates: { sealed: { category: "Synthetic", themes: ["testing"], tools: [resource.name], kind: "Skill" } },
    resources: [resource],
  });
  assert.notEqual(web.sealed.kind, "Skill");
  assert.deepEqual(web.sealed.resourceIds, []);
  assert.deepEqual(web.sealed.tools, [resource.name]);
  assert.deepEqual(web.sealed.unverifiedTools, [resource.name]);
});

test("an add-on that names no kind is given the kind the rules decide, never a placeholder", async () => {
  const unkinded = { category: "Synthetic", themes: ["testing"], summary: "每周复盘的可复用工作流。", action: "Run it every week.", tools: [] };
  const web = await buildWeb({ notes: { unkinded: note({ note_id: "unkinded" }) }, curation: { unkinded } });
  assert.equal(web.unkinded.kind, "Workflow");
  assert.deepEqual(web.unkinded.themes, ["testing"]);
});

test("an add-on with blank fields stays blank and the post's text does not fill them", async () => {
  const web = await buildWeb({
    notes: { blank: note({ note_id: "blank", description: "Original post text that must not fill the blanks" }) },
    curation: { blank: { category: "Synthetic", tools: [], kind: "Note" } },
  });
  assert.equal(web.blank.kind, "Note");
  assert.deepEqual(web.blank.themes, []);
});

test("a confirmed Skill is shown with its resource", async () => {
  const resource = skillResource();
  const web = await buildWeb({
    notes: { n1: note() }, curation: { n1: { category: "Synthetic", themes: ["testing"], tools: [resource.name], kind: "Skill" } },
    resources: [resource],
  });
  assert.equal(web.n1.kind, "Skill");
  assert.deepEqual(web.n1.resourceIds, [resource.id]);
  assert.deepEqual(web.n1.tools, [resource.name]);
  assert.deepEqual(web.n1.unverifiedTools, []);
});

test("the web builder reads the resource freshness limit from the profile, and keeps 30 days when it is absent", async () => {
  const resource = skillResource({ verified_at: "2026-10-08" });
  const scenario = (profileOverride) => ({
    notes: { n1: note() }, curation: { n1: { category: "Synthetic", themes: ["testing"], tools: [resource.name], kind: "Skill" } },
    resources: [resource], profile: profileOverride,
  });
  const byDefault = await buildWeb(scenario(profile));
  assert.equal(byDefault.n1.kind, "Skill");
  assert.deepEqual(byDefault.n1.resourceIds, [resource.id]);
  const strict = await buildWeb(scenario({ ...profile, resource_index: { ...profile.resource_index, verification_max_age_days: 1 } }));
  assert.notEqual(strict.n1.kind, "Skill");
  assert.deepEqual(strict.n1.resourceIds, []);
});

// The link to the original post is the post's own address, whatever the add-on or the post's words say
// (spec LINK-02; the words of the post are no longer used to search for it).

const withAddOn = (noteOverrides = {}) => ({
  notes: { n1: note({ title: "", description: "用Codex封装亚马逊选品Skill后…#codex[话题]#", author: "创作者", ...noteOverrides }) },
  curation: { n1: { category: "Synthetic", themes: ["testing"], tools: ["Codex"], kind: "Note", title: "Codex 亚马逊选品 Go/No-Go 工作流" } },
});

test("the link to the original post is its own address, never built from a title or the add-on", async () => {
  for (const overrides of [{}, { title: "原帖自己的标题" }, { description: "字".repeat(80) }, { title: "题".repeat(80) }, { description: "" }]) {
    const web = await buildWeb(withAddOn(overrides));
    assert.equal(web.n1.sourceUrl, "https://www.xiaohongshu.com/explore/n1");
  }
});
