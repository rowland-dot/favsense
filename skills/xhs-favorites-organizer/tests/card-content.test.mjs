import test from "node:test";
import assert from "node:assert/strict";
import { cardCounts, cardText, cardTitle, postBody, replyState } from "../scripts/card-content.mjs";

const point = (summary = "完整回复", hash = "a".repeat(64)) => ({ summary, summary_sha256: hash });
const video = { kind: "video-transcript", text: "口播文字" };

test("postBody removes topic tags and keeps every paragraph break", () => {
  const body = postBody("第一段 说明。\r\n\r\n\r\n第二段  有   空格。 #AI工具[话题]# #aiagent[话题]# ");
  assert.equal(body, "第一段 说明。\n\n第二段 有 空格。");
});

test("a post with only topic tags has an empty body", () => {
  assert.equal(postBody("#AI工具[话题]# #趋势[话题]#"), "");
  assert.equal(postBody(undefined), "");
});

test("postBody never cuts a long post", () => {
  const long = "字".repeat(5000);
  assert.equal(postBody(long).length, 5000);
});

test("the title is the post's own title, tidied but not cut", () => {
  assert.equal(cardTitle({ title: "  一个人，3天，Codex，10W ", body: "正文", author: "甲", noteId: "n" }), "一个人，3天，Codex，10W");
  const long = "标".repeat(80);
  assert.equal(cardTitle({ title: long, body: "", author: "", noteId: "n" }), long);
});

test("without a title the first line of the post text is the title, cut at 52 characters with an ellipsis", () => {
  const first = "行".repeat(60);
  assert.equal(cardTitle({ title: "", body: `${first}\n第二行`, author: "甲", noteId: "n" }), `${"行".repeat(51)}…`);
  assert.equal(cardTitle({ title: undefined, body: "\n短标题\n后面", author: "", noteId: "n" }), "短标题");
  const emojiAtCut = `${"行".repeat(50)}🥝🥝🥝`;
  assert.equal(cardTitle({ title: "", body: emojiAtCut, author: "", noteId: "n" }), `${"行".repeat(50)}🥝…`, "an emoji at the limit is kept whole");
});

test("without a title or text the title is the author's collection, then the note id tail", () => {
  assert.equal(cardTitle({ title: "", body: "", author: "金黄说AI", noteId: "n" }), "金黄说AI的收藏");
  assert.equal(cardTitle({ title: "", body: "", author: "", noteId: "6a2a81d1000000001702d3de" }), "收藏条目 · 02d3de");
});

test("replyState tells absent, complete and damaged apart by the saved reply's own hash", () => {
  const damaged = new Map([["n1", "a".repeat(64)]]);
  assert.equal(replyState("n1", null, damaged), "absent");
  assert.equal(replyState("n1", point("x", "a".repeat(64)), damaged), "damaged");
  assert.equal(replyState("n1", point("x", "b".repeat(64)), damaged), "complete", "a re-fetched reply replaces the damaged one");
  assert.equal(replyState("n2", point(), damaged), "complete");
});

test("complete reply: the reply is the main text and nothing else is added", () => {
  const out = cardText({ body: "原帖文字", point: point("回复全文"), state: "complete", extracted: video });
  assert.deepEqual(out, { mainText: "回复全文", mainSource: "diandian", extractedSection: null });
});

test("damaged reply with post text: post text is the main text, no extra section", () => {
  const out = cardText({ body: "原帖文字", point: point(), state: "damaged", extracted: video });
  assert.deepEqual(out, { mainText: "原帖文字", mainSource: "post-text", extractedSection: null });
});

test("no reply with post text: post text first, extracted text as its own section (CARD-07)", () => {
  const out = cardText({ body: "原帖文字", point: null, state: "absent", extracted: video });
  assert.deepEqual(out, { mainText: "原帖文字", mainSource: "post-text", extractedSection: video });
});

test("no reply and a post with only tags: the extracted text is the main text (CARD-06)", () => {
  assert.deepEqual(cardText({ body: "", point: null, state: "absent", extracted: video }), { mainText: "口播文字", mainSource: "video-transcript", extractedSection: null });
  const picture = { kind: "image-text", text: "图里的字" };
  assert.equal(cardText({ body: "", point: null, state: "absent", extracted: picture }).mainSource, "image-text");
});

test("a damaged reply with an empty post still falls back to extracted text", () => {
  assert.equal(cardText({ body: "", point: point(), state: "damaged", extracted: video }).mainSource, "video-transcript");
});

test("a damaged reply, a post with only tags and no extracted text: the saved reply is shown rather than nothing (D10)", () => {
  assert.deepEqual(
    cardText({ body: "", point: point("被截断的回复，"), state: "damaged", extracted: null }),
    { mainText: "被截断的回复，", mainSource: "diandian", extractedSection: null },
  );
});

test("nothing at all (no post text, no extracted text, no saved reply) gives an empty main text", () => {
  assert.deepEqual(cardText({ body: "", point: null, state: "absent", extracted: null }), { mainText: "", mainSource: "post-text", extractedSection: null });
});

test("cardCounts counts complete replies and transcripts shown, never a cut reply or a transcript hidden behind a reply", () => {
  const cards = [
    { mainSource: "diandian", replyDamaged: false, extracted: null },
    { mainSource: "diandian", replyDamaged: false, extracted: null },
    { mainSource: "diandian", replyDamaged: true, extracted: null },
    { mainSource: "video-transcript", replyDamaged: false, extracted: null },
    { mainSource: "post-text", replyDamaged: false, extracted: video },
    { mainSource: "post-text", replyDamaged: false, extracted: { kind: "image-text", text: "x" } },
    { mainSource: "post-text", replyDamaged: false, extracted: null },
  ];
  assert.deepEqual(cardCounts(cards), { replyCount: 2, transcriptCount: 2 });
});
