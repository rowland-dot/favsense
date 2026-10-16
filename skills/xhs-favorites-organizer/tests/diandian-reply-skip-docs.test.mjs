import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Issue 130: a DianDian refusal or incomplete reply costs only its own post. The two documents that
// used to say "本批停止" for these cases must now say the post is skipped and the round carries on.

const skill = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = await readFile(resolve(skill, "references/automatic-workflow.md"), "utf8");
const skillDoc = await readFile(resolve(skill, "SKILL.md"), "utf8");

function bullet(text, heading) {
  const line = text.split("\n").find((entry) => entry.includes(heading));
  assert.ok(line, `missing ${heading}`);
  return line;
}

test("the refusal rule says only that post fails and the round goes on", () => {
  const rule = bullet(workflow, "点点拒答识别规则");
  assert.doesNotMatch(rule, /本批停止/);
  assert.match(rule, /继续处理其余笔记和收藏夹/);
  assert.match(rule, /安全限制仍立即停止整轮/);
  assert.match(rule, /diandian_refused/);
});

test("the incomplete-reply rule says the same and names its own count", () => {
  const rule = bullet(workflow, "点点回复缺字识别规则");
  assert.doesNotMatch(rule, /本批停止/);
  assert.match(rule, /本轮继续/);
  assert.match(rule, /diandian_incomplete/);
  assert.match(rule, /summary_incomplete/);
});

test("SKILL.md lists the refusal and incomplete reply next to the share-link exception", () => {
  assert.match(skillDoc, /拒答或回复不完整/);
  assert.match(skillDoc, /本轮继续处理其余笔记与收藏夹/);
});
