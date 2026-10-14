import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TODAY, hex, profile, refusalReply, root, skillResource } from "./public-judgement-fixtures.mjs";

// Spec §3 / §5.2: the builder makes every card from its own text, with no review state in the way, and the
// optional add-on (curation entry or sealed candidate) only supplies topics, tools, category and content kind.

const builder = join(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const reply = (id, summary) => ({
  version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: id, title: "t", summary,
  content_sha256: hex("c"), prompt_version: hex("7"), request_sha256: hex("8"), summary_sha256: sha(summary),
  captured_at: "2026-10-02T00:00:00.000Z",
});
const evidence = (text, method, status) => ({ schema_version: 1, status, method, content_sha256: hex("d"), provider: "local", tool_version: "1", text, result_sha256: sha(text) });

// Runs the builder on a set of notes. `damaged` lists { id, summary } for the saved replies on the frozen list.
// Every call makes its own objects, so no test can leak state into another.
async function run({ notes, curation = {}, candidates = {}, replies = {}, transcripts = {}, pictureText = {}, damaged = [], resources = [], audit = null, extraConfig = {} }, read) {
  const work = await mkdtemp(join(tmpdir(), "favsense-cards-"));
  const at = (name) => join(work, name);
  try {
    await mkdir(at("replies"), { recursive: true });
    await mkdir(at("video"), { recursive: true });
    for (const [id, summary] of Object.entries(replies)) await writeFile(join(at("replies"), `${id}.json`), JSON.stringify(reply(id, summary)));
    for (const [id, text] of Object.entries(transcripts)) {
      await mkdir(join(at("video"), id), { recursive: true });
      await writeFile(join(at("video"), id, "transcription.json"), JSON.stringify(evidence(text, "local_transcription", "transcribed")));
    }
    for (const [id, text] of Object.entries(pictureText)) {
      await mkdir(join(at("video"), id), { recursive: true });
      await writeFile(join(at("video"), id, "visual-ocr.json"), JSON.stringify(evidence(text, "local_image_ocr", "extracted")));
    }
    await writeFile(at("catalog.json"), JSON.stringify({ version: 1, notes }));
    await writeFile(at("curation.json"), JSON.stringify(curation));
    await writeFile(at("candidates.json"), JSON.stringify(candidates));
    await writeFile(at("profile.json"), JSON.stringify(profile));
    await writeFile(at("resources.json"), JSON.stringify({ verified_at: TODAY, resources }));
    await writeFile(at("damaged.json"), JSON.stringify({ entries: damaged.map(({ id, summary }) => ({ note_id: id, summary_sha256: sha(summary), signs: ["ends-on-comma-or-colon"] })) }));
    if (audit) await writeFile(at("audit.json"), JSON.stringify({ version: 2, notes: audit }));
    await writeFile(at("config.json"), JSON.stringify({
      version: 1, domain_profile: at("profile.json"), curation_file: at("curation.json"),
      boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {},
      ...extraConfig,
      // The audit path survives extra quality settings, so a test can combine a real audit with publish_only_accepted.
      ...(audit || extraConfig.curation_quality
        ? { curation_quality: { ...(audit ? { audit_file: at("audit.json") } : {}), ...(extraConfig.curation_quality || {}) } }
        : {}),
    }));
    const result = spawnSync(process.execPath, [
      builder, "--catalog", at("catalog.json"), "--config", at("config.json"), "--curation", at("curation.json"),
      "--candidates", at("candidates.json"), "--profile", at("profile.json"), "--resources", at("resources.json"),
      "--effective-date", TODAY, "--diandian-dir", at("replies"), "--video-analysis", at("video"),
      "--damaged-replies", at("damaged.json"), "--output", at("public.json"),
    ], { cwd: root, encoding: "utf8" });
    return await read(result, at("public.json"), work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const readCards = async (result, outputPath) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const data = JSON.parse(await readFile(outputPath, "utf8"));
  return { meta: data.meta, cards: Object.fromEntries(data.notes.map((card) => [card.id, card])), raw: data };
};
const build = (inputs) => run(inputs, readCards);
const buildResult = (inputs) => run(inputs, async (result, outputPath) => ({
  status: result.status, stderr: result.stderr, written: await readFile(outputPath, "utf8").then(() => true, () => false),
}));

const longFirstLine = "行".repeat(60);
const resource = skillResource();
// One population covering every state a card can be in. Built fresh on every call.
function population() {
  const post = (extra) => ({ author: "作者", published_at: "2026-10-01", source_boards: ["Synthetic"], content_sha256: hex("c"), type: "视频", ...extra });
  return {
    notes: {
      "t-own": post({ title: "我的标题", description: "帖子正文一行。" }),
      "t-first-line": post({ title: "", description: `${longFirstLine}\n第二行` }),
      "t-author": post({ title: "", description: "", author: "金黄说AI" }),
      "r-complete": post({ title: "完整回复", description: "帖子文字一。" }),
      "r-damaged": post({ title: "残缺回复", description: "帖子文字二。" }),
      "r-refusal": post({ title: "拒绝回复", description: "帖子文字三。" }),
      "h-held": post({ title: "原先被扣住", description: "帖子文字四。" }),
      "s-confirmed": post({ title: "确认的技能", description: "帖子文字五。" }),
      "v-video": post({ title: "", description: "#趋势[话题]#" }),
      "v-post-and-transcript": post({ title: "有字有转写", description: "视频帖子的文字。" }),
      "n-reply-and-transcript": post({ title: "回复和转写", description: "帖子文字六。" }),
      "i-image": post({ title: "", description: "#图文[话题]#", type: "图文" }),
      "p-paragraphs": post({ title: "分段", description: "第一段\n\n第二段 #x[话题]#" }),
      "d-only": post({ title: "", description: "#趋势[话题]#" }),
      "e-empty": post({ title: "", description: "#趋势[话题]#" }),
    },
    replies: {
      "r-complete": "完整回复的全文。",
      "r-damaged": "被截断的回复，",
      "r-refusal": refusalReply.trim(),
      "h-held": "原先被扣住的回复全文。",
      "s-confirmed": "确认技能的回复全文。",
      "n-reply-and-transcript": "有回复也有转写的回复全文。",
      "d-only": "这篇讲了两件事，",
    },
    damaged: [{ id: "r-damaged", summary: "被截断的回复，" }, { id: "d-only", summary: "这篇讲了两件事，" }],
    transcripts: { "v-video": "视频里说的话", "v-post-and-transcript": "另附的口播", "n-reply-and-transcript": "被回复盖住的口播" },
    pictureText: { "i-image": "图里的字" },
    resources: [resource],
    curation: {
      "s-confirmed": { category: "Synthetic", themes: ["testing"], tools: [resource.name], kind: "Skill" },
      // An add-on may carry a title and a summary of its own (older review output); neither may reach the card.
      "t-own": { category: "Synthetic", themes: ["标签甲"], tools: [], kind: "Note", title: "审核写的标题", summary: "审核写的总结，不该出现在卡片上。" },
    },
    candidates: {
      "h-held": { kind: "Skill", tools: ["Seedance 导演 Skill"], themes: ["视频"], category: "Synthetic" },
    },
  };
}

const gate = { rejectedAudit: { "r-complete": { status: "rejected", reason: "不足" }, "t-own": { status: "pending" } } };

test("CARD-02: the title is the post's own title; else its first line cut at 52; else the author's collection", async () => {
  const { cards } = await build(population());
  assert.equal(cards["t-own"].title, "我的标题");
  assert.equal(cards["t-first-line"].title, `${"行".repeat(51)}…`);
  assert.equal(cards["t-author"].title, "金黄说AI的收藏");
});

test("CARD-03: a complete saved reply is the main text", async () => {
  const { cards } = await build(population());
  assert.equal(cards["r-complete"].mainSource, "diandian");
  assert.equal(cards["r-complete"].mainText, "完整回复的全文。");
  assert.equal(cards["r-complete"].replyDamaged, false);
});

test("CARD-04: a reply on the frozen list gives way to the post's text; a re-fetched reply is complete again", async () => {
  const inputs = population();
  const { cards } = await build(inputs);
  assert.equal(cards["r-damaged"].mainSource, "post-text");
  assert.equal(cards["r-damaged"].mainText, "帖子文字二。");
  assert.equal(cards["r-damaged"].replyDamaged, true);

  inputs.replies["r-damaged"] = "重新获取的、完整的回复。";
  const refetched = await build(inputs);
  assert.equal(refetched.cards["r-damaged"].mainSource, "diandian");
  assert.equal(refetched.cards["r-damaged"].replyDamaged, false);
});

test("a refusal saved as the reply is not a summary: the post's text shows and the card is not damaged", async () => {
  const { cards } = await build(population());
  assert.equal(cards["r-refusal"].mainSource, "post-text");
  assert.equal(cards["r-refusal"].mainText, "帖子文字三。");
  assert.equal(cards["r-refusal"].replyDamaged, false);
});

test("CARD-05: a formerly held card shows its reply; its Skill tool without a matching resource is neutral and 未核实", async () => {
  const { cards } = await build(population());
  const held = cards["h-held"];
  assert.equal(held.mainSource, "diandian");
  assert.equal(held.mainText, "原先被扣住的回复全文。");
  assert.notEqual(held.kind, "Skill");
  assert.equal(held.kind, profile.classification.default);
  assert.deepEqual(held.tools, ["Seedance 导演 Skill"]);
  assert.deepEqual(held.unverifiedTools, ["Seedance 导演 Skill"]);
  assert.deepEqual(held.resourceIds, []);
});

test("a confirmed Skill keeps its kind, its resource and no 未核实 badge", async () => {
  const { cards } = await build(population());
  const confirmed = cards["s-confirmed"];
  assert.equal(confirmed.kind, "Skill");
  assert.deepEqual(confirmed.unverifiedTools, []);
  assert.deepEqual(confirmed.resources, [resource.name]);
  assert.deepEqual(confirmed.resourceIds, [resource.id]);
  assert.equal(confirmed.mainText, "确认技能的回复全文。");
});

test("CARD-06: a video post with only topic tags shows its transcript as the main text", async () => {
  const { cards } = await build(population());
  assert.equal(cards["v-video"].mainSource, "video-transcript");
  assert.equal(cards["v-video"].mainText, "视频里说的话");
  assert.equal(cards["v-video"].extracted, null);
});

test("CARD-07: a post with text and no reply keeps its text and gets the transcript as its own section; a reply hides it", async () => {
  const { cards } = await build(population());
  assert.equal(cards["v-post-and-transcript"].mainSource, "post-text");
  assert.equal(cards["v-post-and-transcript"].mainText, "视频帖子的文字。");
  assert.deepEqual(cards["v-post-and-transcript"].extracted, { kind: "video-transcript", text: "另附的口播" });
  assert.equal(cards["n-reply-and-transcript"].mainSource, "diandian");
  assert.equal(cards["n-reply-and-transcript"].extracted, null);
});

test("an image post with only topic tags shows its picture text", async () => {
  const { cards } = await build(population());
  assert.equal(cards["i-image"].mainSource, "image-text");
  assert.equal(cards["i-image"].mainText, "图里的字");
});

test("CARD-08: paragraph breaks in the post survive and topic tags are taken out", async () => {
  const { cards } = await build(population());
  assert.equal(cards["p-paragraphs"].mainText, "第一段\n\n第二段");
});

test("CARD-09: the home counts match the cards, and the old counts are gone", async () => {
  const { meta, cards } = await build(population());
  const all = Object.values(cards);
  assert.equal(meta.replyCount, all.filter((card) => card.mainSource === "diandian" && !card.replyDamaged).length);
  assert.equal(meta.transcriptCount, all.filter((card) => card.mainSource === "video-transcript" || card.extracted?.kind === "video-transcript").length);
  // Spelled out for this population: the complete replies are r-complete, h-held, s-confirmed and n-reply-and-transcript;
  // the transcripts shown are v-video and v-post-and-transcript (the one behind a reply is not shown).
  assert.equal(meta.replyCount, 4);
  assert.equal(meta.transcriptCount, 2);
  assert.equal(Object.hasOwn(meta, "verifiedNoteCount"), false);
  assert.equal(Object.hasOwn(meta, "videoMethod"), false);
});

test("D3: an unreachable post is flagged from the audit's unavailable list or the add-on, and the flag changes no text", async () => {
  const base = { notes: { "u-1": { title: "不可访问的帖子", description: "帖子文字。", author: "作者", source_boards: ["Synthetic"], content_sha256: hex("c") } } };
  const fromAudit = await build({ ...base, audit: { "u-1": { status: "unavailable" } } });
  const fromAddOn = await build({ ...base, candidates: { "u-1": { kind: "Note", tools: [], themes: ["x"], category: "Synthetic", review_status: "unavailable" } } });
  const neither = await build(base);
  assert.equal(fromAudit.cards["u-1"].postUnreachable, true);
  assert.equal(fromAddOn.cards["u-1"].postUnreachable, true);
  assert.equal(neither.cards["u-1"].postUnreachable, false);
  for (const variant of [fromAudit, fromAddOn]) {
    for (const key of ["title", "mainText", "mainSource"]) assert.equal(variant.cards["u-1"][key], neither.cards["u-1"][key], key);
  }
  // Only "unavailable" is read from the audit.
  for (const status of ["rejected", "pending", "accepted"]) {
    const other = await build({ ...base, audit: { "u-1": { status } } });
    assert.equal(other.cards["u-1"].postUnreachable, false, status);
  }
  // An audit file that is named but missing builds without error.
  const missing = await build({ ...base, extraConfig: { curation_quality: { audit_file: join(tmpdir(), "favsense-no-such-audit.json") } } });
  assert.equal(missing.cards["u-1"].postUnreachable, false);
});

test("AC-NOGATE: title, main text and source do not depend on review state, a baseline, or a stale quality setting", async () => {
  const withReview = population();
  const first = await build({
    ...withReview, audit: gate.rejectedAudit,
    extraConfig: { curation_quality: { publish_only_accepted: true, baseline_file: join(tmpdir(), "favsense-no-such-baseline.json") } },
  });
  const bare = population();
  const second = await build({ ...bare, curation: {}, candidates: {} });
  const stale = population();
  const third = await build({
    ...stale,
    extraConfig: { curation_quality: { publish_only_accepted: true, audit_file: join(tmpdir(), "favsense-no-such-audit.json") } },
  });
  assert.deepEqual(Object.keys(first.cards), Object.keys(second.cards));
  for (const id of Object.keys(first.cards)) {
    for (const key of ["title", "mainText", "mainSource"]) {
      assert.equal(first.cards[id][key], second.cards[id][key], `${id}.${key} (review state)`);
      assert.equal(third.cards[id][key], second.cards[id][key], `${id}.${key} (stale setting)`);
    }
  }
});

test("AC-ADDON: the add-on may change topics, tools, category and kind, and nothing about the card's text", async () => {
  const withAddOn = await build(population());
  const without = await build({ ...population(), curation: {}, candidates: {} });
  const mayDiffer = new Set(["themes", "tools", "unverifiedTools", "category", "categorySource", "categoryReason", "suggestedCategory", "kind", "resources", "resourceIds"]);
  let differing = 0;
  for (const id of Object.keys(withAddOn.cards)) {
    for (const key of Object.keys(withAddOn.cards[id])) {
      if (mayDiffer.has(key)) continue;
      assert.deepEqual(withAddOn.cards[id][key], without.cards[id][key], `${id}.${key}`);
    }
    if (JSON.stringify(withAddOn.cards[id]) !== JSON.stringify(without.cards[id])) differing += 1;
  }
  assert.ok(differing > 0, "the add-on should have changed at least one card's topics, tools or kind");
  // A title and a summary inside an add-on never reach the card.
  assert.equal(withAddOn.cards["t-own"].title, "我的标题");
  assert.doesNotMatch(JSON.stringify(withAddOn.raw), /审核写的/);
});

test("public safety: a token inside the post's own text stops the build, naming the note and field but not the token", async () => {
  const outcome = await buildResult({
    notes: { "bad-1": { title: "有标题的帖子", description: "链接 xsec_token=abc 在这里", author: "作者", source_boards: ["Synthetic"], content_sha256: hex("c") } },
  });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /Public data safety check failed/);
  assert.match(outcome.stderr, /bad-1/);
  assert.match(outcome.stderr, /mainText/);
  assert.doesNotMatch(outcome.stderr, /abc/);
  assert.equal(outcome.written, false);
});

test("no field of the old gate is left on a card", async () => {
  const { cards } = await build(population());
  const gone = ["summary", "deepSummary", "deepSummarySource", "curationRevision", "summaryStatus", "curationStatus", "summaryReason", "summaryState", "summaryReasonCode", "candidateKind", "reviewedAt", "action", "evidence"];
  for (const card of Object.values(cards)) for (const key of gone) assert.equal(Object.hasOwn(card, key), false, `${card.id}.${key}`);
});

test("the link to the original is still a search link, never a direct post link", async () => {
  const { cards } = await build(population());
  for (const card of Object.values(cards)) {
    assert.match(card.sourceUrl, /^https:\/\/www\.xiaohongshu\.com\/search_result\?/);
    assert.doesNotMatch(card.sourceUrl, /\/explore\/|xsec_token/);
  }
});

test("D10: a cut reply that is the only text is shown as saved, is not a complete reply, and an empty note stays empty", async () => {
  const { cards, meta } = await build(population());
  assert.equal(cards["d-only"].mainSource, "diandian");
  assert.equal(cards["d-only"].replyDamaged, true);
  assert.equal(cards["d-only"].mainText, "这篇讲了两件事，");
  assert.equal(cards["d-only"].extracted, null);
  assert.equal(cards["e-empty"].mainText, "");
  assert.equal(cards["e-empty"].mainSource, "post-text");
  // Not counted among the complete replies (the count in the CARD-09 test already excludes it).
  assert.equal(meta.replyCount, 4);
});
