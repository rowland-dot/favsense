import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDiandianRefusal } from "../scripts/diandian-refusal.mjs";
import { loadFormalPointSummary, parseFormalPointSummaryRecord } from "../scripts/curation-quality.mjs";
import { auditCuration } from "../scripts/validate-curation.mjs";
import { prepareReview } from "../scripts/prepare-curation-review.mjs";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { diandianReplyCases, normalReply, refusalReply } from "./public-judgement-fixtures.mjs";

// A DianDian reply that refuses to read the note ("I cannot open the link, send me the text") is not a
// summary. This is the JavaScript copy of the rule, held to the same table as the Python copy
// (test_diandian_refusal.py); the readers and the quality gate below must all act on it.

const NOTE_ID = "a".repeat(24);
const CONTENT_SHA256 = "c".repeat(64);
const PROMPT_VERSION = "7".repeat(64);
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const record = (summary) => ({
  version: 2,
  provider: "xiaohongshu-diandian",
  prompt: "总结",
  prompt_version: PROMPT_VERSION,
  note_id: NOTE_ID,
  title: "具体标题",
  summary,
  content_sha256: CONTENT_SHA256,
  request_sha256: "d".repeat(64),
  summary_sha256: sha256(summary.replace(/\r\n?/g, "\n").trim()),
  captured_at: "2026-10-13T00:00:00.000Z"
});

test("the JavaScript rule follows the shared table of real replies", () => {
  assert.ok(diandianReplyCases.some((entry) => entry.refused) && diandianReplyCases.some((entry) => !entry.refused));
  for (const entry of diandianReplyCases) {
    assert.equal(isDiandianRefusal(entry.text), entry.refused, `${entry.id}: ${entry.why}`);
  }
  for (const value of [undefined, null, 0, {}, []]) assert.equal(isDiandianRefusal(value), false);
});

test("a stored refusal is not a point summary, and the same record with a real summary is", () => {
  assert.equal(parseFormalPointSummaryRecord(record(refusalReply), NOTE_ID), null);
  assert.equal(parseFormalPointSummaryRecord(record(normalReply), NOTE_ID)?.summary, normalReply.trim());
});

test("reading a point summary from the private folder gives nothing for a refusal", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-diandian-refusal-"));
  try {
    fs.writeFileSync(path.join(directory, `${NOTE_ID}.json`), JSON.stringify(record(refusalReply)), "utf8");
    assert.equal(loadFormalPointSummary(directory, NOTE_ID, PROMPT_VERSION), null);
    fs.writeFileSync(path.join(directory, `${NOTE_ID}.json`), JSON.stringify(record(normalReply)), "utf8");
    assert.notEqual(loadFormalPointSummary(directory, NOTE_ID, PROMPT_VERSION), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("review preparation does not offer a refusal as the body of a video note", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-diandian-refusal-review-"));
  try {
    const pointRoot = path.join(directory, "point");
    const evidenceRoot = path.join(directory, "evidence");
    fs.mkdirSync(pointRoot);
    fs.mkdirSync(path.join(evidenceRoot, NOTE_ID), { recursive: true });
    const prepare = () => prepareReview({
      catalog: { notes: { [NOTE_ID]: {
        note_id: NOTE_ID, title: "视频标题", description: "公开简介", type: "视频",
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

    fs.writeFileSync(path.join(pointRoot, `${NOTE_ID}.json`), JSON.stringify(record(normalReply)), "utf8");
    const real = prepare().items[0];
    assert.equal(real.evidence_methods.includes("diandian_summary"), true);
    assert.equal(real.blockers.includes("video-body-evidence-missing"), false);

    fs.writeFileSync(path.join(pointRoot, `${NOTE_ID}.json`), JSON.stringify(record(refusalReply)), "utf8");
    const refused = prepare().items[0];
    assert.equal(refused.diandian_summary_text, "");
    assert.equal(refused.evidence_methods.includes("diandian_summary"), false);
    assert.equal(refused.blockers.includes("video-body-evidence-missing"), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function acceptedNote(overrides) {
  const entry = {
    category: "主题甲",
    themes: ["主题"],
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度与内容检查。",
    action: "使用一个真实样例核对输入、输出和限制，再决定是否纳入自己的工作流。",
    tools: [],
    kind: "Note",
    ...overrides
  };
  return {
    catalog: { notes: { [NOTE_ID]: { note_id: NOTE_ID, title: "具体标题", type: "图文", source_boards: ["主题甲"] } } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    curation: { [NOTE_ID]: entry },
    audit: { notes: { [NOTE_ID]: {
      status: "accepted",
      reviewed_at: "2026-10-13",
      evidence_methods: ["description", "comments", "image_ocr"],
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

test("the quality gate refuses a reviewed summary or action that is a refusal", () => {
  assert.deepEqual(auditCuration(acceptedNote({})).fatal, []);
  assert.match(auditCuration(acceptedNote({ summary: refusalReply })).fatal.join("\n"), /summary-not-specific/);
  assert.match(auditCuration(acceptedNote({ action: refusalReply })).fatal.join("\n"), /action-not-specific/);
  // A real DianDian summary is long and specific, so the refusal rule leaves it alone. (Pasting a reply
  // into a reviewed summary is refused by a different rule, for its opening: accepted-text-quality.test.mjs.)
  assert.doesNotMatch(auditCuration(acceptedNote({ summary: normalReply })).fatal.join("\n"), /summary-not-specific/);
});
