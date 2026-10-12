import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { auditCuration } from "../scripts/validate-curation.mjs";
import { prepareReview } from "../scripts/prepare-curation-review.mjs";
import { curationRevision } from "../scripts/curation-revision.mjs";

// Owner ruling on issue 56 (2026-10-13): an image note needs image text that was actually read
// (curation-standard.md section 2, image-text rule 2). A DianDian summary alone no longer accepts one.

const NOTE_ID = "a".repeat(24);
const CONTENT_SHA256 = "c".repeat(64);
const PROMPT_VERSION = "7".repeat(64);
const SUMMARY = "点点读取图片后确认正文明确提到了 EvidenceTool。";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function acceptedImageNote(evidenceMethods) {
  const entry = {
    category: "主题甲",
    themes: ["主题"],
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度与内容检查。",
    action: "使用一个真实样例核对输入、输出和限制，再决定是否纳入自己的工作流。",
    tools: [],
    kind: "Note"
  };
  return {
    catalog: { notes: { [NOTE_ID]: { note_id: NOTE_ID, title: "具体标题", type: "图文", source_boards: ["主题甲"] } } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    curation: { [NOTE_ID]: entry },
    audit: { notes: { [NOTE_ID]: {
      status: "accepted",
      reviewed_at: "2026-10-13",
      evidence_methods: evidenceMethods,
      diandian_summary_sha256: "a".repeat(64),
      comments_checked: true,
      claims_supported: true,
      resource_status: "not_applicable",
      unresolved_facts: [],
      curation_sha256: curationRevision(entry)
    } } },
    resources: { resources: [] },
    scopeIds: [NOTE_ID]
  };
}

test("the quality gate refuses an image note whose only body evidence is the DianDian summary", () => {
  const result = auditCuration(acceptedImageNote(["description", "comments", "diandian_summary"]));
  assert.match(result.fatal.join("\n"), /image-text-evidence-missing/);
});

test("the quality gate still accepts an image note with read image text, with or without the summary", () => {
  assert.deepEqual(auditCuration(acceptedImageNote(["description", "comments", "image_ocr"])).fatal, []);
  assert.deepEqual(
    auditCuration(acceptedImageNote(["description", "comments", "image_ocr", "diandian_summary"])).fatal,
    []
  );
});

test("review preparation keeps the image-text blocker when only a current DianDian summary exists", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-image-text-required-"));
  try {
    const pointRoot = path.join(directory, "point");
    const evidenceRoot = path.join(directory, "evidence");
    fs.mkdirSync(pointRoot);
    fs.mkdirSync(path.join(evidenceRoot, NOTE_ID), { recursive: true });
    fs.writeFileSync(path.join(pointRoot, `${NOTE_ID}.json`), JSON.stringify({
      version: 2,
      provider: "xiaohongshu-diandian",
      prompt: "总结",
      prompt_version: PROMPT_VERSION,
      note_id: NOTE_ID,
      title: "具体标题",
      summary: SUMMARY,
      content_sha256: CONTENT_SHA256,
      request_sha256: "d".repeat(64),
      summary_sha256: sha256(SUMMARY),
      captured_at: "2026-10-13T00:00:00.000Z"
    }), "utf8");
    const prepare = () => prepareReview({
      catalog: { notes: { [NOTE_ID]: {
        note_id: NOTE_ID, title: "图文标题", description: "公开简介", type: "图文",
        comment_evidence_checked: true, content_sha256: CONTENT_SHA256
      } } },
      scope: { note_ids: [NOTE_ID] },
      candidates: { [NOTE_ID]: {
        themes: ["主题"],
        summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结。",
        action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
        tools: [], kind: "Note"
      } },
      resources: { resources: [] },
      evidenceRoot,
      diandianRoot: pointRoot,
      expectedPromptVersion: PROMPT_VERSION
    });

    const summaryOnly = prepare().items[0];
    assert.equal(summaryOnly.diandian_summary_text, SUMMARY);
    assert.equal(summaryOnly.blockers.includes("image-text-review-required"), true);

    const imageText = "图片里读到的文字";
    fs.writeFileSync(path.join(evidenceRoot, NOTE_ID, "visual-ocr.json"), JSON.stringify({
      schema_version: 1,
      status: "extracted",
      method: "local_image_ocr",
      provider: "configured-local-engine",
      tool_version: "local-ocr;engine_sha256=" + "e".repeat(64),
      content_sha256: CONTENT_SHA256,
      result_sha256: sha256(imageText),
      text: imageText
    }), "utf8");
    const withImageText = prepare().items[0];
    assert.equal(withImageText.blockers.includes("image-text-review-required"), false);
    assert.equal(withImageText.evidence_methods.includes("image_ocr"), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
