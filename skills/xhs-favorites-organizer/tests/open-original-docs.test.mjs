import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Issue 112: the workbench's post button is the same link the public site shows. The instructions, the README and
// the workflow reference say so, and no longer describe the retired "打开原帖" that opened a favourites folder in
// the scan browser and scrolled it to find the post.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");

const SAME_BUTTON = "显示同一个来源按钮";
const NO_FOLDER_DIGGING = "不会为了找一篇笔记而打开收藏夹";

const RETIRED = [
  "同一时刻最多占用 1 个小红书页面",
  "再次点击时先关闭上一个",
  "整理进行中拒绝",
  "在现有 SOP 扫描浏览器中打开来源收藏夹",
  "实时签名精确定位原帖",
  "用户脚本从当前页面取得实时签名链接",
];

for (const path of ["skills/xhs-favorites-organizer/SKILL.md", "README.md"]) {
  test(`${path} says the workbench shows the same source button as the public site`, async () => {
    const text = await read(path);
    assert.ok(text.includes(SAME_BUTTON), `${path} does not say: ${SAME_BUTTON}`);
    assert.ok(text.includes(NO_FOLDER_DIGGING), `${path} does not say: ${NO_FOLDER_DIGGING}`);
    for (const phrase of RETIRED) {
      assert.ok(!text.includes(phrase), `${path} still describes the retired folder lookup: ${phrase}`);
    }
  });
}

test("the workflow reference no longer mentions the retired 打开原帖", async () => {
  const text = await read("skills/xhs-favorites-organizer/references/automatic-workflow.md");
  assert.ok(!text.includes("打开原帖"));
});

test("AGENTS.md is untouched by this behaviour: its single-page rule stays the one source", async () => {
  const text = await read("AGENTS.md");
  assert.ok(text.includes("任何时候只保留一个小红书页面"));
  assert.ok(!text.includes("打开原帖"));
});
