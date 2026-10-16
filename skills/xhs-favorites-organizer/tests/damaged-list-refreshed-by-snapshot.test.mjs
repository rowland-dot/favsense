import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Issue 142: the snapshot step regenerates the damaged-reply list from the current catalog and reply folder
// just before it freezes its inputs, so the list is never older than the replies it judges. The tests drive
// the snapshot command line against a throwaway workspace, with the real card builder. The bridge's side of
// the same change (it always names the list) is checked in test_final_build.py.

const here = dirname(fileURLToPath(import.meta.url));
const snapshotScript = join(here, "..", "scripts", "build-organization-snapshot.mjs");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const record = (id, summary) => ({
  version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: id, title: "t", summary,
  content_sha256: "c".repeat(64), prompt_version: "7".repeat(64), request_sha256: "8".repeat(64),
  summary_sha256: sha(summary), captured_at: "2026-10-17T00:00:00.000Z",
});

const COMPLETE_REPLY = "这篇笔记讲了两件事。\n\n第一件，先做 A。\n第二件，再做 B。\n\n整体来说，值得收藏。";
const CUT_REPLY = "前面都完整。\n\n完整地址在笔记评论区，";
const POST_TEXT = "原帖自己写的文字";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "favsense-damaged-refresh-"));
  const state = join(root, ".xhs-favorites");
  const ids = { whole: "a".repeat(24), late: "b".repeat(24) };
  const files = {
    catalog: join(state, "catalog.json"), config: join(root, "config.json"), curation: join(root, "curation.json"),
    bundle: join(state, "bundle.json"), profile: join(root, "profile.json"), resources: join(root, "resources.json"),
    damaged: join(state, "damaged-diandian-replies.json"), replies: join(state, "diandian-summaries"),
    video: join(state, "video-analysis"), output: join(root, "site", "data", "knowledge.json"),
  };
  await mkdir(files.replies, { recursive: true });
  await mkdir(join(root, "site", "data"), { recursive: true });
  await writeFile(join(root, "site", "index.html"), "<main>site</main>");
  const note = { title: "", description: POST_TEXT, source_boards: ["Synthetic"] };
  await writeFile(files.catalog, JSON.stringify({ notes: { [ids.whole]: note, [ids.late]: note } }));
  await writeFile(files.config, JSON.stringify({ boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {} }));
  await writeFile(files.curation, "{}");
  const scope = Object.values(ids).sort();
  await writeFile(files.bundle, JSON.stringify({
    schema_version: 1, outcome: "ready_for_safe_build", scope: { note_ids: scope },
    curation: Object.fromEntries(scope.map((id) => [id, { review_status: "pending" }])),
  }));
  await writeFile(files.profile, await readFile(join(here, "..", "..", "..", "config", "domain-profiles", "software.json"), "utf8"));
  await writeFile(files.resources, JSON.stringify({ verified_at: "2026-10-17", resources: [] }));
  await writeFile(join(files.replies, `${ids.whole}.json`), JSON.stringify(record(ids.whole, COMPLETE_REPLY)));
  // The list as an earlier run left it: it knows nothing about the reply saved after it was written.
  await writeFile(files.damaged, JSON.stringify({ schema_version: 1, entries: [] }));
  const run = () => spawnSync(process.execPath, [
    snapshotScript, "--root", root, "--public-target", files.output, "--catalog", files.catalog, "--config", files.config,
    "--curation", files.curation, "--curation-bundle", files.bundle, "--profile", files.profile, "--resources", files.resources,
    "--sealed-scope-digest", sha(JSON.stringify(scope)), "--diandian-dir", files.replies, "--video-analysis", files.video,
    "--damaged-replies", files.damaged, "--effective-date", "2026-10-17",
  ], { encoding: "utf8" });
  const cards = async () => Object.fromEntries(JSON.parse(await readFile(files.output, "utf8")).notes.map((card) => [card.id, card]));
  return { root, ids, files, run, cards };
}

test("a reply saved after the list was written is judged by the snapshot, not published as complete", async () => {
  const { root, ids, files, run, cards } = await workspace();
  try {
    await writeFile(join(files.replies, `${ids.late}.json`), JSON.stringify(record(ids.late, CUT_REPLY)));
    const built = run();
    assert.equal(built.status, 0, built.stderr);
    const byId = await cards();
    assert.equal(byId[ids.late].replyDamaged, true);
    assert.equal(byId[ids.late].mainSource, "post-text");
    assert.equal(byId[ids.late].mainText, POST_TEXT);
    // A reply with no sign of lost text stays complete.
    assert.equal(byId[ids.whole].replyDamaged, false);
    assert.equal(byId[ids.whole].mainSource, "diandian");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the list file is rewritten in its usual place and format, and a reply that was re-fetched whole drops off it", async () => {
  const { root, ids, files, run, cards } = await workspace();
  try {
    await writeFile(join(files.replies, `${ids.late}.json`), JSON.stringify(record(ids.late, CUT_REPLY)));
    assert.equal(run().status, 0);
    const list = JSON.parse(await readFile(files.damaged, "utf8"));
    assert.deepEqual(list.entries, [{ note_id: ids.late, summary_sha256: sha(CUT_REPLY), signs: ["ends-on-comma-or-colon"] }]);
    // The same note saved again with its full text is complete on the next build, with no hand step between.
    await writeFile(join(files.replies, `${ids.late}.json`), JSON.stringify(record(ids.late, COMPLETE_REPLY)));
    assert.equal(run().status, 0);
    assert.deepEqual(JSON.parse(await readFile(files.damaged, "utf8")).entries, []);
    assert.equal((await cards())[ids.late].replyDamaged, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a build that is not told where the list lives leaves every file alone and still builds", async () => {
  const { root, ids, files } = await workspace();
  try {
    await writeFile(join(files.replies, `${ids.late}.json`), JSON.stringify(record(ids.late, CUT_REPLY)));
    const scope = Object.values(ids).sort();
    const built = spawnSync(process.execPath, [
      snapshotScript, "--root", root, "--public-target", files.output, "--catalog", files.catalog, "--config", files.config,
      "--curation", files.curation, "--curation-bundle", files.bundle, "--profile", files.profile, "--resources", files.resources,
      "--sealed-scope-digest", sha(JSON.stringify(scope)), "--diandian-dir", files.replies, "--video-analysis", files.video,
      "--effective-date", "2026-10-17",
    ], { encoding: "utf8" });
    // Saved replies and no list at all: the build still refuses, as it always did.
    assert.notEqual(built.status, 0);
    assert.match(built.stderr, /DAMAGED_REPLY_LIST_MISSING/);
    assert.equal(await readFile(files.damaged, "utf8"), JSON.stringify({ schema_version: 1, entries: [] }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
