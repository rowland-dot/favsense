import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resourceGroup, resourceSortsForGroup, sortResources, validateResourceIndex } from "../../../site/resource-utils.mjs";
import { hasHuggingFaceMiniHeader, resolveHuggingFaceHeaderLayout } from "../../../site/huggingface-layout.mjs";
import { assertPrivateDataset, repositoryIsMissing, repositoryWriteConflict } from "../../../site/hf-sync-guard.mjs";
import { collectVideoEvidenceStats } from "../scripts/evidence-stats.mjs";
import { validateLocalBridgeConfig, validateLocalBridgeSession } from "../../../site/local-bridge-utils.mjs";
import {
  loadPersonalData,
  mergePersonalData,
  normalizePersonalData,
  relatedResourceNames,
  serializePersonalData
} from "../../../site/personal-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");

async function buildProfileFixture(profileFile, options = {}) {
  const work = await mkdtemp(resolve(root, ".resource-index-test-"));
  const noteId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const configPath = resolve(work, "config.json");
  const catalogPath = resolve(work, "catalog.json");
  const curationPath = resolve(work, "curation.json");
  const outputPath = resolve(work, "knowledge.json");
  await Promise.all([
    writeFile(configPath, JSON.stringify({
      version: 1,
      domain_profile: `config/domain-profiles/${profileFile}`,
      curation_file: curationPath,
      public_stats: {},
      boards: [{ id: "bbbbbbbbbbbbbbbbbbbbbbbb", name: "Fixture", enabled: true }]
    })),
    writeFile(catalogPath, JSON.stringify({ notes: {
      [noteId]: options.note || { title: "Fixture note", description: "Fixture description", source_boards: ["Fixture"] }
    } })),
    writeFile(curationPath, JSON.stringify(options.uncurated ? {} : {
      [noteId]: { category: "Fixture", themes: [], summary: "Fixture summary with enough content for deterministic profile compilation.", action: "Review the configured resource and its official evidence before taking action.", tools: [] }
    }))
  ]);
  const args = [
    resolve(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs"),
    "--config", configPath,
    "--catalog", catalogPath,
    "--curation", curationPath,
    "--profile", resolve(root, `config/domain-profiles/${profileFile}`),
    "--video-analysis", resolve(work, "video-analysis"),
    "--output", outputPath
  ];
  if (options.resources) args.push("--resources", options.resources);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(await readFile(outputPath, "utf8"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test("public site ships complete, structured knowledge data", async () => {
  const data = JSON.parse(await read("site/data/knowledge.json"));
  assert.ok(data.notes.length >= 32);
  assert.equal(data.meta.noteCount, data.notes.length);
  assert.ok(data.resources.length >= 30);
  assert.equal(data.meta.resourceCount, data.resources.length);
  assert.equal(data.meta.resourceIndexEnabled, true);
  assert.ok(data.categories.length >= 8);

  for (const note of data.notes) {
    assert.match(note.id, /^[a-f0-9]{24}$/);
    assert.ok(note.title.length > 0);
    assert.ok(note.summary.length > 0);
    assert.ok(note.deepSummary.length >= note.summary.length);
    assert.ok(note.action.length > 20);
    assert.match(note.sourceUrl, /^https:\/\/www\.xiaohongshu\.com\/search_result\?/);
    assert.equal(Object.hasOwn(note, "priority"), false);
    assert.equal(Object.hasOwn(note, "risk"), false);
    assert.match(note.kind, /^(Note|Tool|Skill|Workflow|Product)$/);
  }

  assert.equal(Object.hasOwn(data.meta, "priorityLabels"), false);
  assert.ok(data.meta.sourceBoards.includes("Skills"));
  assert.equal(data.notes.some((note) => note.title === "未命名收藏"), false);
});

test("missing titles are inferred and public source navigation never publishes expiring direct links", async () => {
  const data = await buildProfileFixture("software.json", {
    uncurated: true,
    note: {
      title: "",
      description: "国产“爱死机”《丧尸清道夫》创作思路分享#AI视频[话题]#",
      author: "创作者",
      source_boards: ["Fixture"]
    }
  });
  const note = data.notes[0];
  assert.equal(note.title, "国产“爱死机”《丧尸清道夫》创作思路分享");
  assert.equal(note.category, "AI设计与多媒体");
  const source = new URL(note.sourceUrl);
  assert.equal(source.pathname, "/search_result");
  assert.match(source.searchParams.get("keyword"), /丧尸清道夫/);
  assert.equal(source.searchParams.get("source"), "web_search_result_notes");
  assert.doesNotMatch(note.sourceUrl, /xsec_token|\/explore\/|\/discovery\/item\//);
});

test("uncertain software content uses a neutral category instead of Vibe Coding", async () => {
  const data = await buildProfileFixture("software.json", {
    uncurated: true,
    note: { title: "一条暂时无法判断领域的收藏", description: "一般观点", source_boards: ["Fixture"] }
  });
  assert.equal(data.notes[0].category, "其他软件与 AI");
});

test("content kind supports an explicit curated override", async () => {
  const builder = await read("skills/xhs-favorites-organizer/scripts/build-public-site.mjs");
  const schema = await read("skills/xhs-favorites-organizer/references/organization-schema.md");
  assert.match(builder, /if \(entry\.kind !== undefined\)/);
  assert.doesNotMatch(builder, /Invalid priority for|entry\.priority|priorityLabels/);
  assert.match(schema, /可选的内容形态人工覆盖值/);
  assert.match(schema, /当前 `domain_profile` 的 `content_kinds`/);
  assert.match(schema, /不要求用户为每篇笔记维护等级/);
});

test("uncurated software notes infer content kind from public metadata", async () => {
  const work = await mkdtemp(resolve(root, ".fallback-kind-test-"));
  const configPath = resolve(work, "config.json");
  const catalogPath = resolve(work, "catalog.json");
  const curationPath = resolve(work, "curation.json");
  const outputPath = resolve(work, "knowledge.json");
  const cases = {
    "aaaaaaaaaaaaaaaaaaaaaaaa": ["三个 Codex 神级 Skill", "", "Skill"],
    "bbbbbbbbbbbbbbbbbbbbbbbb": ["4 步搭建自动化工作流教程", "", "Workflow"],
    "cccccccccccccccccccccccc": ["这款在线平台需要会员", "", "Product"],
    "dddddddddddddddddddddddd": ["GitHub 开源视频剪辑工具", "", "Tool"],
    "eeeeeeeeeeeeeeeeeeeeeeee": ["关于个人知识管理的几点思考", "", "Note"]
  };
  try {
    await Promise.all([
      writeFile(configPath, JSON.stringify({
        version: 1,
        domain_profile: "config/domain-profiles/software.json",
        curation_file: curationPath,
        public_stats: {},
        boards: [{ id: "ffffffffffffffffffffffff", name: "Fixture", enabled: true }]
      })),
      writeFile(catalogPath, JSON.stringify({ notes: Object.fromEntries(
        Object.entries(cases).map(([id, [title, description]]) => [id, { title, description }])
      ) })),
      writeFile(curationPath, "{}")
    ]);
    const result = spawnSync(process.execPath, [
      resolve(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs"),
      "--config", configPath,
      "--catalog", catalogPath,
      "--curation", curationPath,
      "--profile", resolve(root, "config/domain-profiles/software.json"),
      "--video-analysis", resolve(work, "video-analysis"),
      "--output", outputPath
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const data = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(
      Object.fromEntries(data.notes.map((note) => [note.id, note.kind])),
      Object.fromEntries(Object.entries(cases).map(([id, values]) => [id, values[2]]))
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("uncurated domain content uses domain semantics instead of a Note status fallback", async () => {
  const software = await buildProfileFixture("software.json", { uncurated: true });
  const fitness = await buildProfileFixture("fitness.json", { uncurated: true });
  const skincare = await buildProfileFixture("skincare.json", { uncurated: true });
  assert.equal(software.notes[0].kind, "Note");
  assert.equal(fitness.notes[0].kind, "Claim");
  assert.equal(skincare.notes[0].kind, "Claim");
});

test("each domain exports only its own content-kind vocabulary", async () => {
  const expectations = {
    "software.json": ["Note", "Tool", "Skill", "Workflow", "Product"],
    "fitness.json": ["Note", "Movement", "Program", "Claim", "Product"],
    "skincare.json": ["Note", "Ingredient", "Routine", "Claim", "Product"]
  };
  for (const [profileFile, expectedKinds] of Object.entries(expectations)) {
    const data = await buildProfileFixture(profileFile);
    assert.deepEqual(Object.keys(data.meta.kindLabels), expectedKinds);
  }
  const app = await read("site/app.js");
  assert.match(app, /state\.data\.meta\.kindLabels/);
  assert.match(app, /new Set\(state\.data\.notes\.map\(\(note\) => note\.kind\)\)/);
});

test("resource index groups projects, websites, documentation and tutorials", async () => {
  const profile = JSON.parse(await read("config/domain-profiles/software.json"));
  const index = profile.resource_index;
  assert.equal(resourceGroup({ name: "Palmier Pro", type: "AI 视频编辑" }, index), "开源项目");
  assert.equal(resourceGroup({ name: "Crawl4AI 官网", type: "官方网站" }, index), "官方网站");
  assert.equal(resourceGroup({ name: "AiWind", type: "提示词与案例网站" }, index), "官方网站");
  assert.equal(resourceGroup({ name: "Crawl4AI Docs", type: "官方文档" }, index), "官方文档");
  assert.equal(resourceGroup({ name: "Quick Start", type: "教程" }, index), "教程");
});

test("domain profile without an explicit valid default fails instead of falling back to Note", async () => {
  const work = await mkdtemp(resolve(root, ".invalid-kind-profile-test-"));
  const configPath = resolve(work, "config.json");
  const catalogPath = resolve(work, "catalog.json");
  const curationPath = resolve(work, "curation.json");
  const profilePath = resolve(work, "profile.json");
  const outputPath = resolve(work, "knowledge.json");
  const baseProfile = JSON.parse(await read("config/domain-profiles/software.json"));
  try {
    await Promise.all([
      writeFile(configPath, JSON.stringify({ version: 1, boards: [] })),
      writeFile(catalogPath, JSON.stringify({ notes: {} })),
      writeFile(curationPath, "{}")
    ]);
    for (const invalidDefault of [undefined, "MissingKind"]) {
      const profile = structuredClone(baseProfile);
      if (invalidDefault === undefined) delete profile.classification.default;
      else profile.classification.default = invalidDefault;
      await writeFile(profilePath, JSON.stringify(profile));
      const result = spawnSync(process.execPath, [
        resolve(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs"),
        "--config", configPath,
        "--catalog", catalogPath,
        "--curation", curationPath,
        "--profile", profilePath,
        "--video-analysis", resolve(work, "video-analysis"),
        "--resources", resolve(root, "skills/xhs-favorites-organizer/references/software-resources.json"),
        "--output", outputPath
      ], { cwd: root, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /classification\.default|required|not declared/);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("resource index follows configured sorts and leaves missing metrics last", async () => {
  const profile = JSON.parse(await read("config/domain-profiles/software.json"));
  const resources = [
    { name: "Beta", metricNumeric: 20 },
    { name: "Alpha", metricNumeric: 10 },
    { name: "Unknown", metricNumeric: null }
  ];
  assert.deepEqual(sortResources(resources, "metric-desc", profile.resource_index).map((item) => item.name), ["Beta", "Alpha", "Unknown"]);
  assert.deepEqual(sortResources(resources, "metric-asc", profile.resource_index).map((item) => item.name), ["Alpha", "Beta", "Unknown"]);
  assert.deepEqual(sortResources(resources, "name-asc", profile.resource_index).map((item) => item.name), ["Alpha", "Beta", "Unknown"]);
  assert.deepEqual(sortResources(resources, "name-desc", profile.resource_index).map((item) => item.name), ["Unknown", "Beta", "Alpha"]);
});

test("resource sort options follow the selected resource type", async () => {
  const profile = JSON.parse(await read("config/domain-profiles/software.json"));
  const index = profile.resource_index;
  assert.deepEqual(resourceSortsForGroup(index, "all").map((sort) => sort.id), ["name-asc", "name-desc"]);
  assert.deepEqual(resourceSortsForGroup(index, "开源项目").map((sort) => sort.id), ["metric-desc", "metric-asc", "name-asc", "name-desc"]);
  assert.deepEqual(resourceSortsForGroup(index, "GitHub 项目").map((sort) => sort.id), ["metric-desc", "metric-asc", "name-asc", "name-desc"]);
  assert.deepEqual(resourceSortsForGroup(index, "官方文档").map((sort) => sort.id), ["name-asc", "name-desc"]);
});

test("personal curation stays note-scoped and links bookmarked resources", () => {
  const ids = new Set(["note-a", "note-b"]);
  const normalized = normalizePersonalData({
    bookmarks: ["note-a", "unknown", "note-a"],
    descriptionOverrides: {
      "note-a": { description: "  我的修订  ", updatedAt: "2026-07-29T00:00:00.000Z" },
      unknown: { description: "不应保留" }
    }
  }, ids);
  assert.deepEqual(normalized.bookmarks, ["note-a"]);
  assert.equal(normalized.descriptionOverrides["note-a"].description, "我的修订");
  assert.equal(normalized.descriptionOverrides.unknown, undefined);

  const resources = relatedResourceNames([
    { id: "note-a", resources: ["Tool A", "Guide B"] },
    { id: "note-b", resources: ["Tool C"] }
  ], new Set(normalized.bookmarks));
  assert.deepEqual([...resources], ["Tool A", "Guide B"]);
});

test("personal curation migrates old bookmarks and merges portable backups", () => {
  const memory = new Map([["xhs-kb-saved", JSON.stringify(["note-a"])]]);
  const storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key)
  };
  const loaded = loadPersonalData(storage, new Set(["note-a", "note-b"]));
  assert.deepEqual(loaded.bookmarks, ["note-a"]);
  assert.equal(memory.has("xhs-kb-saved"), false);

  const merged = mergePersonalData(loaded, {
    bookmarks: ["note-b"],
    descriptionOverrides: { "note-b": { description: "跨设备修订" } }
  }, new Set(["note-a", "note-b"]));
  assert.deepEqual(merged.bookmarks, ["note-a", "note-b"]);
  assert.match(serializePersonalData(merged, new Set(["note-a", "note-b"])), /"version": 2/);
});

test("personal curation resolves stale cross-device edits and deletions", () => {
  const ids = new Set(["note-a"]);
  const remote = {
    bookmarkStates: { "note-a": { bookmarked: false, updatedAt: "2026-07-29T02:00:00.000Z" } },
    descriptionOverrides: { "note-a": { description: "", deleted: true, updatedAt: "2026-07-29T02:00:00.000Z" } }
  };
  const staleLocal = {
    bookmarkStates: { "note-a": { bookmarked: true, updatedAt: "2026-07-29T01:00:00.000Z" } },
    descriptionOverrides: { "note-a": { description: "旧修订", updatedAt: "2026-07-29T01:00:00.000Z" } }
  };
  const merged = mergePersonalData(remote, staleLocal, ids);
  assert.deepEqual(merged.bookmarks, []);
  assert.equal(merged.bookmarkStates["note-a"].bookmarked, false);
  assert.equal(merged.descriptionOverrides["note-a"].deleted, true);
  assert.equal(merged.descriptionOverrides["note-a"].description, "");
});

test("personal sync merges the latest remote snapshot before a second client writes", () => {
  const ids = new Set(["note-a", "note-b"]);
  const clientA = normalizePersonalData({
    bookmarkStates: { "note-a": { bookmarked: true, updatedAt: "2026-07-29T01:00:00.000Z" } }
  }, ids);
  const clientB = normalizePersonalData({
    bookmarkStates: { "note-b": { bookmarked: true, updatedAt: "2026-07-29T01:00:01.000Z" } }
  }, ids);
  const afterA = mergePersonalData({}, clientA, ids);
  const afterB = mergePersonalData(afterA, clientB, ids);
  assert.deepEqual(new Set(afterB.bookmarks), new Set(["note-a", "note-b"]));
});

test("Hugging Face personal sync fails closed when the Dataset is public", () => {
  assert.equal(assertPrivateDataset({ private: true, sha: "a".repeat(40) }).private, true);
  assert.throws(() => assertPrivateDataset({ private: false, sha: "a".repeat(40) }), /sync was stopped/);
  assert.throws(() => assertPrivateDataset({ private: true }), /no verifiable revision/);
  assert.throws(() => assertPrivateDataset(null), /sync was stopped/);
  assert.equal(repositoryIsMissing(new Error("404 repository not found")), true);
  assert.equal(repositoryIsMissing(new Error("network timeout")), false);
  assert.equal(repositoryWriteConflict(new Error("409 Conflict: parent commit changed")), true);
  assert.equal(repositoryWriteConflict(new Error("network timeout")), false);
});

test("resource index validation rejects broken type-sort contracts", () => {
  assert.throws(
    () => validateResourceIndex({ groups: [], default_group: "其他", sorts: [{ id: "metric", label: "指标", field: "metricNumeric", type: "number", direction: "desc", applies_to: ["拼错的类型"] }] }),
    /unknown resource type/
  );
  assert.throws(
    () => validateResourceIndex({ groups: [], default_group: "其他", sorts: [{ id: "metric", label: "指标", field: "metricNumeric", type: "number", direction: "desc", applies_to: ["其他"] }] }),
    /at least one global sort/
  );
  assert.throws(
    () => validateResourceIndex({ groups: [], default_group: "其他", sorts: [{ id: "metric", label: "指标", field: "metricNumeric", type: "number", direction: "desc", applies_to: "其他" }] }),
    /must be an array/
  );
});

test("software, fitness and skincare profiles expose a complete resource-index contract", async () => {
  for (const file of ["software.json", "fitness.json", "skincare.json"]) {
    const profile = JSON.parse(await read(`config/domain-profiles/${file}`));
    assert.equal(profile.version, 1);
    assert.ok(profile.id);
    assert.ok(profile.presentation?.hero?.from);
    assert.ok(profile.presentation?.hero?.to);
    assert.equal(Object.hasOwn(profile, "priorities"), false);
    assert.ok(Object.hasOwn(profile.content_kinds, profile.classification.default));
    for (const rule of profile.classification.rules) {
      assert.ok(Object.hasOwn(profile.content_kinds, rule.kind));
      assert.doesNotThrow(() => new RegExp(rule.pattern, "i"));
    }
    if (profile.fallback?.default_kind) {
      assert.ok(Object.hasOwn(profile.content_kinds, profile.fallback.default_kind));
    }
    for (const rule of profile.fallback?.kind_rules || []) {
      assert.ok(Object.hasOwn(profile.content_kinds, rule.kind));
      assert.doesNotThrow(() => new RegExp(rule.pattern, "i"));
    }
    const index = profile.resource_index;
    assert.doesNotThrow(() => validateResourceIndex(index));
    assert.equal(profile.features.resource_index, true);
    assert.ok(index.label && index.entity_label && index.registry_file);
    assert.ok(index.mapping.name && index.mapping.type && index.mapping.description);
    assert.ok(Array.isArray(index.fields));
    assert.ok(index.groups.length > 0 && index.sorts.length > 0 && index.actions.length > 0);
    for (const group of index.groups) assert.doesNotThrow(() => new RegExp(group.pattern, "i"));
    for (const sort of index.sorts) {
      assert.match(sort.field, /^(name|metricNumeric)$/);
      assert.match(sort.type, /^(text|number)$/);
      assert.match(sort.direction, /^(asc|desc)$/);
      for (const group of sort.applies_to || []) {
        assert.ok(
          group === index.default_group || index.groups.some((candidate) => candidate.label === group),
          `Unknown sort group ${group} in ${file}`
        );
      }
    }
    const registry = JSON.parse(await read(index.registry_file));
    const resources = registry[index.collection];
    assert.ok(Array.isArray(resources) && resources.length > 0);
    for (const resource of resources) {
      assert.ok(resource[index.mapping.name]);
      assert.ok(resource[index.mapping.type]);
      assert.ok(resource[index.mapping.description]);
      for (const field of index.fields) assert.ok(resource[field.field]);
      const availableActions = index.actions.filter((action) => resource[action.field]);
      assert.ok(availableActions.length > 0);
      for (const action of availableActions) assert.match(resource[action.field], /^https:\/\//);
    }
  }
});

test("video evidence statistics are derived from local evidence files", async () => {
  const work = await mkdtemp(resolve(root, ".evidence-stats-test-"));
  const noteA = resolve(work, "aaaaaaaaaaaaaaaaaaaaaaaa");
  const noteB = resolve(work, "bbbbbbbbbbbbbbbbbbbbbbbb");
  const ignored = resolve(work, "not-a-note");
  try {
    await Promise.all([mkdir(resolve(noteA, "frames"), { recursive: true }), mkdir(noteB), mkdir(ignored)]);
    await Promise.all([
      writeFile(resolve(noteA, "analysis.json"), JSON.stringify({ status: "complete" })),
      writeFile(resolve(noteA, "overview.jpg"), "a"),
      writeFile(resolve(noteA, "frames", "0001.jpg"), "a"),
      writeFile(resolve(noteB, "0001.png"), "a"),
      writeFile(resolve(ignored, "analysis.json"), JSON.stringify({ status: "complete" })),
      writeFile(resolve(ignored, "0001.jpg"), "a")
    ]);
    const stats = await collectVideoEvidenceStats(work, {}, ["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"]);
    assert.equal(stats.frameEvidenceCount, 2);
    assert.deepEqual(stats.verifiedNoteIds, ["aaaaaaaaaaaaaaaaaaaaaaaa"]);
    assert.equal(stats.derivedFromLocalEvidence, true);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("all domain profiles compile through the same public builder", async () => {
  const expectations = [
    ["software.json", "software", "资源索引", null, []],
    ["fitness.json", "fitness", "训练资料库", 3, ["目标", "适用", "注意"]],
    ["skincare.json", "skincare", "成分资料库", 3, ["适用", "耐受", "边界"]]
  ];
  for (const [file, id, label, count, fields] of expectations) {
    const data = await buildProfileFixture(file);
    assert.equal(data.meta.profileId, id);
    assert.equal(data.meta.resourceIndex.label, label);
    if (count === null) {
      assert.ok(data.resources.length >= 30);
      assert.equal(data.meta.resourceCount, data.resources.length);
    } else {
      assert.equal(data.resources.length, count);
    }
    assert.deepEqual((data.resources[0].attributes || []).map((attribute) => attribute.label), fields);
  }
});

test("builder preserves missing numeric metrics as null", async () => {
  const work = await mkdtemp(resolve(root, ".resource-metric-test-"));
  const registry = resolve(work, "registry.json");
  await writeFile(registry, JSON.stringify({ verified_at: "2026-07-28", resources: [
    { name: "Null", aliases: [], type: "Tool", usage_note: "Missing", stars: "", stars_numeric: null, repo: "https://github.com/example/null", download: "https://github.com/example/null/archive/refs/heads/main.zip" },
    { name: "Empty", aliases: [], type: "Tool", usage_note: "Missing", stars: "", stars_numeric: "", repo: "https://github.com/example/empty", download: "https://github.com/example/empty/archive/refs/heads/main.zip" },
    { name: "Absent", aliases: [], type: "Tool", usage_note: "Missing", stars: "", repo: "https://github.com/example/absent", download: "https://github.com/example/absent/archive/refs/heads/main.zip" }
  ] }));
  try {
    const data = await buildProfileFixture("software.json", { resources: registry });
    assert.deepEqual(data.resources.map((resource) => resource.metricNumeric), [null, null, null]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("skincare sunscreen resource points to a sunscreen-specific guide", async () => {
  const registry = JSON.parse(await read("config/resource-registries/skincare.example.json"));
  const sunscreen = registry.resources.find((resource) => resource.name === "防晒基础");
  assert.ok(sunscreen);
  assert.match(sunscreen.guide, /aad\.org\/public\/everyday-care\/sun-protection\//);
  assert.doesNotMatch(sunscreen.guide, /retinoid|retinol/);
});

test("public payload excludes private account state", async () => {
  const payload = await read("site/data/knowledge.json");
  for (const forbidden of [
    /xsec_token/i,
    /\/user\/profile\//i,
    /author_id/i,
    /ChromeUserData/i,
    /AppData\\Local/i
  ]) {
    assert.doesNotMatch(payload, forbidden);
  }
});

test("software resource registry mixes repositories, websites, docs and tutorials", async () => {
  const data = JSON.parse(await read("site/data/knowledge.json"));
  const urls = [];
  for (const resource of data.resources) {
    assert.ok(resource.name && resource.type && resource.description);
    assert.ok(Array.isArray(resource.actions) && resource.actions.length > 0);
    for (const action of resource.actions) {
      assert.match(action.url, /^https:\/\//);
      urls.push(action.url);
    }
    assert.equal(Object.hasOwn(resource, "status"), false);
  }
  assert.ok(urls.some((url) => url.startsWith("https://github.com/")));
  assert.ok(urls.some((url) => url.startsWith("https://docs.")));
  assert.ok(data.resources.some((resource) => resource.type === "官方网站"));
  assert.ok(data.resources.some((resource) => resource.type === "教程"));
});

test("VividDub keeps its verified GitHub project identity", async () => {
  const registry = JSON.parse(await read("skills/xhs-favorites-organizer/references/software-resources.json"));
  const vividdub = registry.resources.find((resource) => resource.name === "VividDub");
  assert.ok(vividdub);
  assert.equal(vividdub.type, "GitHub 产品项目");
  assert.equal(vividdub.repo, "https://github.com/VividDub/VividDub");
  assert.equal(vividdub.stars_numeric, 7);
  assert.doesNotMatch(vividdub.usage_note, /没有 GitHub|不是已确认的 GitHub/);
});

test("verified video evidence does not claim every frame was reviewed", async () => {
  const data = JSON.parse(await read("site/data/knowledge.json"));
  const vividdub = data.notes.find((note) => note.id === "6a603e4e000000001d00c0a0");
  assert.ok(vividdub);
  assert.equal(vividdub.evidence.method, "已结合本地视频证据核验内容");
  assert.doesNotMatch(vividdub.evidence.method, /完整查看视频/);
  assert.doesNotMatch(vividdub.evidence.method, /音频转写/);
  assert.doesNotMatch(data.meta.videoMethod, /完整视频解读/);
});

test("static app has the required deployment assets", async () => {
  const [html, css, js, personalStore, hfPersonalSync, hfSyncGuard, siteConfig, readme, publishingGuide, archivedCss, archiveReadme] = await Promise.all([
    read("site/index.html"),
    read("site/styles.css"),
    read("site/app.js"),
    read("site/personal-store.mjs"),
    read("site/hf-personal-sync.mjs"),
    read("site/hf-sync-guard.mjs"),
    read("site/site-config.js"),
    read("README.md"),
    read("docs/PUBLISHING.md"),
    read("site/themes/archive/research-blue-v1/styles.css"),
    read("site/themes/archive/research-blue-v1/README.md")
  ]);
  assert.match(html, /id="notes-grid"/);
  assert.match(html, /id="resources-grid"/);
  assert.match(html, /id="resource-type-filter"/);
  assert.match(html, /id="resource-sort"/);
  assert.match(html, /id="resource-result-count"/);
  assert.match(html, /id="bookmark-filter"/);
  assert.doesNotMatch(html, /open-source-note|私人数据默认不公开/);
  assert.match(html, /id="resource-bookmark-filter"/);
  assert.match(html, /id="personal-data-export"/);
  assert.match(html, /id="personal-data-import"/);
  assert.doesNotMatch(html, /owner\/repo|Star、许可证|从官方仓库确认/);
  assert.match(html, />同步设置</);
  assert.doesNotMatch(html, /id="clear-filters"/);
  assert.match(html, /<kbd[^>]*>按 \/ 搜索<\/kbd>/);
  assert.doesNotMatch(html, /项目雷达|资源雷达|同步与方法/);
  assert.doesNotMatch(html, /项目、风险与下一步|视频核验后的判断|证据方法|TRY →/);
  assert.match(html, /id="board-manager"/);
  assert.match(html, /id="board-list"/);
  assert.match(html, /id="board-enabled-count"/);
  assert.match(html, /id="manual-sync-control"[^>]*hidden/);
  assert.match(html, /id="manual-sync-start"[^>]*>开始整理</);
  assert.doesNotMatch(html, /选择每天整理|自动进入每日同步/);
  assert.match(html, /id="creator-space-link"/);
  assert.doesNotMatch(html, /id="hero-dismiss"|id="hero-restore"/);
  assert.match(html, /theme-icon--sun/);
  assert.match(html, /theme-icon--moon/);
  assert.match(html, /FavSense · 拾光台/);
  assert.match(html, /name="keywords"[^>]*Xiaohongshu[^>]*RedNote[^>]*Obsidian/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.filter-sidebar \{[^}]*position:\s*static[^}]*height:\s*auto[^}]*overflow-y:\s*visible/);
  assert.doesNotMatch(css, /\.filter-sidebar \{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /--brand-red:\s*#ff2442/);
  assert.match(css, /--cobalt:\s*#5b7cfa/);
  assert.match(js, /categoryAccents = new Map/);
  assert.match(js, /resourceGroup, resourceSortsForGroup, sortResources/);
  assert.match(js, /renderResourceSortOptions/);
  assert.match(js, /data-bookmark-note/);
  assert.match(js, /data-description-form/);
  assert.match(js, /relatedResourceNames/);
  assert.match(personalStore, /favsense-personal-v1/);
  assert.match(personalStore, /MAX_DESCRIPTION_LENGTH = 4000/);
  assert.match(hfPersonalSync, /@huggingface\/hub@2\.14\.2/);
  assert.match(hfPersonalSync, /type: "dataset"/);
  assert.match(hfPersonalSync, /private: true/);
  assert.match(hfPersonalSync, /datasetInfo/);
  assert.match(hfPersonalSync, /additionalFields: \["sha"\]/);
  assert.match(hfPersonalSync, /assertPrivateDataset/);
  assert.match(hfPersonalSync, /parentCommit: info\.sha,/);
  assert.doesNotMatch(hfPersonalSync, /parentCommit: info\.sha \|\| undefined/);
  assert.match(hfPersonalSync, /repositoryWriteConflict/);
  assert.match(hfSyncGuard, /info\?\.private !== true/);
  assert.match(readme, /hf_oauth_scopes:\s*\n\s+- contribute-repos/);
  assert.match(html, /统计随每次同步与站点构建自动更新/);
  assert.match(js, /\.\/\.local\/bridge\.json/);
  assert.match(js, /X-XHS-Bridge-Token/);
  assert.match(js, /localBridgeRequest\("\/boards"/);
  assert.match(js, /localBridgeRequest\("\/sync\/start"/);
  assert.match(js, /localBridgeRequest\("\/sync\/status"/);
  assert.match(js, /manualSyncStartedHere/);
  assert.match(js, /creatorGitHubUrl/);
  assert.match(js, /FAVSENSE_CONFIG/);
  assert.match(js, /CREATOR_GITHUB_URL/);
  assert.match(css, /\.creator-space-link/);
  assert.doesNotMatch(css, /\.tech-watermark/);
  assert.match(js, /view === "notes" \? elements\.hero/);
  assert.doesNotMatch(js, /heroCollapsed|favsense-hero-collapsed/);
  assert.match(js, /state\.resourceType === "all"/);
  assert.match(js, /class="card-kind">\$\{escapeHtml\(note\.category\)\} · \$\{escapeHtml\(note\.kind\)\}/);
  assert.doesNotMatch(js, /class="card-category"/);
  assert.doesNotMatch(js, /FRAME \$\{String\(note\.number\)/);
  assert.match(js, /"信息采集与搜索", "#3569e8"/);
  assert.match(js, /"本地模型与成本", "#007c91"/);
  assert.match(js, /"内容增长与商业", "#d14b31"/);
  assert.match(js, /"知识管理与记忆", "#16803c"/);
  assert.match(css, /border-top:\s*4px solid var\(--accent\)/);
  assert.match(css, /\.card-title::after/);
  assert.match(css, /\.detail-dialog\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.dialog-shell\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.doesNotMatch(html, /priority-filter|data-priority|保存到本机/);
  assert.doesNotMatch(js, /priorityFilter|xhs-kb-saved|toggleSaved|保存到本机|project-status/);
  assert.doesNotMatch(`${html}\n${css}\n${js}`, /themes\/archive|#3158e8|#e2ddff|#28a783/i);
  assert.match(archivedCss, /#3158e8/i);
  assert.match(archiveReadme, /当前网页不会导入或链接本目录/);
  assert.match(js, /escapeHtml/);
  assert.match(readme, /sdk: static/);
  assert.match(readme, /app_file: site\/index\.html/);
  const frontMatter = readme.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontMatter, "README must begin with Hugging Face YAML front matter");
  assert.deepEqual(
    frontMatter[1].split(/\r?\n/).filter((line) => /^header:\s*/.test(line)),
    ["header: mini"]
  );
  assert.match(siteConfig, /huggingFaceHeader:\s*"mini"/);
  assert.match(js, /configureHostLayout/);
  assert.match(js, /hasHuggingFaceMiniHeader/);
  assert.match(js, /dataset\.hfHeader/);
  assert.match(css, /--hf-mini-controls-top:\s*72px/);
  assert.match(css, /html\[data-hf-header="mini"\]\s+\.header-actions/);
  assert.match(css, /top:\s*var\(--hf-mini-controls-top\)/);
  assert.doesNotMatch(css, /--hf-mini-site-header-height|html\[data-hf-header="mini"\]\s+\.site-header\s*\{/);
  assert.doesNotMatch(css, /--hf-mini-header-right-clearance|right:\s*var\(--hf-mini-header-right-clearance\)/);
  assert.doesNotMatch(css, /--hf-mini-header-clearance|margin-top:\s*var\(--hf/);
  assert.match(css, /\.skip-link\s*\{[\s\S]*?top:\s*0;[\s\S]*?transform:\s*translateY\(-100%\)/);
  assert.match(css, /\.skip-link:focus\s*\{[\s\S]*?top:\s*12px/);
  assert.match(publishingGuide, /`header: mini`/);
  assert.match(publishingGuide, /浮动放在 mini header 下方/);
  assert.match(publishingGuide, /不增加 FavSense 头部高度/);
  assert.match(publishingGuide, /Space 根目录 README 前置配置中的 `header` 规范为 `mini`/);
});

test("Hugging Face mini header avoidance only activates for an embedded mini Space", () => {
  assert.equal(hasHuggingFaceMiniHeader({
    framed: true,
    referrer: "https://huggingface.co/",
    creatorUserId: "6a589b8bfe3a3b00f834c4c3",
    configuredHeader: "mini",
  }), true);
  assert.equal(hasHuggingFaceMiniHeader({
    framed: false,
    referrer: "https://huggingface.co/",
    creatorUserId: "6a589b8bfe3a3b00f834c4c3",
    configuredHeader: "mini",
  }), false);
  assert.equal(hasHuggingFaceMiniHeader({
    framed: true,
    referrer: "https://huggingface.co/",
    creatorUserId: "6a589b8bfe3a3b00f834c4c3",
    configuredHeader: "default",
  }), false);
  assert.equal(hasHuggingFaceMiniHeader({
    framed: true,
    referrer: "https://example.com/",
    creatorUserId: "6a589b8bfe3a3b00f834c4c3",
    configuredHeader: "mini",
  }), false);
  assert.equal(hasHuggingFaceMiniHeader({
    framed: true,
    referrer: "https://huggingface.co/",
    creatorUserId: "invalid",
    configuredHeader: "mini",
  }), false);
});

test("Hugging Face controls return to the site header when the host expands", () => {
  const initial = resolveHuggingFaceHeaderLayout({
    capable: true,
    outerHeight: 1187,
    innerHeight: 1100,
    baselineGap: null,
  });
  assert.deepEqual(initial, { mode: "mini", baselineGap: 87 });

  const expanded = resolveHuggingFaceHeaderLayout({
    capable: true,
    outerHeight: 1187,
    innerHeight: 1050,
    baselineGap: initial.baselineGap,
  });
  assert.deepEqual(expanded, { mode: "default", baselineGap: 87 });

  const restored = resolveHuggingFaceHeaderLayout({
    capable: true,
    outerHeight: 1187,
    innerHeight: 1100,
    baselineGap: expanded.baselineGap,
  });
  assert.deepEqual(restored, { mode: "mini", baselineGap: 87 });

  assert.deepEqual(resolveHuggingFaceHeaderLayout({
    capable: false,
    outerHeight: 1187,
    innerHeight: 1050,
    baselineGap: 87,
  }), { mode: "default", baselineGap: null });
});

test("local board manager accepts only a tokenized loopback bridge", () => {
  const valid = validateLocalBridgeConfig({
    baseUrl: "http://127.0.0.1:47631"
  });
  assert.equal(valid.baseUrl, "http://127.0.0.1:47631");
  for (const config of [
    { baseUrl: "https://127.0.0.1:47631" },
    { baseUrl: "http://example.com:47631" },
    { baseUrl: "http://localhost:47631" },
    { baseUrl: "http://127.0.0.1" },
    { baseUrl: "http://127.0.0.1:47631/private" }
  ]) assert.throws(() => validateLocalBridgeConfig(config));
  assert.equal(validateLocalBridgeSession({ ok: true, protocol_version: 5, token: "a".repeat(64) }), "a".repeat(64));
  assert.throws(() => validateLocalBridgeSession({ ok: true, protocol_version: 4, token: "a".repeat(64) }));
});

test("setup removes the legacy daily task and keeps organization user-triggered", async () => {
  const [setup, start, task, readme] = await Promise.all([
    read("skills/xhs-favorites-organizer/scripts/setup-autosync.ps1"),
    read("skills/xhs-favorites-organizer/scripts/start-autosync.ps1"),
    read("skills/xhs-favorites-organizer/scripts/install-windows-task.ps1"),
    read("README.md")
  ]);
  assert.doesNotMatch(setup, /install-windows-task\.ps1/);
  assert.match(setup, /Unregister-ScheduledTask/);
  assert.match(setup, /One browser step remains/);
  assert.match(setup, /No daily or Windows startup task was installed/);
  assert.match(start, /\$expectedProtocolVersion = 5/);
  assert.match(task, /FavSense-Daily/);
  assert.match(task, /Unregister-ScheduledTask/);
  assert.doesNotMatch(task, /Register-ScheduledTask|New-ScheduledTaskTrigger/);
  assert.match(readme, /开始整理/);
});
