import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { contentRevision } from "../scripts/content-revision.mjs";

const organizeScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/organize.mjs");

// Runs the organizer once on fresh notes in a fresh repository; returns the catalog notes and the printed report.
function organizeOnce(t, notes) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "favsense-organize-paragraphs-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(work, ".gitignore"), ".xhs-favorites/\n", "utf8");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: work }).status, 0);
  fs.mkdirSync(path.join(work, ".xhs-favorites"));
  const input = path.join(work, ".xhs-favorites", "input.json");
  fs.writeFileSync(input, JSON.stringify({ notes }), "utf8");
  const catalog = path.join(work, ".xhs-favorites", "catalog.json");
  const run = spawnSync(process.execPath, [organizeScript, "--input", input, "--catalog", catalog, "--date", "2026-10-14"], { cwd: work, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return { notes: JSON.parse(fs.readFileSync(catalog, "utf8")).notes, report: run.stdout };
}

test("the catalog keeps the post's paragraph breaks; spaces are tidied per line and other fields stay on one line", (t) => {
  const { notes, report } = organizeOnce(t, [{ note_id: "n1", title: "标题\n 第二行", description: "第一段  有空格\r\n\r\n\r\n第二段\n第三行" }]);
  assert.equal(notes.n1.description, "第一段 有空格\n\n第二段\n第三行");
  assert.equal(notes.n1.title, "标题 第二行");
  // The private daily report keeps its one-line bullet.
  assert.match(report, /- 原文描述：第一段 有空格 第二段 第三行\n/);
});

test("keeping paragraphs does not change a note's content revision", (t) => {
  const { notes } = organizeOnce(t, [{ note_id: "n1", title: "t", description: "甲\n\n乙" }]);
  assert.equal(notes.n1.content_sha256, contentRevision({ title: "t", description: "甲 乙" }));
});
