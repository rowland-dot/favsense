import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { requirePrivateOutput } from "../scripts/build-knowledge-base.mjs";

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-kb-test-"));
try {
  const catalogPath = path.join(temporary, "catalog.json");
  const configPath = path.join(temporary, "config.json");
  const curationPath = path.join(temporary, "curation.json");
  const diandianPath = path.join(temporary, "diandian-summaries");
  fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, notes: {
    note_a: { note_id: "note_a", title: "Alpha", author: "A", description: "搜索工具", published_at: "2026-03-01_10:00:00", url: "https://www.xiaohongshu.com/explore/note_a" },
    note_b: { note_id: "note_b", title: "Beta", author: "B", description: "知识图谱", published_at: "2026-01-01_00:00:00", url: "https://www.xiaohongshu.com/explore/note_b" },
    note_old: { note_id: "note_old", title: "Old", author: "C", description: "旧收藏", published_at: "2025-12-31_23:59:59", source_board_ids: ["skills"], url: "https://www.xiaohongshu.com/explore/note_old" },
    note_other_old: { note_id: "note_other_old", title: "Other old", author: "D", description: "其他收藏夹旧内容", published_at: "2025-12-31_23:59:59", source_board_ids: ["other"], url: "https://www.xiaohongshu.com/explore/note_other_old" },
  } }), "utf8");
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, published_since: "2026-01-01", knowledge_base: "knowledge-base", legacy_source_board_id: "skills", boards: [
    { id: "skills", name: "Skills", enabled: true, advertised_count: 2 },
    { id: "other", name: "其他收藏", enabled: true, advertised_count: 1 },
    { id: "cooking", name: "烹饪", enabled: false, reason: "用户明确排除", advertised_count: 1 },
  ] }), "utf8");
  fs.writeFileSync(curationPath, JSON.stringify({
    note_a: { category: "信息采集与搜索", category_override: true, category_reason: "测试显式覆盖", themes: ["搜索"], summary: "搜索摘要", action: "验证搜索", tools: ["SearchTool"] },
    note_b: { category: "知识管理与记忆", category_override: true, category_reason: "测试显式覆盖", themes: ["知识图谱"], summary: "知识摘要", action: "验证知识", tools: [] },
  }), "utf8");
  fs.mkdirSync(diandianPath);
  fs.writeFileSync(path.join(diandianPath, "note_b.json"), JSON.stringify({
    version: 1,
    provider: "xiaohongshu-diandian",
    prompt: "总结",
    note_id: "note_b",
    title: "Beta",
    summary: "点点 AI 已完整读取这篇笔记，并生成这段深度总结。",
  }), "utf8");
  // The builder only writes into a directory that does not exist yet, so each
  // build goes to a fresh path (the refusal cases live in knowledge-base-new-output-only.test.mjs).
  let output;
  let buildCount = 0;
  const run = () => {
    buildCount += 1;
    output = path.join(temporary, `knowledge-base-${buildCount}`);
    return spawnSync("node", [
      path.join(skill, "scripts", "build-knowledge-base.mjs"),
      "--catalog", catalogPath,
      "--config", configPath,
      "--curation", curationPath,
      "--diandian-dir", diandianPath,
      "--output", output,
    ], { encoding: "utf8", windowsHide: true });
  };
  let result;

  const qualityConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const baselinePath = path.join(temporary, "curation-baseline.json");
  const auditPath = path.join(temporary, "curation-audit.json");
  qualityConfig.curation_quality = {
    publish_only_accepted: true,
    audit_file: auditPath,
    baseline_file: baselinePath,
  };
  fs.writeFileSync(configPath, JSON.stringify(qualityConfig), "utf8");
  const currentCuration = JSON.parse(fs.readFileSync(curationPath, "utf8"));
  fs.writeFileSync(baselinePath, JSON.stringify({
    version: 1,
    note_ids: ["note_a", "note_b"],
    curation_hashes: {
      note_a: curationRevision(currentCuration.note_a),
      note_b: curationRevision(currentCuration.note_b),
    },
  }), "utf8");
  fs.writeFileSync(auditPath, JSON.stringify({ version: 1, notes: {} }), "utf8");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  const baselineNoteA = fs.readFileSync(path.join(output, fs.readdirSync(output).find((name) => name.startsWith("02-")), "note_a.md"), "utf8");
  assert.match(baselineNoteA, /SearchTool/);

  fs.writeFileSync(path.join(diandianPath, "note_a.json"), JSON.stringify({
    version: 1,
    provider: "xiaohongshu-diandian",
    prompt: "总结",
    note_id: "note_b",
    title: "Alpha",
    summary: "这份摘要的稳定笔记 ID 不匹配，不应进入 Alpha 卡片。",
    xsec_token: "credential-shaped-value",
  }), "utf8");

  result = run();
  assert.equal(result.status, 0, result.stderr);
  const home = fs.readFileSync(path.join(output, "00-首页.md"), "utf8");
  assert.match(home, /已整理：\*\*4\*\*/);
  assert.match(home, /深度处理范围：\*\*2026-01-01 起发布\*\*/);
  assert.match(home, /已排除：烹饪/);
  assert.match(home, /domain_profile: "software"/);
  assert.equal(fs.readdirSync(path.join(output, "02-知识卡片")).length, 4);
  assert.equal(fs.existsSync(path.join(output, "02-知识卡片", "note_old.md")), true);
  assert.equal(fs.existsSync(path.join(output, "02-知识卡片", "note_other_old.md")), true);
  const noteB = fs.readFileSync(path.join(output, "02-知识卡片", "note_b.md"), "utf8");
  assert.doesNotMatch(noteB, /^(?:priority|status):/m);
  assert.doesNotMatch(noteB, /- \[ \]/);
  assert.match(noteB, /https:\/\/www\.xiaohongshu\.com\/search_result\?keyword=Beta\+B&source=web_search_result_notes/);
  assert.doesNotMatch(noteB, /\/explore\/|\/discovery\/item\//);
  assert.doesNotMatch(noteB, /## 点点 AI 深度总结|点点 AI 已完整读取这篇笔记/);
  const noteA = fs.readFileSync(path.join(output, "02-知识卡片", "note_a.md"), "utf8");
  assert.doesNotMatch(noteA, /## 点点 AI 深度总结|稳定笔记 ID 不匹配|credential-shaped-value/);
  assert.equal(fs.existsSync(path.join(output, "04-行动与实验", "行动清单.md")), false);
  assert.equal(fs.existsSync(path.join(output, "04-行动与实验", "使用建议.md")), true);
  for (const file of fs.readdirSync(path.join(output, "02-知识卡片"))) {
    assert.doesNotMatch(fs.readFileSync(path.join(output, "02-知识卡片", file), "utf8"), /xsec_token/i);
  }

  fs.writeFileSync(path.join(diandianPath, "note_a.json"), JSON.stringify({
    version: 1,
    provider: "xiaohongshu-diandian",
    prompt: "总结",
    note_id: "note_a",
    title: "Alpha",
    summary: "Encoded %78%73%65%63%5f%74%6f%6b%65%6e%3dsecret must stay out of Markdown.",
  }), "utf8");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  const generatedCardsDir = fs.readdirSync(output).find((name) => name.startsWith("02-"));
  assert.ok(generatedCardsDir);
  const encodedNoteA = fs.readFileSync(path.join(output, generatedCardsDir, "note_a.md"), "utf8");
  assert.doesNotMatch(encodedNoteA, /Encoded|xsec_token/);

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  delete catalog.notes.note_b;
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), "utf8");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs.readdirSync(path.join(output, "02-知识卡片")).sort(),
    ["note_a.md", "note_old.md", "note_other_old.md"]
  );
  assert.equal(fs.existsSync(path.join(output, "01-主题地图", "知识管理与记忆.md")), false);

  // The privacy boundary stays: an output path behind a redirected ancestor is refused.
  const privacyRepo = path.join(temporary, "privacy-repo");
  fs.mkdirSync(privacyRepo);
  fs.writeFileSync(path.join(privacyRepo, ".gitignore"), ".xhs-tools/\nknowledge-base/\n.private/\n", "utf8");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: privacyRepo }).status, 0);
  const redirectedTarget = path.join(privacyRepo, "public-target");
  const redirectedPrivate = path.join(privacyRepo, ".private");
  fs.mkdirSync(redirectedTarget);
  fs.symlinkSync(redirectedTarget, redirectedPrivate, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => requirePrivateOutput(path.join(redirectedPrivate, "leak")),
    /redirected|invalid ancestor/i,
  );
  assert.equal(fs.existsSync(path.join(redirectedTarget, "leak")), false);

  const malicious = JSON.parse(fs.readFileSync(curationPath, "utf8"));
  malicious.note_a.category = "../../README";
  fs.writeFileSync(curationPath, JSON.stringify(malicious), "utf8");
  const maliciousBaseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  maliciousBaseline.curation_hashes.note_a = curationRevision(malicious.note_a);
  fs.writeFileSync(baselinePath, JSON.stringify(maliciousBaseline), "utf8");
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not safe for a generated filename/);
  assert.equal(fs.existsSync(path.join(temporary, "README.md")), false);
  assert.equal(fs.existsSync(output), false);
  process.stdout.write("knowledge base tests passed\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
