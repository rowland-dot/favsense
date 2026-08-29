import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditCuration } from "../scripts/validate-curation.mjs";
import { prepareReview } from "../scripts/prepare-curation-review.mjs";
import {
  acceptedRevisionsCurrent,
  currentFormalRevisions,
  formalCurationDecision,
  isPublishableCuration,
  loadFormalPointSummary,
  publicEvidenceStatus
} from "../scripts/curation-quality.mjs";
import { prepareScope } from "../scripts/prepare-curation-scope.mjs";
import { initializeAudit } from "../scripts/initialize-curation-audit.mjs";
import { mergeResults } from "../scripts/merge-curation-results.mjs";
import { curationRevision, reviewPacketRevision } from "../scripts/curation-revision.mjs";
import { executeJournaledTransaction } from "../scripts/journaled-transaction.mjs";
import { expectedResourceRevisions } from "../scripts/resource-quality.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mergeCli = path.join(
  repositoryRoot,
  "skills/xhs-favorites-organizer/scripts/merge-curation-results.mjs"
);
const prepareReviewCli = path.join(
  repositoryRoot,
  "skills/xhs-favorites-organizer/scripts/prepare-curation-review.mjs"
);

test("public Skill rebuild examples preserve the Bridge-frozen DianDian prompt contract", () => {
  const skill = fs.readFileSync(
    path.join(repositoryRoot, "skills/xhs-favorites-organizer/SKILL.md"),
    "utf8"
  );
  assert.match(skill, /rebuild_knowledge_base\(\)/);
  assert.match(skill, /不要直接运行缺少该值的底层 builder/);
  const examples = skill.match(/```powershell[\s\S]*?```/g) || [];
  const knowledge = examples.find((example) => example.includes("build-knowledge-base.mjs")) || "";
  const publicSite = examples.find((example) => example.includes("build-public-site.mjs")) || "";
  for (const example of [knowledge, publicSite]) {
    assert.match(example, /--diandian-prompt-version \$promptVersion/);
  }
});

