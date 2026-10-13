import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareReview } from "../scripts/prepare-curation-review.mjs";
import { mergeResults } from "../scripts/merge-curation-results.mjs";

// Issue #99 (owner ruling 2026-10-14): knowledge cards no longer show a next-step box, so the curation
// standard no longer asks every entry for an `action`. The quality gate side is in accepted-text-quality.test.mjs.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const profile = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "config/domain-profiles/software.json"), "utf8"));

const NOTE_ID = "no-action";
const candidate = {
  title: "具体标题",
  summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度检查。",
  themes: ["主题"],
  tools: [],
  kind: "Note"
};
const catalog = { notes: { [NOTE_ID]: {
  note_id: NOTE_ID, type: "视频", description: "可核验的公开简介", content_sha256: "a".repeat(64),
  source_boards: ["主题甲"], comment_evidence_checked: true
} } };
const transcript = "可核验的本地转写正文";

test("review preparation does not block a candidate that has no action", () => {
  const review = prepareReview({
    catalog,
    scope: { note_ids: [NOTE_ID] },
    candidates: { [NOTE_ID]: candidate },
    resources: { resources: [] },
    evidenceRoot: path.join(os.tmpdir(), "missing-evidence"),
    diandianRoot: path.join(os.tmpdir(), "missing-diandian")
  });
  assert.equal(review.items[0].blockers.includes("action-too-short"), false);
});

test("the merge accepts a candidate with no action and writes it with an empty one", () => {
  const merged = mergeResults({
    profile,
    catalog,
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scope: { note_ids: [NOTE_ID] },
    candidates: {},
    audit: { notes: {} },
    curation: {},
    expectedCount: 1,
    evidenceReview: { items: [{
      note_id: NOTE_ID,
      content_sha256: "a".repeat(64),
      transcript_text: transcript,
      transcript_evidence: {
        method: "local_transcription",
        provider: "faster-whisper",
        version: "faster-whisper-v1",
        result_sha256: createHash("sha256").update(transcript, "utf8").digest("hex")
      }
    }] },
    review: { items: [{
      note_id: NOTE_ID,
      candidate,
      audit: {
        status: "accepted", reviewed_at: "2026-10-14", evidence_methods: ["description", "comments", "audio_transcript"],
        comments_checked: true, claims_supported: true, resource_status: "not_applicable", unresolved_facts: []
      }
    }] }
  });
  assert.deepEqual(Object.keys(merged.curation), [NOTE_ID]);
  assert.equal(merged.curation[NOTE_ID].action, "");
});

test("a candidate that does write an action still has to give a real one", () => {
  assert.throws(() => mergeResults({
    profile,
    catalog,
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scope: { note_ids: [NOTE_ID] },
    candidates: {},
    audit: { notes: {} },
    curation: {},
    expectedCount: 1,
    evidenceReview: { items: [] },
    review: { items: [{
      note_id: NOTE_ID,
      candidate: { ...candidate, action: "好" },
      audit: {
        status: "accepted", reviewed_at: "2026-10-14", evidence_methods: ["description", "comments", "audio_transcript"],
        comments_checked: true, claims_supported: true, resource_status: "not_applicable", unresolved_facts: []
      }
    }] }
  }), /candidate action is too short/);
});
