import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A folder page in a background tab cannot scroll, so the history scan asks the sync service to show it.
// The skill document, the workflow reference and the changelog must all say so, and say what the operator
// sees when the page cannot be brought forward.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");

const ROUTE = "/sync/scan-page-front";
const STOP_SENTENCE = "收藏夹页面一直在浏览器的后台标签页里";

test("the skill document names the route and the stop sentence, in the history mode and in the recovery list", async () => {
  const skill = await read("skills/xhs-favorites-organizer/SKILL.md");
  assert.ok(skill.includes(ROUTE), "the route is named");
  assert.ok(skill.includes(STOP_SENTENCE), "the stop sentence is named");
  assert.ok(skill.includes("至多等 30 秒"), "the wait limit is stated");
  const recovery = skill.slice(skill.indexOf("## 故障恢复"));
  assert.ok(recovery.includes(STOP_SENTENCE), "the recovery list explains what to do when the round stops this way");
});

test("the workflow reference says the history scan needs the page in front", async () => {
  const workflow = await read("skills/xhs-favorites-organizer/references/automatic-workflow.md");
  assert.ok(workflow.includes(ROUTE));
});

test("the changelog records the fix, the version and what was not done", async () => {
  const changelog = await read("CHANGELOG.md");
  assert.ok(changelog.includes(ROUTE));
  assert.ok(changelog.includes("3.3.0"));
  assert.ok(changelog.includes("这次没有做的部分"));
});
