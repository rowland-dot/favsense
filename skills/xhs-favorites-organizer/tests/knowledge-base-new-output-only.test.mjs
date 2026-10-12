import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as builderModule from "../scripts/build-knowledge-base.mjs";
import { curationRevision } from "../scripts/curation-revision.mjs";

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const refusal = /只能写到新目录；正式知识库只由快照步骤写入/;

function fixture(root) {
  const catalog = path.join(root, "catalog.json");
  const config = path.join(root, "config.json");
  const curation = path.join(root, "curation.json");
  const baseline = path.join(root, "baseline.json");
  const audit = path.join(root, "audit.json");
  const diandian = path.join(root, "diandian");
  const note = { category: "信息采集与搜索", category_override: true, category_reason: "测试显式覆盖", themes: ["搜索"], summary: "搜索摘要", action: "验证搜索", tools: ["SearchTool"] };
  fs.mkdirSync(diandian);
  fs.writeFileSync(catalog, JSON.stringify({ version: 1, notes: {
    note_a: { note_id: "note_a", title: "Alpha", author: "A", description: "搜索工具", published_at: "2026-03-01_10:00:00", url: "https://www.xiaohongshu.com/explore/note_a" },
  } }));
  fs.writeFileSync(config, JSON.stringify({ version: 1, published_since: "2026-01-01", boards: [{ id: "skills", name: "Skills", enabled: true, advertised_count: 1 }], curation_quality: { publish_only_accepted: true, audit_file: audit, baseline_file: baseline } }));
  fs.writeFileSync(curation, JSON.stringify({ note_a: note }));
  fs.writeFileSync(baseline, JSON.stringify({ version: 1, note_ids: ["note_a"], curation_hashes: { note_a: curationRevision(note) } }));
  fs.writeFileSync(audit, JSON.stringify({ version: 1, notes: {} }));
  return (target) => spawnSync(process.execPath, [
    path.join(skill, "scripts", "build-knowledge-base.mjs"),
    "--catalog", catalog, "--config", config, "--curation", curation, "--diandian-dir", diandian, "--output", target,
  ], { encoding: "utf8", windowsHide: true });
}

function withTemporary(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-kb-new-output-"));
  try { body(root, fixture(root)); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("a path that does not exist yet is built", () => withTemporary((root, build) => {
  const target = path.join(root, "fresh");
  const result = build(target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(target, "00-首页.md")), true);
  assert.equal(fs.existsSync(path.join(target, "02-知识卡片", "note_a.md")), true);
}));

test("an existing empty directory is refused and stays empty", () => withTemporary((root, build) => {
  const target = path.join(root, "empty");
  fs.mkdirSync(target);
  const result = build(target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, refusal);
  assert.deepEqual(fs.readdirSync(target), []);
}));

test("an existing directory with files is refused and its files stay byte for byte", () => withTemporary((root, build) => {
  const target = path.join(root, "filled");
  const manualBytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x41]);
  fs.mkdirSync(path.join(target, "02-知识卡片"), { recursive: true });
  fs.writeFileSync(path.join(target, "我的人工笔记.md"), manualBytes);
  fs.writeFileSync(path.join(target, "02-知识卡片", "note_a.md"), "hand edited card");
  const result = build(target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, refusal);
  assert.deepEqual(fs.readFileSync(path.join(target, "我的人工笔记.md")), manualBytes);
  assert.equal(fs.readFileSync(path.join(target, "02-知识卡片", "note_a.md"), "utf8"), "hand edited card");
  assert.deepEqual(fs.readdirSync(target).sort(), ["02-知识卡片", "我的人工笔记.md"]);
  assert.deepEqual(fs.readdirSync(path.join(target, "02-知识卡片")), ["note_a.md"]);
}));

test("inside a Git worktree a new path that is not ignored is still refused by the privacy check", () => withTemporary((root, build) => {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".xhs-tools/\n");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
  const visible = path.join(repo, "visible-knowledge-base");
  let result = build(visible);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not ignored by Git/);
  assert.equal(fs.existsSync(visible), false);
  const ignored = path.join(repo, ".xhs-tools", "staging", "knowledge-base");
  fs.mkdirSync(path.dirname(ignored), { recursive: true });
  result = build(ignored);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(ignored, "00-首页.md")), true);
  assert.deepEqual(fs.readdirSync(path.join(repo, ".xhs-tools")), ["staging"], "no transaction storage is created");
  assert.deepEqual(fs.readdirSync(path.dirname(ignored)), ["knowledge-base"]);
}));

test("the second safe-save mechanism is gone from the builder exports", () => {
  assert.deepEqual(Object.keys(builderModule).sort(), ["requirePrivateOutput"]);
});