test("curation merge documentation requires the prepared evidence packet", () => {
  const standard = fs.readFileSync(
    path.join(repositoryRoot, "skills/xhs-favorites-organizer/references/curation-standard.md"),
    "utf8"
  );
  const mergeExample = (standard.match(
    /```powershell[\s\S]*?merge-curation-results\.mjs[\s\S]*?```/
  ) || [""])[0];
  assert.match(mergeExample, /--evidence-review ".+curation-review\.json"/);
  assert.match(standard, /accepted` candidate 还必须保留该包的 `id` 与 `content_sha256`/);
});

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function transcriptEvidence(text) {
  return {
    transcript_text: text,
    transcript_evidence: {
      method: "local_transcription",
      provider: "faster-whisper",
      version: "faster-whisper-v1",
      result_sha256: createHash("sha256").update(text, "utf8").digest("hex")
    }
  };
}

function mergeCliFixture(workspace) {
  const privateRoot = path.join(workspace, ".xhs-favorites");
  const paths = {
    catalog: path.join(privateRoot, "catalog.json"),
    config: path.join(workspace, "config.json"),
    scope: path.join(privateRoot, "curation-scope.json"),
    review: path.join(privateRoot, "curation-review.json"),
    evidenceReview: path.join(privateRoot, "curation-evidence-review.json"),
    candidates: path.join(privateRoot, "curation-candidates.json"),
    resources: path.join(workspace, "resources.json"),
    audit: path.join(privateRoot, "curation-audit.json"),
    curation: path.join(workspace, "formal-curation.json"),
    transactionRoot: path.join(privateRoot, "organization-transactions"),
    lock: path.join(privateRoot, "organization-migration", ".apply-lock")
  };
  const candidate = {
    title: "具体标题",
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度检查。",
    action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
    themes: ["主题"],
    tools: [],
    kind: "Note"
  };
  writeJson(paths.catalog, { notes: {
    current: {
      note_id: "current",
      type: "图文",
      description: "可核验的公开简介",
      content_sha256: "a".repeat(64),
      source_boards: ["主题甲"]
    }
  } });
  writeJson(paths.config, { boards: [{ name: "主题甲", category: "主题甲" }] });
  writeJson(paths.scope, { note_ids: ["current"] });
  const evidencePacket = {
    note_id: "current",
    content_sha256: "a".repeat(64),
    blockers: ["synthetic-rejection"]
  };
  evidencePacket.review_packet_sha256 = reviewPacketRevision(evidencePacket);
  writeJson(paths.evidenceReview, { items: [evidencePacket] });
  writeJson(paths.review, { items: [{
    note_id: "current",
    review_packet_sha256: evidencePacket.review_packet_sha256,
    candidate,
    audit: {
      status: "rejected",
      reviewed_at: "2026-08-26",
      evidence_methods: ["description", "comments"],
      comments_checked: true,
      claims_supported: false,
      resource_status: "not_applicable",
      unresolved_facts: [],
      reason: "当前证据不足"
    }
  }] });
  writeJson(paths.candidates, { old: { summary: "old candidates" } });
  writeJson(paths.resources, { resources: [] });
  writeJson(paths.audit, { notes: { old: { status: "rejected", reason: "old audit" } } });
  writeJson(paths.curation, { old: { summary: "old curation" } });
  return paths;
}

function runMergeCli(workspace, paths, { nodeArgs = [], env = process.env } = {}) {
  return spawnSync(process.execPath, [
    ...nodeArgs,
    mergeCli,
    "--catalog", paths.catalog,
    "--config", paths.config,
    "--scope", paths.scope,
    "--review", paths.review,
    "--evidence-review", paths.evidenceReview,
    "--candidates", paths.candidates,
    "--resources", paths.resources,
    "--audit", paths.audit,
    "--curation", paths.curation,
    "--expected-count", "1"
  ], { cwd: workspace, encoding: "utf8", env });
}

function assertDocumentContract(relativePath, contract) {
  const document = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  for (const phrase of contract.required_phrases) {
    assert.equal(document.includes(phrase), true, `${relativePath} must document: ${phrase}`);
  }
  for (const phrase of contract.forbidden_phrases || []) {
    assert.equal(document.includes(phrase), false, `${relativePath} must not claim: ${phrase}`);
  }
}

test("Task 11 documentation states the verified organization lifecycle", () => {
  const fixturePath = path.join(
    repositoryRoot,
    "skills/xhs-favorites-organizer/test-fixtures/task-11-documentation-contract.json"
  );
  const contract = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  for (const [relativePath, documentContract] of Object.entries(contract.product_contracts)) {
    assertDocumentContract(relativePath, documentContract);
  }
});

test("Task 11 contributor and CI commands match executable package contracts", () => {
  const fixturePath = path.join(
    repositoryRoot,
    "skills/xhs-favorites-organizer/test-fixtures/task-11-documentation-contract.json"
  );
  const contract = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  for (const [relativePath, documentContract] of Object.entries(contract.developer_contracts)) {
    assertDocumentContract(relativePath, documentContract);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageJson.engines.node, ">=20");
  for (const command of contract.package_script_contracts.windows_contract_fragments) {
    assert.equal(packageJson.scripts["test:windows-contracts"].includes(command), true);
  }
  for (const command of contract.package_script_contracts.release_gate_commands) {
    assert.equal(packageJson.scripts["release:check"].includes(command), true);
  }

  const ci = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /- name: Run the complete release gate\s+run: npm run release:check/);
  assert.match(ci, /- name: Run Windows setup safety contracts\s+if: runner\.os == 'Windows'\s+run: npm\.cmd run test:windows-contracts/);
});

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
  const currentPromptVersion = "7".repeat(64);
  const catalog = { notes: { [noteId]: {
    note_id: noteId,
    title: "具体标题",
    description: "公开简介",
    type: "图文",
    source_boards: ["主题甲"],
    comment_evidence_checked: true,
    content_sha256: "a".repeat(64)
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
    const summary = "点点读取图文和视频后确认正文明确提到了 EvidenceTool。";
    fs.writeFileSync(path.join(directory, `${noteId}.json`), JSON.stringify({
      version: 2,
      provider: "xiaohongshu-diandian",
      prompt: "总结",
      prompt_version: "b".repeat(64),
      note_id: noteId,
      title: "具体标题",
      summary,
      content_sha256: "a".repeat(64),
      request_sha256: "c".repeat(64),
      summary_sha256: createHash("sha256").update(summary, "utf8").digest("hex"),
      captured_at: "2026-08-26T00:00:00.000Z"
    }), "utf8");
    let review = prepareReview({
      catalog,
      scope: { note_ids: [noteId] },
      candidates,
      resources: { resources: [{ name: "EvidenceTool" }] },
      evidenceRoot: path.join(directory, "video"),
      diandianRoot: directory,
      expectedPromptVersion: currentPromptVersion
    });
    assert.equal(review.items[0].diandian_summary_text, "");
    assert.equal(review.items[0].blockers.includes("image-text-review-required"), true);

    const currentRecord = JSON.parse(fs.readFileSync(path.join(directory, `${noteId}.json`), "utf8"));
    currentRecord.prompt_version = currentPromptVersion;
    fs.writeFileSync(path.join(directory, `${noteId}.json`), JSON.stringify(currentRecord), "utf8");
    review = prepareReview({
      catalog,
      scope: { note_ids: [noteId] },
      candidates,
      resources: { resources: [{ name: "EvidenceTool" }] },
      evidenceRoot: path.join(directory, "video"),
      diandianRoot: directory,
      expectedPromptVersion: currentPromptVersion
    });
    assert.equal(review.items[0].diandian_summary_text.includes("EvidenceTool"), true);
    assert.equal(review.items[0].content_sha256, "a".repeat(64));
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
      diandianRoot: directory,
      expectedPromptVersion: currentPromptVersion
    });
    assert.equal(review.items[0].diandian_summary_text, "");
    assert.equal(review.items[0].blockers.includes("image-text-review-required"), true);

    record.note_id = noteId;
    record.summary = "Encoded %78%73%65%63%5f%74%6f%6b%65%6e%3dsecret";
    record.summary_sha256 = createHash("sha256").update(record.summary, "utf8").digest("hex");
    fs.writeFileSync(path.join(directory, `${noteId}.json`), JSON.stringify(record), "utf8");
    review = prepareReview({
      catalog,
      scope: { note_ids: [noteId] },
      candidates,
      resources: { resources: [{ name: "EvidenceTool" }] },
      evidenceRoot: path.join(directory, "video"),
      diandianRoot: directory,
      expectedPromptVersion: currentPromptVersion
    });
    assert.equal(review.items[0].diandian_summary_text, "");

    record.summary = summary;
    record.summary_sha256 = createHash("sha256").update(summary, "utf8").digest("hex");
    fs.writeFileSync(path.join(directory, `${noteId}.json`), JSON.stringify(record), "utf8");
    catalog.notes[noteId].content_sha256 = "d".repeat(64);
    review = prepareReview({
      catalog,
      scope: { note_ids: [noteId] },
      candidates,
      resources: { resources: [{ name: "EvidenceTool" }] },
      evidenceRoot: path.join(directory, "video"),
      diandianRoot: directory,
      expectedPromptVersion: currentPromptVersion
    });
    assert.equal(review.items[0].diandian_summary_text, "");

    catalog.notes[noteId].content_sha256 = "a".repeat(64);
    fs.writeFileSync(path.join(directory, `${noteId}.json`), JSON.stringify({
      version: 1,
      provider: "xiaohongshu-diandian",
      prompt: "总结",
      note_id: noteId,
      title: "具体标题",
      summary
    }), "utf8");
    review = prepareReview({
      catalog,
      scope: { note_ids: [noteId] },
      candidates,
      resources: { resources: [{ name: "EvidenceTool" }] },
      evidenceRoot: path.join(directory, "video"),
      diandianRoot: directory,
      expectedPromptVersion: currentPromptVersion
    });
    assert.equal(review.items[0].diandian_summary_text, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("review preparation CLI requires the validated frozen DianDian prompt version", () => {
  const result = spawnSync(process.execPath, [
    prepareReviewCli,
    "--catalog", "catalog.json",
    "--scope", "scope.json",
    "--candidates", "candidates.json",
    "--resources", "resources.json",
    "--evidence-root", "evidence",
    "--output", "review.json"
  ], { cwd: repositoryRoot, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--diandian-prompt-version is required/);
});

test("formal point loader rejects a direct-child symlink or reparse point", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-formal-point-link-"));
  const outside = path.join(root, "outside.json");
  const pointRoot = path.join(root, "point");
  fs.mkdirSync(pointRoot);
  fs.writeFileSync(outside, "{}", "utf8");
  try {
    try {
      fs.symlinkSync(outside, path.join(pointRoot, "linked-note.json"), "file");
    } catch (error) {
      context.skip(`file-link fixture unavailable: ${error.code || error.message}`);
      return;
    }
    assert.equal(loadFormalPointSummary(pointRoot, "linked-note", "7".repeat(64)), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

test("producer evidence must be successful, revision-bound, and tool-versioned through merge", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-formal-local-evidence-"));
  const noteId = "local-evidence";
  const contentSha256 = "a".repeat(64);
  const transcriptText = "可核验且绑定当前正文 revision 的本地转写内容";
  const transcriptSha256 = createHash("sha256").update(transcriptText, "utf8").digest("hex");
  const catalog = { notes: { [noteId]: {
    type: "视频",
    title: "具体标题",
    description: "当前公开简介",
    content_sha256: contentSha256,
    source_boards: ["主题甲"],
    comment_evidence_checked: true
  } } };
  const scope = { note_ids: [noteId] };
  const candidate = {
    title: "具体标题",
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度检查。",
    action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
    themes: ["主题"],
    tools: [],
    kind: "Note"
  };
  const noteDirectory = path.join(directory, noteId);
  fs.mkdirSync(noteDirectory, { recursive: true });
  const artifact = {
    schema_version: 1,
    status: "transcribed",
    method: "local_transcription",
    provider: "faster-whisper",
    tool_version: "faster-whisper-v1",
    content_sha256: contentSha256,
    result_sha256: transcriptSha256,
    text: transcriptText
  };
  const prepare = () => prepareReview({
    catalog,
    scope,
    candidates: { [noteId]: candidate },
    resources: { resources: [] },
    evidenceRoot: directory
  });
  try {
    fs.writeFileSync(
      path.join(noteDirectory, "transcription.json"),
      JSON.stringify(artifact),
      "utf8"
    );
    let evidenceReview = prepare();
    assert.equal(evidenceReview.items[0].transcript_text, transcriptText);
    assert.deepEqual(evidenceReview.items[0].transcript_evidence, {
      method: "local_transcription",
      provider: "faster-whisper",
      version: "faster-whisper-v1",
      result_sha256: transcriptSha256
    });
    const merged = mergeResults({
      catalog,
      config: { boards: [{ name: "主题甲", category: "主题甲" }] },
      scope,
      candidates: {},
      resources: { resources: [] },
      audit: { notes: {} },
      curation: {},
      evidenceReview,
      review: { items: [{
        note_id: noteId,
        review_packet_sha256: evidenceReview.items[0].review_packet_sha256,
        candidate,
        audit: {
          status: "accepted",
          reviewed_at: "2026-08-26",
          evidence_methods: ["description", "comments", "audio_transcript"],
          comments_checked: true,
          claims_supported: true,
          resource_status: "not_applicable",
          unresolved_facts: []
        }
      }] }
    });
    assert.equal(
      merged.curation[noteId].evidence_dependencies.some((dependency) => (
        dependency.method === "audio_transcript"
        && dependency.provider === artifact.provider
        && dependency.version === artifact.tool_version
        && dependency.result_sha256 === transcriptSha256
      )),
      true
    );

    catalog.notes[noteId].content_sha256 = "b".repeat(64);
    evidenceReview = prepare();
    assert.equal(evidenceReview.items[0].transcript_text, "");
    assert.equal(evidenceReview.items[0].blockers.includes("video-body-evidence-missing"), true);

    fs.writeFileSync(
      path.join(noteDirectory, "transcription.json"),
      JSON.stringify({
        ...artifact,
        status: "failed",
        content_sha256: "b".repeat(64)
      }),
      "utf8"
    );
    evidenceReview = prepare();
    assert.equal(evidenceReview.items[0].transcript_text, "");

    fs.writeFileSync(
      path.join(noteDirectory, "visual-ocr.json"),
      JSON.stringify({
        schema_version: 1,
        status: "extracted",
        method: "local_image_ocr",
        provider: "configured-local-engine",
        tool_version: "local-ocr-v1",
        content_sha256: "b".repeat(64),
        result_sha256: "c".repeat(64),
        metadata_only: "must not become evidence text"
      }),
      "utf8"
    );
    evidenceReview = prepare();
    assert.equal(evidenceReview.items[0].visual_text, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("successful revision-bound video frame OCR prepares and merges as image_ocr", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-formal-ocr-evidence-"));
  const noteId = "d".repeat(24);
  const contentSha256 = "a".repeat(64);
  const visualText = "可核验且绑定当前正文 revision 的本地图像文字证据";
  const visualSha256 = createHash("sha256").update(visualText, "utf8").digest("hex");
  const candidate = {
    title: "具体图文标题",
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体图文总结，用来通过长度检查。",
    action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
    themes: ["主题"],
    tools: [],
    kind: "Note"
  };
  const catalog = { notes: { [noteId]: {
    type: "视频",
    title: "具体图文标题",
    description: "当前公开简介",
    content_sha256: contentSha256,
    source_boards: ["主题甲"],
    comment_evidence_checked: true
  } } };
  const scope = { note_ids: [noteId] };
  const mediaDirectory = path.join(directory, "media");
  const analysisDirectory = path.join(directory, "analysis");
  const catalogPath = path.join(directory, "catalog.json");
  const reportPath = path.join(directory, "report.json");
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(mediaDirectory, `${noteId}.jpg`),
    `import sys\nsys.stdout.buffer.write(bytes.fromhex("${Buffer.from(visualText, "utf8").toString("hex")}"))\n`,
    "utf8"
  );
  writeJson(catalogPath, catalog);
  try {
    const pythonCommand = process.env.PYTHON
      || (process.platform === "win32" ? "python" : "python3");
    const executableProbe = spawnSync(
      pythonCommand,
      ["-c", "import sys; print(sys.executable)"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(executableProbe.status, 0);
    const pythonExecutable = executableProbe.stdout.trim();
    const producer = spawnSync(pythonExecutable, [
      path.join(
        repositoryRoot,
        "skills/xhs-favorites-organizer/scripts/extract-pending-image-text.py"
      ),
      "--media-dir", mediaDirectory,
      "--analysis-dir", analysisDirectory,
      "--engine", pythonExecutable,
      "--catalog", catalogPath,
      "--note-id", noteId,
      "--report", reportPath
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(producer.status, 0);
    const evidenceReview = prepareReview({
      catalog,
      scope,
      candidates: { [noteId]: candidate },
      resources: { resources: [] },
      evidenceRoot: analysisDirectory
    });
    assert.equal(evidenceReview.items[0].visual_text, visualText);
    assert.equal(evidenceReview.items[0].evidence_methods.includes("image_ocr"), true);
    const merged = mergeResults({
      catalog,
      config: { boards: [{ name: "主题甲", category: "主题甲" }] },
      scope,
      candidates: {},
      resources: { resources: [] },
      audit: { notes: {} },
      curation: {},
      evidenceReview,
      review: { items: [{
        note_id: noteId,
        review_packet_sha256: evidenceReview.items[0].review_packet_sha256,
        candidate,
        audit: {
          status: "accepted",
          reviewed_at: "2026-08-26",
          evidence_methods: ["description", "comments", "image_ocr"],
          comments_checked: true,
          claims_supported: true,
          resource_status: "not_applicable",
          unresolved_facts: []
        }
      }] }
    });
    assert.equal(
      merged.curation[noteId].evidence_dependencies.some((dependency) => (
        dependency.method === "image_ocr"
        && dependency.provider === "configured-local-engine"
        && dependency.result_sha256 === visualSha256
      )),
      true
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("review preparation rejects unsafe scope IDs before reading outside evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-review-containment-"));
  const evidenceRoot = path.join(root, "evidence");
  const outside = path.join(root, "outside");
  fs.mkdirSync(evidenceRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(
    path.join(outside, "transcription.json"),
    JSON.stringify({ text: "outside evidence must not be read" }),
    "utf8"
  );
  try {
    assert.throws(() => prepareReview({
      catalog: { notes: {} },
      scope: { note_ids: ["../outside"] },
      candidates: {},
      resources: { resources: [] },
      evidenceRoot,
      diandianRoot: path.join(root, "diandian")
    }), /note ID/i);
    assert.throws(() => prepareReview({
      catalog: { notes: {} },
      scope: { note_ids: ["__proto__"] },
      candidates: {},
      resources: { resources: [] },
      evidenceRoot,
      diandianRoot: path.join(root, "diandian")
    }), /note ID/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review preparation rejects reparse-point evidence directories", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-review-reparse-"));
  const evidenceRoot = path.join(root, "evidence");
  const outside = path.join(root, "outside");
  const noteId = "safe-note";
  fs.mkdirSync(evidenceRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(
    path.join(outside, "transcription.json"),
    JSON.stringify({ text: "outside evidence must not be read" }),
    "utf8"
  );
  try {
    try {
      fs.symlinkSync(
        outside,
        path.join(evidenceRoot, noteId),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      context.skip(`reparse fixture unavailable: ${error.code || error.message}`);
      return;
    }
    assert.throws(() => prepareReview({
      catalog: { notes: { [noteId]: { note_id: noteId, type: "视频" } } },
      scope: { note_ids: [noteId] },
      candidates: { [noteId]: {} },
      resources: { resources: [] },
      evidenceRoot,
      diandianRoot: path.join(root, "diandian")
    }), /evidence path/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review preparation rejects an evidence file swapped after validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-review-swap-"));
  const evidenceRoot = path.join(root, "evidence");
  const outside = path.join(root, "outside");
  const noteId = "swap-note";
  const noteDirectory = path.join(evidenceRoot, noteId);
  const target = path.join(noteDirectory, "transcription.json");
  const parkedTarget = `${target}.parked`;
  const outsideTarget = path.join(outside, "transcription.json");
  fs.mkdirSync(noteDirectory, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(target, JSON.stringify({ text: "inside evidence" }), "utf8");
  fs.writeFileSync(
    outsideTarget,
    JSON.stringify({ text: "outside evidence must not be consumed" }),
    "utf8"
  );
  const originalRealpath = fs.realpathSync.native;
  let swapped = false;
  fs.realpathSync.native = (filename) => {
    const result = originalRealpath(filename);
    if (!swapped && path.resolve(filename) === path.resolve(target)) {
      fs.renameSync(target, parkedTarget);
      fs.linkSync(outsideTarget, target);
      swapped = true;
    }
    return result;
  };
  try {
    assert.throws(() => prepareReview({
      catalog: { notes: { [noteId]: { note_id: noteId, type: "视频" } } },
      scope: { note_ids: [noteId] },
      candidates: { [noteId]: {} },
      resources: { resources: [] },
      evidenceRoot,
      diandianRoot: path.join(root, "diandian")
    }), /evidence path/i);
  } finally {
    fs.realpathSync.native = originalRealpath;
    if (swapped) {
      fs.unlinkSync(target);
      fs.renameSync(parkedTarget, target);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("a curated category stays a suggestion unless an explicit override has a reason", () => {
  const input = fixture();
  input.curation[input.id].category = "另一主题";
  input.audit.notes[input.id].curation_sha256 = curationRevision(input.curation[input.id]);
  let result = auditCuration(input);
  assert.deepEqual(result.fatal, []);

  input.curation[input.id].category_override = true;
  input.audit.notes[input.id].curation_sha256 = curationRevision(input.curation[input.id]);
  result = auditCuration(input);
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
    content_sha256: "a".repeat(64),
    evidence_sha256: "b".repeat(64),
    candidate_revision: "c".repeat(64),
    curation_revision: curationRevision(entry),
    evidence_dependencies: [],
    curation_sha256: curationRevision(entry)
  };
  const audit = { notes: { current: accepted, pending: { ...accepted, status: "pending" } } };
  const note = { title: "具体标题", type: "图文", source_boards: ["主题甲"], published_at: "2026-08-12" };
  const context = {
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    currentRevisions: {
      content_sha256: "a".repeat(64),
      evidence_sha256: "b".repeat(64),
      candidate_revision: "c".repeat(64),
      curation_revision: curationRevision(entry),
      evidence_dependencies: []
    }
  };
  const baselineHashes = new Map([["old", curationRevision(entry)]]);
  assert.equal(isPublishableCuration("old", note, curation, policy, audit, new Set(["old"]), baselineHashes, context), true);
  assert.equal(isPublishableCuration("current", note, curation, policy, audit, new Set(), new Map(), context), true);
  assert.equal(isPublishableCuration("pending", note, curation, policy, audit, new Set(), new Map(), context), false);
  assert.equal(isPublishableCuration("old", note, { ...curation, old: { ...entry, summary: `${entry.summary} 已修改` } }, policy, audit, new Set(["old"]), baselineHashes, context), false);
  for (const explicitAudit of [
    { ...accepted, status: "pending", reason: "仍待复核" },
    { ...accepted, status: "rejected", reason: "证据不足" },
    { ...accepted, content_sha256: "f".repeat(64) }
  ]) {
    assert.equal(
      isPublishableCuration(
        "old",
        note,
        curation,
        policy,
        { notes: { old: explicitAudit } },
        new Set(["old"]),
        baselineHashes,
        {
          ...context,
          currentRevisions: {
            content_sha256: "a".repeat(64),
            evidence_sha256: "b".repeat(64),
            candidate_revision: "c".repeat(64),
            curation_revision: curationRevision(entry),
            evidence_dependencies: []
          }
        }
      ),
      false
    );
  }
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
      accepted: { type: "视频", description: "可核验的公开简介", content_sha256: "a".repeat(64), source_boards: ["主题甲"] },
      pending: { type: "视频", description: "仍待补充的公开简介", content_sha256: "b".repeat(64), source_boards: ["主题甲"] }
    } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scope: { note_ids: ["accepted", "pending"] },
    candidates: {},
    audit: { notes: {} },
    curation: {},
    expectedCount: 2,
    evidenceReview: { items: [
      {
        note_id: "accepted",
        content_sha256: "a".repeat(64),
        ...transcriptEvidence("可核验的本地转写正文")
      },
      { note_id: "pending", content_sha256: "b".repeat(64), transcript_text: "" }
    ] },
    review: { items: [
      { note_id: "accepted", candidate, audit: { status: "accepted", reviewed_at: "2026-08-12", evidence_methods: ["description", "comments", "audio_transcript"], comments_checked: true, claims_supported: true, resource_status: "not_applicable", unresolved_facts: [] } },
      { note_id: "pending", candidate, audit: { status: "pending", reviewed_at: "2026-08-12", evidence_methods: ["description", "comments"], comments_checked: true, claims_supported: false, resource_status: "not_applicable", unresolved_facts: ["image-text"], reason: "缺少图片正文" } }
    ] }
  });
  assert.deepEqual(Object.keys(merged.curation), ["accepted"]);
  assert.equal(merged.audit.notes.pending.status, "pending");
  assert.deepEqual(merged.counts, { accepted: 1, unavailable: 0, pending: 1, rejected: 0 });
  const current = currentFormalRevisions(
    { content_sha256: "a".repeat(64) },
    merged.curation.accepted
  );
  assert.notEqual(current, null);
  assert.equal(acceptedRevisionsCurrent(merged.audit.notes.accepted, current), true);
  assert.equal(merged.audit.notes.accepted.curation_sha256, curationRevision(merged.curation.accepted));
  assert.equal(Object.hasOwn(merged.candidates.pending, "content_sha256"), false);
});

test("production review merge requires a current packet and candidate identity binding", () => {
  const noteId = "note-a";
  const contentSha256 = "a".repeat(64);
  const packet = {
    note_id: noteId,
    content_sha256: contentSha256,
    blockers: []
  };
  packet.review_packet_sha256 = reviewPacketRevision(packet);
  const candidate = {
    id: noteId,
    content_sha256: contentSha256,
    title: "Bound candidate",
    summary: "This review candidate is explicitly bound to the current note and evidence packet revision.",
    action: "Verify the bounded evidence before publishing this synthetic candidate.",
    themes: ["binding"],
    tools: [],
    kind: "Note"
  };
  const reviewItem = {
    note_id: noteId,
    review_packet_sha256: packet.review_packet_sha256,
    candidate,
    audit: {
      status: "accepted",
      reviewed_at: "2026-08-27",
      evidence_methods: ["description", "comments"],
      comments_checked: true,
      claims_supported: true,
      resource_status: "not_applicable",
      unresolved_facts: []
    }
  };
  const base = {
    catalog: { notes: { [noteId]: { description: "A", content_sha256: contentSha256 } } },
    config: { boards: [] },
    resources: { resources: [] },
    scope: { note_ids: [noteId] },
    candidates: {},
    audit: { notes: {} },
    curation: {},
    evidenceReview: { items: [packet] },
    review: { items: [reviewItem] },
    requirePacketBinding: true
  };
  assert.equal(mergeResults(base).counts.accepted, 1);
  assert.throws(
    () => mergeResults({ ...base, evidenceReview: null }),
    /review packet/i
  );
  assert.throws(
    () => mergeResults({
      ...base,
      evidenceReview: { items: [{ ...packet, review_packet_sha256: "" }] }
    }),
    /review packet/i
  );
  const extraPacket = {
    note_id: "note-b",
    content_sha256: "b".repeat(64),
    blockers: []
  };
  extraPacket.review_packet_sha256 = reviewPacketRevision(extraPacket);
  assert.throws(
    () => mergeResults({
      ...base,
      evidenceReview: { items: [packet, extraPacket] }
    }),
    /out-of-scope/i
  );
  assert.throws(
    () => mergeResults({
      ...base,
      review: { items: [{ ...reviewItem, review_packet_sha256: "b".repeat(64) }] }
    }),
    /review packet/i
  );
  assert.throws(
    () => mergeResults({
      ...base,
      review: { items: [{
        ...reviewItem,
        candidate: { ...candidate, id: "note-b", content_sha256: "b".repeat(64) }
      }] }
    }),
    /candidate.*binding/i
  );
  assert.throws(
    () => mergeResults({
      ...base,
      catalog: { notes: { [noteId]: { description: "Changed", content_sha256: "b".repeat(64) } } }
    }),
    /review packet.*stale/i
  );
});

test("review merge rejects stale or synthetic body evidence before formal acceptance", () => {
  const candidate = {
    title: "具体标题",
    summary: "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度检查。",
    action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
    themes: ["主题"], tools: [], kind: "Note"
  };
  const base = {
    catalog: { notes: { current: {
      type: "视频", description: "当前公开简介", content_sha256: "a".repeat(64), source_boards: ["主题甲"]
    } } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scope: { note_ids: ["current"] },
    candidates: {}, audit: { notes: {} }, curation: {},
    review: { items: [{ note_id: "current", candidate, audit: {
      status: "accepted", reviewed_at: "2026-08-12",
      evidence_methods: ["description", "comments", "audio_transcript"],
      comments_checked: true, claims_supported: true,
      resource_status: "not_applicable", unresolved_facts: []
    } }] }
  };
  assert.throws(() => mergeResults({
    ...base,
    evidenceReview: { items: [{
      note_id: "current", content_sha256: "b".repeat(64), transcript_text: "旧版本转写"
    }] }
  }), /stale/);
  assert.throws(() => mergeResults({
    ...base,
    catalog: { notes: { current: { ...base.catalog.notes.current, type: "图文" } } },
    review: { items: [{ ...base.review.items[0], audit: {
      ...base.review.items[0].audit,
      evidence_methods: ["description", "comments", "image_review"]
    } }] },
    evidenceReview: { items: [{
      note_id: "current", content_sha256: "a".repeat(64), transcript_text: ""
    }] }
  }), /image review evidence is unavailable/);
  assert.throws(() => mergeResults({
    ...base,
    catalog: { notes: { current: {
      ...base.catalog.notes.current,
      type: "图文"
    } } },
    review: { items: [{ ...base.review.items[0], audit: {
      ...base.review.items[0].audit,
      evidence_methods: ["description", "comments", "image_ocr"]
    } }] },
    evidenceReview: { items: [{
      note_id: "current",
      content_sha256: "a".repeat(64),
      visual_text: "",
      visual_evidence: null
    }] }
  }), /image.*evidence is missing or invalid/);
  for (const method of ["visual_ocr", "video_analysis"]) {
    assert.throws(() => mergeResults({
      ...base,
      catalog: { notes: { current: {
        ...base.catalog.notes.current,
        type: "视频"
      } } },
      review: { items: [{ ...base.review.items[0], audit: {
        ...base.review.items[0].audit,
        evidence_methods: ["description", "comments", method]
      } }] },
      evidenceReview: { items: [{
        note_id: "current",
        content_sha256: "a".repeat(64),
        transcript_text: "",
        visual_text: ""
      }] }
    }), new RegExp(`${method} evidence is unavailable`));
  }
});

test("review merge evaluates Skill resource freshness against the merge date", () => {
  const resource = {
    id: "github-owner-repo",
    name: "Official Skill",
    aliases: [],
    type: "Agent Skill",
    canonical_repo: "owner/repo",
    repo: "https://github.com/owner/repo",
    download: "https://github.com/owner/repo/archive/refs/heads/main.zip",
    stars: "1",
    stars_numeric: 1,
    license: "MIT",
    skill_manifest: "SKILL.md",
    compatibility: ["Codex"],
    compatibility_evidence: ["README.md"],
    verified_at: "2026-08-01",
    status: "verified",
    usage_note: "Synthetic fixture"
  };
  Object.assign(resource, expectedResourceRevisions(resource));
  const summary = "这是一段包含明确对象、工作方式、适用情境与限制条件的具体内容总结，用来通过长度检查。";
  const base = {
    catalog: { notes: { current: {
      type: "视频",
      description: "当前公开简介",
      content_sha256: "a".repeat(64),
      source_boards: ["主题甲"]
    } } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [resource] },
    scope: { note_ids: ["current"] },
    candidates: {},
    audit: { notes: {} },
    curation: {},
    evidenceReview: { items: [{
      note_id: "current",
      content_sha256: "a".repeat(64),
      ...transcriptEvidence("可核验的本地转写正文")
    }] },
    review: { items: [{
      note_id: "current",
      candidate: {
        title: "具体标题",
        summary,
        action: "使用一个真实样例核对输入、输出和限制，再决定是否采用。",
        themes: ["主题"],
        tools: [resource.name],
        kind: "Skill"
      },
      audit: {
        status: "accepted",
        reviewed_at: "2026-08-02",
        evidence_methods: ["description", "comments", "audio_transcript"],
        comments_checked: true,
        claims_supported: true,
        resource_status: "verified",
        unresolved_facts: []
      }
    }] }
  };

  assert.equal(mergeResults({ ...base, today: "2026-08-31" }).counts.accepted, 1);
  assert.throws(
    () => mergeResults({ ...base, today: "2026-09-01" }),
    /Skill resource is unavailable or stale/
  );
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

test("review merge validates status first, stores bounded non-accepted skeletons, and audits every status", () => {
  const base = {
    catalog: { notes: {
      rejected: { type: "图文", source_boards: ["主题甲"] },
      pending: { type: "视频", source_boards: ["主题甲"] }
    } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scope: { note_ids: ["rejected", "pending"] },
    candidates: {},
    audit: { notes: {} },
    curation: {
      rejected: { summary: "must be removed" },
      pending: { summary: "must be removed" }
    }
  };
  const merged = mergeResults({
    ...base,
    review: { items: [
      {
        note_id: "rejected",
        candidate: null,
        audit: {
          status: "rejected",
          reviewed_at: "2026-08-26",
          evidence_methods: [],
          comments_checked: false,
          claims_supported: false,
          resource_status: "not_applicable",
          unresolved_facts: [],
          reason: "正文不足，不适合进入知识库"
        }
      },
      {
        note_id: "pending",
        candidate: {
          title: "待补证",
          summary: "x".repeat(20_000),
          action: "y".repeat(20_000),
          themes: Array.from({ length: 100 }, (_, index) => `主题-${index}`),
          tools: Array.from({ length: 100 }, (_, index) => `工具-${index}`),
          kind: "Note",
          ignored_private_shape: "must not be persisted"
        },
        audit: {
          status: "pending",
          reviewed_at: "2026-08-26",
          evidence_methods: ["description"],
          comments_checked: false,
          claims_supported: false,
          resource_status: "not_applicable",
          unresolved_facts: ["audio-transcript"],
          reason: "等待正文证据"
        }
      }
    ] }
  });
  assert.deepEqual(merged.counts, { accepted: 0, unavailable: 0, pending: 1, rejected: 1 });
  assert.deepEqual(Object.keys(merged.curation), []);
  assert.deepEqual(merged.candidates.rejected, {
    title: "",
    summary: "",
    action: "",
    themes: [],
    tools: [],
    kind: ""
  });
  assert.equal(merged.candidates.pending.summary.length <= 1_000, true);
  assert.equal(merged.candidates.pending.action.length <= 500, true);
  assert.equal(merged.candidates.pending.themes.length <= 12, true);
  assert.equal(merged.candidates.pending.tools.length <= 12, true);
  assert.equal(Object.hasOwn(merged.candidates.pending, "ignored_private_shape"), false);

  assert.throws(() => mergeResults({
    ...base,
    scope: { note_ids: ["rejected"] },
    review: { items: [{
      note_id: "rejected",
      candidate: null,
      audit: {
        status: "rejected",
        reviewed_at: "2026-08-26",
        evidence_methods: [],
        comments_checked: false,
        claims_supported: false,
        resource_status: "not_applicable",
        unresolved_facts: []
      }
    }] }
  }), /rejected final audit failed quality validation/);
  assert.throws(() => mergeResults({
    ...base,
    scope: { note_ids: ["pending"] },
    review: { items: [{
      note_id: "pending",
      candidate: null,
      audit: {
        status: "pending",
        reviewed_at: "",
        evidence_methods: [],
        comments_checked: false,
        claims_supported: false,
        resource_status: "not_applicable",
        unresolved_facts: ["audio-transcript"],
        reason: "等待正文证据"
      }
    }] }
  }), /pending final audit failed quality validation/);
});

test("an unavailable source is a completed unpublished terminal state", () => {
  const unavailableAudit = {
    status: "unavailable",
    reviewed_at: "2026-08-29",
    evidence_methods: ["description", "source_unavailable"],
    comments_checked: false,
    claims_supported: false,
    resource_status: "not_applicable",
    unresolved_facts: ["comments-unchecked"],
    reason: "原帖当前不可访问，保留现有记录并结束补证。"
  };
  const input = {
    catalog: { notes: { unavailable: {
      type: "视频",
      description: "此前保存的公开简介",
      source_boards: ["主题甲"]
    } } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scopeIds: ["unavailable"],
    curation: {},
    audit: { notes: { unavailable: unavailableAudit } }
  };

  const quality = auditCuration(input);
  assert.equal(quality.fatal.length, 0);
  assert.deepEqual(quality.report.totals, {
    scoped: 1, accepted: 0, unavailable: 1, pending: 0, rejected: 0, invalid: 0
  });
  assert.deepEqual(formalCurationDecision({
    publishable: false,
    auditEntry: unavailableAudit
  }), {
    accepted: false,
    reason_code: "source_unavailable",
    summary_source: "metadata",
    content_sha256: "",
    evidence_sha256: "",
    resource_ids: []
  });
  assert.deepEqual(publicEvidenceStatus("unavailable", input.audit), {
    method: "原帖当前不可访问，已保留此前记录并结束补证",
    locallyAvailable: false
  });

  const merged = mergeResults({
    catalog: input.catalog,
    config: input.config,
    resources: input.resources,
    scope: { note_ids: ["unavailable"] },
    candidates: { unavailable: { title: "保留的旧记录" } },
    audit: { notes: {} },
    curation: { unavailable: { summary: "must be removed" } },
    review: { items: [{
      note_id: "unavailable",
      candidate: { title: "保留的旧记录" },
      audit: unavailableAudit
    }] }
  });
  assert.deepEqual(merged.counts, {
    accepted: 0, unavailable: 1, pending: 0, rejected: 0
  });
  assert.equal(merged.audit.notes.unavailable.status, "unavailable");
  assert.equal(Object.hasOwn(merged.curation, "unavailable"), false);

  const initialized = initializeAudit({
    items: [{
      note_id: "unavailable",
      public_text: "原帖重新进入普通证据准备",
      blockers: ["comments-unchecked"],
      tool_checks: []
    }]
  }, merged.audit, merged.curation, "2026-08-30");
  assert.equal(initialized.notes.unavailable.status, "unavailable");
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
    catalog: { notes: { override: {
      type: "视频",
      description: "可核验的公开简介",
      content_sha256: "c".repeat(64),
      source_boards: ["主题甲"]
    } } },
    config: { boards: [{ name: "主题甲", category: "主题甲" }] },
    resources: { resources: [] },
    scope: { note_ids: ["override"] }, candidates: {}, audit: { notes: {} }, curation: {},
    evidenceReview: { items: [{
      note_id: "override",
      content_sha256: "c".repeat(64),
      ...transcriptEvidence("可核验的本地转写正文")
    }] },
    review: { items: [{ note_id: "override", candidate, audit: {
      status: "accepted", reviewed_at: "2026-08-12",
      evidence_methods: ["description", "comments", "audio_transcript"], comments_checked: true,
      claims_supported: true, resource_status: "not_applicable", unresolved_facts: []
    } }] }
  });
  assert.equal(merged.curation.override.category, "推荐新分类");
  assert.equal(merged.curation.override.category_override, true);
});

test("curation merge CLI recovers a mid-participant crash before reading live inputs", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-curation-cli-restart-"));
  const paths = mergeCliFixture(workspace);
  const participants = [
    { name: "curation-candidates", target: paths.candidates, content: "{invalid candidates" },
    { name: "curation-audit", target: paths.audit, content: "{invalid audit" },
    { name: "formal-curation", target: paths.curation, content: "{invalid curation" }
  ];
  try {
    await assert.rejects(
      executeJournaledTransaction({
        root: workspace,
        transactionRoot: paths.transactionRoot,
        id: "curation-review-restart-before-read",
        participants,
        failAt: "crash-after-swap:curation-candidates"
      }),
      /SIMULATED_CRASH/
    );
    assert.throws(() => JSON.parse(fs.readFileSync(paths.candidates, "utf8")));

    const result = runMergeCli(workspace, paths);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      accepted: 0,
      unavailable: 0,
      pending: 0,
      rejected: 1
    });
    assert.equal(JSON.parse(fs.readFileSync(paths.candidates, "utf8")).current.title, "具体标题");
    assert.equal(JSON.parse(fs.readFileSync(paths.audit, "utf8")).notes.current.status, "rejected");
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(paths.curation, "utf8")), "current"), false);
    assert.equal(
      fs.readdirSync(paths.transactionRoot)
        .some((name) => name.startsWith(".organization-tx-curation-review-")),
      false
    );
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("curation merge CLI rejects a redirected transaction root before external staging", (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-curation-cli-root-"));
  const paths = mergeCliFixture(workspace);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-curation-cli-outside-"));
  try {
    try {
      fs.symlinkSync(
        outside,
        paths.transactionRoot,
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      context.skip(`redirected transaction root fixture unavailable: ${error.code}`);
      return;
    }

    const result = runMergeCli(workspace, paths);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^curation-merge: CURATION_MERGE_TRANSACTION_UNSAFE\r?\n$/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    if (fs.existsSync(paths.transactionRoot)) fs.unlinkSync(paths.transactionRoot);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("curation merge CLI fails closed if the validated transaction root is swapped before cleanup", (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-curation-cli-root-swap-"));
  const paths = mergeCliFixture(workspace);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-curation-cli-swap-outside-"));
  const originalRoot = `${paths.transactionRoot}.original`;
  const legacyName = ".curation-review-staging-22222222-2222-4222-8222-222222222222";
  const outsideLegacy = path.join(outside, legacyName);
  const sentinel = path.join(outsideLegacy, "must-remain.txt");
  const preload = path.join(workspace, "swap-transaction-root.mjs");
  try {
    fs.mkdirSync(path.join(paths.transactionRoot, legacyName), { recursive: true });
    fs.mkdirSync(outsideLegacy, { recursive: true });
    fs.writeFileSync(sentinel, "outside sentinel", "utf8");
    try {
      const probe = path.join(workspace, "junction-probe");
      fs.symlinkSync(outside, probe, process.platform === "win32" ? "junction" : "dir");
      fs.unlinkSync(probe);
    } catch (error) {
      context.skip(`redirected transaction root fixture unavailable: ${error.code}`);
      return;
    }
    fs.writeFileSync(preload, `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const transactionRoot = process.env.XHS_TEST_TRANSACTION_ROOT;
      const originalRoot = process.env.XHS_TEST_ORIGINAL_ROOT;
      const outside = process.env.XHS_TEST_OUTSIDE_ROOT;
      const originalReaddir = fs.promises.readdir;
      let swapped = false;
      fs.promises.readdir = async (target, options) => {
        const result = await originalReaddir(target, options);
        if (!swapped && String(target) === transactionRoot) {
          swapped = true;
          fs.renameSync(transactionRoot, originalRoot);
          fs.symlinkSync(outside, transactionRoot, process.platform === "win32" ? "junction" : "dir");
        }
        return result;
      };
      syncBuiltinESMExports();
    `, "utf8");

    const result = runMergeCli(workspace, paths, {
      nodeArgs: ["--import", pathToFileURL(preload).href],
      env: {
        ...process.env,
        XHS_TEST_TRANSACTION_ROOT: paths.transactionRoot,
        XHS_TEST_ORIGINAL_ROOT: originalRoot,
        XHS_TEST_OUTSIDE_ROOT: outside
      }
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^curation-merge: CURATION_MERGE_TRANSACTION_UNSAFE\r?\n$/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside sentinel");
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    if (fs.existsSync(paths.transactionRoot)) fs.unlinkSync(paths.transactionRoot);
    if (fs.existsSync(originalRoot)) fs.renameSync(originalRoot, paths.transactionRoot);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("curation merge CLI emits only an allowlisted input error", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-curation-cli-error-"));
  const paths = mergeCliFixture(workspace);
  const privateFragment = "private-fragment-must-not-escape";
  try {
    fs.writeFileSync(paths.candidates, `{"${privateFragment}":`, "utf8");

    const result = runMergeCli(workspace, paths);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^curation-merge: CURATION_MERGE_INPUT_INVALID\r?\n$/);
    assert.equal(result.stderr.includes(privateFragment), false);
    assert.equal(result.stderr.includes(workspace), false);
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("curation merge CLI releases the mutation lock when private cleanup fails", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-curation-cli-cleanup-"));
  const paths = mergeCliFixture(workspace);
  const legacyStaging = path.join(
    paths.transactionRoot,
    ".curation-review-staging-11111111-1111-4111-8111-111111111111"
  );
  try {
    fs.mkdirSync(legacyStaging, { recursive: true });
    const failed = runMergeCli(workspace, paths);

    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /^curation-merge: CURATION_MERGE_CLEANUP_FAILED\r?\n$/);
    assert.equal(failed.stderr.includes("private cleanup detail"), false);
    assert.equal(fs.existsSync(paths.lock), false);

    fs.rmSync(legacyStaging, { recursive: true, force: true });
    const restarted = runMergeCli(workspace, paths);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
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
  assert.deepEqual(publicEvidenceStatus("current", audit, true, true), {
    method: "已结合本地视频证据核验内容",
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
