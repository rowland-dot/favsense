import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TODAY, hex, profile, root } from "./public-judgement-fixtures.mjs";
import { assertPublicTextSafe } from "../scripts/public-tree-policy.mjs";

// Spec §8 (never publish a token, a profile or folder id) once the whole post text and the transcripts are public.
// Before this feature a card carried a 240-character excerpt; now every word of the post, every transcript and every
// picture text goes into data/knowledge.json, so each of those places must be checked by the builder, and the builder
// must refuse everything the publisher will refuse (otherwise the build says yes and the one publish of the run fails).

const builder = join(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const PROFILE_ID = "5f1234567890abcdef123456";
const BOARD_ID = "board-private-9876";

// One note, optionally with a transcript, picture text, or saved DianDian reply; returns what the builder did.
async function buildOne({ note = {}, transcript = "", pictureText = "", reply = "", tools = [] }) {
  const work = await mkdtemp(join(tmpdir(), "favsense-safety-"));
  const at = (name) => join(work, name);
  try {
    await mkdir(at("replies"), { recursive: true });
    await mkdir(join(at("video"), "n1"), { recursive: true });
    const evidence = (text, method, status) => ({ schema_version: 1, status, method, content_sha256: hex("d"), provider: "local", tool_version: "1", text, result_sha256: sha(text) });
    if (transcript) await writeFile(join(at("video"), "n1", "transcription.json"), JSON.stringify(evidence(transcript, "local_transcription", "transcribed")));
    if (pictureText) await writeFile(join(at("video"), "n1", "visual-ocr.json"), JSON.stringify(evidence(pictureText, "local_image_ocr", "extracted")));
    if (reply) {
      await writeFile(join(at("replies"), "n1.json"), JSON.stringify({
        version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: "n1", title: "t", summary: reply,
        content_sha256: hex("c"), prompt_version: hex("7"), request_sha256: hex("8"), summary_sha256: sha(reply), captured_at: "2026-10-02T00:00:00.000Z",
      }));
    }
    await writeFile(at("catalog.json"), JSON.stringify({ version: 1, notes: { n1: { title: "有标题", description: "", author: "作者", source_boards: ["Synthetic"], content_sha256: hex("c"), type: "视频", ...note } } }));
    await writeFile(at("curation.json"), JSON.stringify(tools.length ? { n1: { category: "Synthetic", themes: ["主题"], tools, kind: "Note" } } : {}));
    await writeFile(at("candidates.json"), "{}");
    await writeFile(at("profile.json"), JSON.stringify(profile));
    await writeFile(at("resources.json"), JSON.stringify({ verified_at: TODAY, resources: [] }));
    await writeFile(at("damaged.json"), JSON.stringify({ entries: [] }));
    await writeFile(at("config.json"), JSON.stringify({
      version: 1, domain_profile: at("profile.json"), curation_file: at("curation.json"),
      boards: [{ id: BOARD_ID, name: "Synthetic", enabled: true }], public_stats: {},
      profile_url: `https://www.xiaohongshu.com/user/profile/${PROFILE_ID}`,
    }));
    const result = spawnSync(process.execPath, [
      builder, "--catalog", at("catalog.json"), "--config", at("config.json"), "--curation", at("curation.json"),
      "--candidates", at("candidates.json"), "--profile", at("profile.json"), "--resources", at("resources.json"),
      "--effective-date", TODAY, "--diandian-dir", at("replies"), "--video-analysis", at("video"),
      "--damaged-replies", at("damaged.json"), "--output", at("public.json"),
    ], { cwd: root, encoding: "utf8" });
    const written = await readFile(at("public.json"), "utf8").catch(() => null);
    return { status: result.status, stderr: result.stderr, written };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function assertRefused(outcome, field, secret) {
  assert.notEqual(outcome.status, 0, "the build must stop");
  assert.match(outcome.stderr, /Public data safety check failed/);
  assert.match(outcome.stderr, /n1/, "names the note");
  if (field) assert.match(outcome.stderr, field, "names the field");
  if (secret) assert.equal(outcome.stderr.includes(secret), false, "never repeats what it found");
  assert.equal(outcome.written, null, "writes nothing");
}

test("a token in a transcript or in picture text stops the build and names where it was", async () => {
  // With post text of its own the transcript is a section of its own (field extracted.text); with only topic tags it is the main text.
  assertRefused(await buildOne({ note: { description: "有正文的帖子" }, transcript: "口播里读出 xsec_token=zzz999 这串" }), /extracted\.text/, "zzz999");
  assertRefused(await buildOne({ note: { description: "#趋势[话题]#" }, transcript: "口播里读出 xsec_token=zzz999 这串" }), /mainText/, "zzz999");
  assertRefused(await buildOne({ note: { description: "#图文[话题]#", type: "图文" }, pictureText: "图上有 xsec_token=zzz999" }), /mainText/, "zzz999");
});

test("a saved reply that carries a token is not used at all: the post's own text shows and the token is nowhere in the data", async () => {
  const outcome = await buildOne({ note: { description: "帖子自己的文字" }, reply: "总结里带着 xsec_token=zzz999 这个" });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(outcome.written.includes("zzz999"), false);
  const card = JSON.parse(outcome.written).notes[0];
  assert.equal(card.mainSource, "post-text");
  assert.equal(card.mainText, "帖子自己的文字");
});

test("a profile page address in the post text or a transcript stops the build", async () => {
  assertRefused(await buildOne({ note: { description: "我的主页 https://www.xiaohongshu.com/user/profile/abc123 欢迎来" } }), /mainText/);
  assertRefused(await buildOne({ note: { description: "有正文的帖子" }, transcript: "去看 https://www.xiaohongshu.com/user/profile/abc123" }), /extracted\.text/);
});

test("the owner's own profile id or folder id in any public text stops the build and is never repeated", async () => {
  assertRefused(await buildOne({ note: { description: `私人记号 ${BOARD_ID} 混进来了` } }), null, BOARD_ID);
  assertRefused(await buildOne({ note: { description: "" }, transcript: `读出 ${PROFILE_ID} 这串` }), null, PROFILE_ID);
  assertRefused(await buildOne({ note: { description: "正文" }, tools: [BOARD_ID] }), null, BOARD_ID);
});

// What the publisher refuses in data/knowledge.json (public-tree-policy.mjs) is also what the builder must refuse:
// a card text such as these used to be cut out of the 240-character excerpt, and now travels whole.
for (const [name, text] of [
  ["a password written as password: value", "登录 password: hunter2hunter2 就行"],
  ["a bearer credential", "请求头 Authorization: Bearer abcdefghijkl1234"],
  ["a secret written as secret = value", "配置 secret = abcdefghij12 记得改"],
  ["a cookie value", "复制 cookie: abcdefgh12345678 到请求里"],
  ["a link to a collection folder page", "收藏夹在 https://www.xiaohongshu.com/board/6a7dc92600000000250090ff 这里"],
]) {
  test(`the builder never writes data the publisher would refuse: ${name}`, async () => {
    const outcome = await buildOne({ note: { description: text } });
    if (outcome.written !== null) {
      assert.doesNotThrow(() => assertPublicTextSafe(outcome.written, "data/knowledge.json"), "built data the publisher refuses");
    } else {
      assert.notEqual(outcome.status, 0);
      assert.match(outcome.stderr, /Public data safety check failed/);
      assert.match(outcome.stderr, /n1/);
    }
  });
}

// Spec LINK-02 / AC-LINK: the post button now points at the post itself, so the public-file check lets a
// token-free post address through and still refuses everything that identifies the owner or opens a session.
const POST_ID = "6a7dc92600000000250090ff";
const publicJson = (url) => JSON.stringify({ notes: [{ sourceUrl: url }] });

for (const [name, url] of [
  ["a post address under /explore/", `https://www.xiaohongshu.com/explore/${POST_ID}`],
  ["a post address under /discovery/item/", `https://www.xiaohongshu.com/discovery/item/${POST_ID}`],
]) {
  test(`the public-file check allows ${name}`, () => {
    assert.doesNotThrow(() => assertPublicTextSafe(publicJson(url), "data/knowledge.json"));
  });
}

for (const [name, url] of [
  ["a session token on a post address", `https://www.xiaohongshu.com/explore/${POST_ID}?xsec_token=zzz999&xsec_source=pc_share`],
  ["a profile page address", "https://www.xiaohongshu.com/user/profile/abc123def456"],
  ["a collection folder address", "https://www.xiaohongshu.com/board/abc123def456"],
  ["a bare profile path", "/user/profile/abc123def456"],
  ["a bare folder path", "/board/abc123def456"],
]) {
  test(`the public-file check still refuses ${name}`, () => {
    assert.throws(() => assertPublicTextSafe(publicJson(url), "data/knowledge.json"), /sensitive public content is not allowed/);
  });
}
