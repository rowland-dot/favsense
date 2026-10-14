import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { damageSigns, loadDamagedReplies } from "../scripts/damaged-replies.mjs";
import { diandianReplyCases } from "./public-judgement-fixtures.mjs";

const script = fileURLToPath(new URL("../scripts/damaged-replies.mjs", import.meta.url));
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const record = (id, summary) => ({
  version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: id, title: "t", summary,
  content_sha256: "c".repeat(64), prompt_version: "7".repeat(64), request_sha256: "8".repeat(64),
  summary_sha256: sha(summary), captured_at: "2026-10-02T00:00:00.000Z",
});

const COMPLETE = "这篇笔记讲了三件事。\n\n第一件，先做 A。\n第二件，再做 B。\n\n整体来说，值得收藏。\n\n#ai #agent #skill";

test("a complete reply, even one ending on a hashtag line, shows no sign", () => {
  assert.deepEqual(damageSigns(COMPLETE), []);
});

test("sign 1: a list marker glued after a comma means text was lost where two items joined", () => {
  const joined = "图文制作类\n\n**jimeng**（@甲）：即梦信息图生成，- **guizang**（@乙）：社交媒体配图。\n结束。";
  assert.deepEqual(damageSigns(joined), ["joined-list-items"]);
  assert.deepEqual(damageSigns("A - B 是一个普通的连字符用法，不算。"), []);
});

test("sign 1 also holds when the glued marker follows a sentence end (。？！), as in real saved replies", () => {
  // Shape of saved reply …03cc55: the opener sentence and the first list item share a line.
  assert.deepEqual(damageSigns("根据你引用的笔记，核心观点是：普通人写愿望，高手写规格。- 用途：这张图用在哪里？\n\n结束。"), ["joined-list-items"]);
  assert.deepEqual(damageSigns("构图：画面如何组织？- 色彩：配色方案是什么？\n\n结束。"), ["joined-list-items"]);
  assert.deepEqual(damageSigns("真不错！- 下一项\n\n结束。"), ["joined-list-items"]);
  assert.deepEqual(damageSigns("第一句。\n- 第二句是新的一行\n\n结束。"), []);
});

test("sign 1 needs the bullet on the same line: a colon line followed by a bullet line is normal formatting", () => {
  assert.deepEqual(damageSigns("核心内容：\n- 第一点\n- 第二点\n\n整体来说，值得收藏。"), []);
});

test("sign 2: the reply stops on a comma or a colon", () => {
  assert.deepEqual(damageSigns("前面都完整。\n\n完整地址在笔记评论区，"), ["ends-on-comma-or-colon"]);
  assert.deepEqual(damageSigns("前面都完整。\n\n这样做：\n"), ["ends-on-comma-or-colon"]);
});

test("sign 2: the reply stops on a bare heading, trailing hashtag lines ignored", () => {
  assert.deepEqual(damageSigns("前面都完整。\n\n核心亮点"), ["ends-on-bare-heading"]);
  assert.deepEqual(damageSigns("前面都完整。\n\n核心亮点\n\n#ai #agent"), ["ends-on-bare-heading"]);
});

test("both signs can be reported together", () => {
  assert.deepEqual(damageSigns("项目，- 另一个项目\n\n结尾是逗号，"), ["joined-list-items", "ends-on-comma-or-colon"]);
});

test("zero-width characters around bold markers do not hide a sign", () => {
  assert.deepEqual(damageSigns("项目​​，- ​​下一个​​。"), ["joined-list-items"]);
});

test("the command lists only complete-looking-damaged replies the loader accepts, with the sealed hash", async () => {
  const work = await mkdtemp(join(tmpdir(), "favsense-damaged-"));
  try {
    await mkdir(join(work, "replies"));
    const ids = { ok: "a".repeat(24), cut: "b".repeat(24), refusal: "c".repeat(24), none: "d".repeat(24) };
    await writeFile(join(work, "catalog.json"), JSON.stringify({ version: 1, notes: Object.fromEntries(Object.values(ids).map((id) => [id, {}])) }));
    await writeFile(join(work, "replies", `${ids.ok}.json`), JSON.stringify(record(ids.ok, COMPLETE)));
    const cut = "前面都完整。\n\n完整地址在笔记评论区，";
    await writeFile(join(work, "replies", `${ids.cut}.json`), JSON.stringify(record(ids.cut, cut)));
    // A refusal is not a summary: the loader drops it, so it can never be "damaged".
    const refusal = diandianReplyCases.find((entry) => entry.id === "refusal-cannot-open-link-asks-for-copy").text.trim();
    await writeFile(join(work, "replies", `${ids.refusal}.json`), JSON.stringify(record(ids.refusal, refusal)));
    const run = spawnSync(process.execPath, [script, "--catalog", join(work, "catalog.json"), "--diandian-dir", join(work, "replies"), "--output", join(work, "damaged.json")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const printed = JSON.parse(run.stdout);
    assert.equal(printed.count, 1);
    assert.deepEqual(printed.ids, [ids.cut]);
    const list = JSON.parse(await readFile(join(work, "damaged.json"), "utf8"));
    assert.deepEqual(list.entries, [{ note_id: ids.cut, summary_sha256: sha(cut), signs: ["ends-on-comma-or-colon"] }]);
    assert.deepEqual([...loadDamagedReplies(join(work, "damaged.json"))], [[ids.cut, sha(cut)]]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a missing list means nothing is damaged; a malformed one is an error, not an empty list", async () => {
  assert.equal(loadDamagedReplies(join(tmpdir(), "favsense-no-such-list.json")).size, 0);
  const work = await mkdtemp(join(tmpdir(), "favsense-damaged-"));
  try {
    await writeFile(join(work, "bad.json"), JSON.stringify({ entries: [{ note_id: "x", summary_sha256: "nope" }] }));
    assert.throws(() => loadDamagedReplies(join(work, "bad.json")), /damaged reply list/i);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("the list loads when an editor saved it with a byte-order mark, and a note the owner takes off the list is complete again", async () => {
  const work = await mkdtemp(join(tmpdir(), "favsense-damaged-"));
  try {
    const list = (ids) => `﻿${JSON.stringify({ schema_version: 1, entries: ids.map((id) => ({ note_id: id, summary_sha256: sha(id), signs: ["ends-on-comma-or-colon"] })) })}`;
    await writeFile(join(work, "list.json"), list(["a".repeat(24), "b".repeat(24)]));
    assert.deepEqual([...loadDamagedReplies(join(work, "list.json")).keys()], ["a".repeat(24), "b".repeat(24)]);
    await writeFile(join(work, "list.json"), list(["b".repeat(24)]));
    assert.deepEqual([...loadDamagedReplies(join(work, "list.json")).keys()], ["b".repeat(24)]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a list that is not valid JSON, or has a malformed entry among good ones, is an error and never an empty list", async () => {
  const work = await mkdtemp(join(tmpdir(), "favsense-damaged-"));
  try {
    await writeFile(join(work, "broken.json"), "{ \"entries\": [");
    assert.throws(() => loadDamagedReplies(join(work, "broken.json")));
    const good = { note_id: "a".repeat(24), summary_sha256: sha("x"), signs: [] };
    await writeFile(join(work, "mixed.json"), JSON.stringify({ entries: [good, { note_id: "../escape", summary_sha256: sha("y") }] }));
    assert.throws(() => loadDamagedReplies(join(work, "mixed.json")), /damaged reply list/i);
    await writeFile(join(work, "notalist.json"), JSON.stringify({ entries: "none" }));
    assert.throws(() => loadDamagedReplies(join(work, "notalist.json")), /damaged reply list/i);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
