import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const skill = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-kb-test-"));
try {
  const catalogPath = path.join(temporary, "catalog.json");
  const configPath = path.join(temporary, "config.json");
  const curationPath = path.join(temporary, "curation.json");
  const output = path.join(temporary, "knowledge-base");
  fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, notes: {
    note_a: { note_id: "note_a", title: "Alpha", author: "A", description: "搜索工具", published_at: "2026-03-01_10:00:00", url: "https://www.xiaohongshu.com/explore/note_a" },
    note_b: { note_id: "note_b", title: "Beta", author: "B", description: "知识图谱", published_at: "2026-01-01_00:00:00", url: "https://www.xiaohongshu.com/explore/note_b" },
    note_old: { note_id: "note_old", title: "Old", author: "C", description: "旧收藏", published_at: "2025-12-31_23:59:59", url: "https://www.xiaohongshu.com/explore/note_old" },
  } }), "utf8");
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, published_since: "2026-01-01", knowledge_base: "knowledge-base", legacy_source_board_id: "skills", boards: [
    { id: "skills", name: "Skills", enabled: true, advertised_count: 2 },
    { id: "cooking", name: "烹饪", enabled: false, reason: "用户明确排除", advertised_count: 1 },
  ] }), "utf8");
  fs.writeFileSync(curationPath, JSON.stringify({
    note_a: { category: "信息采集与搜索", category_override: true, category_reason: "测试显式覆盖", themes: ["搜索"], summary: "搜索摘要", action: "验证搜索", tools: ["SearchTool"] },
    note_b: { category: "知识管理与记忆", category_override: true, category_reason: "测试显式覆盖", themes: ["知识图谱"], summary: "知识摘要", action: "验证知识", tools: [] },
  }), "utf8");

  const run = () => spawnSync("node", [
    path.join(skill, "scripts", "build-knowledge-base.mjs"),
    "--catalog", catalogPath,
    "--config", configPath,
    "--curation", curationPath,
    "--output", output,
  ], { encoding: "utf8", windowsHide: true });

  let result = run();
  assert.equal(result.status, 0, result.stderr);
  const home = fs.readFileSync(path.join(output, "00-首页.md"), "utf8");
  assert.match(home, /已整理：\*\*2\*\*/);
  assert.match(home, /2026-01-01/);
  assert.match(home, /已排除：烹饪/);
  assert.match(home, /domain_profile: "software"/);
  assert.equal(fs.readdirSync(path.join(output, "02-知识卡片")).length, 2);
  assert.equal(fs.existsSync(path.join(output, "02-知识卡片", "note_old.md")), false);
  const noteB = fs.readFileSync(path.join(output, "02-知识卡片", "note_b.md"), "utf8");
  assert.doesNotMatch(noteB, /^(?:priority|status):/m);
  assert.doesNotMatch(noteB, /- \[ \]/);
  assert.match(noteB, /https:\/\/www\.xiaohongshu\.com\/search_result\?keyword=Beta\+B&source=web_search_result_notes/);
  assert.doesNotMatch(noteB, /\/explore\/|\/discovery\/item\//);
  assert.equal(fs.existsSync(path.join(output, "04-行动与实验", "行动清单.md")), false);
  assert.equal(fs.existsSync(path.join(output, "04-行动与实验", "使用建议.md")), true);
  for (const file of fs.readdirSync(path.join(output, "02-知识卡片"))) {
    assert.doesNotMatch(fs.readFileSync(path.join(output, "02-知识卡片", file), "utf8"), /xsec_token/i);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  delete catalog.notes.note_b;
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), "utf8");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(output, "02-知识卡片")), ["note_a.md"]);
  assert.equal(fs.existsSync(path.join(output, "01-主题地图", "知识管理与记忆.md")), false);

  const malicious = JSON.parse(fs.readFileSync(curationPath, "utf8"));
  malicious.note_a.category = "../../README";
  fs.writeFileSync(curationPath, JSON.stringify(malicious), "utf8");
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not safe for a generated filename/);
  assert.equal(fs.existsSync(path.join(temporary, "README.md")), false);
  process.stdout.write("knowledge base tests passed\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
