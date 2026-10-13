import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diandianBlocks, stripDiandianOpener } from "../../../site/diandian-text.mjs";

// Issue #99: how a saved DianDian reply is shown. The browser tests (site/e2e/faithful-cards.spec.mjs)
// check what the page looks like; these check the reply handling against every real published reply.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const published = (await readJson("site/data/knowledge.json")).notes
  .filter((note) => note.deepSummarySource === "xiaohongshu-diandian");
const frozen = (await readJson("scripts/fixtures/faithful-cards.json")).notes;
const letters = (text) => [...text.matchAll(/\p{L}/gu)].map((match) => match[0]).join("");

test("the published set holds the DianDian replies this sweep is meant to cover", () => {
  assert.ok(published.length >= 200, `expected the 200+ published DianDian replies, found ${published.length}`);
});

test("only the chat-style opening is left out of a real reply, and never everything", () => {
  for (const note of published) {
    const original = note.deepSummary.trim();
    const { text, removed } = stripDiandianOpener(note.deepSummary);
    assert.ok(text.length > 0, `${note.id}: nothing left to show`);
    assert.ok(original.endsWith(text), `${note.id}: the shown text is not the tail of the stored reply`);
    const dropped = original.slice(0, original.length - text.length);
    if (!removed) {
      assert.equal(dropped, "", `${note.id}: reported nothing removed but text changed`);
      continue;
    }
    assert.match(dropped, /^(?:根据(?:你|获取到)|以下是)/, `${note.id}: dropped text is not an opening line`);
    assert.ok(dropped.length <= 400, `${note.id}: dropped ${dropped.length} characters`);
    assert.ok(dropped.trim().split(/\n\s*\n/).every((block) => !block.includes("\n")), `${note.id}: dropped a multi-line block`);
  }
});

test("opening lines are recognised by what they are, not by position alone", () => {
  assert.equal(stripDiandianOpener("根据你引用的笔记，这是一篇分享。以下是核心内容总结：\n\n核心故事\n\n正文。").text, "核心故事\n\n正文。");
  assert.equal(stripDiandianOpener("以下是核心总结：\n\n项目简介\n\n正文。").text, "项目简介\n\n正文。");
  // Two opening lines in a row both go; a first block that merely begins like one but does not end like one stays.
  assert.equal(stripDiandianOpener("根据你分享的笔记，我来总结：\n\n以下是要点：\n\n正文。").text, "正文。");
  const notAnOpener = "根据你的描述，这个方法没有说明价格（待确认）\n\n正文。";
  assert.equal(stripDiandianOpener(notAnOpener).text, notAnOpener);
  // A reply that is only an opening line is shown as it is rather than as nothing.
  assert.equal(stripDiandianOpener("根据你引用的笔记，这是一篇分享：").text, "根据你引用的笔记，这是一篇分享：");
  assert.equal(stripDiandianOpener("").text, "");
});

test("formatting never changes the words of any real reply", () => {
  for (const note of published) {
    const { text } = stripDiandianOpener(note.deepSummary);
    const shown = diandianBlocks(text).map((block) => block.type === "list" ? block.items.join("") : block.text).join("");
    assert.equal(letters(shown), letters(text), `${note.id}: letters differ after formatting`);
  }
});

test("every real reply formats into well-formed blocks", () => {
  for (const note of published) {
    const blocks = diandianBlocks(stripDiandianOpener(note.deepSummary).text);
    assert.ok(blocks.length > 0, `${note.id}: no blocks`);
    for (const block of blocks) {
      if (block.type === "list") {
        assert.ok(block.items.length >= 2, `${note.id}: a list of fewer than two items`);
        assert.ok(block.items.every((item) => item.trim()), `${note.id}: an empty list item`);
      } else {
        assert.ok(block.text.trim(), `${note.id}: an empty ${block.type}`);
      }
      if (block.type === "heading") assert.ok(block.text.replace(/[​-‍﻿]/g, "").length <= 24, `${note.id}: long heading ${block.text}`);
    }
  }
});

test("the approved example reply comes out with the headings and lists of the approved design", () => {
  const example = frozen.find((note) => note.id === "6a7dc92600000000250090ff");
  const blocks = diandianBlocks(stripDiandianOpener(example.mainText).text);
  const outline = blocks.map((block) => block.type === "list"
    ? `${block.ordered ? "ol" : "ul"}:${block.items.length}`
    : `${block.type === "heading" ? "h" : "p"}:${block.text.replace(/[​-‍﻿]/g, "").slice(0, 12)}`);
  assert.deepEqual(outline, [
    "h:核心故事", "p:作者原本每月做小红书账号", "h:搭建过程拆解", "ul:2", "h:让 AI 敢下判断的 4", "ol:4",
    "p:就这 4 个问题，让 A", "h:商业化逻辑", "p:客户买的不是 Codex", "ol:3", "h:核心观点", "p:AI 最大的机会不一定在", "h:互动引导", "p:作者预告下一篇会拆解这个"
  ]);
  assert.deepEqual(blocks[5].items, ["哪条数据异常了？", "为什么会异常？", "对账号影响有多大？", "下周具体发什么、怎么改？"]);
});

test("existing list and heading markers are honoured and removed from the text", () => {
  const blocks = diandianBlocks("### 要点\n- 第一条内容。\n- 第二条内容。\n\n**注意事项**\n1、先做这个。\n2、再做那个。");
  assert.deepEqual(blocks, [
    { type: "heading", text: "要点" },
    { type: "list", ordered: false, items: ["第一条内容。", "第二条内容。"] },
    { type: "heading", text: "注意事项" },
    { type: "list", ordered: true, items: ["先做这个。", "再做那个。"] }
  ]);
});

test("short bare lines that sit together are list items, not a column of headings", () => {
  const blocks = diandianBlocks("常用工具\n\nClaude Code\nCursor\nWindsurf\n\n以上都可以试试。");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "list", "paragraph"]);
  assert.deepEqual(blocks[1].items, ["Claude Code", "Cursor", "Windsurf"]);
});
