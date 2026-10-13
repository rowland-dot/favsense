import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtractedText } from "../scripts/extracted-text.mjs";

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
