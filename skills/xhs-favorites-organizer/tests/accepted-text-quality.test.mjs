import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { auditCuration } from "../scripts/validate-curation.mjs";
import { curationRevision } from "../scripts/curation-revision.mjs";

// An accepted entry is shown on a public card exactly as curated. These rules refuse five kinds of
// text that had been accepted and published: a DianDian reply's opening, invisible characters, a
// summary or action with no Chinese at all, Xiaohongshu topic tags, and a summary that is source
// text copied over without being rewritten. The inputs below are the real accepted entries that
// carried each defect (public curation text, issue 86), so each rule is proved on the case that
// was reported, not on an invented one.

const NOTE_ID = "a".repeat(24);
const ZW = String.fromCharCode(0x200b); // zero-width space, as DianDian wrapped its bold text in

const GOOD = {
  title: "装机顺序公开：四个 AI 编程辅助项目的安装顺序",
  summary: "图文视频按安装顺序推荐四个 AI 编程辅助项目：Graphify 把代码库建成知识图谱供按需查询，Ponytail 让 Agent 写更精简的代码，Find Skills 按任务检索并安装合适的 Skill，OmniRoute 在额度耗尽时自动切换模型提供商；“代码量省一半”“每月约 15.1 亿免费 token”属于作者转述的数据。",
  action: "先在一个仓库副本上依次接入 Graphify 和 Ponytail，对比同一任务的 token 与代码量；Find Skills 安装的第三方 Skill 逐个审查来源，OmniRoute 只接入自有密钥并核对各提供商条款。"
};

// Real accepted entries (summary / action as published before the fix).
const DIANDIAN_OPENING_SUMMARY = `根据你引用的笔记，这是一篇关于${ZW}${ZW}AI 聚合网站${ZW}${ZW}的分享推荐，核心内容总结如下： 核心亮点 ${ZW}${ZW}无需会员${ZW}${ZW}：网站免费开放使用，不需要开通会员即可体验各项功能。 ${ZW}${ZW}国内直连${ZW}${ZW}：无需特殊网络环境，国内可直接访问。`;
const INVISIBLE_ONLY_SUMMARY = `${ZW}${ZW}标点符号技巧${ZW}${ZW}：用不同标点改变语气节奏。 比如省略号能制造停顿，带出欲言又止的情绪。 ${ZW}${ZW}细化情绪描述${ZW}${ZW}：别只写"愤怒"，要加上语速、节奏、声音状态的细节描述。`;
const PLACEHOLDER_ACTION_SKIP = "Skip — too brief and entity name missing; no actionable AI technique or specific tool can be identified";
const PLACEHOLDER_ACTION_SAVE = "Save — strategic deep-dive on AI-native business operations covering Agent layers, SOP automation, and skill building";
const ENGLISH_SUMMARY = "A 20k-star GitHub tool for document parsing and format conversion, supporting PPT and PDF inputs with structured output — suitable for building document ingestion pipelines.";
const TOPIC_TAG_SUMMARY = "突然发现朋友的直通车优化口诀好清晰啊 #新手开网店[话题]# #电商运营[话题]# #电商干货[话题]# #淘宝运营[话题]# 新 手 开 网 店 电 商 运 营";
const TOPIC_TAG_SUMMARY_2 = "豆包的灰产让拍摄彻底要被洗牌了#ai[话题]##职场干货[话题]# #个人ip[话题]# a i 职 场 干 货 个 人 i p";
const TRANSCRIPT_SUMMARY = "这简直是AI圈的古神 目前在Gatehub上的数据高达93万克星 它不是一个指挥下单的交易智能体 而是一整套完整的AI交易公司 首先是它的信息分析团队 它会整理新闻 财报 市场数据等公开信息 尝试分析公司的基本面 市场情绪和宏观环境";
const TRANSCRIPT_SUMMARY_2 = "阿里最近新出来的这个悟空啊 它是直接对接的生意产品还有无界的 我们现在一看呢是可以一个人 你靠这一个AI就能够搞定设计 搞定客服 然后呢整个店的运营还有推广 这个很多小卖家还在死磕手动计划";

// Every opening seen across the 292 saved DianDian replies (all but the two refusal shapes, which the
// existing refusal rule already handles). The reply must be recognised by its first words.
const DIANDIAN_OPENINGS = [
  "根据你引用的笔记，这是一篇关于",
  "根据你引用的笔记，这篇内容主要",
  "根据你分享的这篇小红书笔记，",
  "根据你分享的小红书笔记，这是",
  "根据你分享的笔记，这是一篇关于",
  "根据你提供的链接，这篇小红书",
  "根据获取到的笔记信息，",
  "以下是核心总结：\n\n核心亮点"
];

