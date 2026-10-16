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

test("postBody drops a run of plain tags at the end of a line, line by line (issue 115)", () => {
  assert.equal(postBody("正文说明。 #开源项目 #自媒体 #开发者"), "正文说明。");
  assert.equal(postBody("第一行 #a工具 #b工具\n第二行 #c工具"), "第一行\n第二行");
  assert.equal(postBody("正文。\n\n#开源项目 #自媒体"), "正文。", "a line made only of plain tags goes entirely");
  assert.equal(postBody("#开源项目 #自媒体"), "", "a post whose only text is plain tags has an empty body, so the extracted text can take over");
});

test("postBody leaves 'C#', a bare '#1' and a tag followed by more words alone (issue 115)", () => {
  assert.equal(postBody("我在学 C#"), "我在学 C#");
  assert.equal(postBody("用 C# 写 #1 的工具 很好用"), "用 C# 写 #1 的工具 很好用");
  assert.equal(postBody("榜单排名 #1"), "榜单排名 #1", "digits alone are a number, not a tag");
  assert.equal(postBody("#开源项目 的项目很多"), "#开源项目 的项目很多", "a tag with words after it is not a trailing run");
  assert.equal(postBody("C# #开源项目"), "C#", "only the tag run goes; the C# before it stays");
  assert.equal(postBody("版本 v2#发布 的变化 很多"), "版本 v2#发布 的变化 很多", "a glued '#' that is not at the end of the line is left alone");
});

// The real description of the post ending 00255e: no title field, and the first tag is glued to the last word.
const GLUED_DESCRIPTION = "YouTube推荐的5个AI博主#Ai#油管推荐博主[话题]# #个人成长[话题]# #知识付费[话题]# #小鹅通[话题]# #好视频扶持计划[话题]#";

test("a tag glued to the last word of the post text goes, so the title taken from it is clean (issue 115 reopened)", () => {
  const body = postBody(GLUED_DESCRIPTION);
  assert.equal(body, "YouTube推荐的5个AI博主");
  assert.equal(cardTitle({ title: undefined, body, author: "甲", noteId: "n" }), "YouTube推荐的5个AI博主");
  assert.equal(postBody("版本 v2#发布"), "版本 v2", "a glued tag at the end of the line goes whatever it is glued to");
  assert.equal(postBody("学C#入门"), "学C#入门", "a lone letter before '#' is a language name");
  assert.equal(postBody("本周第#1名"), "本周第#1名", "a glued '#' followed by a digit is a number");
});

test("a closing label wrapped in zero-width spaces goes with its tags (issue 115 reopened)", () => {
  const zw = "​​";
  assert.equal(replyText(`这是总结。\n\n${zw}标签${zw}：#AI视频`), "这是总结。", "the real reply tail on the live card");
  assert.equal(replyText(`这是总结。\n${zw}笔${zw}记标签：#AI视频 #开源`), "这是总结。", "zero-width spaces anywhere inside the label");
  assert.equal(replyText(`这是总结。\n${zw}\n${zw}标签：#AI视频`), "这是总结。", "a line holding only zero-width spaces counts as blank");
  assert.equal(replyText(`这是总结。\n\n${zw}#AI视频`), "这是总结。", "a closing line left holding only zero-width spaces goes too");
  assert.equal(replyText(`这是总结。${zw}\n`), `这是总结。${zw}\n`, "zero-width spaces with no tags are left exactly as saved");
});

test("postBody drops a closing 标签 label line with its tags too (issue 115 reopened)", () => {
  assert.equal(postBody("正文说明。\n笔记标签：#开源项目 #自媒体"), "正文说明。");
  assert.equal(postBody("标签是一种分类方式。\n标签：#a工具 的说明"), "标签是一种分类方式。\n标签：#a工具 的说明");
});

