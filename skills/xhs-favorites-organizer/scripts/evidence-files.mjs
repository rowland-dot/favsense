// Safe reading of the per-note evidence files (transcripts, picture text, saved DianDian replies).
// Used by the review preparation and by the card builder, so both read these files by the same rules.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export const HASH = /^[a-f0-9]{64}$/;

// File identity is compared on exact (bigint) values. Ordinary Number values lose the low bits of a
// 64-bit Windows file number, so two different files can read back as the same file. Both sides of
// every comparison must come from a call that passes EXACT; a Number never equals a BigInt.
const EXACT = { bigint: true };

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function containedEvidenceFile(root, noteId, filename, maxBytes, nested) {
  if (!root) return null;
  const base = path.resolve(root);
  const parts = nested ? [noteId] : [];
  let current = base;
  try {
    const rootMetadata = fs.lstatSync(base, EXACT);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("unsafe root");
    }
    const bindings = [{ filename: base, metadata: rootMetadata, directory: true }];
    for (const part of parts) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) return null;
      const metadata = fs.lstatSync(current, EXACT);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("unsafe directory");
      }
      bindings.push({ filename: current, metadata, directory: true });
    }
    const target = path.join(current, filename);
    const relativeTarget = path.relative(base, target);
    if (
      !relativeTarget
      || path.isAbsolute(relativeTarget)
      || relativeTarget === ".."
      || relativeTarget.startsWith(`..${path.sep}`)
      || !fs.existsSync(target)
    ) return null;
    const metadata = fs.lstatSync(target, EXACT);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("unsafe file");
    }
    if (metadata.size > BigInt(maxBytes)) return null;
    bindings.push({ filename: target, metadata, directory: false });
    const realBase = fs.realpathSync.native(base);
    const realTarget = fs.realpathSync.native(target);
    const relativeRealTarget = path.relative(realBase, realTarget);
    if (
      path.isAbsolute(relativeRealTarget)
      || relativeRealTarget === ".."
      || relativeRealTarget.startsWith(`..${path.sep}`)
    ) throw new Error("outside root");
    return { base, target, maxBytes, bindings };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Curation evidence path is unsafe");
  }
}

export function readContainedText(binding) {
  if (!binding) return null;
  let descriptor;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(binding.target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, EXACT);
    const expectedTarget = binding.bindings.at(-1).metadata;
    if (!opened.isFile() || !sameFileIdentity(opened, expectedTarget) || opened.size > BigInt(binding.maxBytes)) {
      throw new Error("opened evidence identity changed");
    }
    const text = fs.readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(text, "utf8") > binding.maxBytes) return null;
    for (const item of binding.bindings) {
      const current = fs.lstatSync(item.filename, EXACT);
      if (
        current.isSymbolicLink()
        || (item.directory ? !current.isDirectory() : !current.isFile())
        || !sameFileIdentity(current, item.metadata)
      ) throw new Error("evidence identity changed");
    }
    const realBase = fs.realpathSync.native(binding.base);
    const realTarget = fs.realpathSync.native(binding.target);
    const relativeTarget = path.relative(realBase, realTarget);
    if (
      path.isAbsolute(relativeTarget)
      || relativeTarget === ".."
      || relativeTarget.startsWith(`..${path.sep}`)
    ) throw new Error("evidence escaped root");
    const after = fs.fstatSync(descriptor, EXACT);
    if (!sameFileIdentity(after, opened)) throw new Error("opened evidence identity changed");
    return text;
  } catch {
    throw new Error("Curation evidence path is unsafe");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readEvidence(root, noteId, filename) {
  const source = readContainedText(
    containedEvidenceFile(root, noteId, filename, 16 * 1024 * 1024, true)
  );
  if (!source) return null;
  try {
    return JSON.parse(source.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

// Everything about a transcript or picture-text record except which version of the post it was made for.
export function evidenceText(record, contract) {
  if (
    !record
    || typeof record !== "object"
    || Array.isArray(record)
    || record.schema_version !== 1
    || record.status !== contract.status
    || record.method !== contract.method
    || !clean(record.provider)
    || !clean(record.tool_version)
  ) return null;
  const text = clean(record.text);
  const resultSha256 = clean(record.result_sha256);
  if (
    !text
    || !HASH.test(resultSha256)
    || createHash("sha256").update(text, "utf8").digest("hex") !== resultSha256
  ) return null;
  return {
    text,
    evidence: {
      method: record.method,
      provider: clean(record.provider),
      version: clean(record.tool_version),
      result_sha256: resultSha256
    }
  };
}

// The review's reading: the record must also belong to this exact version of the post.
export function currentEvidence(record, contentSha256, contract) {
  if (!HASH.test(contentSha256) || clean(record?.content_sha256) !== contentSha256) return null;
  return evidenceText(record, contract);
}
