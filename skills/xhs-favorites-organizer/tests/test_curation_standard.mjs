import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditCuration } from "../scripts/validate-curation.mjs";
import { prepareReview } from "../scripts/prepare-curation-review.mjs";
import { isPublishableCuration, publicEvidenceStatus } from "../scripts/curation-quality.mjs";
import { prepareScope } from "../scripts/prepare-curation-scope.mjs";
import { initializeAudit } from "../scripts/initialize-curation-audit.mjs";
import { mergeResults } from "../scripts/merge-curation-results.mjs";
import { curationRevision } from "../scripts/curation-revision.mjs";

function fixture({ type = "视频", kind = "Tool", tools = [] } = {}) {
  const id = "note-current";
  const catalog = { notes: { [id]: { note_id: id, title: "具体标题", type, published_at: "2026-08-01_10:00:00", source_boards: ["主题甲"] } } };
  const config = { boards: [{ name: "主题甲", category: "主题甲" }] };
  const curation = { [id]: { category: "主题甲", themes: ["主题"], summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度与内容检查。", action: "使用一个真实样例核对输入、输出和限制，再决定是否纳入自己的工作流。", tools, kind } };
  const audit = { notes: { [id]: { status: "accepted", reviewed_at: "2026-08-04", evidence_methods: ["description", "comments", type === "视频" ? "audio_transcript" : "image_ocr"], comments_checked: true, claims_supported: true, resource_status: tools.length ? "verified" : "not_applicable", unresolved_facts: [], curation_sha256: curationRevision(curation[id]) } } };
  return { id, catalog, config, curation, audit, resources: { resources: [] }, from: "2026-07-21", to: "2026-08-04" };
}

test("accepts a scoped note with media-specific evidence", () => {
  const result = auditCuration(fixture());
  assert.deepEqual(result.fatal, []);
  assert.equal(result.report.totals.accepted, 1);
});

test("rejects image notes inferred from title and tags without image OCR", () => {
  const input = fixture({ type: "图文" });
  input.audit.notes[input.id].evidence_methods = ["description", "comments"];
  const result = auditCuration(input);
  assert.match(result.fatal.join("\n"), /image-text-evidence-missing/);
});

test("accepts a documented human image review as image body evidence", () => {
  const input = fixture({ type: "图文" });
  input.audit.notes[input.id].evidence_methods = ["description", "comments", "image_review"];
  assert.deepEqual(auditCuration(input).fatal, []);
});

test("DianDian summary is valid body evidence for video and image without bypassing comments", () => {
  for (const type of ["视频", "图文"]) {
    const input = fixture({ type });
    input.audit.notes[input.id].evidence_methods = ["description", "comments", "diandian_summary"];
    input.audit.notes[input.id].diandian_summary_sha256 = "a".repeat(64);
    let result = auditCuration(input);
    assert.deepEqual(result.fatal, []);

    delete input.audit.notes[input.id].diandian_summary_sha256;
    result = auditCuration(input);
    assert.match(result.fatal.join("\n"), /diandian-summary-hash-missing/);
    input.audit.notes[input.id].diandian_summary_sha256 = "a".repeat(64);

    input.audit.notes[input.id].comments_checked = false;
    input.audit.notes[input.id].evidence_methods = ["description", "diandian_summary"];
    result = auditCuration(input);
    assert.match(result.fatal.join("\n"), /comments-not-checked/);
    assert.match(result.fatal.join("\n"), /comment-evidence-method-missing/);
  }

  const resourceInput = fixture({ kind: "Skill", tools: ["Missing Skill"] });
  resourceInput.audit.notes[resourceInput.id].evidence_methods = ["description", "comments", "diandian_summary"];
  resourceInput.audit.notes[resourceInput.id].diandian_summary_sha256 = "a".repeat(64);
  const resourceResult = auditCuration(resourceInput);
  assert.match(resourceResult.fatal.join("\n"), /resource-not-indexed:Missing Skill/);
});

test("review preparation uses only a matching keyed DianDian summary as body evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-diandian-review-"));
  const noteId = "note-current";
  const catalog = { notes: { [noteId]: {
    note_id: noteId,
    title: "具体标题",
    description: "公开简介",
    type: "图文",
    source_boards: ["主题甲"],
    comment_evidence_checked: true
  } } };
  const candidates = { [noteId]: {
    category: "主题甲",
    themes: ["主题"],
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结。",
    action: "使用真实样例核对输入和输出，再决定是否采用这个方法。",
    tools: ["EvidenceTool"],
    kind: "Tool"
  } };
  try {
    fs.writeFileSync(path.join(directory, `${noteId}.json`), JSON.stringify({
      version: 1,
      provider: "xiaohongshu-diandian",
      prompt: "总结",
      note_id: noteId,
      title: "具体标题",
      summary: "点点读取图文和视频后确认正文明确提到了 EvidenceTool。"
    }), "utf8");
    let review = prepareReview({
      catalog,
      scope: { note_ids: [noteId] },
      candidates,
      resources: { resources: [{ name: "EvidenceTool" }] },
      evidenceRoot: path.join(directory, "video"),
      diandianRoot: directory
    });
    assert.equal(review.items[0].diandian_summary_text.includes("EvidenceTool"), true);
    assert.match(review.items[0].diandian_summary_sha256, /^[a-f0-9]{64}$/);
    assert.equal(review.items[0].blockers.includes("image-text-review-required"), false);
    assert.deepEqual(review.items[0].evidence_methods, ["description", "comments", "diandian_summary"]);
    assert.equal(review.items[0].tool_checks[0].mentioned_in_evidence, true);

    const record = JSON.parse(fs.readFileSync(path.join(directory, `${noteId}.json`), "utf8"));
    record.note_id = "different-note-id";
    fs.writeFileSync(path.join(directory, `${noteId}.json`), JSON.stringify(record), "utf8");
    review = prepareReview({
      catalog,
      scope: { note_ids: [noteId] },
      candidates,
      resources: { resources: [{ name: "EvidenceTool" }] },
      evidenceRoot: path.join(directory, "video"),
      diandianRoot: directory
    });
    assert.equal(review.items[0].diandian_summary_text, "");
    assert.equal(review.items[0].blockers.includes("image-text-review-required"), true);

    record.note_id = noteId;
    record.summary = "Encoded %78%73%65%63%5f%74%6f%6b%65%6e%3dsecret";
    fs.writeFileSync(path.join(directory, `${noteId}.json`), JSON.stringify(record), "utf8");
    review = prepareReview({
      catalog,
      scope: { note_ids: [noteId] },
      candidates,
      resources: { resources: [{ name: "EvidenceTool" }] },
      evidenceRoot: path.join(directory, "video"),
      diandianRoot: directory
    });
    assert.equal(review.items[0].diandian_summary_text, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("review preparation carries a note-scoped human image review into the evidence packet", () => {
  const noteId = "note-image";
  const review = prepareReview({
    catalog: { notes: { [noteId]: { note_id: noteId, title: "图文标题", description: "公开简介", type: "图文", comment_evidence_checked: true } } },
    scope: { note_ids: [noteId] },
    candidates: { [noteId]: { themes: ["主题"], summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结。", action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。", tools: [], kind: "Note" } },
    resources: { resources: [] },
    evidenceRoot: path.join(os.tmpdir(), "missing-evidence"),
    diandianRoot: path.join(os.tmpdir(), "missing-diandian"),
    supplementalReview: { items: [{ note_id: noteId, audit: { evidence_methods: ["image_review"] } }] }
  });
  assert.equal(review.items[0].blockers.includes("image-text-review-required"), false);
  assert.equal(review.items[0].evidence_methods.includes("image_review"), true);
});

test("pending notes require a reason and must not be in public curation", () => {
  const input = fixture();
  input.audit.notes[input.id] = { status: "pending", reviewed_at: "2026-08-04", evidence_methods: ["description", "comments"], comments_checked: true, reason: "缺少画面中的项目名" };
  const result = auditCuration(input);
  assert.match(result.fatal.join("\n"), /pending-must-not-be-published/);
});

test("pending may record missing comments without pretending they were checked", () => {
  const input = fixture();
  delete input.curation[input.id];
  input.audit.notes[input.id] = {
    status: "pending",
    reviewed_at: "2026-08-04",
    evidence_methods: ["description", "audio_transcript"],
    comments_checked: false,
    reason: "评论尚未取得"
  };
  const result = auditCuration(input);
  assert.deepEqual(result.fatal, []);
  assert.equal(result.report.totals.pending, 1);
});

test("Skill requires a verified GitHub resource, license and manifest", () => {
  const input = fixture({ kind: "Skill", tools: ["Example Skill"] });
  input.resources.resources = [{ name: "Example Skill", type: "Agent Skill", repo: "https://github.com/example/skill", download: "https://github.com/example/skill/archive/refs/heads/main.zip" }];
  const result = auditCuration(input);
  assert.match(result.fatal.join("\n"), /license-missing/);
  assert.match(result.fatal.join("\n"), /skill-manifest-missing/);
});

test("category override requires an explicit reason", () => {
  const input = fixture();
  input.curation[input.id].category = "另一主题";
  const result = auditCuration(input);
  assert.match(result.fatal.join("\n"), /category-override-unexplained/);
});

test("publication gate binds the historical baseline and accepted audit to the current curation revision", () => {
  const entry = fixture({ type: "图文" }).curation["note-current"];
  const curation = { old: entry, current: entry, pending: entry };
  const policy = { publish_only_accepted: true };
  const accepted = {
    status: "accepted", reviewed_at: "2026-08-12",
    evidence_methods: ["description", "comments", "image_review"],
    comments_checked: true, claims_supported: true,
    resource_status: "not_applicable", unresolved_facts: [],
    curation_sha256: curationRevision(entry)
  };
  const audit = { notes: { current: accepted, pending: { ...accepted, status: "pending" } } };
  const note = { title: "具体标题", type: "图文", source_boards: ["主题甲"], published_at: "2026-08-12" };
  const context = { config: { boards: [{ name: "主题甲", category: "主题甲" }] }, resources: { resources: [] } };
  const baselineHashes = new Map([["old", curationRevision(entry)]]);
  assert.equal(isPublishableCuration("old", note, curation, policy, audit, new Set(["old"]), baselineHashes, context), true);
  assert.equal(isPublishableCuration("current", note, curation, policy, audit, new Set(), new Map(), context), true);
  assert.equal(isPublishableCuration("pending", note, curation, policy, audit, new Set(), new Map(), context), false);
  assert.equal(isPublishableCuration("old", note, { ...curation, old: { ...entry, summary: `${entry.summary} 已修改` } }, policy, audit, new Set(["old"]), baselineHashes, context), false);
});

test("published baseline is preserved while its catalog difference becomes the review scope", () => {
  const publishedEntry = { summary: "published" };
  const publishedRevision = curationRevision(publishedEntry);
  const result = prepareScope(
    { notes: { published: {}, newOne: {}, newTwo: {} } },
    { notes: [{ id: "published", curationRevision: publishedRevision }] },
    "2026-08-04T00:00:00.000Z",
    [],
    false,
    { published: { summary: "edited after the public snapshot" } }
  );
  assert.deepEqual(result.baseline.note_ids, ["published"]);
  assert.equal(result.baseline.curation_hashes.published, publishedRevision);
  assert.deepEqual(result.scope.note_ids.sort(), ["newOne", "newTwo"]);
  assert.equal(
    isPublishableCuration(
      "published", {}, { published: { summary: "published" } },
      { publish_only_accepted: true }, { notes: {} }, new Set(["published"]),
      new Map(Object.entries(result.baseline.curation_hashes))
    ),
    true
  );
});

test("an explicit one-click enrichment run re-enters baseline notes into the review scope", () => {
  const result = prepareScope(
    { notes: { old: {}, fresh: {} } },
    { notes: [{ id: "old" }] },
    "2026-08-12T00:00:00.000Z",
    ["old"]
  );
  assert.equal(result.scope.mode, "baseline-difference-plus-explicit-run");
  assert.deepEqual(result.scope.note_ids.sort(), ["fresh", "old"]);
});

test("run-only scope isolates an explicitly rerun batch from unrelated baseline differences", () => {
  const result = prepareScope(
    { notes: { old: {}, fresh: {}, rerun: {} } },
    { note_ids: ["old"] },
    "2026-08-12T00:00:00.000Z",
    ["rerun"],
    true
  );
  assert.equal(result.scope.mode, "explicit-run");
  assert.deepEqual(result.scope.note_ids, ["rerun"]);
});

test("a saved private baseline can be reused without converting it back to public knowledge", () => {
  const result = prepareScope(
    { notes: { old: {}, fresh: {} } },
    { note_ids: ["old"] },
    "2026-08-12T00:00:00.000Z"
  );
  assert.deepEqual(result.baseline.note_ids, ["old"]);
  assert.deepEqual(result.scope.note_ids, ["fresh"]);
});

test("review merge publishes only accepted candidates and keeps pending work private", () => {
  const candidate = {
    title: "具体标题",
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度检查。",
    action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
    themes: ["主题"],
    tools: [],
    kind: "Note"
  };
  const merged = mergeResults({
    catalog: { notes: {
      accepted: { type: "图文", source_boards: ["主题甲"] },
      pending: { type: "图文", source_boards: ["主题甲"] }
    } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scope: { note_ids: ["accepted", "pending"] },
    candidates: {},
    audit: { notes: {} },
    curation: {},
    expectedCount: 2,
    review: { items: [
      { note_id: "accepted", candidate, audit: { status: "accepted", reviewed_at: "2026-08-12", evidence_methods: ["description", "comments", "image_review"], comments_checked: true, claims_supported: true, resource_status: "not_applicable", unresolved_facts: [] } },
      { note_id: "pending", candidate, audit: { status: "pending", reviewed_at: "2026-08-12", evidence_methods: ["description", "comments"], comments_checked: true, claims_supported: false, resource_status: "not_applicable", unresolved_facts: ["image-text"], reason: "缺少图片正文" } }
    ] }
  });
  assert.deepEqual(Object.keys(merged.curation), ["accepted"]);
  assert.equal(merged.audit.notes.pending.status, "pending");
  assert.deepEqual(merged.counts, { accepted: 1, pending: 1, rejected: 0 });
  assert.equal(merged.audit.notes.accepted.curation_sha256, curationRevision(candidate));
});

test("review merge rejects an incomplete accepted audit before formal curation", () => {
  const candidate = {
    title: "具体标题", category: "主题甲",
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度检查。",
    action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
    themes: ["主题"], tools: [], kind: "Note"
  };
  assert.throws(() => mergeResults({
    catalog: { notes: { incomplete: { type: "图文", source_boards: ["主题甲"] } } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scope: { note_ids: ["incomplete"] }, candidates: {}, audit: { notes: {} }, curation: {},
    review: { items: [{ note_id: "incomplete", candidate, audit: { status: "accepted" } }] }
  }), /accepted audit failed quality validation/);
});

test("review merge preserves an explained category override", () => {
  const candidate = {
    title: "具体标题", category: "推荐新分类", category_override: true,
    category_reason: "正文主题明显属于推荐新分类",
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度检查。",
    action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
    themes: ["主题"], tools: [], kind: "Note"
  };
  const merged = mergeResults({
    catalog: { notes: { override: { type: "图文", source_boards: ["主题甲"] } } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scope: { note_ids: ["override"] }, candidates: {}, audit: { notes: {} }, curation: {},
    review: { items: [{ note_id: "override", candidate, audit: {
      status: "accepted", reviewed_at: "2026-08-12",
      evidence_methods: ["description", "comments", "image_review"], comments_checked: true,
      claims_supported: true, resource_status: "not_applicable", unresolved_facts: []
    } }] }
  });
  assert.equal(merged.curation.override.category, "推荐新分类");
  assert.equal(merged.curation.override.category_override, true);
});

test("explicit scope audits the baseline difference instead of post publication dates", () => {
  const input = fixture();
  input.catalog.notes[input.id].published_at = "2025-01-01_10:00:00";
  input.scopeIds = [input.id];
  const result = auditCuration(input);
  assert.equal(result.report.totals.scoped, 1);
  assert.equal(result.report.totals.accepted, 1);
});

test("accepted audit is exposed as verified without leaking private evidence", () => {
  const audit = { notes: { current: { status: "accepted", evidence_methods: ["audio_transcript", "comments"] } } };
  assert.deepEqual(publicEvidenceStatus("current", audit, false, true), {
    method: "已按媒体类型读取内容、检查评论，并对关键资源完成必要核验",
    locallyAvailable: true
  });
});

test("audit initialization preserves accepted work and makes every other scoped item pending", () => {
  const review = { items: [
    { note_id: "accepted", public_text: "a", transcript_text: "b", visual_text: "", tool_checks: [], blockers: [] },
    {
      note_id: "missing-comments",
      public_text: "a",
      transcript_text: "",
      visual_text: "",
      diandian_summary_text: "点点已经读取这篇图文或视频的完整内容。",
      evidence_methods: ["description", "diandian_summary"],
      diandian_summary_sha256: "b".repeat(64),
      tool_checks: [],
      blockers: ["comments-unchecked"]
    }
  ] };
  const acceptedCuration = {};
  const existing = { notes: { accepted: {
    status: "accepted", reviewed_at: "2026-08-04",
    curation_sha256: curationRevision(acceptedCuration)
  } } };
  const result = initializeAudit(review, existing, { accepted: acceptedCuration }, "2026-08-04");
  assert.equal(result.notes.accepted.status, "accepted");
  assert.equal(result.notes["missing-comments"].status, "pending");
  assert.equal(result.notes["missing-comments"].comments_checked, false);
  assert.deepEqual(result.notes["missing-comments"].evidence_methods, ["description", "diandian_summary"]);
  assert.equal(result.notes["missing-comments"].diandian_summary_sha256, "b".repeat(64));
});

test("audit initialization invalidates accepted DianDian evidence when the summary revision changes", () => {
  const review = { items: [{
    note_id: "changed",
    public_text: "public",
    transcript_text: "",
    visual_text: "",
    diandian_summary_text: "new summary",
    diandian_summary_sha256: "b".repeat(64),
    evidence_methods: ["description", "comments", "diandian_summary"],
    tool_checks: [],
    blockers: []
  }] };
  const existing = { notes: { changed: {
    status: "accepted",
    evidence_methods: ["description", "comments", "diandian_summary"],
    diandian_summary_sha256: "a".repeat(64),
    curation_sha256: curationRevision({})
  } } };
  const result = initializeAudit(review, existing, { changed: {} }, "2026-08-12");
  assert.equal(result.notes.changed.status, "pending");
  assert.equal(result.notes.changed.diandian_summary_sha256, "b".repeat(64));
});