test("a title taken from the first line of the text never ends in a tag run, even the issue's own example (issue 115)", () => {
  // The post ending 03d0c8: a long first line whose end is plain tags, cut at 52 it ended '#开源项目 #自媒体 #开发者 #一…'.
  const line = `${"项".repeat(30)} #开源项目 #自媒体 #开发者 #一个人公司 #AI工具`;
  assert.match(`${Array.from(line).slice(0, 51).join("")}…`, /#\S+…$/, "control: the old cut really ended in a tag run");
  assert.equal(cardTitle({ title: "", body: postBody(line), author: "甲", noteId: "n" }), "项".repeat(30));
});

test("the 52-character cut itself never leaves a tag run before the ellipsis (issue 115)", () => {
  const body = `${"字".repeat(40)} #开源项目 #自媒体 #开发者 接着还有很长很长的说明文字`;
  const title = cardTitle({ title: "", body, author: "", noteId: "n" });
  assert.equal(title, `${"字".repeat(40)}…`);
});

test("a short first line that still carries a tag run is cleaned too, whatever fed cardTitle (issue 115)", () => {
  assert.equal(cardTitle({ title: "", body: "短标题 #AI工具 #开源项目\n后面", author: "", noteId: "n" }), "短标题");
});

test("the post's own title is untouched except for a closing tag run (issue 115)", () => {
  assert.equal(cardTitle({ title: "  我的 #AI 标题，不裁剪  ", body: "正文", author: "甲", noteId: "n" }), "我的 #AI 标题，不裁剪", "a tag in the middle stays");
});

const ownTitle = (title, body = "正文") => cardTitle({ title, body, author: "甲", noteId: "n" });

test("an own title loses a closing tag run, spaced or glued to its last word (issue 115 reopened)", () => {
  assert.equal(ownTitle("我的标题 #AI工具 #开源项目"), "我的标题");
  assert.equal(ownTitle("YouTube推荐的5个AI博主#Ai"), "YouTube推荐的5个AI博主", "the issue's own glued example");
  assert.equal(ownTitle("推荐博主#Ai#工具 #开源"), "推荐博主", "glued tags and spaced tags in one run");
  assert.equal(ownTitle("标题 标签：#Ai #开源"), "标题", "a label run goes with its label");
});

test("an own title keeps 'C#', digit-only tags and a '#' that is not at the end (issue 115 reopened)", () => {
  assert.equal(ownTitle("我在学 C#"), "我在学 C#");
  assert.equal(ownTitle("C#入门教程"), "C#入门教程");
  assert.equal(ownTitle("学C#入门"), "学C#入门", "a lone letter before '#' is a language name even without a space");
  assert.equal(ownTitle("榜单排名 #1"), "榜单排名 #1");
  assert.equal(ownTitle("本周第#1名"), "本周第#1名", "a glued '#' followed by a digit is a number");
  assert.equal(ownTitle("#开源项目 的项目很多"), "#开源项目 的项目很多");
});

test("an own title made only of tags is no title, so the first line of the text takes over (issue 115 reopened)", () => {
  assert.equal(ownTitle("#开源项目 #自媒体", "正文第一行\n第二行"), "正文第一行");
  assert.equal(ownTitle("#开源项目 #自媒体", ""), "甲的收藏");
});

const replyText = (summary, state = "complete") => cardText({ body: "原帖文字", point: point(summary), state, extracted: null }).mainText;

test("a DianDian reply loses a closing line made of a 标签 label and tags, label included (issue 115 reopened)", () => {
  assert.equal(replyText("这是总结。\n标签：#开源项目 #自媒体"), "这是总结。");
  assert.equal(replyText("这是总结。\n笔记标签：#开源项目 #自媒体"), "这是总结。");
  assert.equal(replyText("这是总结。\n\n标签包括：#开源项目、#自媒体等。"), "这是总结。", "the Chinese list comma and the closing 等。 go with the line");
  assert.equal(replyText("这是总结。\n标签: #开源项目"), "这是总结。", "an ASCII colon and a single tag");
});

test("a DianDian reply loses a bare closing line of tags and tags at the end of its last line (issue 115 reopened)", () => {
  assert.equal(replyText("这是总结。\n\n#开源项目 #自媒体\n"), "这是总结。");
  assert.equal(replyText("这是总结。 #开源项目 #自媒体"), "这是总结。");
  assert.equal(replyText("这是总结。\n标签：#a工具\n#b工具"), "这是总结。", "two closing lines in a row both go");
  assert.equal(replyText("这是总结。 标签：#a工具 #b工具"), "这是总结。", "a label glued to prose on the same line goes with its tags");
});

test("a cut (damaged) reply is cleaned the same way when it is all that is left (issue 115 reopened)", () => {
  assert.equal(cardText({ body: "", point: point("被截断的回复。\n标签：#a工具"), state: "damaged", extracted: null }).mainText, "被截断的回复。");
});

test("a DianDian reply keeps everything that is not a closing tag run (issue 115 reopened)", () => {
  assert.equal(replyText("# 标题\n\n用 C# 写 #1 的工具。\n标签：#a工具 的说明很多"), "# 标题\n\n用 C# 写 #1 的工具。\n标签：#a工具 的说明很多", "a heading, C#, #1 and a label whose tag is followed by words all stay");
  assert.equal(replyText("第一行 #a工具 #b工具\n第二行是正文"), "第一行 #a工具 #b工具\n第二行是正文", "tags on a line that is not the last stay; only the closing lines are cleaned");
  assert.equal(replyText("标签是一种分类方式。"), "标签是一种分类方式。", "the word 标签 with no colon and tags is just prose");
  assert.equal(replyText("总结。\n这个标签是作者自己起的名字不是平台分类 #a工具"), "总结。\n这个标签是作者自己起的名字不是平台分类", "without a colon the word 标签 is prose; only the tag goes");
  assert.equal(replyText("第一行 #a工具\n总结。 #b工具"), "第一行 #a工具\n总结。", "stripping stops after the last line that had text");
  assert.equal(replyText("总结。\n#a工具\n\n#b工具"), "总结。", "a blank line between two closing tag lines does not stop the strip");
  const crlf = "第一行\r\n第二行";
  assert.equal(replyText(crlf), crlf, "a reply with nothing to strip comes back byte for byte");
});

// Issue 115, reopened a third time: the closing line introduced its tags in words the label pattern does not know, so the tags
// went and the lead-in stayed. These are the three saved replies' real tails (U+200B pairs wrap the tags exactly as saved).
const ZW = "​​";
const BODY = "这是总结。";

test("a reply whose closing line is a short lead-in plus tags loses the whole line (issue 115 reopened again)", () => {
  assert.equal(replyText(`${BODY}\n\n笔记标签涉及 ${ZW}#视频下载${ZW}、${ZW}#github开源项目推荐${ZW}、${ZW}#办公技巧${ZW}，整体定位是一个实用型工具推荐。`), BODY, "ending 1: 笔记标签涉及");
  assert.equal(replyText(`${BODY}\n\n笔记作者还附带了话题标签：#GitHub #开源 #AI #程序员 #科技，适合对开源项目和前沿技术感兴趣的读者关注。`), BODY, "ending 2: 笔记作者还附带了话题 + 标签：");
  assert.equal(replyText(`${BODY}\n标签\n\n笔记带上了 ${ZW}#vibecoding${ZW}、${ZW}#openclaw${ZW}、${ZW}#ai设计${ZW}、`), BODY, "ending 3: a bare 标签 heading, then 笔记带上了 and cut-off tags");
  assert.equal(replyText(`${BODY}\n笔记带上了 #a工具 #b工具`), BODY, "plain spaced tags after a lead-in");
  assert.equal(replyText(`${BODY}\n\n（笔记标签：#AI人工智能 #AI工具测评 #skill #插件）`), BODY, "a parenthesis opening the closing line is a lead-in too (the card ending 0231c0 showed a dangling '（')");
});

test("the lead-in rule keeps real sentences: punctuation, length, or a line that is not the closing one (issue 115 reopened again)", () => {
  assert.equal(replyText(`${BODY}\n好用。笔记标签涉及 #a工具 #b工具`), `${BODY}\n好用。笔记标签涉及`, "a lead-in holding a sentence end is text, only the tags go");
  const twelve = "字".repeat(12);
  const thirteen = "字".repeat(13);
  assert.equal(replyText(`${BODY}\n${twelve} #a工具 #b工具`), BODY, "twelve characters is still a lead-in");
  assert.equal(replyText(`${BODY}\n${thirteen} #a工具 #b工具`), `${BODY}\n${thirteen}`, "thirteen characters is a sentence that merely ends before its tags");
  assert.equal(replyText(`${BODY}\n笔记带上了 #a工具 #b工具\n后面还有正文`), `${BODY}\n笔记带上了 #a工具 #b工具\n后面还有正文`, "tags on a line that is not the closing one stay");
});

test("the lead-in rule is for the closing line of a reply only: a short post line before its tags keeps its words (issue 115 reopened again)", () => {
  assert.equal(postBody("今天去了咖啡店 #探店 #咖啡"), "今天去了咖啡店");
  assert.equal(postBody("笔记带上了 #a工具"), "笔记带上了");
});

test("a bare 标签 heading goes only when the tags under it were removed (issue 115 reopened again)", () => {
  assert.equal(replyText(`${BODY}\n笔记标签\n\n#a工具 #b工具`), BODY, "a label-only heading above a tags-only line");
  assert.equal(replyText(`${BODY}\n标签：\n#a工具`), BODY, "a heading with a colon");
  assert.equal(replyText("标签：#a工具"), "", "a reply made only of a label line and tags has nothing left");
  assert.equal(replyText(`${BODY}\n标签`), `${BODY}\n标签`, "with no tags removed the reply is left exactly as saved");
  assert.equal(replyText("第一行 #a工具\n标签"), "第一行 #a工具\n标签", "a heading that closes the reply with no tags under it stays, and the line above it is not touched");
  assert.equal(replyText(`${BODY}\n${"🥝".repeat(7)} #a工具`), BODY, "the lead-in length counts characters, so seven emoji (fourteen code units) are still short");
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
