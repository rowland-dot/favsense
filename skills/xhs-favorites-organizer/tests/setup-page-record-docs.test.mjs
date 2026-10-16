import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Issue 137: the Xiaohongshu page setup opens in the scan browser is a FavSense page. Setup records its tab
// id in a private file and the next round closes it by that id. The skill document's description of the
// round-start cleanup, and the changelog, must say so and keep the old rule for every unrecorded page.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("SKILL.md's round-start cleanup names the page setup opens, recognised by its recorded tab id", async () => {
  const skill = await read("skills/xhs-favorites-organizer/SKILL.md");
  const line = skill.split("\n").find((entry) => entry.includes("先关闭以前各轮遗留的 FavSense 页面"));
  assert.ok(line, "missing the round-start cleanup sentence");
  assert.match(line, /setup-autosync\.ps1/);
  assert.match(line, /`\.xhs-favorites\/setup-pages\.json`/);
  assert.match(line, /标签页 ID/);
  assert.match(line, /只存标签页 ID/);
  assert.match(line, /没有记录的页面[^。]*SOP 启动脚本[^。]*不关闭也不跳转/);
});

test("the changelog records the fix, the private record and the live check still owed", async () => {
  const changelog = await read("CHANGELOG.md");
  const entry = changelog.split("\n").find((line) => line.includes("#137"));
  assert.ok(entry, "missing the #137 entry");
  assert.ok(entry.includes("setup-pages.json"));
  assert.ok(entry.includes("SOP 启动脚本"));
  assert.ok(entry.includes("还没有现场验证"));
});
