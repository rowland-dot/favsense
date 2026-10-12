import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The paragraph that describes the workbench's "打开原帖" must say how many Xiaohongshu pages it may hold
// and when it closes the one it opened, in the organizer skill's instructions and in the README.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");

const BEHAVIOURS = [
  ["at most one page at a time", "同一时刻最多占用 1 个小红书页面"],
  ["the previous page is closed before the next opens", "再次点击时先关闭上一个"],
  ["a round start closes it before opening the round's page", "一轮整理开始时，在打开本轮页面之前也先关闭它"],
  ["it is refused while a round is running", "整理进行中拒绝"],
];

for (const path of ["skills/xhs-favorites-organizer/SKILL.md", "README.md"]) {
  test(`${path} describes the one-page behaviour of 打开原帖`, async () => {
    const text = await read(path);
    for (const [name, phrase] of BEHAVIOURS) {
      assert.ok(text.includes(phrase), `${path} does not say: ${name} (${phrase})`);
    }
  });
}

test("AGENTS.md is untouched by this behaviour: its single-page rule stays the one source", async () => {
  const text = await read("AGENTS.md");
  assert.ok(text.includes("任何时候只保留一个小红书页面"));
  assert.ok(!text.includes("打开原帖"));
});