function accepted(overrides, { type = "图文", methods = ["description", "comments", "image_ocr"] } = {}) {
  const entry = {
    category: "主题甲",
    themes: ["主题"],
    tools: [],
    kind: "Note",
    ...GOOD,
    ...overrides
  };
  return {
    entry,
    input: {
      catalog: { notes: { [NOTE_ID]: { note_id: NOTE_ID, title: "具体标题", type, source_boards: ["主题甲"] } } },
      config: { boards: [{ name: "主题甲", category: "主题甲" }] },
      curation: { [NOTE_ID]: entry },
      audit: { notes: { [NOTE_ID]: {
        status: "accepted",
        reviewed_at: "2026-10-13",
        evidence_methods: methods,
        comments_checked: true,
        claims_supported: true,
        resource_status: "not_applicable",
        unresolved_facts: [],
        curation_sha256: curationRevision(entry)
      } } },
      resources: { resources: [] },
      scopeIds: [NOTE_ID]
    }
  };
}

const fatal = (overrides) => auditCuration(accepted(overrides).input).fatal.join("\n");

test("guard: a well-written entry passes untouched", () => {
  assert.deepEqual(auditCuration(accepted({}).input).fatal, []);
});

test("a title, summary or action that starts with a DianDian reply is refused, whichever field it is in", () => {
  assert.match(fatal({ summary: DIANDIAN_OPENING_SUMMARY }), /diandian-reply-opening:summary/);
  for (const opening of DIANDIAN_OPENINGS) {
    for (const field of ["title", "summary", "action"]) {
      const text = `${opening}${GOOD[field]}`;
      assert.match(fatal({ [field]: text }), new RegExp(`diandian-reply-opening:${field}`), `${field} starting "${opening.slice(0, 12)}"`);
    }
  }
  // Leading invisible characters do not hide the opening.
  assert.match(fatal({ summary: `${ZW}${DIANDIAN_OPENINGS[0]}${GOOD.summary}` }), /diandian-reply-opening:summary/);
});

test("the same words in the middle of a sentence are ordinary text, not a reply opening", () => {
  const middle = `${GOOD.summary} 作者写道：根据你引用的笔记整理，这是原帖的口吻。`;
  assert.equal(/diandian-reply-opening/.test(fatal({ summary: middle })), false);
});

test("invisible characters in the title, summary or action are refused", () => {
  assert.match(fatal({ summary: INVISIBLE_ONLY_SUMMARY }), /invisible-character:summary/);
  for (const code of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
    const mark = String.fromCharCode(code);
    for (const field of ["title", "summary", "action"]) {
      const text = `${GOOD[field].slice(0, 6)}${mark}${GOOD[field].slice(6)}`;
      assert.match(fatal({ [field]: text }), new RegExp(`invisible-character:${field}`), `U+${code.toString(16)} in ${field}`);
    }
  }
});

test("a summary or action with no Chinese character is refused, a title in English is not", () => {
  assert.match(fatal({ action: PLACEHOLDER_ACTION_SKIP }), /no-chinese:action/);
  assert.match(fatal({ action: PLACEHOLDER_ACTION_SAVE }), /no-chinese:action/);
  assert.match(fatal({ summary: ENGLISH_SUMMARY }), /no-chinese:summary/);
  assert.equal(/no-chinese/.test(fatal({ title: "Claude Design" })), false);
});

test("a Xiaohongshu topic tag in the title, summary or action is refused, but C# is not a topic", () => {
  assert.match(fatal({ summary: TOPIC_TAG_SUMMARY }), /hashtag:summary/);
  assert.match(fatal({ summary: TOPIC_TAG_SUMMARY_2 }), /hashtag:summary/);
  assert.match(fatal({ title: "豆包的灰产 #职场干货" }), /hashtag:title/);
  assert.match(fatal({ action: `${GOOD.action} #个人ip[话题]#` }), /hashtag:action/);
  assert.equal(/hashtag/.test(fatal({ title: "用 C# 写一个 Agent 的入门笔记" })), false);
  assert.equal(/hashtag/.test(fatal({ summary: `${GOOD.summary} 示例语言包括 C# 与 F#。` })), false);
});

