import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { PROMPT, TODAY, acceptedSkill, note, pointFile, profile, root, skillResource } from "./public-judgement-fixtures.mjs";

// Issue 6: the knowledge base and the web data are two layouts of one verdict. Run both builders
// on the same inputs and they must agree on every field the verdict decides.

const builder = (name) => join(root, "skills/xhs-favorites-organizer/scripts", name);

// Builds both outputs and returns, for each note, what the card says next to what the web data says.
async function buildBoth({ notes, curation = {}, candidates = {}, audit = null, baseline = { note_ids: [], curation_hashes: {} }, profile: profileOverride = profile, resources = [], points = {} }) {
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
    const common = [
      "--catalog", paths.catalog, "--config", paths.config, "--curation", paths.curation,
      "--profile", paths.profile, "--resources", paths.resources, "--candidates", paths.candidates,
      "--effective-date", TODAY, "--diandian-prompt-version", PROMPT, "--diandian-dir", join(work, "point"),
    ];
    const kb = spawnSync(process.execPath, [builder("build-knowledge-base.mjs"), ...common, "--output", join(work, "knowledge-base")], { cwd: root, encoding: "utf8" });
    assert.equal(kb.status, 0, kb.stderr || kb.stdout);
    const site = spawnSync(process.execPath, [builder("build-public-site.mjs"), ...common, "--video-analysis", join(work, "video"), "--output", paths.public], { cwd: root, encoding: "utf8" });
    assert.equal(site.status, 0, site.stderr || site.stdout);
    const web = Object.fromEntries(JSON.parse(await readFile(paths.public, "utf8")).notes.map((item) => [item.id, item]));
    const result = {};
    for (const id of Object.keys(notes)) {
      const card = await readFile(join(work, "knowledge-base", "02-知识卡片", `${id}.md`), "utf8");
      result[id] = {
        web: web[id],
        card: {
          kind: JSON.parse(card.match(/^content_kind: (.*)$/m)[1]),
          kindLine: card.match(/^- 内容形态：(.*)$/m)[1],
          summary: card.match(/> \[!summary\] 一句话结论\n> (.*)\n/)[1],
          themes: JSON.parse(card.match(/^themes: (.*)$/m)[1]),
          tools: [...card.matchAll(/^- \[\[03-工具雷达\/工具索引#.*?\|(.*?)\]\]$/gm)].map((match) => match[1]),
          hasPointSection: card.includes("## 点点 AI 深度总结"),
          hasSkillSection: card.includes("## Skill 核验"),
          action: card.match(/## 怎么用\n\n- (.*)\n/)?.[1] ?? "",
        },
      };
    }
    return result;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// What the two outputs must agree on for one note.
function assertSameVerdict({ web, card }, label) {
  assert.equal(card.kind, web.kind, `${label}: content kind`);
  assert.equal(card.kindLine, web.kind, `${label}: content kind line`);
  assert.equal(card.summary, web.summary, `${label}: one-sentence conclusion`);
  assert.deepEqual(card.themes, web.themes, `${label}: themes`);
  assert.deepEqual(card.tools, web.tools, `${label}: tools`);
  assert.equal(card.hasPointSection, web.deepSummarySource === "xiaohongshu-diandian", `${label}: point summary shown`);
}

test("builders agree on a note with no reviewed entry and no sealed candidate", async () => {
  const description = `Weekly workflow review. ${"x".repeat(300)}`;
  const built = await buildBoth({ notes: { plain: note({ note_id: "plain", title: "Weekly review", description }) } });
  assertSameVerdict(built.plain, "plain");
  assert.equal(built.plain.web.kind, "Workflow");
  assert.equal(built.plain.web.summary, description.slice(0, 240));
  assert.deepEqual(built.plain.web.themes, []);
});

test("builders agree on a note held only as a sealed Skill candidate whose resource check expired", async () => {
  const resource = skillResource({ verified_at: "2026-09-01" });
  const { entry } = acceptedSkill({ resource });
  const built = await buildBoth({
    notes: { sealed: note({ note_id: "sealed", title: "Skill walkthrough", description: "Plain walkthrough" }) },
    candidates: { sealed: entry }, audit: {}, resources: [resource],
  });
  assertSameVerdict(built.sealed, "sealed");
  assert.equal(built.sealed.web.candidateKind, "Skill");
  assert.notEqual(built.sealed.web.kind, "Skill");
  assert.equal(built.sealed.card.hasSkillSection, false);
});

test("builders agree on an entry that names no kind, and write the kind the rules decide, never a placeholder", async () => {
  const unkinded = { category: "Synthetic", themes: ["testing"], summary: "每周复盘的可复用工作流。", action: "Run it every week.", tools: [] };
  const built = await buildBoth({ notes: { unkinded: note({ note_id: "unkinded" }) }, curation: { unkinded } });
  assertSameVerdict(built.unkinded, "unkinded");
  assert.equal(built.unkinded.web.kind, "Workflow");
  assert.equal(built.unkinded.card.kind, "Workflow");
});

test("builders agree that a reviewed entry with blank fields stays blank", async () => {
  const entry = { category: "Synthetic", summary: "Reviewed summary, written by hand.", tools: [], kind: "Note" };
  const built = await buildBoth({
    notes: { blank: note({ note_id: "blank", description: "Original post text that must not fill the blanks" }) },
    curation: { blank: entry }, audit: {},
    baseline: { note_ids: ["blank"], curation_hashes: { blank: curationRevision(entry) } },
  });
  assertSameVerdict(built.blank, "blank");
  assert.deepEqual(built.blank.card.themes, []);
  assert.equal(built.blank.card.summary, "Reviewed summary, written by hand.");
  assert.equal(built.blank.card.action, "");
});

test("builders agree on an accepted Skill, and on the same Skill once its point summary is gone", async () => {
  const accepted = acceptedSkill();
  const id = "n1";
  const common = {
    notes: { [id]: note() }, curation: { [id]: accepted.entry }, audit: { [id]: accepted.audit },
    resources: [accepted.resource],
  };
  const current = await buildBoth({ ...common, points: { [id]: pointFile(id, accepted) } });
  assertSameVerdict(current[id], "accepted");
  assert.equal(current[id].web.curationStatus, "accepted");
  assert.equal(current[id].card.kind, "Skill");
  assert.equal(current[id].card.hasSkillSection, true);
  assert.equal(current[id].card.hasPointSection, true);
  // No point summary on disk: still accepted, and both fall back to the reviewed entry's own summary.
  const without = await buildBoth(common);
  assertSameVerdict(without[id], "accepted without point");
  assert.equal(without[id].card.hasPointSection, false);
});

test("builders both read the resource freshness limit from the profile, and keep 30 days when it is absent", async () => {
  const accepted = acceptedSkill({ resource: skillResource({ verified_at: "2026-10-08" }) });
  const id = "n1";
  const scenario = (profileOverride) => ({
    notes: { [id]: note() }, curation: { [id]: accepted.entry }, audit: { [id]: accepted.audit },
    resources: [accepted.resource], points: { [id]: pointFile(id, accepted) }, profile: profileOverride,
  });
  const byDefault = await buildBoth(scenario(profile));
  assert.equal(byDefault[id].web.curationStatus, "accepted");
  assert.equal(byDefault[id].card.hasSkillSection, true);
  const strict = await buildBoth(scenario({ ...profile, resource_index: { ...profile.resource_index, verification_max_age_days: 1 } }));
  assertSameVerdict(strict[id], "strict");
  assert.equal(strict[id].web.summaryReason, "resource_stale");
  assert.notEqual(strict[id].web.kind, "Skill");
  assert.equal(strict[id].card.hasSkillSection, false);
});
