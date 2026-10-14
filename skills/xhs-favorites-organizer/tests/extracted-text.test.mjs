import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtractedText } from "../scripts/extracted-text.mjs";
import { currentEvidence, evidenceText } from "../scripts/evidence-files.mjs";

const NOTE = "6a2a81d1000000001702d3de";
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const evidence = (text, method, status, overrides = {}) => ({
  schema_version: 1, status, method, content_sha256: "c".repeat(64), provider: "local", tool_version: "1",
  text, result_sha256: sha(text), ...overrides,
});
const transcript = (text, overrides) => evidence(text, "local_transcription", "transcribed", overrides);
const imageText = (text, overrides) => evidence(text, "local_image_ocr", "extracted", overrides);

async function withRoot(files, run) {
  const root = await mkdtemp(join(tmpdir(), "favsense-extracted-"));
  try {
    await mkdir(join(root, NOTE), { recursive: true });
    for (const [name, value] of Object.entries(files)) await writeFile(join(root, NOTE, name), JSON.stringify(value));
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a video's transcript is returned as video-transcript text", async () => {
  await withRoot({ "transcription.json": transcript("记住这个项目") }, async (root) => {
    assert.deepEqual(loadExtractedText(root, NOTE, "视频"), { kind: "video-transcript", text: "记住这个项目" });
  });
});

test("a video's transcript and its on-screen text are returned together, transcript first", async () => {
  await withRoot({ "transcription.json": transcript("口播"), "visual-ocr.json": imageText("画面字") }, async (root) => {
    assert.deepEqual(loadExtractedText(root, NOTE, "视频"), { kind: "video-transcript", text: "口播\n\n画面字" });
  });
});

test("a video with only on-screen text is returned as video-transcript text", async () => {
  await withRoot({ "visual-ocr.json": imageText("只有画面字") }, async (root) => {
    assert.deepEqual(loadExtractedText(root, NOTE, "视频"), { kind: "video-transcript", text: "只有画面字" });
  });
});

test("an image post's picture text is returned as image-text and a stray transcript is ignored", async () => {
  await withRoot({ "visual-ocr.json": imageText("图里的字"), "transcription.json": transcript("不该出现") }, async (root) => {
    assert.deepEqual(loadExtractedText(root, NOTE, "图文"), { kind: "image-text", text: "图里的字" });
  });
});

test("the post's own content hash is not matched, so restored paragraphs cannot hide a transcript", async () => {
  await withRoot({ "transcription.json": transcript("口播", { content_sha256: "d".repeat(64) }) }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频").text, "口播");
  });
});

test("a record whose text does not match its own hash is not used", async () => {
  await withRoot({ "transcription.json": transcript("口播", { result_sha256: "e".repeat(64) }) }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频"), null);
  });
});

test("a record with the wrong method or status is not used", async () => {
  await withRoot({ "transcription.json": transcript("口播", { status: "partial" }) }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频"), null);
  });
  await withRoot({ "transcription.json": transcript("口播", { method: "other" }) }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频"), null);
  });
});

test("no folder, no files, or an image post without picture text give null", async () => {
  assert.equal(loadExtractedText(join(tmpdir(), "favsense-no-such-root"), NOTE, "视频"), null);
  await withRoot({}, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频"), null);
    assert.equal(loadExtractedText(root, NOTE, "图文"), null);
  });
});

// Regression: BUG-001 — a picture-text record saved while the engine's Windows code-page bytes were
// decoded as UTF-8 keeps U+FFFD replacement characters, and its own hash was computed over that
// damage, so the hash check alone passes it. Text that cannot be decoded truthfully is absent.
// Found by /qa on 2026-10-14. Report: docs/reports/qa/2026-10-14-favsense-faithful-cards-qa-report.md
const GARBLED = "K K \uFFFD\u01F3\uFFFD\uFFFD\u043B\uFFFD\uFFFD\u04B6\uFFFD\uFFFD\u04B5\uFFFD\u03F2\uFFFD\uFFFD\uFFFD\u05A7\uFFFD K K";

test("a record whose text carries replacement characters is not used, whichever record it is", async () => {
  await withRoot({ "visual-ocr.json": imageText(GARBLED) }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频"), null);
    assert.equal(loadExtractedText(root, NOTE, "图文"), null);
  });
  await withRoot({ "transcription.json": transcript(`口播${GARBLED}`) }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频"), null);
  });
});

test("a damaged picture-text record is dropped but a sound transcript beside it is still shown", async () => {
  await withRoot({ "transcription.json": transcript("口播"), "visual-ocr.json": imageText(GARBLED) }, async (root) => {
    assert.deepEqual(loadExtractedText(root, NOTE, "视频"), { kind: "video-transcript", text: "口播" });
  });
});

test("the review's reading of evidence refuses a damaged record too, since both read through one function", () => {
  const record = imageText(GARBLED, { content_sha256: "c".repeat(64) });
  assert.equal(currentEvidence(record, "c".repeat(64), { status: "extracted", method: "local_image_ocr" }), null);
  assert.equal(evidenceText(record, { status: "extracted", method: "local_image_ocr" }), null);
});

test("a legitimate middle dot or multiplication sign is not mistaken for damage", async () => {
  await withRoot({ "visual-ocr.json": imageText("乔布斯·史蒂夫 3×4") }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频").text, "乔布斯·史蒂夫 3×4");
  });
});