test("a long summary with no Chinese punctuation is source text that was not rewritten", () => {
  assert.match(fatal({ summary: TRANSCRIPT_SUMMARY }), /unrewritten-source-text:summary/);
  assert.match(fatal({ summary: TRANSCRIPT_SUMMARY_2 }), /unrewritten-source-text:summary/);
});

test("guard: real entries that are fine today still pass, including a short summary with no Chinese punctuation", () => {
  const short = "通过Codex连接Photoshop MCP实现AI辅助自动化PS图像处理操作";
  assert.ok(short.length < 60 && !/[，。；：！？、]/.test(short));
  assert.deepEqual(auditCuration(accepted({ summary: short }).input).fatal, []);
  assert.deepEqual(auditCuration(accepted({ title: "Claude Design 实测：一句需求生成网页界面，设计加前端合一" }).input).fatal, []);
  assert.deepEqual(auditCuration(accepted({
    summary: "图文整理淘宝新品运营步骤，涉及上架素材、详情页、关键词、活动和广告复盘；其中关于流量扶持、时间窗口与递增单量的说法可能随平台规则变化，不能作为固定规则。",
    action: "仅采用合规的素材、关键词和广告复盘部分；任何做单、规避搜索或操纵互动的做法一律不执行，并以淘宝当前官方规则复核。"
  }).input).fatal, []);
});

// Issue #99 (owner ruling 2026-10-14): cards no longer show a next-step box, so the standard no longer
// asks every entry for an action. One that is written is still held to the text rules above.
test("an accepted entry with no action passes the standard", () => {
  for (const overrides of [{ action: "" }, { action: undefined }]) {
    const built = accepted(overrides);
    assert.deepEqual(auditCuration(built.input).fatal, [], JSON.stringify(overrides));
  }
});

test("an action that is written is still refused when it is a placeholder", () => {
  assert.match(fatal({ action: "继续关注" }), /action-not-specific/);
  assert.match(fatal({ action: PLACEHOLDER_ACTION_SKIP }), /no-chinese:action/);
});

// Issue #118: the standard refused "待确认" in a summary or action but not in a topic, so two accepted
// entries published it as a topic chip ("实体待确认" and "工具待确认", their real topic lists below).
// The wording the standard asks for when a fact is not established is "未核实".
test("a topic that says 待确认 is refused, on the two real topic lists that carried it", () => {
  assert.match(fatal({ themes: ["AI虚拟朋友", "实体待确认", "项目核验"] }), /placeholder-theme/);
  assert.match(fatal({ themes: ["工具待确认", "账户安全", "跨境广告"] }), /placeholder-theme/);
  // Wherever the word sits in the topic, and whichever position the topic has in the list.
  assert.match(fatal({ themes: ["待确认"] }), /placeholder-theme/);
  assert.match(fatal({ themes: ["账户安全", "跨境广告", "待确认的工具"] }), /placeholder-theme/);
});

test("guard: the same topics without the placeholder, and a topic saying 未核实, pass", () => {
  assert.deepEqual(auditCuration(accepted({ themes: ["AI虚拟朋友", "项目核验"] }).input).fatal, []);
  assert.deepEqual(auditCuration(accepted({ themes: ["账户安全", "跨境广告"] }).input).fatal, []);
  assert.deepEqual(auditCuration(accepted({ themes: ["实体未核实", "项目核验"] }).input).fatal, []);
});

const SKILL_DIR = new URL("../", import.meta.url);
const readSkillFile = (relative) => fs.readFileSync(new URL(relative, SKILL_DIR), "utf8");

test("the curation instructions tell the curator to write 未核实, never 待确认", () => {
  const skill = readSkillFile("SKILL.md");
  assert.equal(skill.includes("待确认"), false, "SKILL.md still tells curators to write 待确认");
  assert.match(skill, /事实不充分时必须写“未核实”/);
  assert.match(skill, /不能唯一确认项目时必须保留“未核实”/);
});

test("the committed curation entries and card topics carry no 待确认 topic", () => {
  const curation = JSON.parse(readSkillFile("references/skills-board-curation.json"));
  const withPlaceholder = Object.values(curation).filter((entry) => (entry.themes || []).some((theme) => theme.includes("待确认")));
  assert.deepEqual(withPlaceholder.map((entry) => entry.id), []);
  const knowledge = JSON.parse(fs.readFileSync(new URL("../../../site/data/knowledge.json", import.meta.url), "utf8"));
  const cards = knowledge.notes.filter((note) => (note.themes || []).some((theme) => theme.includes("待确认")));
  assert.deepEqual(cards.map((note) => note.id), []);
});
