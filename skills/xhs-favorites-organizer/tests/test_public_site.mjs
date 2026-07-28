import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resourceGroup, resourceSortsForGroup, sortResources, validateResourceIndex } from "../../../site/resource-utils.mjs";
import { collectVideoEvidenceStats } from "../scripts/evidence-stats.mjs";
import { validateLocalBridgeConfig, validateLocalBridgeSession } from "../../../site/local-bridge-utils.mjs";

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
      [noteId]: { title: "Fixture note", description: "Fixture description", source_boards: ["Fixture"] }
    } })),
    writeFile(curationPath, JSON.stringify({
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
    assert.ok(note.kind === "Note" ? note.summary.length > 0 : note.summary.length > 30);
    assert.ok(note.deepSummary.length >= note.summary.length);
    assert.ok(note.action.length > 20);
    assert.match(note.sourceUrl, /^https:\/\/www\.xiaohongshu\.com\/explore\//);
    assert.equal(Object.hasOwn(note, "priority"), false);
    assert.equal(Object.hasOwn(note, "risk"), false);
    assert.match(note.kind, /^(Note|Tool|Skill|Workflow|Product)$/);
  }

  assert.equal(Object.hasOwn(data.meta, "priorityLabels"), false);
  assert.ok(data.meta.sourceBoards.includes("Skills"));
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

test("resource index groups projects, websites, documentation and tutorials", async () => {
  const profile = JSON.parse(await read("config/domain-profiles/software.json"));
  const index = profile.resource_index;
  assert.equal(resourceGroup({ name: "Palmier Pro", type: "AI 视频编辑" }, index), "开源项目");
  assert.equal(resourceGroup({ name: "Crawl4AI 官网", type: "官方网站" }, index), "官方网站");
  assert.equal(resourceGroup({ name: "Crawl4AI Docs", type: "官方文档" }, index), "官方文档");
  assert.equal(resourceGroup({ name: "Quick Start", type: "教程" }, index), "教程");
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
  assert.deepEqual(resourceSortsForGroup(index, "官方文档").map((sort) => sort.id), ["name-asc", "name-desc"]);
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
    ["software.json", "software", "资源索引", 35, []],
    ["fitness.json", "fitness", "训练资料库", 3, ["目标", "适用", "注意"]],
    ["skincare.json", "skincare", "成分资料库", 3, ["适用", "耐受", "边界"]]
  ];
  for (const [file, id, label, count, fields] of expectations) {
    const data = await buildProfileFixture(file);
    assert.equal(data.meta.profileId, id);
    assert.equal(data.meta.resourceIndex.label, label);
    assert.equal(data.resources.length, count);
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

test("static app has the required deployment assets", async () => {
  const [html, css, js, readme, archivedCss, archiveReadme] = await Promise.all([
    read("site/index.html"),
    read("site/styles.css"),
    read("site/app.js"),
    read("README.md"),
    read("site/themes/archive/research-blue-v1/styles.css"),
    read("site/themes/archive/research-blue-v1/README.md")
  ]);
  assert.match(html, /id="notes-grid"/);
  assert.match(html, /id="resources-grid"/);
  assert.match(html, /id="resource-type-filter"/);
  assert.match(html, /id="resource-sort"/);
  assert.match(html, /id="resource-result-count"/);
  assert.doesNotMatch(html, /owner\/repo|Star、许可证|从官方仓库确认/);
  assert.match(html, />同步设置</);
  assert.doesNotMatch(html, /项目雷达|资源雷达|同步与方法/);
  assert.doesNotMatch(html, /项目、风险与下一步|视频核验后的判断|证据方法|TRY →/);
  assert.match(html, /id="board-manager"/);
  assert.match(html, /id="board-list"/);
  assert.match(html, /id="board-enabled-count"/);
  assert.match(html, /id="creator-space-link"/);
  assert.doesNotMatch(html, /id="hero-dismiss"|id="hero-restore"/);
  assert.match(html, /theme-icon--sun/);
  assert.match(html, /theme-icon--moon/);
  assert.match(html, /FavSense · 拾光台/);
  assert.match(html, /name="keywords"[^>]*Xiaohongshu[^>]*RedNote[^>]*Obsidian/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /--brand-red:\s*#ff2442/);
  assert.match(css, /--cobalt:\s*#5b7cfa/);
  assert.match(js, /categoryAccents = new Map/);
  assert.match(js, /resourceGroup, resourceSortsForGroup, sortResources/);
  assert.match(js, /renderResourceSortOptions/);
  assert.match(html, /统计随每次同步与站点构建自动更新/);
  assert.match(js, /\.\/\.local\/bridge\.json/);
  assert.match(js, /X-XHS-Bridge-Token/);
  assert.match(js, /localBridgeRequest\("\/boards"/);
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
  assert.doesNotMatch(html, /priority-filter|data-priority|保存到本机/);
  assert.doesNotMatch(js, /priorityFilter|xhs-kb-saved|toggleSaved|保存到本机|project-status/);
  assert.doesNotMatch(`${html}\n${css}\n${js}`, /themes\/archive|#3158e8|#e2ddff|#28a783/i);
  assert.match(archivedCss, /#3158e8/i);
  assert.match(archiveReadme, /当前网页不会导入或链接本目录/);
  assert.match(js, /escapeHtml/);
  assert.match(readme, /sdk: static/);
  assert.match(readme, /app_file: site\/index\.html/);
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
  assert.equal(validateLocalBridgeSession({ ok: true, protocol_version: 4, token: "a".repeat(64) }), "a".repeat(64));
  assert.throws(() => validateLocalBridgeSession({ ok: true, protocol_version: 3, token: "a".repeat(64) }));
});

test("setup installs the daily task and leaves only Tampermonkey confirmation", async () => {
  const [setup, task, readme] = await Promise.all([
    read("skills/xhs-favorites-organizer/scripts/setup-autosync.ps1"),
    read("skills/xhs-favorites-organizer/scripts/install-windows-task.ps1"),
    read("README.md")
  ]);
  assert.match(setup, /install-windows-task\.ps1/);
  assert.match(setup, /One browser step remains/);
  assert.doesNotMatch(setup, /Automatic sync is configured/);
  assert.match(task, /FavSense-Daily/);
  assert.doesNotMatch(task, /non-cooking/i);
  assert.match(readme, /Tampermonkey 安装页确认安装后，自动同步才正式启用/);
});
